/** 自定义端点表单（编辑态）的形状。 */
export interface EndpointForm {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  models: { id: string; name: string; contextWindow: string }[];
}

/** 由显示名生成唯一 provider id：custom-<slug>，冲突追加 -2/-3。 */
export function generateEndpointId(
  name: string,
  existingIds: string[],
  builtinIds: string[],
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `custom-${slug || 'endpoint'}`;
  const taken = new Set([...existingIds, ...builtinIds]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** 校验表单，返回错误消息列表（空表示合法）。 */
export function validateEndpoint(form: {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: { id: string }[];
}): string[] {
  const errs: string[] = [];
  if (!form.name.trim()) errs.push('显示名不能为空');
  if (!form.baseUrl.trim()) errs.push('URL 不能为空');
  else if (!/^https?:\/\//i.test(form.baseUrl.trim()))
    errs.push('URL 需以 http:// 或 https:// 开头');
  if (!form.apiKey.trim()) errs.push('API Key 不能为空');
  const validModels = form.models.filter((m) => m.id.trim());
  if (validModels.length === 0) errs.push('至少添加一个模型');
  return errs;
}
