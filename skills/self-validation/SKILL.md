---
name: self-validation
description: >
  项目规范自检技能：在代码变更后对照项目约束、TypeScript 配置、Biome 规则、
  AGENTS.md 规范进行自我验证，确保产出符合项目质量标准。
  当用户提到"检查规范"、"自检"、"验证代码"、"self-check"、"质量检查"时触发。
  也在回合结束前自动执行（由 stop-hooks 触发）。
allowed-tools: Bash, Read, Grep, Glob, Edit, Write
---

# 项目规范自检

## 触发时机

| 场景 | 模式 |
|------|------|
| 用户主动要求检查 | **MANUAL** — 收到"检查规范/自检/验证代码"等关键词时 |
| 回合结束前自动触发 | **AUTO** — stop-hooks 在每次 turn 结束后自动执行（仅 `full_access` / `auto_edit` 模式） |
| 提交前验证 | **PRE_COMMIT** — 在执行 git commit 前快速验证关键项 |

## 阶段

### Phase 0: 收集上下文

同时执行以下操作（无依赖），收集当前变更范围：

```bash
# 获取当前变更的文件列表
git diff --name-only
git diff --cached --name-only
git status --short
```

> 如果已经知道变更范围（例如刚刚做完编辑），可跳过此阶段，直接进入检查。

### Phase 1: TypeScript 规范自检

对本次变更涉及的所有 `.ts` / `.vue` 文件，逐项对照以下规则：

#### 1.1 类型检查

| # | 规则 | 验证方式 | 严重度 |
|---|------|----------|--------|
| 1 | `strict: true` — 不允许隐式 `any` | `grep` 搜索新增代码中未标注类型的参数/变量 | error |
| 2 | 禁止 `any` 除非有 `// biome-ignore` 注释说明原因 | 搜索 `: any` / `as any` | warn |
| 3 | 可选属性不用 `| undefined` 标注 | 搜索新增代码中 `?: type | undefined` | error |
| 4 | `undefined` 直接传递，不用条件展开 `...(x ? { y } : {})` | 搜索新增代码中 `...(x ? {` 模式 | warn |

#### 1.2 代码风格

| # | 规则 | 验证方式 | 严重度 |
|---|------|----------|--------|
| 5 | 单参数内部方法不使用选项对象 | 检查新增方法签名 | warn |
| 6 | 类型和方法使用 PascalCase（类型）、camelCase（方法/变量） | `grep` 搜索新增定义 | warn |
| 7 | index.ts 优先用 `export * from './module'` | 检查新增的 index.ts | warn |
| 8 | 核心类构造函数不强制依赖外部生命周期对象 | 检查新增类构造函数参数 | error |

### Phase 2: Biome 规则自检

对变更文件运行 Biome 检查，区分 errors 和 warnings：

```bash
# 仅检查变更文件（而非全量），快速验证
npx biome check --changed --since=HEAD
```

> 如果 `--changed --since=HEAD` 不可用（旧版本 biome），则直接运行：
> ```bash
> npx biome check <file1> <file2> ...
> ```

**解读规则**：
- **errors**（退出码非零）：必须修复，否则阻塞提交
- **warnings**：建议修复，但不阻塞流程

常见 Biome 问题及修复方式：

| 问题类型 | Biome 规则 | 修复方式 |
|----------|-----------|----------|
| 未使用的变量 | `noUnusedVariables` | 删除或加 `// biome-ignore` |
| 未使用的导入 | `noUnusedImports` | 删除未使用的 import |
| 禁止的 `any` | `noExplicitAny` | 替换为具体类型，或加注释说明原因 |
| 非空断言 | `noNonNullAssertion` | 改用类型守卫或可选链 |
| 用了 `var` 未用 `const` | `useConst` | 替换为 `const` |
| 字符串拼接 | `useTemplate` | 改用模板字符串 `` `...${}...` `` |
| 使用了被禁用的类型 | `noBannedTypes` | 避免使用 `Function`、`String`、`Number`、`Boolean`、`Symbol`、`Object` 等 |
| 无用的构造函数 | `noUselessConstructor` | 删除空的或仅调用 `super()` 的构造函数 |

### Phase 3: 项目约束检查

对照 AGENTS.md / CLAUDE.md 中的项目约束，逐项验证：

#### 3.1 变更原则

| # | 约束 | 验证方式 |
|---|------|----------|
| 9 | **改动聚焦**：本次变更只做一件事 | 检查 git diff 中是否包含无关文件或跨模块修改 |
| 10 | 代码风格遵循已有模式，不引入新范式 | 对比变更前后代码风格是否一致 |
| 11 | 不引入无关重构 | 检查是否有原本不在任务范围内的重构 |

