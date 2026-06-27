# bash 工具 — 设计文档

## 1. 概述

bash 是 SunCode 的命令执行工具，让 agent 能运行 shell 命令、脚本、编译、测试等。v2 从 pi-1 迁移了两个关键改进：**尾部截断策略**（保留末尾而非开头）和**进程树 kill**（级联杀子进程）。

---

## 2. 核心流程

```
┌──────────────────────────────────────────────┐
│              bash.ts (工具入口)               │
│                                              │
│  1. 安全检查（黑名单正则）                    │
│  2. 选择 shell: powershell.exe / /bin/bash   │
│                                              │
│  ┌───── foreground ─────┐ ┌── background ───┐│
│  │ spawn(shell, command)│ │ spawn + detach  ││
│  │  │                   │ │  │              ││
│  │  ▼                   │ │  ▼              ││
│  │ 累积 stdout/stderr   │ │ onBackgroundStart││
│  │  │                   │ │  │              ││
│  │  ▼                   │ │  ▼              ││
│  │ 溢出(200KB)? → kill  │ │ child.unref()   ││
│  │  │                   │ │  │              ││
│  │  ▼                   │ │  ▼              ││
│  │ 进程结束              │ │ 回调通知  ││
│  │  │                   │ │                ││
│  │  ▼                   │ └────────────────┘│
│  │ truncateTail()        │                   │
│  │  │ (保留最后 2000行/  │                   │
│  │  │  50KB)            │                   │
│  │  ▼                   │                   │
│  │ 截断? → 存完整输出到  │                   │
│  │  temp file            │                   │
│  │  ▼                   │                   │
│  │ 返回 ToolResult       │                   │
│  └──────────────────────┘                   │
└──────────────────────────────────────────────┘
```

---

## 3. 尾部截断策略

### 3.1 为什么是尾部而非头部

bash 输出中最有价值的内容通常在最末尾：

- **编译错误**：错误信息在输出的最后
- **测试结果**：`Tests: 8 passed, 1 failed` 在最后
- **构建输出**：最终状态在末尾
- **git 操作**：结果在最后一行

v1 用 `stdout.slice(0, 50000)` 截取头部，导致这些关键信息被丢弃。

### 3.2 实现

```typescript
function truncateTail(content, maxLines = 2000, maxBytes = 50000) {
    const lines = content.split('\n');

    // 从末尾向前收集，直到达到 line/byte 限制
    const outputLines = [];
    let outputBytes = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(lines[i]) + (outputLines.length > 0 ? 1 : 0);
        if (outputBytes + lineBytes > maxBytes) {
            // 边界情况：还没加任何行，单行就超限 → 截取该行尾部
            if (outputLines.length === 0) {
                const buf = Buffer.from(lines[i]);
                const tail = buf.subarray(Math.max(0, buf.length - maxBytes));
                outputLines.unshift(tail.toString());
            }
            break;
        }
        outputLines.unshift(lines[i]);
        outputBytes += lineBytes;
    }

    return {
        text: `... (${lines.length - outputLines.length} lines skipped)\n` + outputLines.join('\n'),
        truncated: outputLines.length < lines.length
    };
}
```

### 3.3 截断标志

输出被截断时的提示：

```
... (1234 earlier lines skipped)
[compilation error output here...]

[Full output saved to: /tmp/suncode-bash-abc123.log]
```

---

## 4. 临时文件保存

### 4.1 触发条件

- 输出超过 2000 行
- 输出超过 50KB
- 溢出被强制 kill

### 4.2 实现

```typescript
const id = randomBytes(8).toString('hex');
const fullOutputPath = join(tmpdir(), `suncode-bash-${id}.log`);

// stdout + stderr 完整写入 temp file
stream.write(stdout);
if (stderr) {
    stream.write('\n--- STDERR ---\n');
    stream.write(stderr);
}
```

结果中携带路径，agent 可以用 read 工具查看完整输出。

---

## 5. 进程树 kill

### 5.1 问题

`child.kill()` 只杀直接子进程。如果命令启动子进程（如 `npm run build` 启动 webpack），kill 后子进程变成孤儿继续运行。

### 5.2 实现

```typescript
function killProcessTree(pid: number): void {
    if (process.platform === 'win32') {
        // Windows: taskkill /T 级联杀进程树
        spawn('taskkill', ['/F', '/T', '/PID', String(pid)]);
    } else {
        // Unix: SIGKILL 进程组
        try { process.kill(-pid, 'SIGKILL'); }
        catch { process.kill(pid, 'SIGKILL'); }
    }
}
```

### 5.3 触发时机

- stdout/stderr 超过 200KB → kill 进程树
- timeout 到期 → spawn 内置超时机制

---

## 6. 安全措施

| 措施 | 实现 |
|------|------|
| 黑名单正则 | `rm -rf /`, `mkfs`, `dd if=`, fork bomb 等 |
| 路径限制 | 命令在 workingDir 执行，不限制参数路径 |
| 超时 | 默认 60s，最多 300s |
| 溢出保护 | stdout+stderr 超 200KB 时 kill 进程树 |
| 进程孤儿预防 | `taskkill /T`（Win）/ `SIGKILL -pid`（Unix） |

---

## 7. 参数设计

```json
{
  "command": "npm run build",
  "timeout": 120000,
  "description": "构建前端资源",
  "run_in_background": false
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `command` | string | ✅ | Shell 命令 |
| `timeout` | number | ❌ | 超时毫秒（默认 60000，最大 300000） |
| `description` | string | ❌ | UI 展示用，5-10 词 |
| `run_in_background` | boolean | ❌ | 后台模式（dev server 等） |

---

## 8. 输出格式

```
Command: npm run build
Exit code: 0

STDOUT:
> build output here...

STDERR:
> warnings here...

[Full output saved to: /tmp/suncode-bash-abc123.log]
```

---

## 9. 关键文件

| 文件 | 职责 |
|------|------|
| `src/worker/tools/bash.ts` | 工具入口，进程管理，截断逻辑 |
| `src/shared/types.ts` | `CommandDetails` 类型（含 `fullOutputPath`） |
| `src/worker/agent/system-prompt.ts` | LLM 指令：输出截断说明 |
