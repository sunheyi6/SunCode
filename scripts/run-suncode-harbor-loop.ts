import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type {
  AppSettings,
  Message,
  ToolCallContent,
  ToolResult,
} from '@shared/types';
import { runAgentLoop } from '../src/worker/agent/agent-loop';
import { createDefaultStopHookRegistry } from '../src/worker/agent/stop-hooks';
import { createModelRegistry } from '../src/worker/models/registry';
import { BaseTool, obj, p } from '../src/worker/tools/types';

interface RemoteExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

class RemoteExecutor {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async exec(command: string, timeoutMs?: number): Promise<RemoteExecResult> {
    const response = await fetch(`${this.url}/exec`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ command, timeoutMs }),
    });
    const payload = (await response.json()) as Partial<RemoteExecResult> & { error?: string };
    if (!response.ok) {
      return {
        stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
        stderr:
          typeof payload.error === 'string'
            ? payload.error
            : typeof payload.stderr === 'string'
              ? payload.stderr
              : `Harbor tool executor returned HTTP ${response.status}`,
        exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : 1,
      };
    }
    return {
      stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
      stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
      exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
    };
  }
}

abstract class HarborTool extends BaseTool {
  constructor(
    protected readonly executor: RemoteExecutor,
    protected readonly workdir: string,
  ) {
    super();
  }

  protected remotePath(path: string): string {
    if (!path || path === '.') return this.workdir;
    if (path.startsWith('/')) return path;
    return `${this.workdir.replace(/\/$/, '')}/${path}`;
  }

  protected shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  protected formatExec(command: string, result: RemoteExecResult): ToolResult {
    const combined = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : '']
      .filter(Boolean)
      .join('\n');
    const details = {
      type: 'command' as const,
      command,
      cwd: this.workdir,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    if (result.exitCode === 0) return this.success(combined || '(no output)', details);
    return this.failure(`Command exited ${result.exitCode ?? 'unknown'}`, details);
  }
}

