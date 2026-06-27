# 工具调用设计文档

## 1. 设计目标

工具调用（Tool Calling / Function Calling）是 coding agent 与环境交互的机制。设计目标：

- **安全可靠**：每个工具都有明确的输入校验和错误处理
- **LLM 友好**：JSON Schema 清晰准确，让模型少犯错
- **可扩展**：支持内置工具 + MCP 外部工具统一注册
- **可观测**：每个工具调用都有完整的生命周期事件
- **高性能**：支持独立工具并行执行

---

## 2. 整体架构

```
┌──────────────────────────────────────────────┐
│                  Agent Loop                   │
│                                               │
│  1. LLM 返回 tool_call 事件                   │
│  2. 解析 ToolCall { id, name, arguments }     │
│  3. ToolRegistry.lookup(name) → Tool          │
│  4. tool.execute(params) → ToolResult         │
│  5. ToolResult 追加到对话上下文               │
│  6. 继续循环 → LLM 决定下一步                 │
│                                               │
├──────────────────────────────────────────────┤
│              ToolRegistry                      │
│                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │  read    │ │  write   │ │  edit    │     │
│  │  bash    │ │  grep    │ │  glob    │     │
│  └──────────┘ └──────────┘ └──────────┘     │
│                                               │
│  ┌──────────────────────────────────────┐    │
│  │  MCP Tools (mcp__前缀)                │    │
│  │  mcp__github__search_repos           │    │
│  │  mcp__postgres__query                │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

---

## 3. 工具接口设计

### 3.1 核心接口

```typescript
interface Tool {
  readonly name: string;          // 唯一标识，如 "read", "bash"
  readonly description: string;   // 给 LLM 看的使用说明
  readonly parameters: JSONSchema; // 参数 Schema

  // 执行工具，返回结果
  execute(params: Record<string, unknown>): Promise<ToolResult>;

  // 生成 LLM 需要的工具定义
  getDefinition(): ToolDefinition;
}
```

### 3.2 ToolResult 结构

```typescript
interface ToolResult {
  toolCallId: string;   // 对应 LLM 返回的 tool_call.id
  name: string;         // 工具名
  success: boolean;     // 是否成功
  output: string;       // 成功时的输出（给 LLM 看的纯文本）
  error?: string;       // 失败时的错误信息
}
```

**关键设计决策：`output` 是纯文本字符串**

为什么不用结构化数据？

- LLM 接受的是文本流，结构化数据需要额外序列化
- 纯文本更灵活，可以包含自然语言解释 + 格式化数据
- 参考 Claude、OpenAI 的 tool result 设计

### 3.3 BaseTool 抽象类

```typescript
abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract parameters: JSONSchema;
  abstract execute(params): Promise<ToolResult>;

  getDefinition(): ToolDefinition {
    return { name, description, parameters };
  }

  protected success(output: string): ToolResult { ... }
  protected failure(error: string): ToolResult { ... }
}
```

提供 `success()` 和 `failure()` 便捷方法，统一输出格式。

---

## 4. 六个内置工具

> 各工具详细设计见 [docs/tools/](./tools/) 目录。

### 4.1 read — 文件读取

> 📄 详细设计：[docs/tools/read.md](./tools/read.md)（待补充）

```
输入: file_path, offset?, limit?
输出: 带行号的文件内容 或 base64 图片数据

安全: 无（只读操作）
特殊: 自动识别图片（png/jpg/gif/webp），返回 base64
目录读取：列出目录内容
```

### 4.2 write — 文件写入

> 📄 详细设计：[docs/tools/write.md](./tools/write.md)

```
输入: file_path, content
输出: 成功信息 + 行变更统计

安全: 禁止写入工作目录之外
特殊: 自动创建父目录 (mkdir -p)
v2: 接入 file-mutation-queue 串行锁
```

### 4.3 edit — 精确字符串替换（批量 edits）

> 📄 详细设计：[docs/tools/edit.md](./tools/edit.md)

```
输入: file_path, edits: [{oldText, newText}]
      (向后兼容: old_string, new_string, replace_all?)
