import { describe, expect, it } from 'vitest';
import { formatHeaderTokenUsage } from '../../src/renderer/components/chat/header-token-usage';

describe('formatHeaderTokenUsage', () => {
  it('hides the label when no tokens have been consumed', () => {
    expect(formatHeaderTokenUsage(0)).toBe('');
  });

  it('formats the current total with thousands separators', () => {
    expect(formatHeaderTokenUsage(1234)).toBe('1,234 tokens');
  });
});
