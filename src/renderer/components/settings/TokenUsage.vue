<script setup lang="ts">
import type { ModelStats, TokenUsageSummary } from '@shared/types';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useStatsStore } from '../../stores/stats';

const statsStore = useStatsStore();
const chartDays = ref(14); // last N days to show
const animateReady = ref(false);

// Use cached stats from the store; if the user opens this tab before the
// preload finishes, trigger a load now. This avoids the blank -> data flash.
const stats = computed<TokenUsageSummary | null>(() => statsStore.tokenUsage);
const loading = computed(() => statsStore.tokenUsageLoading && !statsStore.hasTokenUsage);

onMounted(async () => {
  if (!statsStore.tokenUsageLoaded) {
    await statsStore.loadTokenUsage();
  }
  // Defer enabling CSS transitions until after the initial paint to avoid
  // animating every bar from 0 simultaneously when the tab first appears.
  void nextTick().then(() => {
    requestAnimationFrame(() => {
      animateReady.value = true;
    });
  });
});

// Reset animation readiness when cached data changes after the first load,
// so subsequent refreshes still animate smoothly instead of jumping.
watch(
  () => statsStore.tokenUsage,
  (value, oldValue) => {
    if (value && oldValue && animateReady.value) {
      animateReady.value = false;
      void nextTick().then(() => {
        requestAnimationFrame(() => {
          animateReady.value = true;
        });
      });
    }
  },
);

const filteredDaily = computed(() => {
  if (!stats.value) return [];
  const all = stats.value.daily;
  if (all.length <= chartDays.value) return all;
  return all.slice(-chartDays.value);
});

const chartMax = computed(() => {
  const max = Math.max(0, ...filteredDaily.value.map((d) => d.total));
  return max === 0 ? 1 : max;
});

// Rough cost estimate: GPT-4 level pricing ~ $2.5/1M input, $10/1M output
const estimatedCost = computed(() => {
  if (!stats.value) return '0.00';
  const { input, output } = stats.value.totals;
  return ((input / 1_000_000) * 2.5 + (output / 1_000_000) * 10).toFixed(2);
});

function barHeight(value: number): string {
  return `${Math.max(2, (value / chartMax.value) * 100)}%`;
}