输出: 编辑成功，附上下文 diff

核心逻辑:
  1. 文件并发锁 — 确保同文件不竞态
  2. 读取文件 → 剥离 BOM → 行尾统一转 LF
  3. 精确匹配 → 失败降级模糊匹配（Unicode/空格/引号规范化）
  4. 重叠检测 → 逆序应用

v2: 批量 edits + BOM/LF 规范化 + 模糊匹配降级 + 文件并发锁（详见 docs/tools/edit.md）
```

**为什么用字符串匹配而非行号？**

这是从 Claude Code / pi 项目借鉴的核心设计：
- 行号会随编辑变化，多步编辑时行号失效
- 字符串匹配是幂等的——同一个 oldText 匹配同一个位置
- LLM 更擅长复制粘贴代码片段，而非计数行号

### 4.4 bash — Shell 执行

> 📄 详细设计：[docs/tools/bash.md](./tools/bash.md)

```
输入: command, timeout?, description?, run_in_background?
输出: stdout + stderr + exit code + 临时文件路径（截断时）

安全措施:
  1. 黑名单正则检查
  2. 超时限制（默认 60s，最大 300s）
  3. 溢出保护（stdout+stderr 超 200KB 时 kill 进程树）

v2: 尾部截断（保留末尾 2000 行/50KB）+ 临时文件保存 + taskkill /T 进程树 kill
```

### 4.5 grep — 内容搜索

> 📄 详细设计：[docs/tools/grep.md](./tools/grep.md)

```
输入: pattern, path?, glob?, type?, ignoreCase?, literal?, context?, limit?
输出: 匹配行 + 行号 + 可选上下文行

实现: 调用系统 rg，--json 结构化输出解析

v2: JSON 解析 + 隐藏文件 + 字面量搜索 + 文件缓存上下文 + 提前 kill
```

### 4.6 glob — 文件名匹配

```
输入: pattern, path?
输出: 匹配的文件路径列表

实现: Node.js 递归目录遍历 + glob-to-regex 转换
支持: ** (任意深度), * (单层), ? (单字符), {a,b} (选择)
限制: 500 个结果上限
忽略: node_modules, .git, dist 等常见目录
```

---

## 5. 工具注册中心

```typescript
class ToolRegistry {
  private tools: Map<string, Tool>;

  register(tool: Tool): void;     // 注册工具
  get(name: string): Tool;        // 查找工具
  getAll(): Tool[];               // 获取全部
  getDefinitions(): ToolDefinition[];  // 生成 LLM Schema 列表
  execute(name, callId, params): Promise<ToolResult>;  // 执行
}
```

### MCP 工具集成

MCP 工具通过 `mcp__<server>__<tool>` 前缀命名空间注册：

```
mcp__github__search_repos     → GitHub MCP 服务器
mcp__postgres__query           → PostgreSQL MCP 服务器
mcp__filesystem__read_file     → 文件系统 MCP 服务器
```

前缀机制解决了两个问题：

1. **命名冲突**：不同 MCP 服务器可能有同名工具
2. **可识别性**：用户和 LLM 都能看出工具来源

---

## 6. Agent Loop 中的工具调用流

```
                    ┌──────────┐
                    │ LLM 响应  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ 有 tool   │─── 否 ──→ 返回最终回答
                    │ _call?    │
                    └────┬─────┘
                         │ 是
                    ┌────▼──────────┐
                    │ 解析所有       │
                    │ ToolCall[]    │
                    └────┬──────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
         ┌────▼────┐          ┌────▼────┐
         │ Tool A  │          │ Tool B  │  并行执行（无依赖）
         └────┬────┘          └────┬────┘
              │                     │
         ┌────▼────┐          ┌────▼────┐
         │ Result A│          │ Result B│
         └────┬────┘          └────┬────┘
              │                     │
              └──────────┬──────────┘
                         │
                    ┌────▼──────────┐
                    │ 追加到上下文   │
                    │ 继续循环 →    │
                    └───────────────┘
