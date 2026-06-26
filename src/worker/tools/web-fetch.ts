/**
 * Web Fetch Tool — fetch URL content and return readable text.
 *
 * Design references:
 *   - pi-web-access (nicobailon): GitHub cloning, multi-level fallback
 *   - Claude Code WebFetch: SSRF protection, content type handling
 *   - CC-Web-MCP: IP blacklist, size limits
 */
import { lookup } from 'node:dns/promises';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition, ToolResult } from '@shared/types';
import type { Tool } from './types';

// ── Constants ──

const DEFAULT_MAX_LENGTH = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'SunCode/1.0 (AI coding agent)';
const MAX_REDIRECTS = 3;

// ── SSRF Protection ──

const BLOCKED_IP_RANGES = [
  // Loopback
  { prefix: '127.', mask: 8 },
  { prefix: '::1', mask: 128 },
  // Private
  { prefix: '10.', mask: 8 },
  { prefix: '172.16.', mask: 12 },
  { prefix: '192.168.', mask: 16 },
  // Link-local
  { prefix: '169.254.', mask: 16 },
  { prefix: 'fe80:', mask: 10 },
  // AWS Metadata (SSRF classic)
  { prefix: '169.254.169.254', mask: 32 },
];

function isPrivateIp(ip: string): boolean {
  for (const range of BLOCKED_IP_RANGES) {
    if (ip.startsWith(range.prefix)) return true;
  }
  // IPv4-mapped IPv6 loopback
  if (ip === '::ffff:127.0.0.1' || ip === '0:0:0:0:0:0:0:1') return true;
  return false;
}

async function validateUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `无效的 URL: ${url}`;
  }

  // Protocol whitelist
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return `不支持的协议: ${parsed.protocol}（仅允许 http/https）`;
  }

  // Resolve hostname and check IP
  try {
    const addresses = await lookup(parsed.hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        return `安全限制：不允许访问内部/私有网络地址 (${parsed.hostname} → ${addr.address})`;
      }
    }
  } catch {
    return `无法解析域名: ${parsed.hostname}`;
  }

  return null; // OK
}

// ── HTML to Text ──

function htmlToText(html: string): string {
  // Remove script, style, nav, header, footer, aside content
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  // Replace common block elements with newlines
  text = text.replace(/<\/?(?:br|p|div|h[1-6]|li|tr|section|article|main)[^>]*>/gi, '\n');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');

  // Collapse whitespace
  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return text;
}

// ── Content Extraction ──

async function extractContent(
  response: Response,
  maxLength: number,
): Promise<{ text: string; contentType: string }> {
  const contentType = response.headers.get('content-type') || 'text/plain';
  const raw = await response.text();

  if (raw.length === 0) {
    return { text: '(页面内容为空)', contentType };
  }

  let text: string;
  if (contentType.includes('text/html')) {
    text = htmlToText(raw);
  } else if (
    contentType.includes('text/') ||
    contentType.includes('application/json') ||
    contentType.includes('application/xml')
  ) {
    text = raw;
  } else {
    // Binary or unknown — return type info + first 1KB
    text = `Content-Type: ${contentType}\nBody length: ${raw.length} 字节\n\n${raw.slice(0, 1024)}`;
  }

  // Truncate
  if (text.length > maxLength) {
    const truncated = text.slice(0, maxLength);
    const lineCount = truncated.split('\n').length;
    return {
      text: `${truncated}\n\n... (内容已截断，原 ${text.length} 字符，显示前 ${maxLength} 字符)`,
      contentType,
    };
  }

  return { text, contentType };
}

// ── GitHub URL Handling ──

function isGithubUrl(
  url: string,
): { owner: string; repo: string; ref?: string; subpath?: string } | null {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+))?$/,
  );
  if (!match) return null;
  return {
    owner: match[1]!,
    repo: match[2]!.replace(/\.git$/, ''),
    ref: match[3],
    subpath: match[4],
  };
}

function isGithubBlobUrl(
  url: string,
): { owner: string; repo: string; ref: string; filePath: string } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/blob\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, ref: match[3]!, filePath: match[4]! };
}

