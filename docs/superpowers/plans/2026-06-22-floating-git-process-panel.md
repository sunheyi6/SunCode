# Floating Git and Process Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a default-collapsed right-side panel that expands into the approved reference-style Git and latest-background-command status card.

**Architecture:** Introduce one shared `GitInfo` contract and move Git-stat parsing into a small main-process module that can be unit tested. Make the background-process composable an application-lifetime shared event store, with pure helpers for latest-process selection and elapsed-time formatting. Keep visual behavior and orchestration in `GitPanel.vue`, reusing the existing session store and IPC bridge.

**Tech Stack:** Electron, Vue 3 Composition API, TypeScript, Bun test runner, Biome, CSS theme variables.

---

## File Map

- Create `src/main/git-info.ts`: typed Git repository inspection and `--numstat` parsing.
- Create `src/main/git-info.test.ts`: unit tests for added/deleted-line parsing.
- Modify `src/main/ipc-handlers.ts`: delegate `git:getInfo` to the focused Git module.
- Modify `src/shared/types.ts`: define the cross-process `GitInfo` contract and completed-process end time.
- Modify `src/main/preload.ts`: expose `GitInfo` and typed background-process callbacks.
- Modify `src/renderer/api/bridge.ts`: return shared `GitInfo` and `BackgroundProcess` types.
- Modify `src/renderer/types/ipc.ts`: keep `window.suncode` aligned with preload.
- Create `src/renderer/composables/background-process-state.ts`: pure process-state and duration helpers.
- Create `src/renderer/composables/background-process-state.test.ts`: unit tests for duplicate events, latest selection, completion, and Chinese duration text.
- Modify `src/renderer/composables/useBackgroundProcesses.ts`: install one persistent listener pair and update the shared process collection safely.
- Modify `src/renderer/components/layout/GitPanel.vue`: implement the approved collapsed pill and expanded reference-style card.
- Modify `src/renderer/components/chat/ChatHeader.vue`: repair affected mojibake and consume the shared process state without owning its lifecycle.

### Task 1: Add typed, accurate Git line statistics

**Files:**
- Create: `src/main/git-info.ts`
- Create: `src/main/git-info.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Write the failing numstat parser tests**

Create `src/main/git-info.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseNumstat } from './git-info';

describe('parseNumstat', () => {
  test('sums insertions and deletions across files', () => {
    expect(parseNumstat('12\t3\tsrc/a.ts\n5\t0\tsrc/b.ts\n')).toEqual({
      addedLines: 17,
      deletedLines: 3,
      changedFiles: 2,
    });
  });

  test('counts binary files without inventing line changes', () => {
    expect(parseNumstat('-\t-\tresources/icon.png\n2\t1\tsrc/app.ts\n')).toEqual({
      addedLines: 2,
      deletedLines: 1,
      changedFiles: 2,
    });
  });

  test('returns zeroes for clean output', () => {
    expect(parseNumstat('')).toEqual({
      addedLines: 0,
      deletedLines: 0,
      changedFiles: 0,
    });
  });
});
```

- [ ] **Step 2: Run the parser tests and verify the missing-module failure**

Run:

```powershell
bun test src/main/git-info.test.ts
```

Expected: FAIL because `src/main/git-info.ts` does not exist.

- [ ] **Step 3: Add the shared Git contract**

Add to `src/shared/types.ts` near the other IPC-facing types:

```ts
export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  addedLines: number;
  deletedLines: number;
  changedFiles: number;
  stagedFiles: number;
}
```

- [ ] **Step 4: Implement the focused Git module**

Create `src/main/git-info.ts`:

```ts
import { execFileSync } from 'node:child_process';
import type { GitInfo } from '@shared/types';

export interface GitLineStats {
  addedLines: number;
  deletedLines: number;
  changedFiles: number;
}

export function parseNumstat(output: string): GitLineStats {
  let addedLines = 0;
  let deletedLines = 0;
  let changedFiles = 0;

  for (const line of output.trim().split('\n')) {
    if (!line) continue;
    const [added, deleted] = line.split('\t');
    changedFiles += 1;
    if (added !== '-') addedLines += Number.parseInt(added, 10) || 0;
    if (deleted !== '-') deletedLines += Number.parseInt(deleted, 10) || 0;
  }

  return { addedLines, deletedLines, changedFiles };
}

function git(workingDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf-8',
    windowsHide: true,
  }).trim();
}

