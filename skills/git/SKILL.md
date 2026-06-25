---
name: git
description: >
  Git 工作流技能：原子提交、Conventional Commits、历史搜索 (blame/bisect/log -S)、
  rebase 清理。当用户提到 commit、提交、commit message、rebase、squash、git blame、
  bisect、查看提交历史、合并分支等关键词时触发。
allowed-tools: Bash, Read, Grep, Glob
---

# Git 工作流

## 模式识别

根据用户意图自动选择模式：

| 关键词 | 模式 |
|--------|------|
| commit、提交、暂存、stage | **COMMIT** — 创建原子提交（仅本地） |
| push、推送、远端、上传、push到远程 | **PUSH** — 推送已存在的本地提交到远程 |
| 提交到远端、提交到远程、commit and push | **COMMIT+PUSH** — 完整提交并推送（走 COMMIT → PUSH 流程） |
| rebase、squash、清理历史、整理提交 | **REBASE** — 重写历史 |
| who changed、blame、谁改的、bisect、什么时候引入 | **HISTORY** — 搜索历史 |

不要默认使用 COMMIT 模式。先解析用户的实际请求。

**重要**：如果用户说的是"提交到远端"/"commit and push"，你必须完成 git add → git commit → git push 三个步骤。只 commit 不 push 是失败。

---

## COMMIT 模式

### Phase 0: 并行收集上下文

同时执行（无依赖）。**如果当前会话已检测过 commit 风格，可跳过 `git log --oneline -20`。**

```bash
git status
git diff --stat
git diff --cached --stat
git branch --show-current
git log --oneline -20   # 仅首次或风格未知时需要
```

### Phase 1: 风格检测（同会话内只执行一次）

**如果在当前会话中已经检测过此项目的 commit 风格，直接跳过此 Phase，使用之前的结果。**

分析最近 20 条 commit，判断项目使用的风格：

| 风格 | 模式 | 示例 |
|------|------|------|
| **SEMANTIC** | `type: message` 或 `type(scope): message` | `feat: add login` `fix(auth): token refresh` |
| **PLAIN** | 无前缀，>3 词 | `Add login feature` |
| **SHORT** | 1-3 词 | `format` `lint fix` |

**规则**：如果 ≥10 条 semantic → SEMANTIC；≥10 条 plain → PLAIN；≥8 条 short → SHORT；否则默认 PLAIN。

检测完毕后，用一句话报告检测结果（例如"检测到项目使用 SEMANTIC 风格"），然后继续。

### Phase 2: 原子提交规划

**硬性规则**（不遵守视为失败）：

| 文件数 | 最少提交数 |
|--------|-----------|
| 3+ | ≥2 |
| 5+ | ≥3 |
| 10+ | ≥5 |

**PUSH 模式下的务实调整**：当用户要求"提交到远端"时，push 是最高优先级。在不违反硬性规则的前提下：
- 避免在 commit message 中使用括号 `()` 等特殊字符（在 Windows PowerShell 中会导致引号问题）。可以用 `type/scope: message` 或 `type-scope: message` 替代 `type(scope): message`
- 如果某个 commit 的 message 在 Windows 上执行失败，立即换用不带括号的格式重试，不要在同一问题上消耗超过 2 个 turn

按以下优先级拆分：
1. 不同目录/模块 → 不同提交
2. 不同类型（逻辑/配置/测试/文档）→ 不同提交
3. 新文件 vs 修改已有文件 → 不同提交
4. 可独立 revert 的变更 → 不同提交

**依赖顺序**：工具函数 → 类型/模型 → 服务/逻辑 → API/接口 → 配置/文档。

测试必须和实现代码放在同一个 commit 里。

如果某个 commit 包含 3 个以上文件，需要在 commit message 的 body 里写一句话解释为什么它们不可拆分。无效理由如"全都是某个功能相关的"会被拒绝。

输出提交计划：每个 commit 列出文件列表 + 一句话说明 + 执行顺序。**保持简短——用表格呈现，不要写长段落分析。总输出控制在 10 行以内。**

**确认规则（根据当前权限模式）**：
- `full_access` / `auto_edit`：输出计划后直接执行，不需要等待确认。
- `confirm_changes`：输出计划后等待用户确认再执行。
- `plan`：只输出计划，不执行。

### Phase 3: 执行提交

对每个计划的 commit：

```bash
# 1. 显式暂存指定文件（禁止 git add -A / git add .）
git add <path1> <path2>

# 2. 确认暂存内容正确
git diff --staged --stat

# 3. 提交（单行消息，跨平台兼容）
git commit -m "type(scope): short description"
```

**如需多行 commit body**（3 个以上文件时推荐），使用以下方式：
```bash
# Windows PowerShell / Git Bash / Linux bash 都可用
git commit -m "type(scope): short description" -m "Detailed body explaining why these files are grouped together."
```

**不允许**：
- `git add -A` 或 `git add .`
- `git commit --no-verify`（跳过 hooks）
- `git commit --amend`（除非用户明确要求）
- 提交 `.env`、credentials、tokens 等密钥文件 — 如果发现，先警告用户
- **使用 heredoc (`<<'EOF'`) 语法** — 在 Windows PowerShell 上不支持

### Phase 4: 验证

