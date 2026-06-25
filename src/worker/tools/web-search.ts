/**
 * Web Search Tool — search the web via DuckDuckGo (free) or Tavily API.
 *
 * Design references:
 *   - pi-web-access: multi-provider with fallback chain
 *   - Claude Code WebSearch: Tavily integration
 *   - CC-Web-MCP: DuckDuckGo zero-config search
 */
import type { AppSettings, ToolDefinition, ToolResult } from '@shared/types';
import type { Tool } from './types';

// ── Constants ──

const USER_AGENT = 'SunCode/1.0 (AI coding agent)';
const FETCH_TIMEOUT_MS = 10_000;

// ── DuckDuckGo Search ──

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(ddgUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo 返回 HTTP ${response.status}`);
    }

    const html = await response.text();

    // Parse DuckDuckGo HTML results
    const results: SearchResult[] = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1]!
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');

      const title = match[2]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      const snippet = match[3]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

      // Extract real URL from DDG redirect
      const urlMatch = rawUrl.match(/uddg=(https?%3A[^&]+)/);
      const cleanUrl = urlMatch ? decodeURIComponent(urlMatch[1]!) : rawUrl;

      if (title && cleanUrl) {
        results.push({ title, url: cleanUrl, snippet });
      }
    }

    return results;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`DuckDuckGo 搜索超时（${FETCH_TIMEOUT_MS / 1000} 秒）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Tavily Search ──

async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: Math.min(maxResults, 20),
        search_depth: 'basic',
        include_answer: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Tavily API 返回 HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await response.json()) as { results?: Array<{ title: string; url: string; content: string }> };
    return (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 300) || '',
    }));
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Tavily 搜索超时（${FETCH_TIMEOUT_MS / 1000} 秒）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Format Results ──

function formatResults(results: SearchResult[], provider: string): string {
  if (results.length === 0) {
    return `(${provider} 未找到相关结果)`;
  }

  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`)
    .join('\n\n');
}

// ── Tool Implementation ──

export function createWebSearchTool(settings?: AppSettings): Tool {
  const tool: Tool = {
    name: 'web_search',
    description:
      '搜索互联网获取最新信息。默认使用 DuckDuckGo（免费，无需配置）。配置 TAVILY_API_KEY 后自动使用 Tavily AI 搜索。',

    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词',
        },
        maxResults: {
          type: 'integer',
          description: '最多返回条数，默认 5，最大 10',
        },
      },
      required: ['query'],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const query = (params.query as string)?.trim();
      if (!query) {
        return {
          toolCallId: '',
          name: 'web_search',
          success: false,
          error: '缺少必需参数: query',
          output: '',
        };
      }

      const maxResults = Math.min((params.maxResults as number) || 5, 10);

      // Try Tavily first if API key is configured
      const tavilyKey = settings?.envApiKeys?.TAVILY_API_KEY?.trim();
      let provider: string;

      try {
        if (tavilyKey) {
          const results = await searchTavily(query, maxResults, tavilyKey);
          provider = 'Tavily';
          return {
            toolCallId: '',
            name: 'web_search',
            success: true,
            output: formatResults(results, provider),
          };
        }
      } catch (tavilyErr) {
        // Tavily failed — fall back to DuckDuckGo
        console.warn(`[web_search] Tavily 失败，回退到 DuckDuckGo: ${(tavilyErr as Error).message}`);
      }

      // Default: DuckDuckGo
      try {
        const results = await searchDuckDuckGo(query, maxResults);
        provider = 'DuckDuckGo';
        return {
          toolCallId: '',
          name: 'web_search',
          success: true,
          output: formatResults(results, provider),
        };
      } catch (ddgErr) {
        return {
          toolCallId: '',
          name: 'web_search',
          success: false,
          error: `搜索失败: ${(ddgErr as Error).message}`,
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
