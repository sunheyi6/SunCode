# Chat Tool Operation Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every file edit and shell command inside its assistant chat message, including file status, `+added/-removed` line counts, and collapsible command details that survive session reloads.

**Architecture:** Built-in tools will return typed metadata in `ToolResult.details`. The agent loop will forward complete tool calls at start, attach results at completion, and include all calls in the final assistant message. The renderer chat store will own live and persisted tool state, while focused Vue components render file cards, collapsed command cards, and a generic fallback.

**Tech Stack:** Electron, Vue 3, Pinia, TypeScript, Bun test runner, Biome, Vite.

---

## Working-tree constraint

The checkout already contains unrelated uncommitted changes, including changes in several files touched by this feature. Before every edit:

```powershell
git diff -- <target-file>
```

Preserve those changes and patch only the relevant sections. Stage and commit only the files listed by the current task.

## File map

- `src/shared/types.ts`: shared structured result and tool-call execution types.
- `src/worker/tools/line-diff.ts`: pure line-counting function.
- `src/worker/tools/line-diff.test.ts`: Bun tests for line counting.
- `src/worker/tools/types.ts`: allow success/failure helpers to carry structured details.
- `src/worker/tools/edit.ts`: return file path, status, and line counts.
- `src/worker/tools/write.ts`: distinguish create/overwrite and return line counts.
- `src/worker/tools/bash.ts`: return command, cwd, stdout, stderr, exit code, and signal.
- `src/worker/agent/agent-loop.ts`: emit complete tool-call starts, attach results, and retain all tool calls.
- `src/worker/agent/agent.ts`: forward full tool-call start objects.
- `src/worker/agent-worker.ts`: forward the widened event through the worker boundary.
- `src/main/ipc-handlers.ts`: forward the widened event through Electron IPC.
- `src/main/preload.ts`, `src/renderer/api/bridge.ts`, `src/renderer/types/ipc.ts`: expose the widened event safely.
- `src/renderer/stores/chat.ts`: bind starts/results to the active message and save only the completed message.
- `src/renderer/composables/useAgent.ts`: route tool events into the chat store.
- `src/renderer/utils/tool-presentation.ts`: parse arguments and derive UI labels without coupling tests to Vue.
- `src/renderer/utils/tool-presentation.test.ts`: Bun tests for presentation fallback behavior.
- `src/renderer/components/tools/FileOperationCard.vue`: compact always-visible file operation.
- `src/renderer/components/tools/CommandOperationCard.vue`: command details, closed by default.
- `src/renderer/components/tools/ToolOperationList.vue`: select specialized or fallback rendering.
- `src/renderer/components/chat/AssistantMessage.vue`: render the operation list.
- `package.json`: add a repeatable unit-test script.

### Task 1: Add shared structured tool execution types

**Files:**

- Modify: `src/shared/types.ts`
- Modify: `src/worker/tools/types.ts`

- [ ] **Step 1: Add a compile-time failing use site**

Temporarily add the following assignment immediately after `ToolResult` in
`src/shared/types.ts`:

```ts
const toolResultTypeCheck: ToolResult = {
  toolCallId: 'call-1',
  name: 'edit',
  success: true,
  output: '',
  details: {
    type: 'file_edit',
    filePath: 'src/example.ts',
    status: 'edited',
    addedLines: 2,
    removedLines: 1,
  },
};
void toolResultTypeCheck;
```

- [ ] **Step 2: Run typecheck and verify RED**

Run:

```powershell
bun run typecheck
```

Expected: failure because `details` is not a property of `ToolResult`.

- [ ] **Step 3: Define the production types**

Add before `ToolResult`:

```ts
export type FileEditStatus = 'editing' | 'edited' | 'failed';

export interface FileEditDetails {
  type: 'file_edit';
  filePath: string;
  status: FileEditStatus;
  addedLines?: number;
  removedLines?: number;
  error?: string;
}

export interface CommandDetails {
  type: 'command';
  command: string;
  cwd: string;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
}

export type ToolResultDetails = FileEditDetails | CommandDetails;
export type ToolExecutionStatus = 'running' | 'done' | 'error';
```

