/**
 * Fetch the full list of Windows commands from tldr-pages on GitHub.
 * Supports ETag-based incremental updates — only downloads when the list changed.
 *
 * Usage: bun run scripts/fetch-windows-commands.ts
 * npm script: "update:commands": "bun run scripts/fetch-windows-commands.ts"
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'src', 'shared', 'data', 'windows-commands.json');

const API_URL = 'https://api.github.com/repos/tldr-pages/tldr/contents/pages/windows';
const TIMEOUT_MS = 30_000;

/** Load existing data to get the stored ETag. */
function loadExisting(): { etag: string; commands: string[] } | null {
  try {
    if (!existsSync(DATA_FILE)) return null;
    const raw = readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return { etag: data.etag || '', commands: data.commands || [] };
  } catch {
    return null;
  }
}

async function main() {
  const existing = loadExisting();
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'SunCode/1.0',
  };
  if (existing?.etag) {
    headers['If-None-Match'] = existing.etag;
    console.log(`[fetch-commands] Using If-None-Match: ${existing.etag.slice(0, 20)}...`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    console.log(`[fetch-commands] Fetching: ${API_URL}`);
    const response = await fetch(API_URL, {
      headers,
      signal: controller.signal,
    });

    const responseEtag = response.headers.get('etag') || '';

    // 304 Not Modified — no update needed
    if (response.status === 304) {
      console.log('[fetch-commands] ✅ No update needed (304 Not Modified).');
      if (responseEtag && existing) {
        // Refresh the ETag just in case
        updateFile(existing.commands, responseEtag);
      }
      process.exit(0);
    }

    if (!response.ok) {
      console.error(`[fetch-commands] ❌ HTTP ${response.status}: ${response.statusText}`);
      process.exit(1);
    }

    const files = (await response.json()) as Array<{ name: string }>;
    const commands = files
      .map((f) => f.name.replace(/\.md$/, ''))
      .filter((n) => n.length > 0)
      .sort();

    console.log(`[fetch-commands] Got ${commands.length} Windows commands from tldr.`);

    if (existing && arraysEqual(existing.commands, commands) && !responseEtag) {
      console.log('[fetch-commands] Commands unchanged, skipping write.');
      process.exit(0);
    }

    const added = existing ? commands.filter((c) => !existing.commands.includes(c)) : [];
    const removed = existing ? existing.commands.filter((c) => !commands.includes(c)) : [];

    if (added.length > 0) console.log(`[fetch-commands] +${added.length} new: ${added.join(', ')}`);
    if (removed.length > 0) console.log(`[fetch-commands] -${removed.length} removed: ${removed.join(', ')}`);

    updateFile(commands, responseEtag);
    console.log('[fetch-commands] ✅ Updated successfully.');
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.error(`[fetch-commands] ❌ Request timed out after ${TIMEOUT_MS}ms`);
    } else {
      console.error(`[fetch-commands] ❌ Error: ${(err as Error).message}`);
    }
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

function updateFile(commands: string[], etag: string): void {
  // Read the existing file to preserve the linuxToWindows mapping
  let linuxToWindows: Record<string, string> = {};
  try {
    if (existsSync(DATA_FILE)) {
      const existing = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
      linuxToWindows = existing.linuxToWindows || {};
    }
  } catch {
    // Use empty mapping
  }

  const dataDir = dirname(DATA_FILE);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        updated: new Date().toISOString(),
        etag,
        source: 'https://github.com/tldr-pages/tldr/tree/main/pages/windows',
        commands,
        linuxToWindows,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

main();
