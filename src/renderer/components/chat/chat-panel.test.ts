// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import { getFantasyWelcomeMessage } from './chat-panel';

describe('getFantasyWelcomeMessage', () => {
  test('uses a dawn greeting for early morning', () => {
    expect(getFantasyWelcomeMessage(new Date('2026-07-01T06:00:00'))).toContain('晨光');
  });

  test('uses a noon greeting around midday', () => {
    expect(getFantasyWelcomeMessage(new Date('2026-07-01T12:00:00'))).toContain('日冕');
  });

  test('uses an afternoon greeting before evening', () => {
    expect(getFantasyWelcomeMessage(new Date('2026-07-01T16:00:00'))).toContain('云塔');
  });

  test('uses an evening greeting after sunset', () => {
    expect(getFantasyWelcomeMessage(new Date('2026-07-01T20:00:00'))).toContain('星火');
  });

  test('uses a night greeting after midnight', () => {
    expect(getFantasyWelcomeMessage(new Date('2026-07-01T02:00:00'))).toContain('月潮');
  });
});