#### 3.2 测试规范

| # | 约束 | 验证方式 |
|---|------|----------|
| 12 | 优先添加到现有测试文件，不新建测试文件 | 检查是否有新测试文件被创建 |
| 13 | 测试失败时默认先修测试，除非实现真有 bug | —（需人工判断） |
| 14 | 测试验证行为而非特定字符串/文案 | 检查测试中是否 assert 了具体的错误消息文案 |
| 15 | 新增字段时用 `toMatchObject` 而非 `toEqual` | 检查测试中新增的 expect 调用 |

#### 3.3 提交规范

| # | 约束 | 验证方式 |
|---|------|----------|
| 16 | 提交时不添加共同作者 | 检查 `git log` 中 commit message 没有 `Co-authored-by` |
| 17 | 不在提交信息/PR/说明中暴露 agent 身份 | 检查提交信息中是否包含 AI 署名 |
| 18 | 不提交 `.env`、credentials、tokens | 检查 git diff 中是否包含敏感文件 |

### Phase 4: 架构一致性检查

对本次变更涉及的文件，验证是否符合项目架构约定：

| # | 架构约定 | 验证方式 |
|---|----------|----------|
| 19 | Electron Main → Worker → Agent → AgentLoop 单向依赖 | 检查 main 中是否反向引用了 worker 模块 |
| 20 | 工具实现 `Tool` 接口，标记 `isReadonly` 控制权限 | 检查新增工具类是否实现 `Tool` 接口 |
| 21 | Vue SFC 模板引用变量被 biome 误报时用 `// biome-ignore` 抑制 | 检查正确的 ignore 注释格式 |

### Phase 5: 输出报告

根据检查结果，按以下格式输出报告：

```markdown
## ✅ 自检报告

### 通过项
- [x] TypeScript 规范检查 — 无违规
- [x] Biome lint — 0 errors, 0 warnings
- [x] 项目约束 — 全部符合
- [x] 架构一致性 — 通过

### 违规项
- **P1-2**: `src/foo.ts:42` — 使用了 `as any` 但没有注释说明原因
  - 建议: 添加 `// biome-ignore lint/suspicious/noExplicitAny: <reason>` 注释
- **P2-1**: `src/bar.ts:15` — 未使用的导入 `useState`
  - 建议: 删除该导入

### 阻止提交的问题
- ❌ Biome error: `src/baz.ts:10` — 检测到 `noUnusedVariables`
```

**不同模式的输出行为**：

| 模式 | 输出 |
|------|------|
| **AUTO**（stop-hooks） | 仅在发现 **阻止提交的问题**（error 级别）时在 thinking 中报告；全部通过则静默 |
| **MANUAL** | 完整报告，包括通过项和违规项 |
| **PRE_COMMIT** | 只输出违规项，发现 error 时建议用户修复后再提交 |

## 触发方式

### 在 stop-hooks 中注入

```typescript
// stop-hooks.ts — 每次 turn 结束后自动触发 self-validation
import { readSkillAndExecute } from '../skills/loader';

export async function afterTurnHook(context: TurnContext): Promise<void> {
  if (context.permissionMode === 'full_access' || context.permissionMode === 'auto_edit') {
    // 检查本次 turn 是否有代码变更
    const hasChanges = await gitHasChanges();
    if (hasChanges) {
      await readSkillAndExecute('self-validation', { mode: 'AUTO', files: context.changedFiles });
    }
  }
}
```

### 在提交前手动触发

在 system prompt 中注入：

```
<available_skills>
  <skill>
    <name>self-validation</name>
    <description>项目规范自检：TypeScript 规则、Biome 检查、项目约束验证</description>
    <location>.suncode/skills/self-validation/SKILL.md</location>
  </skill>
</available_skills>
```

模型在收到"检查规范/自检"指令或准备提交代码时，先用 `read` 读取此文件，然后按阶段执行自检。

## 常见违规速查

| 代码模式 | 违反规则 | 正确做法 |
|----------|----------|----------|
| `function foo(x?: string \| undefined)` | 1.3 | `function foo(x?: string)` |
| `...(condition ? { key: val } : {})` | 1.4 | `if (condition) obj.key = val` |
| `const fn = (opts: {a: string})` (单参数内部方法) | 1.5 | `const fn = (a: string)` |
| `String`、`Number`、`Boolean` 作为类型标注 | 2.1 | `string`、`number`、`boolean` |
| `git commit -m "feat: add login" --no-verify` | 3.3 | 不要跳过 hooks |
| 没有 `isReadonly` 的新工具类 | 4 | 实现 `Tool` 接口并标记 `isReadonly` |
