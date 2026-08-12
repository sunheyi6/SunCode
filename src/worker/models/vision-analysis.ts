import type { AppSettings, ImageContent } from '@shared/types';
import { resolveApiKey } from '../utils/env';
import { createModelRegistry } from './registry';
import { resolveModelImageSupport, resolveVisionTarget, withImageInput } from './vision-routing';

const MAX_RESULT_CHARS = 12_000;

interface VisionAssistantMessage {
  content: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

type CompleteVision = (
  model: unknown,
  context: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<VisionAssistantMessage>;

export interface VisionAnalysisResult {
  observation: string;
  provider: string;
  model: string;
}

export function buildVisionContext(question: string, images: ImageContent[]) {
  return {
    systemPrompt:
      'You are a focused visual inspector. Answer only the requested question using observable image evidence. Preserve exact visible text when useful. When there are multiple images, identify them by order. Do not invent hidden state. Keep the result concise because it will be passed to another model.',
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: question.trim() || 'Describe the relevant visible details.',
          },
          ...images.map((image) => ({
            type: 'image' as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        timestamp: Date.now(),
      },
    ],
    tools: [],
  };
}

function modelApiKey(model: unknown, provider: string, settings: AppSettings): string | undefined {
  if (model && typeof model === 'object') {
    const apiKey = (model as { apiKey?: unknown }).apiKey;
    if (typeof apiKey === 'string' && apiKey) return apiKey;
  }
  return resolveApiKey(provider, settings);
}

export async function analyzeImages(
  settings: AppSettings,
  activeModel: unknown,
  images: ImageContent[],
  question: string,
): Promise<VisionAnalysisResult> {
  const target = resolveVisionTarget(settings, activeModel);
  if (!target) {
    throw new Error(
      `当前模型 ${settings.activeProvider}/${settings.activeModel} 不支持图片，且未开启或配置图片理解模型。`,
    );
  }

  const registry = createModelRegistry(settings.customEndpoints ?? []);
  const selectedModel =
    target.model === settings.activeModel
      ? activeModel
      : await registry.getModel(target.provider, target.model);
  if (!selectedModel) {
    throw new Error(`无法加载图片理解模型：${target.provider}/${target.model}`);
  }
  if (!resolveModelImageSupport(settings, target.provider, target.model, selectedModel)) {
    throw new Error(
      `模型 ${target.provider}/${target.model} 未声明图片输入能力。可在模型设置中手动覆盖。`,
    );
  }

  const pi = await import('@earendil-works/pi-ai');
  const completeVision = pi.completeSimple as unknown as CompleteVision;
  const result = await completeVision(
    target.forcedImageSupport ? withImageInput(selectedModel) : selectedModel,
    buildVisionContext(question, images),
    {
      apiKey: modelApiKey(selectedModel, target.provider, settings),
      maxTokens: 2048,
      reasoning: 'low',
      cacheRetention: 'none',
    },
  );

  if (result.stopReason === 'error') {
    throw new Error(result.errorMessage || '图片理解模型调用失败。');
  }
  const observation = result.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!observation) throw new Error('图片理解模型没有返回文字观察结果。');

  return {
    observation:
      observation.length > MAX_RESULT_CHARS
        ? `${observation.slice(0, MAX_RESULT_CHARS)}\n\n[视觉结果已截断]`
        : observation,
    provider: target.provider,
    model: target.model,
  };
}