```bash
git status              # 确认工作区干净
git log --oneline -5    # 确认新提交在历史中
```

### Phase 5: 推送到远端（仅 COMMIT+PUSH 模式）

**当用户要求"提交到远端"/"push"时，此步骤是强制性的，跳过视为失败。**

**核心规则：将所有 commit + push 用 `&&` 串联在一条 bash 命令中执行。** 不要在 commit 之间输出文本、不要分多次 bash 调用、不要做 `git diff --staged --stat` 逐个验证。一次调用，全部完成。理由：每个独立的 bash 调用消耗一个 turn，分多次调用会耗尽 turn 配额，导致 push 永远无法执行。

```bash
# 一次性执行所有 commit + push
git add <files1> && git commit -m "msg1" && git add <files2> && git commit -m "msg2" && git add <files3> && git commit -m "msg3" && git push origin <branch>
```

**执行后验证**（单次 bash 调用）：
```bash
git log --oneline -3 && echo "--- pushed commits above ---"
```

**禁止的行为**：
- ❌ 每个 commit 单独调用一次 bash → 浪费 turn
- ❌ 在 commit 之间输出 "Commit 2 ✔️。Commit 3：" → 无意义，消耗 turn
- ❌ 每步都要 `git diff --staged --stat` 验证 → PUSH 模式下省略，出错时 git 会自动报错
- ❌ 先 commit 完所有再单独 push → 分两次也浪费 turn，必须链在一起
- ❌ 把执行步骤输出为正文（visible text）→ 进度信息应放在 thinking 中，正文只展示最终结果

**如果 push 被拒绝**：`git fetch && git rebase origin/<branch>`，然后重试 push。不要用 `--force`（除非用户明确要求且分支不是 main/master）。

**常见失败原因**：
- 认证问题 → 告知用户检查 git credential
- 远端有新提交 → `git pull --rebase` 后重试
- 分支保护 → 告知用户需要 PR 流程

---

## Conventional Commits 格式

当项目使用 SEMANTIC 风格时：

```
type(scope): short description

[optional body]
```

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 格式调整（不影响逻辑） |
| `refactor` | 重构（不改变功能） |
| `test` | 测试 |
| `chore` | 构建/工具/依赖 |
| `perf` | 性能优化 |

- scope 从分支名推导（如 `fix/auth-token` → scope `auth`）或从修改的模块名推导
- 主语用祈使句（"add" 不是 "adds"）
- 首行 ≤ 72 字符，不加句号

---

## REBASE 模式

### 安全检查

- **绝对不要** rebase `main`/`master` 分支
- 如果有未暂存的修改，先 `git stash`
- 如果 commit 已推送到远程，警告用户需要用 `--force-with-lease`

### 策略

| 场景 | 策略 |
|------|------|
| 合并多个小 commit 为一个 | `git reset --soft $(git merge-base HEAD main)` 然后重新提交 |
| 整理 fixup commit | `git rebase -i --autosquash` |
| 更新到最新 main | `git rebase origin/main` |

冲突解决：
1. 读冲突文件，理解冲突原因
2. 解决冲突标记
3. `git add <resolved-file>`
4. `git rebase --continue`

恢复：`git rebase --abort` 可以完全回退。

---

## HISTORY 模式

| 需求 | 命令 |
|------|------|
| 某行代码是谁写的 | `git blame -L <start>,<end> <file>` |
| 某个字符串什么时候加入的 | `git log -S "string" -- <file>` |
| 什么时候引入了 bug | `git bisect start; git bisect bad; git bisect good <hash>; ...` |
| 文件的完整修改历史 | `git log --follow -p -- <file>` |
| 包含某正则的提交 | `git log -G "regex" -- <file>` |

**`-S` vs `-G`**：`-S` 找字符串出现次数变化的提交；`-G` 找 diff 中包含正则的提交。

---

## 安全规则

1. **绝不 force push 到 `main`/`master`**
2. 推送前确认 `git status` 干净
3. 推送前运行 `git log --oneline origin/main..HEAD` 确认要推送的提交
4. 如果 push 被拒绝，先 `git fetch && git rebase`，不要 `--force`
5. 永远不要提交密钥、token、`.env` 文件
6. 不要修改已经推送到共享分支的提交历史

---

## 反模式

| ❌ | ✅ |
|----|----|
| 10 个文件改动用 1 个 commit | 按模块/关注点拆分为多个 commit |
| `git add -A` | `git add <specific-files>` |
| 默认 Conventional Commits | 先 `git log` 检测项目风格 |
| rebase main 分支 | 永远不要 |
| `git push --force` | `git push --force-with-lease` |
| amend 已推送的 commit | 新建一个 fix commit |
| 跳过 hooks (`--no-verify`) | 修复 hook 报错的问题 |
| commit message "fix bug" | "fix(auth): handle expired token gracefully" |

---

## 使用方式

在系统提示词中注入：

```
<available_skills>
  <skill>
    <name>git</name>
    <description>Git 工作流：原子提交、Conventional Commits、rebase、历史搜索</description>
    <location>.suncode/skills/git/SKILL.md</location>
  </skill>
</available_skills>
```

模型在遇到 Git 相关任务时，先用 `read` 工具读取此文件，然后遵循其中的规则执行。