```

### 回合事件 (v2026-06 新增)

参考 pi 项目的 `AgentEvent` 模型，引入 `turn_start` / `turn_end` 事件：

```
turn_start { turnCount, maxTurns }
    │
    ├─ thinking_start / thinking_delta / thinking_end
    ├─ text_delta (仅最终轮) / thinking_delta (中间轮)
    ├─ toolcall_start / toolcall_delta / toolcall_end
    │
    ├─ tool_execution_start (通过 worker message)
    │   └─ tool.execute()
    │   └─ tool_execution_end (通过 worker message)
    │
    └─ turn_end { turnCount, hasToolCalls }
```

**设计要点**：

- `turn_start` 在每轮开始时发送，携带当前轮次和最大轮次
- `turn_end` 携带 `hasToolCalls: true/false` 区分中间轮和最终轮
- 前端据此展示思考摘要：`🧠 第2轮 bash ls...`
- `text_end` 仅在最终轮（无工具调用）时发送
- 中间轮的叙述文本通过 `thinking_delta` 进入思考区，而非正文

### 工具参数验证 (v2026-06 新增)

在 Agent Loop 的工具执行阶段增加了运行时参数验证：

```
JSON.parse(tc.arguments)
    ↓
验证必需参数存在（根据 Tool Schema 的 required 字段）
    ↓ (缺少参数 → 返回错误 ToolResult，不执行)
类型强制转换（如字符串 "42" → 整数 42，修正常见的 LLM 错误）
    ↓
tool.execute(validatedParams)
```

```typescript
// 伪代码
for (const key of required) {
  if (params[key] === undefined || params[key] === null) {
    return { success: false, error: `缺少必需参数: ${key}` };
  }
  // 数字字符串→整数强制转换
  if (props[key]?.type === 'integer' && typeof params[key] === 'string') {
    params[key] = Number(params[key]);
  }
}
```

**为什么不用 TypeBox？** SunCode 使用自定义的轻量 schema helper (`p()`/`obj()`)
来定义工具参数，而非 TypeBox。API 层的 function calling JSON Schema 由 pi-ai 生成，
这里的验证是额外的防御层。

---

## 7. 前端工具卡片

每个工具调用在前端渲染为专用的操作卡片，嵌套在思考区（`<details>` 折叠块）内：

| 工具 | 卡片组件 | 展示内容 |
|------|---------|---------|
| `edit` / `write` | `FileOperationCard` | 文件路径、状态（编辑中/已编辑/失败）、+N/-N 行变更 |
| `bash` | `CommandOperationCard` | 命令、工作目录、退出码、stdout/stderr |
| `read` / `glob` / `grep` | `FileInspectCard` | 操作类型标签、路径/模式、输出预览（≤300 字符）|
| 其他/generic | inline generic | 工具名 + 状态 |

所有卡片内容来源于 `ToolCallContent.result`（通过 `startToolExecution` / `endToolExecution` 在 chat store 中注入）。

### 前端数据流

```
Worker: toolStart → main process → agent:tool-start
    ↓
useAgent.ts: chatStore.startToolExecution(toolCall)
    ↓ (创建或更新 ChatMessage.toolCalls[] 中的条目，status='running')

Worker: toolEnd → main process → agent:tool-end
    ↓
useAgent.ts: chatStore.endToolExecution(result)
    ↓ (注入 result.output / result.details)
    ↓
