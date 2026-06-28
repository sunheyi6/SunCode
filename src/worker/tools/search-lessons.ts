import { BaseTool, obj, p } from './types';
import { searchLessons, loadLessonFile } from '../agent/lessons';
import type { LessonTriggerType } from '@shared/types';

/**
 * search_lessons tool — searches the failure lessons library.
 * Read-only, available in all permission modes.
 */
export function createSearchLessonsTool(workingDir: string) {
  return new (class SearchLessonsTool extends BaseTool {
    readonly name = 'search_lessons';
    readonly isReadonly = true;
    readonly description =
      '搜索失败教训库，查找与当前问题相关的历史教训。返回匹配的教训内容（问题描述、根因、正确做法）。' +
      '当你遇到工具执行失败、重复出错或不确定正确做法时，使用此工具查找历史经验。';
    readonly parameters = obj(
      {
        query: p('string', '搜索关键词，如工具名、错误信息、文件路径、技术术语等'),
        errorType: p(
          'string',
          '教训类型筛选：tool_failure | user_correction | run_error | goal_repeated_failure',
          { enum: ['tool_failure', 'user_correction', 'run_error', 'goal_repeated_failure'] },
        ),
        limit: p('integer', '最多返回条数，默认 3'),
      },
      ['query'],
    );

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      const query = params.query as string;
      const errorType = params.errorType as LessonTriggerType | undefined;
      const limit = (params.limit as number) || 3;

      if (!query) {
        return this.failure('query is required');
      }

      const results = searchLessons(workingDir, query, errorType, Math.min(limit, 10));

      if (results.length === 0) {
        return this.success(`未找到与 "${query}" 相关的教训记录。`);
      }

      const lines: string[] = [`找到 ${results.length} 条相关教训：`, ''];

      const typeLabels: Record<string, string> = {
        tool_failure: '工具执行失败',
        user_correction: '用户纠正',
        run_error: '运行错误',
        goal_repeated_failure: '目标反复失败',
      };

      for (let i = 0; i < results.length; i++) {
        const sr = results[i]!;
        const full = loadLessonFile(workingDir, sr.entry.slug);
        const entry = full || sr.entry;

        lines.push(`### ${entry.title}`);
        lines.push(
          `- 类型: ${entry.type} (${typeLabels[entry.type] || entry.type}) | 工具: ${entry.tool || '无'} | 日期: ${entry.date}`,
        );
        if (entry.problem) {
          lines.push(`- 问题: ${entry.problem}`);
        }
        if (entry.rootCause) {
          lines.push(`- 根因: ${entry.rootCause}`);
        }
        if (entry.solution) {
          lines.push(`- 正确做法: ${entry.solution}`);
        }
        if (entry.files.length > 0) {
          lines.push(`- 相关文件: ${entry.files.join(', ')}`);
        }
        lines.push('');
      }

      return this.success(lines.join('\n'));
    }
  })();
}