function modelBarWidth(value: number, models: ModelStats[]): string {
  const max = Math.max(1, ...models.map((m) => m.total));
  return `${Math.max(2, (value / max) * 100)}%`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatDateLabel(date: string): string {
  const d = new Date(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
</script>

<template>
  <div class="token-usage">
    <!-- Summary cards -->
    <div class="summary-cards">
      <div class="stat-card">
        <span class="stat-label">总 Token 用量</span>
        <span class="stat-value">{{ stats ? formatTokens(stats.totals.total) : '—' }}</span>
        <span class="stat-sub">输入 {{ stats ? formatTokens(stats.totals.input) : '—' }} / 输出 {{ stats ? formatTokens(stats.totals.output) : '—' }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">运行次数</span>
        <span class="stat-value">{{ stats ? stats.totals.runs : '—' }}</span>
        <span class="stat-sub">次 Agent 运行</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">预估费用</span>
        <span class="stat-value">${{ estimatedCost }}</span>
        <span class="stat-sub">基于 GPT-4 级定价估算</span>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="loading-state">加载中...</div>

    <!-- Empty state -->
    <div v-else-if="!stats || stats.totals.runs === 0" class="empty-state">
      <span class="empty-icon">📊</span>
      <p>暂无 Token 使用数据</p>
      <p class="empty-hint">运行一次 Agent 对话后将开始记录用量统计</p>
    </div>

    <!-- Charts -->
    <template v-else>
      <!-- Daily chart -->
      <section class="chart-section">
        <div class="chart-header">
          <h3>📅 每日用量</h3>
          <div class="chart-toggles">
            <button
              v-for="d in [7, 14, 30]"
              :key="d"
              class="toggle-btn"
              :class="{ active: chartDays === d }"
              @click="chartDays = d"
            >{{ d }}天</button>
          </div>
        </div>

        <div class="bar-chart" v-if="filteredDaily.length > 0">
          <div class="bars-row">
            <div
              v-for="day in filteredDaily"
              :key="day.date"
              class="bar-col"
            >
              <div
                class="bar-fill"
                :class="{ animate: animateReady }"
                :style="{ height: barHeight(day.total) }"
              >
                <span class="bar-tip">{{ formatTokens(day.total) }}</span>
              </div>
              <span class="bar-label">{{ formatDateLabel(day.date) }}</span>
            </div>
          </div>
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-dot input-dot" />输入</span>
            <span class="legend-item"><span class="legend-dot output-dot" />输出</span>
          </div>
        </div>
        <p v-else class="no-data">无每日数据</p>
      </section>

      <!-- Model breakdown -->
      <section class="chart-section">
        <h3>🧠 模型用量分布</h3>
        <div class="model-list" v-if="stats.byModel.length > 0">
          <div v-for="m in stats.byModel" :key="m.modelName" class="model-row">
            <div class="model-info">
              <span class="model-name">{{ m.modelName }}</span>
              <span class="model-runs">{{ m.runs }} 次</span>
            </div>
            <div class="model-bar-wrap">
              <div
                class="model-bar-fill"
                :class="{ animate: animateReady }"
                :style="{ width: modelBarWidth(m.total, stats.byModel) }"
              />
            </div>
            <span class="model-tokens">{{ formatTokens(m.total) }}</span>
          </div>
        </div>
        <p v-else class="no-data">无模型数据</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.token-usage {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Summary cards */
.summary-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  padding: 14px;
  background: var(--color-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  gap: 4px;
}

.stat-label {
  font-size: 11px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
}

.stat-sub {
  font-size: 11px;
  color: var(--color-text-muted);
}

/* Loading & empty */
.loading-state {
  text-align: center;
  padding: 40px 0;
  color: var(--color-text-muted);
  font-size: 13px;
}

.empty-state {
  text-align: center;
  padding: 40px 0;
  color: var(--color-text-muted);
}

.empty-icon {
  font-size: 40px;
  display: block;
  margin-bottom: 10px;
}

.empty-state p {
  margin: 4px 0;
  font-size: 13px;
}

.empty-hint {
  font-size: 11px;
  opacity: 0.7;
}

/* Chart section */
.chart-section {
  background: var(--color-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
}

.chart-section h3 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.chart-header h3 {
  margin: 0;
}

.chart-toggles {
  display: flex;
  gap: 4px;
}

.toggle-btn {
  padding: 3px 10px;
  font-size: 11px;
  border: 1px solid var(--border-color);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: 4px;
}

.toggle-btn.active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-bg);
}

/* Bar chart */
.bar-chart {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bars-row {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 140px;
  padding: 0 4px;
}

.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  gap: 4px;
}

.bar-fill {
  width: 100%;
  max-width: 32px;
  background: color-mix(in srgb, var(--color-accent) 70%, transparent);
  border-radius: 3px 3px 0 0;
  position: relative;
  min-height: 2px;
  will-change: height;
}

.bar-fill.animate {
  transition: height 0.25s ease;
}

.bar-fill:hover {
  background: var(--color-accent);
}

.bar-tip {
  position: absolute;
  top: -18px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  color: var(--color-text-muted);
  white-space: nowrap;
  opacity: 0;
}

.bar-fill:hover .bar-tip {
  opacity: 1;
}

.bar-label {
  font-size: 10px;
  color: var(--color-text-muted);
}

.chart-legend {
  display: flex;
  gap: 16px;
  justify-content: center;
  margin-top: 4px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--color-text-muted);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.input-dot { background: color-mix(in srgb, var(--color-accent) 40%, transparent); }
.output-dot { background: var(--color-accent); }

.no-data {
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: center;
  padding: 20px 0;
}

/* Model list */
.model-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.model-info {
  width: 130px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.model-name {
  font-size: 12px;
  color: var(--color-text);
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-runs {
  font-size: 10px;
  color: var(--color-text-muted);
}

.model-bar-wrap {
  flex: 1;
  height: 8px;
  background: var(--color-bg);
  border-radius: 4px;
  overflow: hidden;
}

.model-bar-fill {
  height: 100%;
  background: var(--color-accent);
  border-radius: 4px;
  will-change: width;
}

.model-bar-fill.animate {
  transition: width 0.25s ease;
}

.model-tokens {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-weight: 550;
  flex-shrink: 0;
  width: 50px;
  text-align: right;
}
</style>
