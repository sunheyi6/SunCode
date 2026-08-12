import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import type { AppSettings } from '@shared/types';
import { createModelRegistry } from '../models/registry';
import { analyzeImages } from '../models/vision-analysis';
import { BaseTool, obj, p } from './types';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export { buildVisionContext } from '../models/vision-analysis';

function resolveMimeType(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const mimeByExtension: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return ext ? mimeByExtension[ext] : undefined;
}

export function createInspectImageTool(workingDir: string, settings: AppSettings) {
  return new (class InspectImageTool extends BaseTool {
    readonly name = 'inspect_image';
    isReadonly = true;
    readonly description =
      'Analyzes a local PNG, JPG, GIF, or WEBP with the configured vision model. Use this instead of read for images. Provide a focused question so only relevant visual facts enter the main model context.';
    readonly parameters = obj(
      {
        file_path: p('string', 'The absolute or workspace-relative path to the image'),
        question: p('string', 'What to inspect, extract, compare, or verify in the image'),
      },
      ['file_path', 'question'],
    );

    async execute(params: Record<string, unknown>): ReturnType<BaseTool['execute']> {
      const filePath = params.file_path as string;
      const question = params.question as string;
      if (!filePath) return this.failure('file_path is required');
      if (!question?.trim()) return this.failure('question is required');
      if (!settings.visionRouting.enabled) {
        return this.failure('图片理解功能未开启。请在“设置 → 模型设置 → 图片理解”中开启。');
      }

      const absolutePath = normalize(
        isAbsolute(filePath) ? filePath : resolve(workingDir, filePath),
      );
      const mimeType = resolveMimeType(absolutePath);
      if (!mimeType) return this.failure('仅支持 PNG、JPG、JPEG、GIF 和 WEBP 图片。');

      try {
        const fileInfo = await stat(absolutePath);
        if (!fileInfo.isFile()) return this.failure(`不是文件：${absolutePath}`);
        if (fileInfo.size > MAX_IMAGE_BYTES) {
          return this.failure(`图片超过 20 MB 限制：${absolutePath}`);
        }

        const registry = createModelRegistry(settings.customEndpoints ?? []);
        const activeModel = await registry.getModel(settings.activeProvider, settings.activeModel);
        const image = await readFile(absolutePath);
        const result = await analyzeImages(
          settings,
          activeModel,
          [{ type: 'image', data: image.toString('base64'), mimeType }],
          question,
        );
        return this.success(
          `视觉模型：${result.provider}/${result.model}\n图片：${absolutePath}\n问题：${question.trim()}\n\n${result.observation}`,
        );
      } catch (error) {
        return this.failure(`图片理解失败：${(error as Error).message}`);
      }
    }
  })();
}
