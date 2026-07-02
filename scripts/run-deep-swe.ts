/**
 * DeepSwe/Pier benchmark runner for SunCode.
 *
 * Usage:
 *   bun run test:deep-swe -- <task-id-or-path> [more tasks]
 *   bun run test:deep-swe -- cliffy-config-file-parsing --model deepseek/deepseek-v4-flash
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

type Provider = 'anthropic' | 'deepseek' | 'google' | 'openai';

interface RunnerOptions {
  attempts: string;
  concurrency: string;
  debug: boolean;
  deepSweRoot: string;
  dryRun: boolean;
  jobsDir: string;
  model: string;
  provider: Provider;
  proxy: string;
  quiet: boolean;
  tasks: string[];
}

const providerApiKeys: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const defaultOptions: RunnerOptions = {
  attempts: '1',
  concurrency: '1',
  debug: false,
  deepSweRoot: process.env.DEEP_SWE_ROOT || resolve('..', 'deep-swe'),
  dryRun: false,
  jobsDir: 'jobs',
  model: process.env.SUNCODE_MODEL || 'deepseek/deepseek-v4-flash',
  provider: parseProvider(process.env.SUNCODE_PROVIDER || 'deepseek'),
  proxy: process.env.SUNCODE_PROXY || 'http://host.docker.internal:7897',
  quiet: false,
  tasks: [],
};

function parseProvider(value: string): Provider {
  if (value === 'anthropic' || value === 'deepseek' || value === 'google' || value === 'openai') {
    return value;
  }
  throw new Error(`Unsupported provider: ${value}`);
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = { ...defaultOptions, tasks: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') {
      options.provider = parseProvider(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === '--model') {
      options.model = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--deep-swe-root') {
      options.deepSweRoot = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--jobs-dir') {
      options.jobsDir = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--proxy') {
      options.proxy = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--no-proxy') {
      options.proxy = '';
    } else if (arg === '--concurrency') {
      options.concurrency = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--attempts') {
      options.attempts = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--debug') {
      options.debug = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.tasks.push(arg);
    }
  }

  return options;
}

function resolveTaskPath(task: string, deepSweRoot: string): string {
  const directPath = resolve(task);
  if (existsSync(directPath)) {
    return directPath;
  }

  const taskPath = resolve(deepSweRoot, 'tasks', task);
  if (existsSync(taskPath)) {
    return taskPath;
  }

  throw new Error(`DeepSwe task not found: ${task} (also checked ${taskPath})`);
}

function normalizeShellScripts(directory: string): void {
  for (const entry of readdirSync(directory)) {
    const fullPath = resolve(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      normalizeShellScripts(fullPath);
      continue;
    }

    if (!fullPath.endsWith('.sh') && !fullPath.endsWith('.patch')) {
      continue;
    }

    const content = readFileSync(fullPath, 'utf-8');
    const normalized = content.replaceAll('\r\n', '\n');
    if (normalized !== content) {
      writeFileSync(fullPath, normalized, 'utf-8');
    }
  }
}

function modelForSunCode(model: string, provider: Provider): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function readConfigApiKey(configPath: string, provider: Provider): string | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }

  const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    envApiKeys?: Partial<Record<Provider, string>>;
  };
  const apiKey = parsed.envApiKeys?.[provider];
  return apiKey && !apiKey.includes('在此输入') ? apiKey : undefined;
}

function loadApiKey(apiKeyName: string, provider: Provider): string | undefined {
  const envApiKey = process.env[apiKeyName];
  if (envApiKey) {
    return envApiKey;
  }

  const configPaths = [
    resolve('.suncode', 'config.json'),
    process.env.APPDATA
      ? resolve(process.env.APPDATA, 'SunCode', '.suncode', 'config.json')
      : resolve(homedir(), 'AppData', 'Roaming', 'SunCode', '.suncode', 'config.json'),
  ];

  for (const configPath of configPaths) {
    const apiKey = readConfigApiKey(configPath, provider);
    if (apiKey) {
      return apiKey;
    }
  }

  return undefined;
}

function buildPierArgs(options: RunnerOptions): string[] {
  const agentImportPath = 'pier_suncode_agent:SunCodeAgent';
  const apiKeyName = providerApiKeys[options.provider];
  const suncodeModel = modelForSunCode(options.model, options.provider);
  const args = [
    'run',
    '--agent-import-path',
    agentImportPath,
    '--model',
    options.model,
    '--jobs-dir',
    options.jobsDir,
    '--n-attempts',
    options.attempts,
    '--n-concurrent',
    options.concurrency,
    '--yes',
    '--ae',
    `SUNCODE_PROVIDER=${options.provider}`,
    '--ae',
    `SUNCODE_MODEL=${suncodeModel}`,
  ];

  const apiKey = loadApiKey(apiKeyName, options.provider);
  if (apiKey) {
    args.push('--ae', `${apiKeyName}=${apiKey}`);
  }

  const openaiBaseUrl = process.env.OPENAI_BASE_URL;
  if (openaiBaseUrl) {
    args.push('--ae', `OPENAI_BASE_URL=${openaiBaseUrl}`);
  }
  if (options.proxy) {
    args.push('--ae', `SUNCODE_PROXY=${options.proxy}`);
  }

  if (options.debug) {
    args.push('--debug');
  }
  if (options.quiet) {
    args.push('--quiet');
  }

  for (const task of options.tasks) {
    const taskPath = resolveTaskPath(task, options.deepSweRoot);
    normalizeShellScripts(taskPath);
    args.push('-p', taskPath);
  }

  return args;
}

function quoteArg(arg: string): string {
  if (!/[\s"']/.test(arg)) {
    return arg;
  }
  return `"${arg.replaceAll('"', '\\"')}"`;
}

function maskSensitiveArg(arg: string): string {
  return arg.replace(/((?:API_KEY|TOKEN|SECRET)=).+/i, '$1***');
}

function printUsage(): void {
  console.error(`Usage:
  bun run test:deep-swe -- <task-id-or-path> [more tasks]

Options:
  --provider <name>        deepseek | anthropic | openai | google (default: deepseek)
  --model <name>           Pier model name (default: deepseek/deepseek-v4-flash)
  --deep-swe-root <path>   DeepSwe checkout root (default: ../deep-swe or DEEP_SWE_ROOT)
  --jobs-dir <path>        Pier jobs output directory (default: jobs)
  --proxy <url>            Proxy inside Docker (default: http://host.docker.internal:7897)
  --no-proxy               Disable proxy injection
  --concurrency <n>        Pier concurrent trials (default: 1)
  --attempts <n>           Pier attempts per task (default: 1)
  --debug                  Pass Pier debug mode
  --quiet                  Pass Pier quiet mode
  --dry-run                Print the pier command without running it
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.tasks.length === 0) {
    printUsage();
    process.exit(2);
  }

  const pierArgs = buildPierArgs(options);
  const command = ['pier', ...pierArgs].map(maskSensitiveArg).map(quoteArg).join(' ');
  console.error(`[deep-swe] ${command}`);

  if (options.dryRun) {
    return;
  }

  const child = spawn('pier', pierArgs, {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  const exitCode = await new Promise<number>((resolveExit) => {
    child.on('close', (code) => resolveExit(code ?? 1));
    child.on('error', () => resolveExit(1));
  });

  process.exit(exitCode);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[deep-swe] ${message}`);
  process.exit(1);
});
