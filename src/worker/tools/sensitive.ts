/**
 * Sensitive-file detection — ported from Kimi Code (MoonshotAI/kimi-code).
 *
 * Blocks Read/Write/Edit operations on files that likely contain secrets,
 * preventing credential exfiltration through crafted prompts.
 *
 * The pattern list is intentionally small to avoid false positives.
 * Exemptions like `.env.example` are explicitly allowed.
 */

import { basename } from 'node:path';

/** Exact basename matches that always flag as sensitive. */
const SENSITIVE_BASENAMES = new Set<string>([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'credentials',
]);

/** Path-suffix pairs that flag as sensitive (e.g. ~/.aws/credentials). */
const SENSITIVE_PATH_SUFFIXES: readonly string[][] = [
  ['.aws', 'credentials'],
  ['.gcp', 'credentials'],
];

const ENV_PREFIX = '.env.';
const ENV_EXEMPTIONS = new Set<string>(['.env.example', '.env.sample', '.env.template']);

const SENSITIVE_BASENAME_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials'];
const PUBLIC_KEY_BASENAMES = new Set<string>(['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub']);

/** Suffixes that indicate a renamed/shielded sensitive file. */
const SENSITIVE_DOT_VARIANT_SUFFIXES = new Set<string>([
  '.bak',
  '.backup',
  '.copy',
  '.disabled',
  '.key',
  '.old',
  '.orig',
  '.pem',
  '.save',
  '.tmp',
]);

function comparable(str: string): string {
  return str.toLowerCase();
}

/**
 * Returns true if the file path points to a file that likely contains credentials
 * or other secrets and should not be read or modified by the AI agent.
 */
export function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);
  const comparableName = comparable(name);
  const comparablePath = comparable(filePath);

  // Explicit exemptions
  if (ENV_EXEMPTIONS.has(comparableName)) return false;
  if (PUBLIC_KEY_BASENAMES.has(comparableName)) return false;

  // Exact basename match
  if (SENSITIVE_BASENAMES.has(comparableName)) return true;

  // .env.* variants (but not .env.example etc.)
  if (comparableName.startsWith(ENV_PREFIX)) return true;

  // Prefix-based variants: id_rsa_backup, id_rsa.bak, id_rsa-old, etc.
  for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
    if (comparableName === prefix) return true;
    if (comparableName.length > prefix.length && comparableName.startsWith(prefix)) {
      const suffix = comparableName.slice(prefix.length);
      const next = suffix[0];
      if (next === '-' || next === '_') return true;
      if (next === '.' && SENSITIVE_DOT_VARIANT_SUFFIXES.has(suffix)) return true;
    }
  }

  // Path-suffix matches: .aws/credentials, .gcp/credentials
  for (const suffixParts of SENSITIVE_PATH_SUFFIXES) {
    const suffix = suffixParts.join('/');
    const comparableSuffix = comparable(suffix);
    if (
      comparablePath.endsWith(`/${comparableSuffix}`) ||
      comparablePath.endsWith(`\\${comparableSuffix}`) ||
      comparablePath.includes(`/${comparableSuffix}/`) ||
      comparablePath.includes(`\\${comparableSuffix}\\`)
    ) {
      return true;
    }
  }

  return false;
}
