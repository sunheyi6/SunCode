import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '@shared/types';
import { getAgentDataSubdir } from './agent-data-dir';
import { getGlobalInstructionsPath } from './agent-instructions';

export interface ProjectKnowledgeReference {
  entryPath: string;
  instruction: string;
}

interface PrepareProjectKnowledgeInput {
  workingDir: string;
  sessionId: string;
  settings: Pick<AppSettings, 'activeProvider' | 'activeModel' | 'thinkingLevel'>;
}

const PROJECT_KNOWLEDGE_INSTRUCTION =
  'For questions or changes about SunCode itself (including global user instructions, settings, memory, skills, logs, and architecture), first read the suncode skill from the available skills when present, then this runtime document. Use its resolved paths and linked documentation. The working directory may be an unrelated user project; do not search it for SunCode internals.';

export function prepareProjectKnowledge(
  input: PrepareProjectKnowledgeInput,
): ProjectKnowledgeReference | undefined {
  try {
    const runtimeDir = resolveRuntimeKnowledgeDir(input.workingDir, input.sessionId);
    const docsDir = resolveBuiltinDocsDir();
    mkdirSync(runtimeDir, { recursive: true });

    const entryPath = join(runtimeDir, 'project-info.md');
    writeFileSync(entryPath, buildProjectKnowledgeDocument(input, docsDir), 'utf8');

    return {
      entryPath,
      instruction: PROJECT_KNOWLEDGE_INSTRUCTION,
    };
  } catch (error) {
    console.warn(`[ProjectKnowledge] Failed to prepare document: ${(error as Error).message}`);
    return undefined;
  }
}

export function buildProjectKnowledgeDocument(
  input: PrepareProjectKnowledgeInput,
  docsDir?: string,
): string {
  const docsIndex = docsDir ? join(docsDir, 'README.md') : undefined;
  const staticProjectInfo = docsDir ? join(docsDir, 'project-info.md') : undefined;
  const globalInstructionsPath = getGlobalInstructionsPath();

  return [
    '# SunCode 项目信息入口',
    '',
    '> 本文件由 SunCode 在当前 Agent 运行开始时生成，是回答 SunCode 自身问题的本地权威入口。',
    '> 不包含 API Key 或其他密钥。动态配置以本文件为准，设计细节按需读取下方内置文档。',
    '',
    '## 当前运行配置',
    '',
    `- 当前 Provider：\`${input.settings.activeProvider}\``,
    `- 当前模型：\`${input.settings.activeModel}\``,
    `- 思考级别：\`${input.settings.thinkingLevel}\``,
    `- 当前工作目录：\`${input.workingDir}\``,
    `- 应用数据目录：${process.env.SUNCODE_APP_DATA ? `\`${process.env.SUNCODE_APP_DATA}\`` : '未设置（无头模式）'}`,
    '',
    '## 用户约束',
    '',
    `- 全局用户约束文件：\`${globalInstructionsPath}\``,
    `- 文件状态：${existsSync(globalInstructionsPath) ? '已存在（修改前读取）' : '尚未创建（可按用户要求创建）'}`,
    '- 此文件由 Agent 在每次运行开始时读取，对所有项目生效；运行中写入后，后续新运行会重新加载。',
    '',
    '## 内置文档',
    '',
    ...(docsIndex && staticProjectInfo && existsSync(docsIndex)
      ? [
          `- 完整设计文档索引：\`${docsIndex}\``,
          `- 路径、日志、构建与项目约束：\`${staticProjectInfo}\``,
          '',
          '回答架构、功能机制或路径问题时，先读取最相关的文档，不要遍历整个代码库或进行全局搜索。',
        ]
      : ['当前运行环境未找到内置设计文档目录。动态配置仍可直接使用上方信息。']),
    '',
  ].join('\n');
}

function resolveRuntimeKnowledgeDir(workingDir: string, sessionId: string): string {
  if (process.env.SUNCODE_APP_DATA) {
    return getAgentDataSubdir(workingDir, '.suncode/runtime', sessionId);
  }

  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return join(tmpdir(), 'suncode-runtime', safeSessionId || 'headless');
}

function resolveBuiltinDocsDir(): string | undefined {
  const configuredDir = process.env.SUNCODE_DOCS_DIR;
  if (configuredDir && existsSync(configuredDir)) return configuredDir;

  if (typeof process !== 'undefined' && process.resourcesPath) {
    const packagedDir = join(process.resourcesPath, 'docs');
    if (existsSync(packagedDir)) return packagedDir;
  }

  const developmentCandidates = [
    join(__dirname, '..', '..', 'docs'),
    join(__dirname, '..', '..', '..', 'docs'),
  ];
  return developmentCandidates.find((candidate) => existsSync(candidate));
}