async function cloneGithubRepo(
  url: string,
  workingDir: string,
): Promise<{ text: string; isClone: boolean; error?: string }> {
  // Check git availability
  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    return { text: 'Git 不可用，无法克隆仓库', isClone: false, error: 'git not found' };
  }

  // Clone into .suncode/github-repos/ inside working dir so `read` tool can access files
  const cloneBase = join(workingDir, '.suncode', 'github-repos');
  const cloneDir = join(cloneBase, Date.now().toString(36));
  const blobMatch = isGithubBlobUrl(url);
  const cloneMatch = isGithubUrl(url) || blobMatch;

  try {
    await mkdir(cloneDir, { recursive: true });

    const cloneUrl = blobMatch
      ? `https://github.com/${blobMatch.owner}/${blobMatch.repo}.git`
      : url
          .replace(/\/tree\/.*$/, '')
          .replace(/\/$/, '')
          .replace(/\/$/, '.git');

    execSync(`git clone --depth 1 --single-branch "${cloneUrl}" "${cloneDir}"`, {
      timeout: 30_000,
      stdio: 'pipe',
    });

    if (blobMatch) {
      const filePath = join(cloneDir, blobMatch.filePath);
      if (existsSync(filePath)) {
        const fs = await import('node:fs/promises');
        const content = await fs.readFile(filePath, 'utf-8');
        return {
          text: `# ${blobMatch.owner}/${blobMatch.repo}: ${blobMatch.filePath}\n\n\`\`\`\n${content}\n\`\`\``,
          isClone: true,
        };
      }
      return {
        text: `文件 ${blobMatch.filePath} 在仓库中不存在`,
        isClone: true,
        error: 'file not found in repo',
      };
    }

    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(cloneDir, { withFileTypes: true });
    const listing = entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.gitignore')
      .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
      .join('\n');

    return {
      text: `# ${cloneMatch!.owner}/${cloneMatch!.repo}\n\n本地路径: ${cloneDir}\n\n\`\`\`\n${listing}\n\`\`\``,
      isClone: true,
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    // Detect common failures for better LLM guidance
    const reason =
      errMsg.includes('not found') || errMsg.includes('Repository not found')
        ? '仓库不存在或无访问权限'
        : errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT')
          ? '克隆超时（可能需要配置 git 代理）'
          : errMsg.includes('Permission denied') || errMsg.includes('publickey')
            ? 'SSH 权限不足，尝试用 HTTPS URL'
            : `克隆失败: ${errMsg}`;

    return {
      text: `GitHub 克隆失败: ${reason}。请改用 web_fetch 直接获取 https://github.com/${cloneMatch?.owner ?? blobMatch?.owner}/${cloneMatch?.repo ?? blobMatch?.repo} 的页面内容。`,
      isClone: false,
      error: reason,
    };
  }
}

// ── Tool Implementation ──

export function createWebFetchTool(workingDir: string): Tool {
  const tool: Tool = {
    name: 'web_fetch',
    isReadonly: true,
    description:
      '获取指定 URL 的网页内容，返回清理后的文本。自动识别 GitHub 仓库并克隆到本地。支持 HTML、纯文本、JSON、XML 格式。包含 SSRF 防护。',

    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要获取的 URL（支持 http/https，GitHub 仓库 URL 会自动克隆到本地）',
        },
        maxLength: {
          type: 'integer',
          description: `最大返回字符数，默认 ${DEFAULT_MAX_LENGTH}`,
        },
      },
      required: ['url'],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const url = (params.url as string)?.trim();
      if (!url) {
        return {
          toolCallId: '',
          name: 'web_fetch',
          success: false,
          error: '缺少必需参数: url',
          output: '',
        };
      }

      const maxLength = (params.maxLength as number) || DEFAULT_MAX_LENGTH;

      // 1. Validate URL (SSRF check)
      const validationError = await validateUrl(url);
      if (validationError) {
        return {
          toolCallId: '',
          name: 'web_fetch',
          success: false,
          error: validationError,
          output: '',
        };
      }

      // 2. GitHub special handling — clone locally, fall back to HTTP on failure
      const ghInfo = isGithubUrl(url) || isGithubBlobUrl(url);
      if (ghInfo) {
        const result = await cloneGithubRepo(url, workingDir);
        if (result.isClone) {
          return {
            toolCallId: '',
            name: 'web_fetch',
            success: true,
            output: result.text,
          };
        }
        // Clone failed — return as error so LLM can immediately try HTTP instead
        return {
          toolCallId: '',
          name: 'web_fetch',
          success: false,
          error: result.text,
          output: '',
        };
      }

      // 3. Regular HTTP fetch
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        let response: Response;
        try {
          response = await fetch(url, {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html, text/plain, application/json, application/xml, */*',
            },
            signal: controller.signal,
            redirect: 'follow',
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const preview = await response.text().catch(() => '');
          return {
            toolCallId: '',
            name: 'web_fetch',
            success: false,
            error: `HTTP ${response.status} ${response.statusText}${preview ? `\n响应内容: ${preview.slice(0, 200)}` : ''}`,
            output: '',
          };
        }

        const { text, contentType } = await extractContent(response, maxLength);

        return {
          toolCallId: '',
          name: 'web_fetch',
          success: true,
          output: text,
        };
      } catch (err) {
        const msg =
          (err as Error).name === 'AbortError'
            ? `请求超时（${FETCH_TIMEOUT_MS / 1000} 秒）`
            : (err as Error).message;
        return {
          toolCallId: '',
          name: 'web_fetch',
          success: false,
          error: `获取失败: ${msg}`,
          output: '',
        };
      }
    },

    getDefinition(): ToolDefinition {
      return { name: this.name, description: this.description, parameters: this.parameters };
    },
  };

  return tool;
}
