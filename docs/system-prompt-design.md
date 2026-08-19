# System Prompt 与运行时上下文设计

## 1. 目标

SunCode 不显式管理供应商 KV 缓存，而是尽量让相邻模型请求满足“稳定前缀 + 只追加后缀”。供应商可据此前缀自动命中缓存。

核心原则：

- 高权限、低频变化的指令进入 system prompt。
- 每轮可能变化的状态进入内部 `runtime_context` 用户角色消息。
- 工具调用产生的事实保留在 assistant/tool 消息中，不回写 system prompt。
- 内部上下文消息不能被业务逻辑误判为用户的新指令。
- 主 Agent 与 Subagent 使用同一套构造规则。

## 2. 请求结构

```text
system: suncode.system_prompt                 稳定请求头
user:   suncode.runtime_context（按变化追加）  可信运行时状态
user:   用户真实请求
assistant/tool: 历史执行链
user:   下一条真实请求
```

`system prompt` 与工具定义在一次运行开始时构建一次。同一运行内的后续模型请求复用完全相同的 system 字符串和确定性排序后的工具定义。

### 2.1 `suncode.system_prompt`

由 `system-prompt.ts` 和 `model-structured-content.ts` 生成，主要字段：

```json
{
  "type": "suncode.system_prompt",
  "version": 1,
  "basePrompt": "...",
  "agentRolePrompt": "...",
  "mode": { "permissionMode": "full_access" },
  "guidelines": [],
  "tools": [],
  "context": {
    "projectInstructions": "...",
    "skills": "...",
    "projectKnowledge": "..."
  },
  "environment": { "workingDirectory": "..." }
}
```

其中 `agentRolePrompt` 仅在命名 Subagent 中存在，用来保存该 Agent 的稳定角色约束。它属于 system 权限层，不能作为普通 user 消息追加。

### 2.2 `suncode.runtime_context`

由 `runtime-context.ts` 生成：

```json
{
  "type": "suncode.runtime_context",
  "version": 1,
  "snapshot": {
    "memory": "...",
    "relevantLessons": "...",
    "responseLanguage": {
      "language": "zh",
      "instruction": "..."
    },
    "currentDate": "2026-08-19"
  },
  "semantics": {
    "authority": "trusted_runtime_state",
    "supersedesPriorRuntimeContext": true,
    "userAuthored": false
  }
}
```

它在 provider API 中使用 `user` 角色，但 `Message.contextKind === 'runtime_context'`。所有需要寻找“真实用户”的逻辑必须使用 `isUserAuthoredMessage()`，不能只判断 `role === 'user'`。

插入策略：

1. 构造当前快照的确定性 JSON。
2. 与历史中最近的 runtime context 比较完整内容。
3. 内容相同则不追加。
4. 内容变化则插入当前真实用户消息之前。

因此一次跨轮请求通常形如：

```text
R1, U1, A1, U2
```

若运行时状态变化，则为：

```text
R1, U1, A1, R2, U2
```

`R2` 声明覆盖旧快照，但旧消息不被原地修改，保证已有前缀仍然稳定。

## 3. 主 Agent

`Agent.runLoop()` 在处理真实用户请求后加载：

- 工作区指令与 Skills：静态 system context。
- 检索后的 memory：runtime context。
- 当前任务相关 lessons：runtime context。
- 当前 UI 回复语言：runtime context。

`runAgentLoop()` 会保留完整 provider-facing 历史，包括 assistant tool call 与 tool result。正常完成后，下一次请求在该历史后追加最终回答和新用户消息，不再压扁成“用户请求 + 最终回答”。

运行事件中的 `runtime_context_committed` 会写入 session ledger。`runtime-projector.ts` 维护两个投影：

- `messages`：Renderer 可见消息，不包含 runtime context。
- `modelMessages`：Worker 恢复模型历史时使用，包含 runtime context。

## 4. Subagent

Subagent 复用 `runAgentLoop()`，不自行拼接第二份 system prompt：

- `agentRolePrompt` 保存 `SubagentDefinition.systemPrompt`，不会被公共循环覆盖。
- `memoryContent`、`relevantLessonsContent`、`responseLanguage` 进入同一种 runtime context。
- `parentMessages` 与当前 `AbortSignal` 在每次主 Agent 运行开始时刷新。
- 命名会话保存 `result.modelMessages`，保留完整工具链供下一次同名调用追加。
- 已有命名会话历史时不重复注入 parent context。
- Subagent 的私有 runtime context 不提交到主 session ledger，避免污染主 Agent 的模型投影。

临时 Subagent 没有跨调用历史，但仍能共享稳定 system header，并在单次执行内保持追加式请求。

## 5. 缓存 epoch

以下变化会自然开启新的缓存 epoch，因为它们改变 system prompt 或工具定义：

- 默认或自定义 base prompt 改变。
- 工作目录、项目指令、Skills、Project Knowledge 改变。
- Subagent 角色定义改变。
- 可用工具集合、描述或参数 Schema 改变。
- 权限模式改变。

memory、lessons、日期、回复语言变化不会重写 system prompt，只会追加新的 runtime context。

上下文压缩或语义 projection 会有意改写模型请求视图，也应视为新的历史 epoch，而不是缓存异常。

## 6. TurnEvidence 边界

`TurnEvidenceBuffer` 用于完成门校验和证据索引，不进入 system prompt。模型看到的工具事实以 assistant/tool 消息为准；把 evidence 再注入 system 会同时造成权限混淆、内容重复和缓存失效。

## 7. 关键实现

| 文件 | 职责 |
|------|------|
| `src/worker/agent/system-prompt.ts` | 构建稳定 system envelope，确定性排序工具 |
| `src/worker/agent/model-structured-content.ts` | 结构化 JSON 序列化 |
| `src/worker/agent/runtime-context.ts` | 构造、去重和插入 runtime context；识别真实用户 |
| `src/worker/agent/agent-loop.ts` | 冻结请求头、保留 provider-facing 历史 |
| `src/worker/agent/subagent.ts` | Subagent 角色、上下文继承和命名历史 |
| `src/main/runtime-projector.ts` | 分离 UI 消息投影与模型历史投影 |

## 8. 测试约束

测试应验证行为而不是具体提示词文案：

- 同一运行的 system prompt 和 tools 完全相同。
- 后一请求以前一请求消息为精确前缀。
- runtime context 相同不重复，变化时追加。
- memory、lessons、language 不出现在 system prompt。
- runtime context 不被当作真实用户，也不出现在 UI 投影。
- Subagent 的角色仍位于 system envelope，私有 runtime context 不进入主 ledger。
