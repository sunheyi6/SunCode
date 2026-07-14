import { DEFAULT_SETTINGS } from '../src/shared/constants';
import type { AppSettings } from '../src/shared/types';

const PROTECTED_SETTINGS = new Set<keyof AppSettings>([
  'activeProvider',
  'activeModel',
  'customEndpoints',
  'envApiKeys',
  'permissionMode',
]);

export function parseSettingAssignment(assignment: string): [keyof AppSettings, unknown] {
  const separator = assignment.indexOf('=');
  if (separator <= 0) {
    throw new Error(`Setting must use key=value syntax: ${assignment}`);
  }
  const key = assignment.slice(0, separator).trim();
  const rawValue = assignment.slice(separator + 1).trim();
  if (!key || !rawValue) {
    throw new Error(`Setting must include a non-empty key and value: ${assignment}`);
  }

  let value: unknown = rawValue;
  try {
    value = JSON.parse(rawValue) as unknown;
  } catch {
    // Bare enum/string values such as semanticCompactMode=replace are intentional.
  }
  const patch = validateHarborSettingsPatch({ [key]: value });
  return [key as keyof AppSettings, patch[key as keyof AppSettings]];
}

export function validateHarborSettingsPatch(value: unknown): Partial<AppSettings> {
  if (!isRecord(value)) {
    throw new Error('SunCode settings patch must be a JSON object');
  }

  const patch: Record<string, unknown> = {};
  for (const [key, settingValue] of Object.entries(value)) {
    if (!(key in DEFAULT_SETTINGS)) {
      throw new Error(`Unknown SunCode setting in benchmark patch: ${key}`);
    }
    if (PROTECTED_SETTINGS.has(key as keyof AppSettings)) {
      throw new Error(`Benchmark settings patch cannot override protected setting: ${key}`);
    }
    validateSettingValue(key, settingValue, DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]);
    patch[key] = settingValue;
  }

  validateKnownRanges(patch);
  return patch as Partial<AppSettings>;
}

export function encodeHarborSettingsPatch(value: unknown): string {
  const patch = validateHarborSettingsPatch(value);
  return Buffer.from(JSON.stringify(patch), 'utf8').toString('base64');
}

export function decodeHarborSettingsPatch(encoded: string | undefined): Partial<AppSettings> {
  if (!encoded) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`SUNCODE_SETTINGS_PATCH_B64 is invalid: ${errorText(error)}`);
  }
  return validateHarborSettingsPatch(parsed);
}

function validateSettingValue(key: string, value: unknown, defaultValue: unknown): void {
  if (Array.isArray(defaultValue)) {
    if (!Array.isArray(value)) throw new Error(`SunCode setting ${key} must be an array`);
    return;
  }
  if (isRecord(defaultValue)) {
    if (!isRecord(value)) throw new Error(`SunCode setting ${key} must be an object`);
    return;
  }
  if (typeof value !== typeof defaultValue) {
    throw new Error(`SunCode setting ${key} must be ${typeof defaultValue}`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`SunCode setting ${key} must be finite`);
  }
}

function validateKnownRanges(patch: Record<string, unknown>): void {
  const mode = patch.semanticCompactMode;
  if (mode !== undefined && mode !== 'off' && mode !== 'shadow' && mode !== 'replace') {
    throw new Error('semanticCompactMode must be off, shadow, or replace');
  }
  validateRatio(patch, 'compactThreshold');
  validateRatio(patch, 'semanticCompactThreshold');
  validatePositiveInteger(patch, 'semanticCompactMinNewTokens');
  validatePositiveInteger(patch, 'semanticCompactMaxOutputTokens');
  validatePositiveInteger(patch, 'maxTurns');
}

function validateRatio(patch: Record<string, unknown>, key: string): void {
  const value = patch[key];
  if (value !== undefined && (typeof value !== 'number' || value <= 0 || value > 1)) {
    throw new Error(`${key} must be a number in (0, 1]`);
  }
}

function validatePositiveInteger(patch: Record<string, unknown>, key: string): void {
  const value = patch[key];
  if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
    throw new Error(`${key} must be a positive integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
