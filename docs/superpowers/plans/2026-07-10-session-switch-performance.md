# Session Switch Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session switching render the latest 10 messages quickly, asynchronously hydrate full history, and avoid returning oversized or stale data.

**Architecture:** Keep a renderer-side per-session snapshot cache and request-token guard. Main-process session loading will select a bounded renderer result while retaining full messages for the worker. Background prewarming will use bounded concurrency.

**Tech Stack:** TypeScript, Vue/Pinia, Electron IPC, Vitest, Biome.

---

### Task 1: Add failing tests for bounded session reads

**Files:**
- Modify: `test/main/session-store.test.ts`
- Modify: `src/main/session-store.ts`

- [ ] **Step 1: Write the failing test**

Add a test fixture containing 12 messages and assert that `loadSession(id, 10)` returns only the last 10 while `loadSession(id)` returns all 12. The test must also assert the stored JSON remains unchanged after the bounded read.

- [ ] **Step 2: Run the focused test**

Run `bunx vitest run test/main/session-store.test.ts -t "returns only the requested tail"`.

Expected: FAIL because the current test-facing API and implementation do not expose a fixture/helper for this bounded-read behavior.

- [ ] **Step 3: Implement the minimal storage behavior**

Keep `loadSession` parsing the full file once, create the bounded result from the parsed data without mutating the full parsed message array, and return the bounded result only when `maxMessages` is defined.

- [ ] **Step 4: Run the focused test**

Run `bunx vitest run test/main/session-store.test.ts -t "returns only the requested tail"` and expect PASS.

### Task 2: Make renderer session selection cache-first and race-safe

**Files:**
- Modify: `test/renderer/session-switch.test.ts`
- Modify: `src/renderer/stores/sessions.ts`

- [ ] **Step 1: Write failing tests**

Mock `bridge.getSessions` and `bridge.loadSession` and add tests that assert: a cache/snapshot is rendered with 10 messages before a full load resolves; the full load is requested in the background; and a stale full-load result does not replace a newer selected session.

- [ ] **Step 2: Run the focused tests**

Run `bunx vitest run test/renderer/session-switch.test.ts`.

Expected: FAIL because selection currently awaits full loads for cache misses and lacks a request-token guard.

- [ ] **Step 3: Implement the minimal selection flow**

Add a request sequence counter, load a 10-message snapshot for cache misses, render it immediately, then start full hydration without awaiting it. Store full results in the cache and only call `chatStore.loadMessages` when both the request token and active session id still match.

- [ ] **Step 4: Bound prewarming concurrency**

Use a small worker loop over the remaining sessions so at most four `loadSession(session.id, 10)` calls are in flight. Ignore unreadable sessions and do not block `init` on prewarming.

- [ ] **Step 5: Run the focused tests**

Run `bunx vitest run test/renderer/session-switch.test.ts test/renderer/chat-store.test.ts` and expect PASS.

### Task 3: Ensure main-process loads do not return oversized memory data

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `test/main/ipc-session-load.test.ts`

- [ ] **Step 1: Write the failing test**

Exercise the `session:load` handler with an in-memory session containing more than 10 messages and assert that a `maxMessages=10` request returns only the last 10 while the Worker receives the full message list.

- [ ] **Step 2: Run the focused test**

Run `bunx vitest run test/main/ipc-session-load.test.ts` and expect FAIL because the current handler returns the full in-memory list whenever it is longer than the disk snapshot.

- [ ] **Step 3: Implement the bounded renderer result**

Keep the full list in `sessionMessages`, derive `rendererMessages` from the requested tail, send the full list to Worker, and return only `rendererMessages` to IPC callers. Preserve existing metadata/worktree validation.

- [ ] **Step 4: Run the focused test**

Run `bunx vitest run test/main/ipc-session-load.test.ts test/main/session-store.test.ts` and expect PASS.

### Task 4: Run full verification

**Files:**
- Verify: `src/renderer/stores/sessions.ts`, `src/main/session-store.ts`, `src/main/ipc-handlers.ts`, and related tests

- [ ] **Step 1: Run all tests**

Run `bun run test` and confirm exit code 0.

- [ ] **Step 2: Run lint**

Run `bun run lint` and confirm no errors.

- [ ] **Step 3: Run typecheck**

Run `bun run typecheck` and confirm exit code 0.