Extend `ToolCallContent`:

```ts
export interface ToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: string;
  status?: ToolExecutionStatus;
  result?: ToolResult;
}
```

Extend `ToolResult`:

```ts
export interface ToolResult {
  toolCallId: string;
  name: string;
  success: boolean;
  output: string;
  error?: string;
  details?: ToolResultDetails;
}
```

Change the worker event so start events carry the arguments needed for the live card:

```ts
| { type: 'toolStart'; toolCall: ToolCallContent }
```

Change the callback signature:

```ts
onToolStart: (toolCall: ToolCallContent) => void;
```

In `src/worker/tools/types.ts`, update the helpers:

```ts
protected success(output: string, details?: ToolResult['details']): ToolResult {
  return {
    toolCallId: '',
    name: this.name,
    success: true,
    output,
    details,
  };
}

protected failure(error: string, details?: ToolResult['details']): ToolResult {
  return {
    toolCallId: '',
    name: this.name,
    success: false,
    error,
    output: '',
    details,
  };
}
```

- [ ] **Step 4: Remove the temporary assignment and verify GREEN**

Run:

```powershell
bun run typecheck
```

Expected: no TypeScript errors caused by the new types. Existing callback errors are acceptable only until Task 4; record them before continuing.

- [ ] **Step 5: Commit only the type changes**

```powershell
git add -- src/shared/types.ts src/worker/tools/types.ts
git commit -m "feat(shared): type tool operation details"
```

### Task 2: Calculate added and removed lines

**Files:**

- Create: `src/worker/tools/line-diff.ts`
- Create: `src/worker/tools/line-diff.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the failing unit tests**

Create `src/worker/tools/line-diff.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { countLineChanges } from './line-diff';

describe('countLineChanges', () => {
  test('counts all lines in a new file as additions', () => {
    expect(countLineChanges('', 'one\ntwo\n')).toEqual({ addedLines: 2, removedLines: 0 });
  });

  test('counts a changed line as one removal and one addition', () => {
    expect(countLineChanges('one\ntwo\nthree', 'one\nTWO\nthree')).toEqual({
      addedLines: 1,
      removedLines: 1,
    });
  });

  test('counts inserted and deleted lines around unchanged lines', () => {
    expect(countLineChanges('a\nb\nc\nd', 'a\nx\nc\ny')).toEqual({
      addedLines: 2,
      removedLines: 2,
    });
  });

  test('treats empty text as zero lines', () => {
    expect(countLineChanges('', '')).toEqual({ addedLines: 0, removedLines: 0 });
  });

  test('ignores one trailing line break when counting logical lines', () => {
    expect(countLineChanges('a\nb', 'a\nb\n')).toEqual({ addedLines: 0, removedLines: 0 });
  });
});
```

Add to `package.json` scripts:

```json
"test": "bun test",
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
bun test src/worker/tools/line-diff.test.ts
```

Expected: failure because `./line-diff` does not exist.

- [ ] **Step 3: Implement the minimal pure function**

Create `src/worker/tools/line-diff.ts`:

```ts
export interface LineChanges {
  addedLines: number;
  removedLines: number;
}