ToolOperationList → FileOperationCard / CommandOperationCard / FileInspectCard
```

---

## 8. 设计经验

### ✅ 有效实践

1. **工具描述要写"使用场景"而非"功能说明"**
   - ❌ "Reads a file"
   - ✅ "Reads a file to examine its contents. Use this before editing or when you need to understand existing code."

2. **参数 constrain 明确**
   - 字符串：说明格式和限制
   - 数字：说明范围和默认值
   - 布尔：说明 true/false 分别代表什么

3. **错误消息要对 LLM 有用**
   - ❌ "Error: ENOENT"
   - ✅ "File not found: /path/to/file. Check the path and try again."

4. **工具输出要结构化**

   ```
   File: /src/auth.ts (145 lines)
   
     1  import { Request } from 'express';
     2  
     3  export function authenticate(req: Request) {
   ...
   ```

### ❌ 常见陷阱

1. **参数 Schema 过于宽松**：`{"type": "string"}` 给 LLM 太大自由度
2. **输出过长导致上下文爆炸**：read 不加 limit 可能读 10000 行
3. **忽略时效性**：bash 命令超时设太长，用户等得不耐烦
4. **安全只是前端检查**：黑名单可被绕过，应配合沙箱（V2）

---

## 9. 聊天框渲染策略

### 9.1 流式阶段与完成阶段

| 阶段 | 思考区域 | 正文区域 | 说明 |
|------|---------|---------|------|
| 流式中 | `CompactToolBar` — 工具调用紧凑摘要 | `StreamingText` — 纯文本（不解析 Markdown） | Markdown 解析在流式阶段做 O(n²)，卡死 UI |
| 完成后（有工具） | `<details>` 折叠 → `ToolOperationList` — 完整工具卡片 | `StreamingText` — 完整 Markdown 渲染 | 不展示原始思考文本，思考内容走 CallTracePanel |
| 完成后（无工具） | 无 | `StreamingText` — 完整 Markdown 渲染 | |

### 9.2 CompactToolBar 紧凑工具条

流式阶段每个工具一行，完成后 bash 显示 stdout 尾 3 行、文件编辑显示 `+N -M` diff 统计。

```
> 运行  npm run build  完成
  Build successful in 2.3s
+ 编辑  utils.ts  完成
  +12 -5
$ 读取  utils.ts, config.ts  3 完成
```

### 9.3 工具调用跨轮累积

`chat.ts` `handleStreamEvent` 中工具调用**按 ID 合并**而非覆盖：
- `data.toolCalls` 只含当前轮的工具调用
- 跨轮时合并到 `target.toolCalls`，已存在的更新状态
- 避免最后一轮空 toolCalls 覆盖全部记录

### 9.4 思考文本不进入聊天框

- `mergeThinkingIntoAnswer()` 简化为直接返回 `assistantText`，不再合并思考内容
- 思考过程统一走右侧 `CallTracePanel` 查看
- 聊天框只展示工具调用摘要（流式中）和完整工具卡片（折叠展开）

### 9.5 CallTracePanel 调用轨迹面板

按时间线平铺展示，每条标注身份：

```
[用户]
  "帮我重构 src/utils.ts"
---┼---
[模型] 第1次调用  deepseek/v4-pro  2.1s  ↑1.2k ↓456  end_turn
  输入 · 3条消息  system≈3200
  思考 · 450字符 (可折叠)
  [调用工具] 2个
     bash "npm run build" → stdout, stderr, exit code
     read src/utils.ts → 文件内容
---┼---
[模型] 第2次调用  1.2s  ↑0.8k ↓234  stop
  [回复]
     已完成重构...
```

设计特点：
- 纯文本标签，无 emoji（解析友好）
- 可展开区域有 `>` 旋转箭头 + 悬停高亮
- 输入消息、思考过程、工具调用均可独立折叠
- 专用工具卡片复用 `CommandOperationCard` / `FileOperationCard` 等

---

## 10. 跨平台路径兼容

Windows 上 `node:path.resolve()` 返回反斜杠，而 LLM 传入的路径可能用正斜杠。`startsWith()` 比较会误判。

修复：所有工具在路径验证前统一 normalize：
- `ls.ts`: 自定义 `normalizePath()` 统一转正斜杠
- `glob.ts`, `find.ts`: 使用 `node:path.normalize()` 
- `read.ts`, `write.ts`, `edit.ts`, `grep.ts`: 已使用 `normalize()`，无需修改