export function getGitInfo(workingDir: string): GitInfo {
  try {
    git(workingDir, ['rev-parse', '--git-dir']);
  } catch {
    return {
      isRepo: false,
      addedLines: 0,
      deletedLines: 0,
      changedFiles: 0,
      stagedFiles: 0,
    };
  }

  let branch: string | undefined;
  let remoteUrl: string | undefined;
  try {
    branch = git(workingDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {}
  try {
    remoteUrl = git(workingDir, ['remote', 'get-url', 'origin']);
  } catch {}

  let lineStats: GitLineStats = { addedLines: 0, deletedLines: 0, changedFiles: 0 };
  try {
    lineStats = parseNumstat(git(workingDir, ['diff', '--numstat', 'HEAD']));
  } catch {}

  let stagedFiles = 0;
  try {
    const staged = git(workingDir, ['diff', '--cached', '--name-only']);
    stagedFiles = staged ? staged.split(/\r?\n/).filter(Boolean).length : 0;
  } catch {}

  return { isRepo: true, branch, remoteUrl, ...lineStats, stagedFiles };
}
```

- [ ] **Step 5: Delegate the IPC handler to the Git module**

In `src/main/ipc-handlers.ts`:

1. Remove `execSync` from the imports.
2. Add:

```ts
import { getGitInfo } from './git-info';
```

3. Keep the existing handler:

```ts
ipcMain.handle('git:getInfo', async (_event, workingDir: string) => {
  return getGitInfo(workingDir);
});
```

4. Delete the local `GitInfo` interface and local `getGitInfo()` function.

- [ ] **Step 6: Run the focused tests**

Run:

```powershell
bun test src/main/git-info.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 7: Commit the Git statistics slice**

```powershell
git add src/main/git-info.ts src/main/git-info.test.ts src/main/ipc-handlers.ts src/shared/types.ts
git commit -m "feat(main): expose accurate git line stats"
```

### Task 2: Align the typed renderer bridge

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/api/bridge.ts`
- Modify: `src/renderer/types/ipc.ts`

- [ ] **Step 1: Import the shared contracts in preload**

Add `BackgroundProcess` and `GitInfo` to the `@shared/types` import in
`src/main/preload.ts`.

- [ ] **Step 2: Replace preload’s inline Git and process types**

Use these signatures in `src/main/preload.ts`:

```ts
async getGitInfo(workingDir: string): Promise<GitInfo> {
  return ipcRenderer.invoke('git:getInfo', workingDir);
},

onBgProcessStarted(callback: (process: BackgroundProcess) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, proc: BackgroundProcess): void =>
    callback(proc);
  ipcRenderer.on('agent:bg-process-started', handler);
  return () => ipcRenderer.removeListener('agent:bg-process-started', handler);
},
```

Keep `onBgProcessCompleted(callback: (pid: number, exitCode: number) => void)` unchanged.

- [ ] **Step 3: Use shared types in the renderer bridge**

Import `BackgroundProcess` and `GitInfo` in `src/renderer/api/bridge.ts`, then use:

```ts
async getGitInfo(workingDir: string): Promise<GitInfo> {
  return api().getGitInfo(workingDir);
},

onBgProcessStarted(callback: (proc: BackgroundProcess) => void): () => void {
  return api().onBgProcessStarted(callback);
},
```

- [ ] **Step 4: Align the global Window API**

Import `BackgroundProcess` and `GitInfo` in `src/renderer/types/ipc.ts`, then replace the
existing narrowed declarations with:

```ts
getGitInfo(workingDir: string): Promise<GitInfo>;
onBgProcessStarted(callback: (proc: BackgroundProcess) => void): () => void;
```

Also preserve the existing optional `workingDirectory` argument:

```ts
createSession(name: string, workingDirectory?: string): Promise<SessionMeta>;
```

- [ ] **Step 5: Run strict type checking**

Run:

```powershell
bun run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit the bridge alignment**

```powershell
git add src/main/preload.ts src/renderer/api/bridge.ts src/renderer/types/ipc.ts
git commit -m "refactor(ipc): share git and process contracts"
```

### Task 3: Make background-process state shared and testable

**Files:**
- Create: `src/renderer/composables/background-process-state.ts`
- Create: `src/renderer/composables/background-process-state.test.ts`
- Modify: `src/renderer/composables/useBackgroundProcesses.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write failing process-state tests**

Create `src/renderer/composables/background-process-state.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { BackgroundProcess } from '@shared/types';
import {
  completeProcess,
  formatElapsedTime,
  latestProcess,
  upsertStartedProcess,
} from './background-process-state';

describe('background process state', () => {
  test('replaces duplicate start events by pid', () => {
    const processes: BackgroundProcess[] = [];
    upsertStartedProcess(processes, {
      pid: 7,
      command: 'bun run dev',
      startTime: 1000,
      status: 'running',
    });
    upsertStartedProcess(processes, {
      pid: 7,
      command: 'bun run dev --host',
      startTime: 2000,
      status: 'running',
    });
    expect(processes).toHaveLength(1);
    expect(processes[0].command).toBe('bun run dev --host');
  });

  test('selects the greatest startTime', () => {
    const processes: BackgroundProcess[] = [
      { pid: 1, command: 'older', startTime: 1000, status: 'running' },
      { pid: 2, command: 'newer', startTime: 2000, status: 'running' },
    ];
    expect(latestProcess(processes)?.pid).toBe(2);
  });

  test('records completion time and failure state', () => {
    const processes: BackgroundProcess[] = [
      { pid: 3, command: 'build', startTime: 1000, status: 'running' },
    ];
    completeProcess(processes, 3, 1, 5500);
    expect(processes[0]).toMatchObject({
      status: 'error',
      exitCode: 1,
      endTime: 5500,
    });
  });

  test('formats elapsed time in Chinese', () => {
    expect(formatElapsedTime(0)).toBe('0秒');
    expect(formatElapsedTime(65_000)).toBe('1分 5秒');
    expect(formatElapsedTime(3_900_000)).toBe('1小时 5分');
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run:

```powershell
bun test src/renderer/composables/background-process-state.test.ts
```

Expected: FAIL because `background-process-state.ts` does not exist and `endTime` is absent.

- [ ] **Step 3: Extend the process contract**

Add this optional property to `BackgroundProcess` in `src/shared/types.ts`:

```ts
endTime?: number;
```

- [ ] **Step 4: Implement the pure helpers**

Create `src/renderer/composables/background-process-state.ts`:

```ts
import type { BackgroundProcess } from '@shared/types';

export function upsertStartedProcess(
  processes: BackgroundProcess[],
  process: BackgroundProcess,
): void {
  const index = processes.findIndex((item) => item.pid === process.pid);
  if (index >= 0) processes[index] = { ...process, status: 'running' };
  else processes.push({ ...process, status: 'running' });
}

export function completeProcess(
  processes: BackgroundProcess[],
  pid: number,
  exitCode: number,
  endTime = Date.now(),
): void {
  const process = processes.find((item) => item.pid === pid);
  if (!process) return;
  process.status = exitCode === 0 ? 'completed' : 'error';
  process.exitCode = exitCode;
  process.endTime = endTime;
}

export function latestProcess(
  processes: BackgroundProcess[],
): BackgroundProcess | undefined {
  return processes.reduce<BackgroundProcess | undefined>(
    (latest, process) =>
      !latest || process.startTime > latest.startTime ? process : latest,
    undefined,
  );
}

export function formatElapsedTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时 ${Math.floor((seconds % 3600) / 60)}分`;
}
```

- [ ] **Step 5: Run the process-state tests**

Run:

```powershell
bun test src/renderer/composables/background-process-state.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 6: Convert the composable to one application-lifetime subscription**

Replace `src/renderer/composables/useBackgroundProcesses.ts` with:

```ts
import { readonly, ref } from 'vue';
import type { BackgroundProcess } from '@shared/types';
import { bridge } from '../api/bridge';
import { completeProcess, upsertStartedProcess } from './background-process-state';

const processes = ref<BackgroundProcess[]>([]);
let listening = false;

function ensureListening(): void {
  if (listening) return;
  listening = true;

  bridge.onBgProcessStarted((process) => {
    upsertStartedProcess(processes.value, process);
  });
  bridge.onBgProcessCompleted((pid, exitCode) => {
    completeProcess(processes.value, pid, exitCode);
  });
}

export function useBackgroundProcesses() {
  ensureListening();
  return { processes: readonly(processes) };
}
```

This intentionally keeps two listeners for the renderer application lifetime, so unmounting
`ChatHeader` cannot disconnect `GitPanel`.

- [ ] **Step 7: Run both focused test files and type checking**

Run:

```powershell
bun test src/main/git-info.test.ts src/renderer/composables/background-process-state.test.ts
bun run typecheck
```

Expected: 7 tests PASS and typecheck PASS.

- [ ] **Step 8: Commit shared process state**

```powershell
git add src/shared/types.ts src/renderer/composables/background-process-state.ts src/renderer/composables/background-process-state.test.ts src/renderer/composables/useBackgroundProcesses.ts
git commit -m "feat(renderer): share background process state"
```

### Task 4: Build the approved floating panel

**Files:**
- Modify: `src/renderer/components/layout/GitPanel.vue`
- Modify: `src/renderer/components/chat/ChatHeader.vue`

- [ ] **Step 1: Add panel state and computed process summaries**

In `GitPanel.vue`, import `GitInfo`, `useBackgroundProcesses`, and the pure helpers. Use this
state shape:

```ts
const gitStatus = ref<GitInfo>({
  isRepo: false,
  addedLines: 0,
  deletedLines: 0,
  changedFiles: 0,
  stagedFiles: 0,
});
const collapsed = ref(true);
const now = ref(Date.now());
const panelRef = ref<HTMLElement | null>(null);
const { processes } = useBackgroundProcesses();

const latest = computed(() => latestProcess([...processes.value]));
const runningCount = computed(
  () => processes.value.filter((process) => process.status === 'running').length,
);
const hasChanges = computed(
  () => gitStatus.value.changedFiles > 0 || gitStatus.value.stagedFiles > 0,
);
const elapsedText = computed(() => {
  const process = latest.value;
  if (!process) return '未运行';
  const end = process.endTime ?? now.value;
  return formatElapsedTime(end - process.startTime);
});
```

- [ ] **Step 2: Add one timer and one outside-click listener**

Use one `onMounted` and one `onUnmounted` block:

```ts
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  void refreshGit();
  document.addEventListener('click', onDocumentClick);
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick);
  if (timer) clearInterval(timer);
});
```

Watch `activeSession.value?.workingDirectory`, refresh Git when it changes, and reset
`collapsed.value = true`.

- [ ] **Step 3: Replace the template with the approved information hierarchy**

Use semantic buttons and these visible labels:

```vue
<div v-if="gitStatus.isRepo" ref="panelRef" class="git-float">
  <button
    class="git-pill"
    type="button"
    :aria-expanded="!collapsed"
    :aria-label="collapsed ? '展开 Git 和进程信息' : '收起 Git 和进程信息'"
    @click="togglePanel"
  >
    <span class="branch-icon" aria-hidden="true">⑂</span>
    <span class="pill-branch">{{ gitStatus.branch || 'HEAD' }}</span>
    <span v-if="hasChanges" class="pill-dot" aria-label="存在未提交更改" />
    <span v-if="hasChanges" class="pill-count">
      +{{ gitStatus.addedLines }} −{{ gitStatus.deletedLines }}
    </span>
    <span aria-hidden="true">{{ collapsed ? '⌄' : '⌃' }}</span>
  </button>

  <section v-if="!collapsed" class="git-card" aria-label="Git 和后台进程信息">
    <header class="card-header">
      <span>Git 工具</span>
      <button type="button" class="icon-button" aria-label="刷新 Git 信息" @click="refreshGit">
        ↻
      </button>
    </header>

    <div class="info-row">
      <span>▣　更改</span>
      <span class="line-stats">
        <strong class="added">+{{ gitStatus.addedLines }}</strong>
        <strong class="deleted">-{{ gitStatus.deletedLines }}</strong>
      </span>
    </div>
    <div class="info-row"><span>⑂　{{ gitStatus.branch || 'HEAD' }}</span></div>
    <button type="button" class="commit-row" title="提交功能将在后续流程中接入">
      <span>─　提交</span><span>•••</span>
    </button>

    <div class="section-divider" />
    <section class="process-section">
      <div class="section-heading">
        <span>进程</span><span>{{ latest ? '1/1' : '0/0' }}</span>
      </div>
      <div v-if="latest" class="process-command" :title="latest.command">
        <span :class="['status-mark', latest.status]">
          {{ latest.status === 'running' ? '●' : latest.status === 'completed' ? '✓' : '×' }}
        </span>
        <span class="command-text">{{ latest.command }}</span>
      </div>
      <div v-else class="empty-process">暂无运行进程</div>
    </section>

    <div class="section-divider" />
    <footer class="runtime-row">
      <span>{{ latest?.status === 'running' ? '运行中' : '运行状态' }}</span>
      <span>
        {{ elapsedText }} · {{ runningCount }} 后台
        <template v-if="latest?.status === 'error' && latest.exitCode !== undefined">
          · 退出码 {{ latest.exitCode }}
        </template>
      </span>
    </footer>
  </section>
</div>
```

- [ ] **Step 4: Implement the approved reference-style CSS**

Replace the scoped CSS with rules that enforce:

```css
.git-float {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: calc(100% - 20px);
}

.git-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  max-width: min(320px, calc(100vw - 40px));
  padding: 3px 10px;
  border: 1px solid var(--border-color-strong);
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-bg-secondary) 92%, transparent);
  color: var(--color-text-secondary);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(10px);
}

.git-card {
  width: min(390px, calc(100vw - 40px));
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid var(--border-color-strong);
  border-radius: 14px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
}

.card-header,
.info-row,
.commit-row,
.runtime-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 14px;
}

.section-divider {
  height: 1px;
  margin: 4px 10px;
  background: var(--border-color-strong);
}

.added { color: var(--color-green); }
.deleted { color: var(--color-red); }
.process-command,
.empty-process,
.process-section { min-width: 0; }
.command-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-pill:hover,
.icon-button:hover,
.commit-row:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.pill-branch,
.command-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pill-branch {
  max-width: 120px;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-weight: 600;
}

.pill-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--color-yellow);
}

.pill-count,
.line-stats {
  display: flex;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.card-header,
.section-heading,
.runtime-row {
  color: var(--color-text-muted);
}

.card-header {
  font-size: 12px;
}

.icon-button {
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  color: var(--color-text-secondary);
}

.commit-row {
  width: 100%;
  border-radius: 0;
  background: transparent;
  color: var(--color-text);
  text-align: left;
}

.process-section {
  padding: 10px 14px 12px;
}

.section-heading {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 12px;
}

.process-command {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
}

.status-mark.running { color: var(--color-accent); }
.status-mark.completed { color: var(--color-green); }
.status-mark.error { color: var(--color-red); }

.empty-process {
  color: var(--color-text-muted);
  font-size: 12px;
}

.runtime-row {
  gap: 16px;
  min-height: 50px;
  font-size: 12px;
}

.runtime-row span:last-child {
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Keep the final file within Biome’s 100-character line width.

- [ ] **Step 5: Repair the affected header text**

In `ChatHeader.vue`, replace mojibake with:

```vue
<span v-if="runningBgCount > 0" class="header-bg" title="后台运行中">
  ↻ {{ runningBgCount }} 个后台
</span>
<span class="header-folder" :title="activeSession.workingDirectory">
  ▣ {{ folderName }}
</span>
```

Use `⑂ {{ gitBranch }}`, `⚠ git`, and `—` for the three Git states. Remove the unused
`formatBgTime()` function.

- [ ] **Step 6: Run renderer checks**

Run:

```powershell
bun run typecheck
bun run lint
bun run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the panel**

```powershell
git add src/renderer/components/layout/GitPanel.vue src/renderer/components/chat/ChatHeader.vue
git commit -m "feat(renderer): add floating git process panel"
```

### Task 5: Verify the complete desktop flow

**Files:**
- Verify: `src/renderer/components/layout/GitPanel.vue`
- Verify: `src/renderer/composables/useBackgroundProcesses.ts`
- Verify: `src/main/git-info.ts`

- [ ] **Step 1: Run all automated verification**

Run:

```powershell
bun test
bun run typecheck
bun run lint
bun run build
```

Expected: all tests PASS and all commands exit 0.

- [ ] **Step 2: Start the Electron development app**

Run:

```powershell
bun run dev
```

Expected: the Electron window opens without renderer or main-process errors.

- [ ] **Step 3: Verify collapsed and expanded behavior**

In the app:

1. Open a session whose working directory is a Git repository.
2. Confirm the panel starts as a small right-side pill.
3. Click the pill and confirm the reference-style card opens.
4. Click outside and confirm it closes.
5. Reopen it and click the pill again; confirm it closes.
6. Confirm keyboard focus, Enter, and Space operate the native button.

- [ ] **Step 4: Verify Git values against the command line**

Run in the same project directory:

```powershell
git diff --numstat HEAD
git diff --cached --name-only
git rev-parse --abbrev-ref HEAD
```

Expected: card additions, deletions, staged count, and branch match the command output.

- [ ] **Step 5: Verify latest background command timing**

Trigger two background Bash tool commands at different times. Confirm:

1. The card displays only the later command.
2. The footer reports `2 后台` while both run.
3. The timer starts from the later command’s `startTime`.
4. A completed command freezes its duration.
5. A failed command shows failure state and exit code.

- [ ] **Step 6: Verify visual constraints**

Check dark theme, light theme, and a narrow app window. Expected:

- Text and status remain legible in both themes.
- The card stays inside the main content width.
- Long commands truncate with the complete command available in the tooltip.
- The card does not permanently obscure chat because it defaults to collapsed.

- [ ] **Step 7: Inspect the final diff**

Run:

```powershell
git status --short
git diff --check
git diff --stat
```

Expected: no whitespace errors; only intended feature files plus pre-existing user changes appear.
