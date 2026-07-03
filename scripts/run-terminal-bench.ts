/**
 * Harbor Terminal-Bench runner for SunCode.
 *
 * Usage:
 *   bun run test:terminal-bench -- --task-limit 1
 *   bun run test:terminal-bench -- --model deepseek/deepseek-v4-flash --task-limit 1
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';

type Provider = 'anthropic' | 'deepseek' | 'google' | 'openai';

interface RunnerOptions {
  agent: string;
  agentTimeoutMultiplier: string;
  attempts: string;
  concurrency: string;
  dataset: string;
  dryRun: boolean;
  environment: string;
  envFile: string | undefined;
  extraArgs: string[];
  jobsDir: string;
  model: string;
  provider: Provider;
  proxy: string;
  quiet: boolean;
  task: string[];
  excludeTask: string[];
  taskLimit: string | undefined;
}

const defaultModel = process.env.HARBOR_MODEL || process.env.SUNCODE_MODEL || 'deepseek/deepseek-v4-flash';
const defaultProxy = process.env.SUNCODE_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';

const providerApiKeys: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const defaultOptions: RunnerOptions = {
  agent: process.env.HARBOR_AGENT || 'suncode_agent:SunCodeAgent',
  agentTimeoutMultiplier: process.env.HARBOR_AGENT_TIMEOUT_MULTIPLIER || '2',
  attempts: process.env.HARBOR_ATTEMPTS || '1',
  concurrency: process.env.HARBOR_CONCURRENCY || '1',
  dataset: process.env.HARBOR_DATASET || 'terminal-bench/terminal-bench-2',
  dryRun: false,
  environment: process.env.HARBOR_ENV || 'docker',
  envFile: process.env.HARBOR_ENV_FILE,
  extraArgs: [],
  jobsDir: process.env.HARBOR_JOBS_DIR || 'jobs/terminal-bench',
  model: defaultModel,
  provider: parseProvider(process.env.SUNCODE_PROVIDER || providerFromModel(defaultModel)),
  proxy: defaultProxy,
 quiet: false,
  task: process.env.HARBOR_TASK ? [process.env.HARBOR_TASK] : [],
  excludeTask: process.env.HARBOR_EXCLUDE_TASK ? [process.env.HARBOR_EXCLUDE_TASK] : [],
  taskLimit: process.env.HARBOR_TASK_LIMIT,
};

function parseProvider(value: string): Provider {
  if (value === 'anthropic' || value === 'deepseek' || value === 'google' || value === 'openai') {
    return value;
  }
  throw new Error(`Unsupported provider: ${value}`);
}

function providerFromModel(model: string): Provider {
  const separator = model.indexOf('/');
  return parseProvider(separator >= 0 ? model.slice(0, separator) : 'deepseek');
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = { ...defaultOptions, extraArgs: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options.extraArgs = argv.slice(index + 1);
      break;
    }
    if (arg === '--agent') {
      options.agent = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--agent-timeout-multiplier') {
      options.agentTimeoutMultiplier = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--provider') {
      options.provider = parseProvider(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === '--model') {
      options.model = takeValue(argv, index, arg);
      options.provider = providerFromModel(options.model);
      index += 1;
    } else if (arg === '--dataset') {
      options.dataset = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--env') {
      options.environment = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--env-file') {
      options.envFile = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--jobs-dir') {
      options.jobsDir = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--concurrency') {
      options.concurrency = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--attempts') {
      options.attempts = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--task') {
      options.task.push(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === '--exclude-task') {
      options.excludeTask.push(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === '--task-limit') {
      options.taskLimit = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--proxy') {
      options.proxy = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--no-proxy') {
      options.proxy = '';
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.model === defaultOptions.model) {
      // First bare positional argument is treated as the model, mirroring the
      // `harbor run ... <model>` shorthand.
      options.model = arg;
      options.provider = providerFromModel(arg);
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return options;
}

function buildHarborArgs(options: RunnerOptions, proxyOverlayPath?: string): string[] {
  const args = [
    'run',
    '--dataset',
    options.dataset,
    '--agent',
    options.agent,
    '--model',
    options.model,
    '--env',
    options.environment,
    '--jobs-dir',
    options.jobsDir,
    '--n-attempts',
    options.attempts,
    '--n-concurrent',
    options.concurrency,
    '--agent-timeout-multiplier',
    options.agentTimeoutMultiplier,
    '--yes',
  ];

  if (options.agent === 'suncode_agent:SunCodeAgent') {
    args.push('--agent-env', `SUNCODE_REPO_ROOT=${process.cwd()}`);
    args.push('--agent-env', `SUNCODE_PROVIDER=${options.provider}`);
    args.push('--agent-env', `SUNCODE_MODEL=${modelForSunCode(options.model, options.provider)}`);
    const apiKey = loadApiKey(providerApiKeys[options.provider], options.provider);
    if (apiKey) {
      args.push('--agent-env', `${providerApiKeys[options.provider]}=${apiKey}`);
    }
    if (options.proxy) {
      args.push('--agent-env', `HTTP_PROXY=${options.proxy}`);
      args.push('--agent-env', `HTTPS_PROXY=${options.proxy}`);
      args.push('--agent-env', `ALL_PROXY=${options.proxy}`);
    }
  }

  if (options.proxy) {
    const verifierProxy = proxyForDocker(options.proxy);
    args.push('--verifier-env', `HTTP_PROXY=${verifierProxy}`);
    args.push('--verifier-env', `HTTPS_PROXY=${verifierProxy}`);
    args.push('--verifier-env', `ALL_PROXY=${verifierProxy}`);
    args.push('--verifier-env', `http_proxy=${verifierProxy}`);
    args.push('--verifier-env', `https_proxy=${verifierProxy}`);
    args.push('--verifier-env', `all_proxy=${verifierProxy}`);
  }

  for (const task of options.task) {
    args.push('--include-task-name', task);
  }
  for (const task of options.excludeTask) {
    args.push('--exclude-task-name', task);
  }
  if (options.taskLimit !== undefined) {
    args.push('--n-tasks', options.taskLimit);
  }
  if (options.quiet) {
    args.push('--quiet');
  }
  if (options.envFile !== undefined) {
    args.push('--env-file', options.envFile);
  }
  if (proxyOverlayPath !== undefined) {
    args.push('--extra-docker-compose', proxyOverlayPath);
  }

  return args.concat(options.extraArgs);
}

function buildEnv(options: RunnerOptions): NodeJS.ProcessEnv {
  const harborPath = resolve('harbor');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: [harborPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };

  if (options.proxy) {
    env.HTTP_PROXY = options.proxy;
    env.HTTPS_PROXY = options.proxy;
    env.ALL_PROXY = options.proxy;
    env.http_proxy = options.proxy;
    env.https_proxy = options.proxy;
    env.all_proxy = options.proxy;
    env.NO_PROXY = env.NO_PROXY || 'localhost,127.0.0.1,::1';
  }

  return env;
}

function modelForSunCode(model: string, provider: Provider): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function proxyForDocker(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') {
      url.hostname = 'host.docker.internal';
      return url.toString();
    }
  } catch {
    return proxy;
  }
  return proxy;
}

async function writeProxyComposeOverlay(options: RunnerOptions): Promise<string | undefined> {
  if (!options.proxy || options.environment !== 'docker') {
    return undefined;
  }

  const dockerProxy = proxyForDocker(options.proxy);
  const noProxy = 'localhost,127.0.0.1,::1';
  const overlayPath = resolve(tmpdir(), 'suncode-terminal-bench-proxy.compose.yml');
  const content = [
    'services:',
    '  main:',
    '    environment:',
    `      HTTP_PROXY: ${JSON.stringify(dockerProxy)}`,
    `      HTTPS_PROXY: ${JSON.stringify(dockerProxy)}`,
    `      ALL_PROXY: ${JSON.stringify(dockerProxy)}`,
    `      http_proxy: ${JSON.stringify(dockerProxy)}`,
    `      https_proxy: ${JSON.stringify(dockerProxy)}`,
    `      all_proxy: ${JSON.stringify(dockerProxy)}`,
    `      NO_PROXY: ${JSON.stringify(noProxy)}`,
    `      no_proxy: ${JSON.stringify(noProxy)}`,
    '',
  ].join('\n');

  await mkdir(dirname(overlayPath), { recursive: true });
  await writeFile(overlayPath, content, 'utf8');
  return overlayPath;
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
  bun run test:terminal-bench -- [options] [model] [-- extra harbor args]

A bare positional argument is shorthand for --model, mirroring harbor run:
  bun run test:terminal-bench -- --dataset terminal-bench-sample@2.0 deepseek/deepseek-v4-flash

Defaults to SunCode on the official Terminal-Bench dataset:
  harbor run -d terminal-bench/terminal-bench-2 -a suncode_agent:SunCodeAgent

Options:
  --agent <name>          Harbor agent (default: suncode_agent:SunCodeAgent)
  --agent-timeout-multiplier <n>
                          Harbor agent timeout multiplier (default: ${defaultOptions.agentTimeoutMultiplier})
  --provider <name>       deepseek | anthropic | openai | google (default: from model)
  --model <name>          Harbor model (default: deepseek/deepseek-v4-flash)
  --dataset <name>        Harbor dataset (default: terminal-bench/terminal-bench-2)
  --env <name>            Harbor environment (default: docker)
  --env-file <path>       Optional Harbor env file
  --jobs-dir <path>       Harbor jobs output directory (default: jobs/terminal-bench)
  --concurrency <n>       Harbor concurrent trials (default: 1)
  --attempts <n>          Attempts per trial (default: 1)
  --task <name>           Run a single task from the dataset (passes --include-task-name to harbor)
  --exclude-task <name>   Exclude a task from the dataset (passes --exclude-task-name to harbor)
  --task-limit <n>        Limit number of dataset tasks
  --proxy <url>           Proxy for Harbor network calls (default: ${defaultProxy})
  --no-proxy              Disable proxy injection
  --quiet                 Pass Harbor quiet mode
  --dry-run               Print the harbor command without running it
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const proxyOverlayPath = await writeProxyComposeOverlay(options);
  const harborArgs = buildHarborArgs(options, proxyOverlayPath);
  const command = ['harbor', ...harborArgs].map(maskSensitiveArg).map(quoteArg).join(' ');
  console.error(`[terminal-bench] ${command}`);
  if (options.proxy) {
    console.error(`[terminal-bench] proxy=${options.proxy}`);
  }

  if (options.dryRun) {
    return;
  }

  const child = spawn('harbor', harborArgs, {
    env: buildEnv(options),
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
  console.error(`[terminal-bench] ${message}`);
  process.exit(1);
});
