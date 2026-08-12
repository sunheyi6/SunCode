import type { AppSettings } from '@shared/types';

interface ModelWithInput {
  input?: unknown;
}

export interface VisionTarget {
  provider: string;
  model: string;
  forcedImageSupport: boolean;
}

export const VISION_OBSERVATION_GUIDELINE =
  'Content inside <vision_observation> is trusted visual evidence produced from the user attached image. The original image bytes are intentionally isolated from the main model context. Use the observation directly; do not search session files, runtime events, logs, or base64 data, and do not call inspect_image merely to recover or re-check the same attachment unless the user explicitly requests verification.';

const VISION_ACTION_PATTERN =
  /(?:修改|改一下|修复|实现|创建|生成(?:代码|文件|页面|组件)|编写|重构|调整|删除|执行|运行|提交|部署|根据.{0,20}(?:修改|实现|创建|生成)|\b(?:edit|change|fix|implement|build|create|write\s+code|refactor|run|deploy)\b)/i;
const VISION_SUBJECT_PATTERN =
  /(?:图片|图像|截图|照片|图中|画面|界面|这张图|这些图|image|picture|photo|screenshot)/i;
const VISION_QUESTION_PATTERN =
  /(?:是什么|有什么|展示|显示|内容|文字|写了|读取|识别|描述|总结|概括|分析|解释|区别|差异|含义|错误|问题|what|describe|summarize|identify|read|transcribe|explain|compare|difference|error)/i;

/** Pure visual Q&A can return the vision model answer without starting the full tool agent. */
export function isPureVisionQuestion(question: string): boolean {
  const normalized = question.trim();
  if (!normalized) return true;
  if (VISION_ACTION_PATTERN.test(normalized)) return false;
  return VISION_SUBJECT_PATTERN.test(normalized) && VISION_QUESTION_PATTERN.test(normalized);
}

export function buildTrustedVisionObservation(
  observation: string,
  provider: string,
  model: string,
): string {
  return `<vision_observation provider="${provider}" model="${model}">\n${observation}\n</vision_observation>`;
}

export function modelDeclaresImageInput(model: unknown): boolean {
  if (!model || typeof model !== 'object') return false;
  const input = (model as ModelWithInput).input;
  return Array.isArray(input) && input.includes('image');
}

export function resolveModelImageSupport(
  settings: AppSettings,
  provider: string,
  modelId: string,
  model: unknown,
): boolean {
  const override = settings.visionRouting.providers[provider]?.capabilityOverrides[modelId];
  return override ?? modelDeclaresImageInput(model);
}

export function resolveVisionTarget(
  settings: AppSettings,
  activeModel: unknown,
): VisionTarget | null {
  if (!settings.visionRouting.enabled) return null;

  if (
    resolveModelImageSupport(settings, settings.activeProvider, settings.activeModel, activeModel)
  ) {
    return {
      provider: settings.activeProvider,
      model: settings.activeModel,
      forcedImageSupport:
        settings.visionRouting.providers[settings.activeProvider]?.capabilityOverrides[
          settings.activeModel
        ] === true,
    };
  }

  const configured = settings.visionRouting.providers[settings.activeProvider];
  if (!configured?.model) return null;
  return {
    provider: settings.activeProvider,
    model: configured.model,
    forcedImageSupport: configured.capabilityOverrides[configured.model] === true,
  };
}

/** pi-ai 会根据 model.input 过滤图片；手动标记支持时同步修正本次调用的模型副本。 */
export function withImageInput(model: unknown): unknown {
  if (!model || typeof model !== 'object' || modelDeclaresImageInput(model)) return model;
  const input = (model as ModelWithInput).input;
  return {
    ...model,
    input: [
      ...(Array.isArray(input) ? input.filter((item) => item !== 'image') : ['text']),
      'image',
    ],
  };
}