function splitLogicalLines(content: string): string[] {
  if (!content) return [];
  return content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

export function countLineChanges(oldContent: string, newContent: string): LineChanges {
  const oldLines = splitLogicalLines(oldContent);
  const newLines = splitLogicalLines(newContent);
  const lcs = Array.from({ length: newLines.length + 1 }, () => 0);

  for (const oldLine of oldLines) {
    let diagonal = 0;
    for (let index = 1; index <= newLines.length; index += 1) {
      const previous = lcs[index];
      if (oldLine === newLines[index - 1]) {
        lcs[index] = diagonal + 1;
      } else {
        lcs[index] = Math.max(lcs[index], lcs[index - 1]);
      }
      diagonal = previous;
    }
  }

  const unchangedLines = lcs[newLines.length];
  return {
    addedLines: newLines.length - unchangedLines,
    removedLines: oldLines.length - unchangedLines,
  };
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
bun test src/worker/tools/line-diff.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Run formatting and commit**

```powershell
bunx biome format --write src/worker/tools/line-diff.ts src/worker/tools/line-diff.test.ts package.json
git add -- package.json src/worker/tools/line-diff.ts src/worker/tools/line-diff.test.ts
git commit -m "test(worker): cover file line change counts"
```

### Task 3: Return structured details from edit, write, and bash

**Files:**

- Create: `src/worker/tools/file-tools.test.ts`
- Create: `src/worker/tools/bash.test.ts`
- Modify: `src/worker/tools/edit.ts`
- Modify: `src/worker/tools/write.ts`
- Modify: `src/worker/tools/bash.ts`

- [ ] **Step 1: Add failing file-tool tests**

Create `src/worker/tools/file-tools.test.ts` using temporary directories:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEditTool } from './edit';
import { createWriteTool } from './write';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'suncode-tools-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('file tool details', () => {
  test('edit reports the path and changed line counts', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'sample.ts');
    await writeFile(filePath, 'one\ntwo\nthree\n');

    const result = await createEditTool(dir).execute({
      file_path: filePath,
      old_string: 'two',
      new_string: 'TWO',
    });

    expect(result.details).toEqual({
      type: 'file_edit',
      filePath,
      status: 'edited',
      addedLines: 1,
      removedLines: 1,
    });
  });

  test('edit failure retains the target path and reason', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'sample.ts');
    await writeFile(filePath, 'one\n');

    const result = await createEditTool(dir).execute({
      file_path: filePath,
      old_string: 'missing',
      new_string: 'replacement',
    });

    expect(result.success).toBe(false);
    expect(result.details).toMatchObject({
      type: 'file_edit',
      filePath,
      status: 'failed',
    });
  });

  test('write reports all lines when creating a file', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'created.ts');
    const result = await createWriteTool(dir).execute({
      file_path: filePath,
      content: 'one\ntwo\n',
    });

    expect(await readFile(filePath, 'utf-8')).toBe('one\ntwo\n');
    expect(result.details).toEqual({
      type: 'file_edit',
      filePath,
      status: 'edited',
      addedLines: 2,
      removedLines: 0,
    });
  });

  test('write compares old and replacement content', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'replaced.ts');
    await writeFile(filePath, 'one\ntwo\n');

    const result = await createWriteTool(dir).execute({
      file_path: filePath,
      content: 'one\nthree\n',
    });

    expect(result.details).toMatchObject({ addedLines: 1, removedLines: 1 });
  });
});
```

- [ ] **Step 2: Run file-tool tests and verify RED**

Run:

```powershell
bun test src/worker/tools/file-tools.test.ts
```

Expected: assertions fail because `result.details` is undefined.

- [ ] **Step 3: Implement structured file results**

In both tools, create the normalized target path before validation failures whenever a path exists.

In `edit.ts`, read `content`, produce `newContent`, call `countLineChanges(content, newContent)`,
write the file, and return:

```ts
const changes = countLineChanges(content, newContent);
return this.success(
  `Edit applied to ${normalized}\n${replacementCount} replacement(s) made.`,
  {
    type: 'file_edit',
    filePath: normalized,
    status: 'edited',
    ...changes,
  },
);
```

Use this failure shape for all failures that have a known target:

```ts
return this.failure(message, {
  type: 'file_edit',
  filePath: normalized,
  status: 'failed',
  error: message,
});
```

In `write.ts`, import `readFile` and handle a missing existing file without treating it as an error:

```ts
let oldContent = '';
try {
  oldContent = await readFile(normalized, 'utf-8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

await mkdir(dirname(normalized), { recursive: true });
await writeFile(normalized, content, 'utf-8');
const changes = countLineChanges(oldContent, content);
return this.success(
  `File written successfully: ${normalized}\n${changes.addedLines} added, ${changes.removedLines} removed`,
  {
    type: 'file_edit',
    filePath: normalized,
    status: 'edited',
    ...changes,
  },
);
```

- [ ] **Step 4: Run file-tool tests and verify GREEN**

Run:

```powershell
bun test src/worker/tools/file-tools.test.ts src/worker/tools/line-diff.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 5: Add failing bash tests**

Create `src/worker/tools/bash.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createBashTool } from './bash';

describe('bash tool details', () => {
  test('returns command metadata and stdout', async () => {
    const command =
      process.platform === 'win32' ? 'echo hello' : "printf 'hello\\n'";
    const result = await createBashTool(process.cwd()).execute({ command });

    expect(result.details).toMatchObject({
      type: 'command',
      command,
      cwd: process.cwd(),
      exitCode: 0,
      stderr: '',
    });
    expect(result.details?.type === 'command' && result.details.stdout).toContain('hello');
  });

  test('retains a non-zero exit code', async () => {
    const command = process.platform === 'win32' ? 'exit /b 7' : 'exit 7';
    const result = await createBashTool(process.cwd()).execute({ command });

    expect(result.details).toMatchObject({
      type: 'command',
      command,
      exitCode: 7,
    });
  });
});
```

- [ ] **Step 6: Run bash tests and verify RED**

Run:

```powershell
bun test src/worker/tools/bash.test.ts
```

Expected: assertions fail because command details are absent.

- [ ] **Step 7: Implement structured command results**

For foreground completion, retain the existing output string and add:

```ts
resolveResult(
  this.success(parts.join('\n'), {
    type: 'command',
    command,
    cwd,
    exitCode: code,
    signal: signal || undefined,
    stdout: truncatedStdout,
    stderr: truncatedStderr,
  }),
);
```

For `child.on('error')`, return:

```ts
const message = `Command execution failed: ${error.message}`;
resolveResult(
  this.failure(message, {
    type: 'command',
    command,
    cwd,
    exitCode: null,
    stdout: '',
    stderr: message,
  }),
);
```

For blocked commands, missing commands, background-start success, and background-start failure, also
return `type: 'command'` details. A background start uses `exitCode: null`, empty output streams, and
includes the PID in the human-readable `output`.

- [ ] **Step 8: Run all tool tests and commit**

Run:

```powershell
bun test src/worker/tools/line-diff.test.ts src/worker/tools/file-tools.test.ts src/worker/tools/bash.test.ts
```

Expected: all tests pass.

Then:

```powershell
git add -- src/worker/tools/edit.ts src/worker/tools/write.ts src/worker/tools/bash.ts src/worker/tools/file-tools.test.ts src/worker/tools/bash.test.ts
git commit -m "feat(worker): report file and command operation details"
```

### Task 4: Carry complete tool calls through worker and IPC boundaries

**Files:**

- Modify: `src/worker/agent/agent-loop.ts`
- Modify: `src/worker/agent/agent.ts`
- Modify: `src/worker/agent-worker.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/api/bridge.ts`
- Modify: `src/renderer/types/ipc.ts`

- [ ] **Step 1: Run typecheck and capture the callback failures**

Run:

```powershell
bun run typecheck
```

Expected: failures at old `(toolCallId, toolName)` callback signatures introduced by Task 1.

- [ ] **Step 2: Accumulate and enrich calls in the agent loop**

In `AgentLoopInput`, use:

```ts
onToolStart: (toolCall: ToolCallContent) => void;
```

Before the main loop, add:

```ts
const completedToolCalls: ToolCallContent[] = [];
```

Before executing each call:

```ts
tc.status = 'running';
completedToolCalls.push(tc);
onToolStart({ ...tc });
```

After every success or failure result:

```ts
tc.status = result.success ? 'done' : 'error';
tc.result = result;
onToolEnd(result);
```

For locally-created unknown-tool and JSON-parse errors, apply the same status/result assignment.

Before every return that produces `finalMessage`, attach all accumulated calls:

```ts
finalMessage: {
  role: 'assistant',
  content: contentBlocks,
  toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
},
```

Keep intermediate `contextMessages` tool calls intact so providers continue receiving normal tool
history.

- [ ] **Step 3: Widen the Agent and worker event**

In `agent.ts`, change the field, constructor argument, and `runAgentLoop` callback to accept
`ToolCallContent`, then forward the object unchanged:

```ts
onToolStart: (toolCall) => {
  this.emitStatus('executing');
  this.onToolStart(toolCall);
},
```

In `agent-worker.ts`, post:

```ts
(toolCall) => post({ type: 'toolStart', toolCall }),
```

- [ ] **Step 4: Widen Electron IPC and renderer bridge**

In `ipc-handlers.ts`:

```ts
case 'toolStart':
  mainWindow.webContents.send('agent:tool-start', msg.toolCall);
  break;
```

Use this signature consistently in preload, renderer API declarations, and bridge:

```ts
onToolStart(callback: (toolCall: ToolCallContent) => void): () => void;
```

The preload handler receives one `ToolCallContent` object and passes it unchanged.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
bun run typecheck
```

Expected: typecheck passes, or reports only unrelated pre-existing errors documented before Task 1.

- [ ] **Step 6: Commit the event plumbing**

```powershell
git add -- src/worker/agent/agent-loop.ts src/worker/agent/agent.ts src/worker/agent-worker.ts src/main/ipc-handlers.ts src/main/preload.ts src/renderer/api/bridge.ts src/renderer/types/ipc.ts
git commit -m "feat(agent): retain tool execution history"
```

### Task 5: Bind tool state to the active chat message and persist it

**Files:**

- Create: `src/renderer/stores/tool-call-state.ts`
- Create: `src/renderer/stores/tool-call-state.test.ts`
- Modify: `src/renderer/stores/chat.ts`
- Modify: `src/renderer/composables/useAgent.ts`

- [ ] **Step 1: Add failing pure state tests**

Create `src/renderer/stores/tool-call-state.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { ToolCallContent, ToolResult } from '@shared/types';
import { completeToolCall, startToolCall } from './tool-call-state';

describe('tool call state', () => {
  test('starts a call without duplicating an existing streamed call', () => {
    const calls: ToolCallContent[] = [];
    startToolCall(calls, {
      type: 'tool_call',
      id: 'call-1',
      name: 'edit',
      arguments: '{"file_path":"src/a.ts"}',
    });
    startToolCall(calls, {
      type: 'tool_call',
      id: 'call-1',
      name: 'edit',
      arguments: '{"file_path":"src/a.ts"}',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('running');
  });

  test('attaches a result to the matching call', () => {
    const calls: ToolCallContent[] = [
      { type: 'tool_call', id: 'call-1', name: 'edit', arguments: '', status: 'running' },
    ];
    const result: ToolResult = {
      toolCallId: 'call-1',
      name: 'edit',
      success: true,
      output: '',
    };

    completeToolCall(calls, result);
    expect(calls[0]).toMatchObject({ status: 'done', result });
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
bun test src/renderer/stores/tool-call-state.test.ts
```

Expected: failure because `tool-call-state.ts` does not exist.

- [ ] **Step 3: Implement the pure state helpers**

Create `src/renderer/stores/tool-call-state.ts`:

```ts
import type { ToolCallContent, ToolResult } from '@shared/types';

export function startToolCall(calls: ToolCallContent[], incoming: ToolCallContent): void {
  const existing = calls.find((call) => call.id === incoming.id);
  if (existing) {
    existing.name = incoming.name;
    existing.arguments = incoming.arguments;
    existing.status = 'running';
    return;
  }
  calls.push({ ...incoming, status: 'running' });
}

export function completeToolCall(calls: ToolCallContent[], result: ToolResult): void {
  const existing = calls.find((call) => call.id === result.toolCallId);
  if (!existing) {
    calls.push({
      type: 'tool_call',
      id: result.toolCallId,
      name: result.name,
      arguments: '',
      status: result.success ? 'done' : 'error',
      result,
    });
    return;
  }
  existing.status = result.success ? 'done' : 'error';
  existing.result = result;
}
```

- [ ] **Step 4: Verify helper tests GREEN**

Run:

```powershell
bun test src/renderer/stores/tool-call-state.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Move live tool ownership into chat store**

In `chat.ts`:

- Remove `bridge.saveMessage(...)` from the `text_end` case.
- Add `startToolExecution(toolCall: ToolCallContent)` and
  `endToolExecution(result: ToolResult)` methods that call the pure helpers against
  `currentAssistantMsg.toolCalls`.
- Keep `toolcall_start`/`toolcall_delta` support for providers that stream tool blocks; use
  `startToolCall` to prevent duplicate calls when the worker start event arrives.
- On `done`, merge `event.message.toolCalls` by ID so the final worker message repairs any missed
  live event.
- Build and save one complete assistant message before clearing `currentAssistantMsg`:

```ts
const savedMessage: Message = {
  role: 'assistant',
  content: [
    ...(msg.thinking ? [{ type: 'thinking' as const, text: msg.thinking }] : []),
    { type: 'text' as const, text: msg.content },
  ],
  toolCalls: msg.toolCalls,
};
void bridge.saveMessage(savedMessage);
```

Expose both new methods from the store.

- [ ] **Step 6: Route IPC tool events to chat store**

In `useAgent.ts`, replace agent-store-only handling:

```ts
bridge.onToolStart((toolCall) => {
  chatStore.startToolExecution(toolCall);
  agentStore.startToolExecution(toolCall.id, toolCall.name);
});

bridge.onToolEnd((result) => {
  chatStore.endToolExecution(result);
  agentStore.endToolExecution(result);
});
```

Keep `agentStore` updates because other status UI may still consume them.

- [ ] **Step 7: Run tests and typecheck**

Run:

```powershell
bun test src/renderer/stores/tool-call-state.test.ts
bun run typecheck
```

Expected: helper tests pass and typecheck succeeds.

- [ ] **Step 8: Commit chat persistence**

```powershell
git add -- src/renderer/stores/tool-call-state.ts src/renderer/stores/tool-call-state.test.ts src/renderer/stores/chat.ts src/renderer/composables/useAgent.ts
git commit -m "feat(renderer): persist tool operations with messages"
```

### Task 6: Render file cards and collapsed command cards

**Files:**

- Create: `src/renderer/utils/tool-presentation.ts`
- Create: `src/renderer/utils/tool-presentation.test.ts`
- Create: `src/renderer/components/tools/FileOperationCard.vue`
- Create: `src/renderer/components/tools/CommandOperationCard.vue`
- Create: `src/renderer/components/tools/ToolOperationList.vue`
- Modify: `src/renderer/components/chat/AssistantMessage.vue`

- [ ] **Step 1: Add failing presentation tests**

Create `src/renderer/utils/tool-presentation.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { ToolCallContent } from '@shared/types';
import {
  commandSummary,
  fileOperationView,
  parseToolArguments,
} from './tool-presentation';

describe('tool presentation', () => {
  test('parses complete arguments and tolerates partial JSON', () => {
    expect(parseToolArguments('{"file_path":"src/a.ts"}')).toEqual({
      file_path: 'src/a.ts',
    });
    expect(parseToolArguments('{"file_path":')).toEqual({});
  });

  test('shows editing while an edit call is running', () => {
    const call: ToolCallContent = {
      type: 'tool_call',
      id: '1',
      name: 'edit',
      arguments: '{"file_path":"src/a.ts"}',
      status: 'running',
    };
    expect(fileOperationView(call)).toMatchObject({
      filePath: 'src/a.ts',
      label: '编辑中',
    });
  });

  test('uses description before a shortened command', () => {
    expect(commandSummary({ command: 'bun run build', description: '构建应用' })).toBe('构建应用');
    expect(commandSummary({ command: 'bun run build' })).toBe('bun run build');
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
bun test src/renderer/utils/tool-presentation.test.ts
```

Expected: failure because the module does not exist.

- [ ] **Step 3: Implement presentation helpers**

Create `src/renderer/utils/tool-presentation.ts` with these exports:

```ts
import type { ToolCallContent } from '@shared/types';

export function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function commandSummary(args: Record<string, unknown>): string {
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  if (description) return description;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  return command.length > 80 ? `${command.slice(0, 77)}...` : command || '执行命令';
}

export function fileOperationView(call: ToolCallContent): {
  filePath: string;
  label: '编辑中' | '已编辑' | '编辑失败';
  addedLines?: number;
  removedLines?: number;
  error?: string;
} {
  const args = parseToolArguments(call.arguments);
  const details = call.result?.details?.type === 'file_edit' ? call.result.details : undefined;
  const failed = call.status === 'error' || details?.status === 'failed';
  return {
    filePath:
      details?.filePath ||
      (typeof args.file_path === 'string' ? args.file_path : call.name),
    label: failed ? '编辑失败' : call.status === 'running' ? '编辑中' : '已编辑',
    addedLines: details?.addedLines,
    removedLines: details?.removedLines,
    error: details?.error || call.result?.error,
  };
}
```

- [ ] **Step 4: Verify presentation tests GREEN**

Run:

```powershell
bun test src/renderer/utils/tool-presentation.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Create the file operation card**

`FileOperationCard.vue` accepts one `ToolCallContent`, calls `fileOperationView`, and renders:

```vue
<template>
  <div class="file-operation" :class="statusClass">
    <span class="file-icon">▤</span>
    <span class="file-path" :title="view.filePath">{{ view.filePath }}</span>
    <span class="file-status">{{ view.label }}</span>
    <span v-if="view.addedLines !== undefined" class="added">+{{ view.addedLines }}</span>
    <span v-if="view.removedLines !== undefined" class="removed">-{{ view.removedLines }}</span>
    <p v-if="view.error" class="file-error">{{ view.error }}</p>
  </div>
</template>
```

Use scoped CSS with the project variables. Keep the path flexible with `min-width: 0`,
`overflow: hidden`, and `text-overflow: ellipsis`. Use teal for editing, green for edited, red for
failed/addition-removal accents as appropriate.

- [ ] **Step 6: Create the command operation card**

`CommandOperationCard.vue` uses a `<details class="command-operation">` element without the `open`
attribute, guaranteeing default collapse. Its summary shows the derived title, execution label, and
exit code. The body renders:

```vue
<div class="command-field">
  <span>命令</span>
  <pre><code>{{ details?.command || args.command || '' }}</code></pre>
</div>
<div class="command-meta">
  <span>工作目录：{{ details?.cwd || '等待执行' }}</span>
  <span>退出码：{{ details?.exitCode ?? '—' }}</span>
</div>
<section>
  <h4>标准输出</h4>
  <pre>{{ details?.stdout || '无输出' }}</pre>
</section>
<section v-if="details?.stderr">
  <h4>错误输出</h4>
  <pre>{{ details.stderr }}</pre>
</section>
<div v-if="details?.signal">终止信号：{{ details.signal }}</div>
```

Treat a non-zero `exitCode`, a failed `ToolResult`, or `status === 'error'` as a failed command in
the summary styling.

- [ ] **Step 7: Create operation dispatch and fallback**

`ToolOperationList.vue` accepts `calls: ToolCallContent[]` and dispatches:

```vue
<template>
  <div class="tool-operation-list">
    <template v-for="call in calls" :key="call.id">
      <FileOperationCard v-if="call.name === 'edit' || call.name === 'write'" :call="call" />
      <CommandOperationCard v-else-if="call.name === 'bash'" :call="call" />
      <div v-else class="generic-tool">
        <span>{{ call.name }}</span>
        <span>{{ call.status === 'running' ? '执行中' : call.status === 'error' ? '执行失败' : '已执行' }}</span>
      </div>
    </template>
  </div>
</template>
```

- [ ] **Step 8: Replace assistant tool badges**

In `AssistantMessage.vue`, import `ToolOperationList`, replace the current badge loop with:

```vue
<ToolOperationList
  v-if="hasToolCalls && message.toolCalls"
  :calls="message.toolCalls"
/>
```

Delete obsolete `.tool-calls` and `.tool-call-badge` styles.

- [ ] **Step 9: Run tests, typecheck, and build**

Run:

```powershell
bun test src/renderer/utils/tool-presentation.test.ts
bun run typecheck
bun run build
```

Expected: tests pass, typecheck exits 0, and Vite/Electron bundles build successfully.

- [ ] **Step 10: Commit the UI**

```powershell
git add -- src/renderer/utils/tool-presentation.ts src/renderer/utils/tool-presentation.test.ts src/renderer/components/tools/FileOperationCard.vue src/renderer/components/tools/CommandOperationCard.vue src/renderer/components/tools/ToolOperationList.vue src/renderer/components/chat/AssistantMessage.vue
git commit -m "feat(renderer): show detailed tool operation cards"
```

### Task 7: Full verification and manual Electron checks

**Files:**

- Modify only if verification reveals a defect in files already listed above.

- [ ] **Step 1: Run the complete automated test suite**

```powershell
bun run test
```

Expected: all Bun tests pass with zero failures.

- [ ] **Step 2: Run repository-required static checks**

```powershell
bun run typecheck
bun run lint
bun run build
```

Expected: all commands exit 0. If lint finds pre-existing errors, compare against the starting
baseline and fix only errors introduced by this feature.

- [ ] **Step 3: Start the Electron development app**

```powershell
bun run dev
```

Expected: the renderer and Electron process start without console errors.

- [ ] **Step 4: Verify successful file editing**

Ask the agent to replace one unique line in a disposable project file.

Expected:

- The card initially shows the exact file and `编辑中`.
- It changes to `已编辑`.
- It shows green `+1` and red `-1` for a one-line replacement.

- [ ] **Step 5: Verify failed editing**

Ask the agent to replace text that does not exist.

Expected:

- The card shows the target file.
- It changes to `编辑失败`.
- It shows the tool error and does not invent line counts.

- [ ] **Step 6: Verify command collapse and details**

Run one successful command and one command that exits non-zero.

Expected:

- Both command cards are closed initially.
- Expanding shows complete command, cwd, stdout/stderr, and exit code.
- The non-zero command uses failure styling.

- [ ] **Step 7: Verify session restoration**

Switch to another session and return to the tested session.

Expected: file cards, line counts, command text, outputs, and exit codes remain visible with command
cards collapsed by default.

- [ ] **Step 8: Inspect final scope**

```powershell
git status --short
git diff --stat HEAD~6..HEAD
git diff --check HEAD~6..HEAD
```

Expected: only planned feature files are included in the feature commits; unrelated pre-existing
working-tree changes remain unstaged and untouched.

- [ ] **Step 9: Request code review**

Invoke `superpowers:requesting-code-review`, address any High or Medium findings, and rerun Steps
1–2 before declaring completion.
