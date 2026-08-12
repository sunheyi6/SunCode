import type { ImageAttachment } from './types';

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export const MAX_IMAGE_ATTACHMENTS = 5;
export const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;

export function isSupportedImageMimeType(mimeType: string): boolean {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

export function base64ByteLength(data: string): number {
  const normalized = data.replace(/\s/g, '');
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function imageAttachmentDataUrl(
  attachment: Pick<ImageAttachment, 'data' | 'mimeType'>,
): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

export function validateImageAttachments(attachments: ImageAttachment[]): string | undefined {
  if (attachments.length > MAX_IMAGE_ATTACHMENTS) {
    return `一次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片。`;
  }

  let totalBytes = 0;
  for (const attachment of attachments) {
    if (!attachment.id || !attachment.name || !attachment.data) return '图片附件数据不完整。';
    if (!isSupportedImageMimeType(attachment.mimeType)) {
      return `不支持 ${attachment.mimeType || '未知格式'} 图片。`;
    }
    const bytes = base64ByteLength(attachment.data);
    if (bytes > MAX_IMAGE_ATTACHMENT_BYTES) return `单张图片不能超过 20 MB：${attachment.name}`;
    totalBytes += bytes;
  }

  if (totalBytes > MAX_TOTAL_IMAGE_ATTACHMENT_BYTES) return '图片总大小不能超过 40 MB。';
  return undefined;
}
