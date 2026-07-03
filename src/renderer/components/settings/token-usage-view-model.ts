import type { DayStats, ModelStats, TokenUsageSummary } from '@shared/types';

export interface UsageDayView {
  date: string;
  input: number;
  output: number;
  total: number;
  runs: number;
  label: string;
  intensity: number;
  height: string;
}

export interface UsageModelView extends ModelStats {
  color: string;
  tokenLabel: string;
  percent: number;
  percentLabel: string;
}

export interface UsageViewModel {
  totalTokensLabel: string;
  runs: number;
  messageCount: number;
  activeDays: number;
  currentStreak: number;
  topModel: UsageModelView | null;
  days: UsageDayView[];
  models: UsageModelView[];
  donutBackground: string;
}

const MODEL_COLORS = ['#1683f7', '#1e9345', '#8f6df2', '#59a8ef', '#2f7ed8'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function formatCompactTokens(value: number): string {
  if (value >= 100_000_000) return `${formatTrimmed(value / 100_000_000)}亿`;
  if (value >= 10_000) return `${formatTrimmed(value / 10_000)}万`;
  return String(value);
}

export function buildUsageViewModel(
  summary: TokenUsageSummary,
  rangeDays: number,
  today = new Date(),
): UsageViewModel {
  const days = buildRangeDays(summary.daily, rangeDays, today);
  const activeDays = days.filter((day) => day.total > 0).length;
  const currentStreak = countCurrentStreak(days);
  const models = buildModelViews(summary.byModel, summary.totals.total);

  return {
    totalTokensLabel: formatCompactTokens(summary.totals.total),
    runs: summary.totals.runs,
    messageCount: summary.totals.messages,
    activeDays,
    currentStreak,
    topModel: models[0] ?? null,
    days,
    models,
    donutBackground: buildDonutBackground(models),
  };
}

function buildRangeDays(daily: DayStats[], rangeDays: number, today: Date): UsageDayView[] {
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const end = startOfLocalDay(today);
  const start = new Date(end.getTime() - (rangeDays - 1) * DAY_MS);
  const rawDays: DayStats[] = [];

  for (let index = 0; index < rangeDays; index++) {
    const date = formatDateKey(new Date(start.getTime() + index * DAY_MS));
    rawDays.push(byDate.get(date) ?? { date, input: 0, output: 0, total: 0, runs: 0 });
  }

  const maxTotal = Math.max(1, ...rawDays.map((day) => day.total));
  return rawDays.map((day) => ({
    ...day,
    label: formatDateLabel(day.date),
    intensity: heatIntensity(day.total, maxTotal),
    height: `${Math.max(day.total > 0 ? 4 : 0, (day.total / maxTotal) * 100)}%`,
  }));
}

function buildModelViews(models: ModelStats[], totalTokens: number): UsageModelView[] {
  return models.map((model, index) => {
    const percent = totalTokens > 0 ? (model.total / totalTokens) * 100 : 0;
    return {
      ...model,
      color: MODEL_COLORS[index % MODEL_COLORS.length] as string,
      tokenLabel: `${formatCompactTokens(model.total)} tokens`,
      percent,
      percentLabel: formatPercent(percent),
    };
  });
}

function buildDonutBackground(models: UsageModelView[]): string {
  if (models.length === 0) return '#e8e8e8';

  let cursor = 0;
  const segments = models.map((model) => {
    const start = cursor;
    cursor += model.percent;
    return `${model.color} ${start}% ${cursor}%`;
  });
  return `conic-gradient(${segments.join(', ')})`;
}

function countCurrentStreak(days: UsageDayView[]): number {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index--) {
    if ((days[index]?.total ?? 0) <= 0) break;
    streak++;
  }
  return streak;
}

function heatIntensity(value: number, max: number): number {
  if (value <= 0) return 0;
  return Math.max(1, Math.ceil((value / max) * 5));
}

function formatPercent(percent: number): string {
  if (percent >= 99.95) return '100%';
  if (percent >= 10) return `${Number(percent.toFixed(1))}%`;
  if (percent >= 1) return `${Number(percent.toFixed(1))}%`;
  return `${Number(percent.toFixed(2))}%`;
}

function formatTrimmed(value: number): string {
  if (value >= 10) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, '');
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}