class HarborBashTool extends HarborTool {
  readonly name = 'bash';
  readonly description = 'Run a shell command inside the Terminal-Bench container.';
  readonly parameters = obj(
    {
      command: p('string', 'Shell command to execute.'),
      description: p('string', 'Brief description of why this command is being run.'),
      run_in_background: p('boolean', 'Ignored in Harbor mode; commands run in foreground.'),
      timeout_ms: p('integer', 'Optional timeout hint. Harbor controls the actual timeout.'),
    },
    ['command'],
  );

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = typeof params.command === 'string' ? params.command : '';
    if (!command.trim()) return this.failure('command is required');
    const timeoutMs = typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined;
    const wrapped = `cd ${this.shellQuote(this.workdir)} && ${command}`;
    try {
      return this.formatExec(command, await this.executor.exec(wrapped, timeoutMs));
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

class HarborReadTool extends HarborTool {
  readonly name = 'read';
  readonly description = 'Read a file or list a directory inside the Terminal-Bench container.';
  readonly isReadonly = true;
  readonly parameters = obj(
    {
      file_path: p('string', 'File or directory path to read. Relative paths are resolved under /app.'),
      offset: p('integer', 'Optional 1-based line offset for files.'),
      limit: p('integer', 'Optional maximum number of lines for files.'),
    },
    ['file_path'],
  );

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.remotePath(String(params.file_path ?? ''));
    const offset = Number.isInteger(params.offset) ? Number(params.offset) : 1;
    const limit = Number.isInteger(params.limit) ? Number(params.limit) : 240;
    const command = [
      `target=${this.shellQuote(filePath)}`,
      `offset=${Math.max(1, offset)}`,
      `limit=${Math.max(1, limit)}`,
      'if [ -d "$target" ]; then',
      '  ls -1A "$target" | sort',
      'else',
      '  awk -v start="$offset" -v limit="$limit" \'NR >= start && NR < start + limit { printf "%6d\\t%s\\n", NR, $0 }\' "$target"',
      'fi',
    ].join('\n');
    try {
      return this.formatExec(`read ${filePath}`, await this.executor.exec(command));
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

class HarborWriteTool extends HarborTool {
  readonly name = 'write';
  readonly description = 'Write a file inside the Terminal-Bench container.';
  readonly parameters = obj(
    {
      file_path: p('string', 'Target file path. Relative paths are resolved under /app.'),
      content: p('string', 'Full file content to write.'),
    },
    ['file_path', 'content'],
  );

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.remotePath(String(params.file_path ?? ''));
    const content = typeof params.content === 'string' ? params.content : '';
    try {
      const prepareCommand = [
        `target=${this.shellQuote(filePath)}`,
        'command -v base64 >/dev/null 2>&1 || { echo "base64 is required for write" >&2; exit 127; }',
        'dir=$(dirname "$target")',
        'mkdir -p "$dir"',
        ': > "$target"',
      ].join('\n');
      const prepared = await this.executor.exec(prepareCommand);
      if (prepared.exitCode !== 0) return this.formatExec(`write ${filePath}`, prepared);

      const bytes = Buffer.from(content, 'utf8');
      const chunkSize = 18_000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
        const appendCommand = `printf %s ${this.shellQuote(chunk.toString('base64'))} | base64 -d >> ${this.shellQuote(filePath)}`;
        const appended = await this.executor.exec(appendCommand);
        if (appended.exitCode !== 0) return this.formatExec(`write ${filePath}`, appended);
      }
      return this.success(`wrote ${filePath} (${bytes.length} bytes)`, {
        type: 'command',
        command: `write ${filePath}`,
        cwd: this.workdir,
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

class HarborEditTool extends HarborTool {
  readonly name = 'edit';
  readonly description = 'Edit a file inside the Terminal-Bench container by exact string replacement.';
  readonly parameters = obj(
    {
      file_path: p('string', 'Target file path. Relative paths are resolved under /app.'),
      old_string: p('string', 'Exact text to replace.'),
      new_string: p('string', 'Replacement text.'),
    },
    ['file_path', 'old_string', 'new_string'],
  );

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.remotePath(String(params.file_path ?? ''));
    const oldString = typeof params.old_string === 'string' ? params.old_string : '';
    const newString = typeof params.new_string === 'string' ? params.new_string : '';
    if (!oldString) return this.failure('old_string is required');
    const command = [
      `target=${this.shellQuote(filePath)}`,
      `OLD_B64=${this.shellQuote(Buffer.from(oldString, 'utf8').toString('base64'))}`,
      `NEW_B64=${this.shellQuote(Buffer.from(newString, 'utf8').toString('base64'))}`,
      'if command -v python3 >/dev/null 2>&1; then',
      '  py=python3',
      'elif command -v python >/dev/null 2>&1; then',
      '  py=python',
      'else',
      '  echo "python3 or python is required for edit" >&2',
      '  exit 127',
      'fi',
      `"$py" - "$target" <<'PYEOF'
import base64
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
old_text = base64.b64decode(os.environ["OLD_B64"]).decode("utf-8")
new_text = base64.b64decode(os.environ["NEW_B64"]).decode("utf-8")
text = path.read_text(encoding="utf-8")
if old_text not in text:
    raise SystemExit("old_string not found")
path.write_text(text.replace(old_text, new_text, 1), encoding="utf-8")
print(f"edited {path}")
PYEOF`,
    ].join('\n');
    try {
      return this.formatExec(`edit ${filePath}`, await this.executor.exec(command));
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

class HarborLsTool extends HarborTool {
  readonly name = 'ls';
  readonly description = 'List a directory inside the Terminal-Bench container.';
  readonly isReadonly = true;
  readonly parameters = obj({ path: p('string', 'Directory path to list.') }, []);

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const path = this.remotePath(String(params.path ?? '.'));
    const command = `ls -la ${this.shellQuote(path)}`;
    try {
      return this.formatExec(command, await this.executor.exec(command));
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

class HarborGrepTool extends HarborTool {
  readonly name = 'grep';
  readonly description = 'Search text recursively inside the Terminal-Bench container.';
  readonly isReadonly = true;
  readonly parameters = obj(
    {
      pattern: p('string', 'Regular expression to search for.'),
      path: p('string', 'Directory or file to search. Defaults to /app.'),
    },
    ['pattern'],
  );

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(params.pattern ?? '');
    const path = this.remotePath(String(params.path ?? '.'));
    const command = `grep -RIn --exclude-dir=.git -- ${this.shellQuote(pattern)} ${this.shellQuote(path)} | head -200`;
    try {
      return this.formatExec(command, await this.executor.exec(command));
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

class HarborGlobTool extends HarborTool {
  readonly name = 'glob';
  readonly description = 'Find files by glob-like basename pattern inside the Terminal-Bench container.';
  readonly isReadonly = true;
  readonly parameters = obj(
    {
      pattern: p('string', 'File pattern such as *.py or **/*.js.'),
      path: p('string', 'Directory to search. Defaults to /app.'),
    },
    ['pattern'],
  );

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const pattern = basename(String(params.pattern ?? '*')) || '*';
    const path = this.remotePath(String(params.path ?? '.'));
    const command = `find ${this.shellQuote(path)} -type f -name ${this.shellQuote(pattern)} | head -500`;
    try {
      return this.formatExec(command, await this.executor.exec(command));
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

class HarborFindTool extends HarborTool {
  readonly name = 'find';
  readonly description = 'Find files or directories by name inside the Terminal-Bench container.';
  readonly isReadonly = true;
  readonly parameters = obj(
    {
      name: p('string', 'Name pattern to find.'),
      path: p('string', 'Directory to search. Defaults to /app.'),
    },
    ['name'],
  );

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const name = String(params.name ?? '*');
    const path = this.remotePath(String(params.path ?? '.'));
    const command = `find ${this.shellQuote(path)} -name ${this.shellQuote(name)} | head -500`;
    try {
      return this.formatExec(command, await this.executor.exec(command));
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

function providerFromModel(model: string): string {
  if (model.includes('/')) return model.split('/')[0] || 'deepseek';
  if (model.startsWith('gpt-') || model.startsWith('o')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  return 'deepseek';
}

function stripProvider(model: string, provider: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const MAX_FINAL_TEXT_LENGTH = 32_000;
const MAX_LOG_STRING_LENGTH = 1_000;
const MAX_LOG_ARRAY_ITEMS = 20;
const MAX_LOG_OBJECT_KEYS = 80;
const MAX_LOG_DEPTH = 5;

function appendCappedText(current: string, next: string, maxLength = MAX_FINAL_TEXT_LENGTH): string {
  if (!next) return current;
  const combined = current + next;
  if (combined.length <= maxLength) return combined;
  return `${combined.slice(0, maxLength)}\n\n[truncated final text ${combined.length - maxLength} chars]`;
}

function compactLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_LOG_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_LOG_STRING_LENGTH)}\n[truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`;
  }

  if (typeof value !== 'object' || value === null) return value;

  if (depth >= MAX_LOG_DEPTH) return '[truncated nested value]';

  if (Array.isArray(value)) {
    const compacted = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => compactLogValue(item, depth + 1));
    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      compacted.push(`[truncated ${value.length - MAX_LOG_ARRAY_ITEMS} items]`);
    }
    return compacted;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
    output[key] = compactLogValue(item, depth + 1);
  }
  if (entries.length > MAX_LOG_OBJECT_KEYS) {
    output.__truncatedKeys = entries.length - MAX_LOG_OBJECT_KEYS;
  }
  return output;
}

function terminalBenchInstructions(extraSystemPrompt: string): string {
  return [
    extraSystemPrompt,
    'You are running inside Harbor Terminal-Bench.',
    'Your tools operate inside the benchmark container, normally with /app as the working directory.',
    'Edit files in the container and run the task tests or the closest available verification before stopping.',
    'Do not stop after only exploring the repository. Continue until you have implemented and verified a solution.',
    'When the task is finished, respond with a concise final summary.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function tokenSummaryFrom(usage: { input: number; output: number; total: number }): {
  input: number;
  output: number;
  cachedInput: number;
  total: number;
  costUsd: number;
} {
  return {
    input: usage.input,
    output: usage.output,
    cachedInput: Math.max(0, usage.total - usage.input - usage.output),
    total: usage.total,
    costUsd: 0,
  };
}

async function main(): Promise<void> {
  const instructionFile = process.env.SUNCODE_INSTRUCTION_FILE;
  const instruction = process.env.SUNCODE_INSTRUCTION
    ? process.env.SUNCODE_INSTRUCTION
    : instructionFile
      ? await readFile(instructionFile, 'utf8')
      : '';
  if (!instruction.trim()) {
    throw new Error('SUNCODE_INSTRUCTION or SUNCODE_INSTRUCTION_FILE is required');
  }

  const outputDir = process.env.SUNCODE_OUTPUT_DIR || join(process.cwd(), 'agent');
  const storageRoot = process.env.SUNCODE_STORAGE_ROOT || join(outputDir, 'suncode-storage');
  await mkdir(outputDir, { recursive: true });
  await mkdir(storageRoot, { recursive: true });
  process.env.SUNCODE_APP_DATA = storageRoot;

  const executorUrl = process.env.SUNCODE_HARBOR_TOOL_EXECUTOR_URL;
  const executorToken = process.env.SUNCODE_HARBOR_TOOL_EXECUTOR_TOKEN;
  if (!executorUrl || !executorToken) {
    throw new Error('SUNCODE_HARBOR_TOOL_EXECUTOR_URL and SUNCODE_HARBOR_TOOL_EXECUTOR_TOKEN are required');
  }

  const workdir = process.env.SUNCODE_WORKDIR || '/app';
  const rawModel = process.env.SUNCODE_MODEL || 'deepseek-v4-flash';
  const provider = process.env.SUNCODE_PROVIDER || providerFromModel(rawModel);
  const modelId = stripProvider(rawModel, provider);
  const registry = createModelRegistry();
  const model = await registry.getModel(provider, modelId);
  if (!model) throw new Error(`Model not available: ${provider}/${modelId}`);

  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    activeProvider: provider,
    activeModel: modelId,
    maxTurns: positiveInt(process.env.SUNCODE_MAX_TURNS, 200),
    permissionMode: 'full_access',
    autoCompact: true,
    envApiKeys: {},
  };

  const executor = new RemoteExecutor(executorUrl, executorToken);
  const tools = [
    new HarborBashTool(executor, workdir),
    new HarborReadTool(executor, workdir),
    new HarborWriteTool(executor, workdir),
    new HarborEditTool(executor, workdir),
    new HarborLsTool(executor, workdir),
    new HarborGrepTool(executor, workdir),
    new HarborGlobTool(executor, workdir),
    new HarborFindTool(executor, workdir),
  ];

  const runId = randomUUID();
  const sessionId = process.env.SUNCODE_SESSION_ID || randomUUID();
  const runtimeEventsPath = join(outputDir, 'runtime-events.jsonl');
  const streamEventsPath = join(outputDir, 'stream-events.jsonl');
  await writeFile(runtimeEventsPath, '', 'utf8');
  await writeFile(streamEventsPath, '', 'utf8');

  let toolStartedCount = 0;
  let finalText = '';
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: instruction }] }];

  const result = await runAgentLoop({
    model,
    messages,
    tools,
    settings,
    workingDir: workdir,
    skillsContent: '',
    agentsMdContent: terminalBenchInstructions(process.env.SUNCODE_SYSTEM_PROMPT || ''),
    memoryContent: '',
    relevantLessonsContent: '',
    abortSignal: new AbortController().signal,
    runId,
    sessionId,
    onStream: (event) => {
      appendFileSync(streamEventsPath, `${JSON.stringify(compactLogValue(event))}\n`, 'utf8');
      if (event.type === 'message' && typeof event.content === 'string') {
        finalText = appendCappedText(finalText, event.content);
      }
    },
    onToolStart: () => undefined,
    onToolEnd: () => undefined,
    onToolProgress: () => undefined,
    onRunEvent: (event) => {
      const stamped = { ...event, timestamp: event.timestamp || new Date().toISOString() };
      appendFileSync(runtimeEventsPath, `${JSON.stringify(compactLogValue(stamped))}\n`, 'utf8');
      if (event.type === 'tool_started') {
        toolStartedCount += 1;
      }
    },
    initialTurnCount: 0,
    stopHooks: createDefaultStopHookRegistry(),
  });

  const fallbackFinalText = JSON.stringify(result.finalMessage.content);
  const outputFinalText = finalText || appendCappedText('', fallbackFinalText);
  await writeFile(
    join(outputDir, 'cell-output.json'),
    JSON.stringify(
      {
        status: 'ok',
        errorClass: null,
        steps: result.turnCount,
        tokenSummary: tokenSummaryFrom(result.tokenUsage),
        toolSummary: {
          actualToolCalls: toolStartedCount,
          requestedToolCalls: toolStartedCount,
        },
        runtimeRefs: { runId, sessionId },
        runtimeEventsPath,
        finalText: outputFinalText,
        decision: result.decision,
      },
      null,
      2,
    ),
    'utf8',
  );
}

main().catch(async (error) => {
  const outputDir = process.env.SUNCODE_OUTPUT_DIR || join(process.cwd(), 'agent');
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, 'cell-output.json'),
    JSON.stringify(
      {
        status: 'error',
        errorClass: error instanceof Error ? error.name : 'Error',
        errorMessage: error instanceof Error ? error.message : String(error),
        steps: 0,
        tokenSummary: { input: 0, output: 0, cachedInput: 0, total: 0, costUsd: 0 },
        toolSummary: { actualToolCalls: 0, requestedToolCalls: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );
  console.error(error);
  process.exit(1);
});
