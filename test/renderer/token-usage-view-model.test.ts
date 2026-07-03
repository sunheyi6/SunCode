import { describe, expect, it } from 'vitest';
import type { TokenUsageSummary } from '../../src/shared/types';
import {
  buildUsageViewModel,
  formatCompactTokens,
} from '../../src/renderer/components/settings/token-usage-view-model';

const summary: TokenUsageSummary = {
  daily: [
    { date: '2026-06-29', input: 100, output: 40, total: 140, runs: 1 },
    { date: '2026-07-01', input: 300, output: 100, total: 400, runs: 2 },
    { date: '2026-07-02', input: 600, output: 200, total: 800, runs: 3 },
    { date: '2026-07-03', input: 30, output: 10, total: 40, runs: 1 },
  ],
  byModel: [
    { modelName: 'deepseek-v4-pro', input: 1_900_000_000, output: 700_000_000, total: 2_600_000_000, runs: 6 },
    { modelName: 'deepseek-v4-flash', input: 500_000, output: 330_000, total: 830_000, runs: 1 },
  ],
  totals: { input: 1_900_500_030, output: 700_330_010, total: 2_600_830_040, runs: 7, messages: 23 },
};

describe('formatCompactTokens', () => {
  it('uses Chinese large-number units for dashboard totals', () => {
    expect(formatCompactTokens(2_600_000_000)).toBe('26亿');
    expect(formatCompactTokens(830_000)).toBe('83万');
    expect(formatCompactTokens(9_200)).toBe('9200');
  });
});

describe('buildUsageViewModel', () => {
  it('fills the selected date range and derives activity/model summary', () => {
    const viewModel = buildUsageViewModel(summary, 7, new Date('2026-07-03T10:00:00+08:00'));

    expect(viewModel.days).toHaveLength(7);
    expect(viewModel.days.map((day) => day.date)).toEqual([
      '2026-06-27',
      '2026-06-28',
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
    expect(viewModel.days[3]).toMatchObject({ date: '2026-06-30', total: 0, intensity: 0 });
    expect(viewModel.activeDays).toBe(4);
    expect(viewModel.currentStreak).toBe(3);
    expect(viewModel.messageCount).toBe(23);
    expect(viewModel.topModel).toMatchObject({
      modelName: 'deepseek-v4-pro',
      percentLabel: '100%',
    });
    expect(viewModel.models[1]).toMatchObject({
      modelName: 'deepseek-v4-flash',
      tokenLabel: '83万 tokens',
      percentLabel: '0.03%',
    });
  });
});
