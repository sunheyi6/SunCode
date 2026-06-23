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

### 4.1 read — 文件读取

```
输入: file_path, offset?, limit?
输出: 带行号的文件内容 或 base64 图片数据

安全: 无（只读操作）
特殊: 自动识别图片（png/jpg/gif/webp），返回 base64
```

### 4.2 write — 文件写入

```
输入: file_path, content
输出: 成功信息 (# 行数, 字节数)

安全: 禁止写入工作目录之外
特殊: 自动创建父目录 (mkdir -p)
```

### 4.3 edit — 精确字符串替换

```
输入: file_path, old_string, new_string, replace_all?
输出: 替换数量

安全: 只读操作，然后覆盖写入
核心逻辑:
  1. 读取文件
  2. 检查 old_string 出现次数:
     - 0 次 → 报错 "not found"
     - >1 次且 replace_all ≠ true → 报错 "ambiguous"
  3. 执行替换 → 写回文件
```

**为什么用字符串匹配而非行号？**

这是从 Claude Code / pi 项目借鉴的核心设计：
- 行号会随编辑变化，多步编辑时行号失效
- 字符串匹配是幂等的——同一个 old_string 匹配同一个位置
- LLM 更擅长复制粘贴代码片段，而非计数行号

### 4.4 bash — Shell 执行

```
输入: command, timeout?, description?
输出: stdout + stderr + exit code

安全措施:
  1. 黑名单正则检查（rm -rf /, mkfs, dd, fork bomb）
  2. 超时限制（默认 60s，最大 300s）
  3. 输出截断（stdout/stderr 各 100KB 硬限制）
```

### 4.5 grep — 内容搜索

```
输入: pattern, path?, glob?, type?, multiline?, ignoreCase?, context?, head_limit?
输出: 匹配行 + 行号

实现: 调用系统 rg (ripgrep)，失败时 fallback 提示
默认限制: 100 行输出
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

### 📊 工具调用频率（典型 session）

| 工具 | 调用频率 | 占比 |
|------|---------|------|
| read | 12 | 40% |
| grep | 6 | 20% |
| edit | 4 | 13% |
| bash | 4 | 13% |
| glob | 3 | 10% |
| write | 1 | 3% |
