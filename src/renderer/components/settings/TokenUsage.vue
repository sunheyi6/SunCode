<script setup lang="ts">
import type { TokenUsageSummary } from '@shared/types';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useStatsStore } from '../../stores/stats';
import { buildUsageViewModel } from './token-usage-view-model';

const statsStore = useStatsStore();
const selectedRange = ref(30);
const animateReady = ref(false);

const stats = computed<TokenUsageSummary | null>(() => statsStore.tokenUsage);
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const loading = computed(() => statsStore.tokenUsageLoading && !statsStore.hasTokenUsage);
const viewModel = computed(() =>
  stats.value ? buildUsageViewModel(stats.value, selectedRange.value) : null,
);

onMounted(async () => {
  if (!statsStore.tokenUsageLoaded) {
    await statsStore.loadTokenUsage();
  }
  armAnimations();
});

watch(
  () => [statsStore.tokenUsage, selectedRange.value],
  (value, oldValue) => {
    if (value && oldValue && animateReady.value) {
      animateReady.value = false;
      armAnimations();
    }
  },
);

function armAnimations(): void {
  void nextTick().then(() => {
    requestAnimationFrame(() => {
      animateReady.value = true;
    });
  });
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function shouldShowAxisLabel(index: number): boolean {
  const days = viewModel.value?.days ?? [];
  if (days.length === 0) return false;
  if (index === 0 || index === days.length - 1) return true;
  return index % 5 === 0;
}
</script>

<template>
  <div class="usage-panel">
    <div class="usage-toolbar">
      <span>时间范围</span>
      <div class="range-switch" aria-label="时间范围">
        <button
          v-for="range in [7, 30]"
          :key="range"
          type="button"
          :class="{ active: selectedRange === range }"
          @click="selectedRange = range"
        >
          最近 {{ range }} 天
        </button>
      </div>
    </div>

    <div v-if="loading" class="usage-state">加载中...</div>

    <div v-else-if="!viewModel || viewModel.runs === 0" class="usage-state empty">
      <strong>暂无 Token 使用数据</strong>
      <span>运行一次 Agent 对话后将开始记录用量统计</span>
    </div>

    <template v-else>
      <section class="metric-grid">
        <div class="metric-card">
          <span class="metric-label"><span class="metric-icon">♨</span> tokens 用量</span>
          <strong>{{ viewModel.totalTokensLabel }}</strong>
        </div>
        <div class="metric-card">
          <span class="metric-label"><span class="metric-icon">▱</span> 会话数量</span>
          <strong>{{ viewModel.runs }}</strong>
        </div>
        <div class="metric-card">
          <span class="metric-label"><span class="metric-icon">▭</span> 消息数量</span>
          <strong>{{ viewModel.messageCount }}</strong>
        </div>
        <div class="metric-card">
          <span class="metric-label"><span class="metric-icon">▦</span> 活跃天数</span>
          <strong>{{ viewModel.activeDays }}</strong>
        </div>
        <div class="metric-card">
          <span class="metric-label"><span class="metric-icon">▣</span> 当前连续天数</span>
          <strong>{{ viewModel.currentStreak }}</strong>
        </div>
        <div class="metric-card">
          <span class="metric-label"><span class="metric-icon">⌁</span> 最常用模型</span>
          <strong class="model-title">{{ viewModel.topModel?.modelName ?? '-' }}</strong>
          <small>占比 {{ viewModel.topModel?.percentLabel ?? '0%' }}</small>
        </div>
      </section>

      <section class="usage-card heatmap-card">
        <div class="section-header">
          <h3>活跃热力图</h3>
          <div class="heat-legend" aria-hidden="true">
            <span>较少</span>
            <i v-for="level in [0, 1, 2, 3, 4, 5]" :key="level" :class="`heat-${level}`" />
            <span>较多</span>
          </div>
        </div>
        <div class="heatmap">
          <span
            v-for="day in viewModel.days"
            :key="day.date"
            class="heat-cell"
            :class="`heat-${day.intensity}`"
            :title="`${day.label}: ${day.total} tokens`"
          />
        </div>
      </section>

      <section class="usage-card trend-card">
        <h3>按天 Token 趋势</h3>
        <div class="trend-plot">
          <div class="grid-lines" aria-hidden="true">
            <span v-for="line in 5" :key="line" />
          </div>
          <div class="trend-bars">
            <div v-for="(day, index) in viewModel.days" :key="day.date" class="trend-column">
              <div
                class="trend-bar"
                :class="{ animate: animateReady, empty: day.total === 0 }"
                :style="{ height: day.height }"
                :title="`${day.label}: ${day.total} tokens`"
              />
              <span :class="{ visible: shouldShowAxisLabel(index) }">{{ day.label }}</span>
            </div>
          </div>
        </div>
        <div class="model-legend">
          <span v-for="model in viewModel.models" :key="model.modelName">
            <i :style="{ background: model.color }" />
            {{ model.modelName }}
          </span>
        </div>
      </section>

      <section class="usage-card model-card">
        <h3>模型用量</h3>
        <div v-if="viewModel.models.length > 0" class="model-usage">
          <div class="donut" :style="{ background: viewModel.donutBackground }">
            <div class="donut-hole">
              <strong>{{ viewModel.totalTokensLabel }}</strong>
              <span>tokens</span>
            </div>
          </div>
          <div class="model-breakdown">
            <div v-for="model in viewModel.models" :key="model.modelName" class="model-row">
              <span class="model-dot" :style="{ background: model.color }" />
              <span class="model-copy">
                <strong>{{ model.modelName }}</strong>
                <small>{{ model.tokenLabel }}</small>
              </span>
              <span class="model-percent">{{ model.percentLabel }}</span>
            </div>
          </div>
        </div>
        <p v-else class="no-data">无模型数据</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.usage-panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.usage-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: var(--color-text);
  font-size: 15px;
}

.range-switch {
  display: inline-flex;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border-color-strong);
  border-radius: 10px;
  background: var(--color-bg);
}

.range-switch button {
  height: 30px;
  padding: 0 14px;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 14px;
}

.range-switch button.active {
  background: var(--color-surface-hover);
  color: var(--color-text);
  font-weight: 560;
}

.usage-state {
  display: flex;
  min-height: 220px;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 14px;
}

.usage-state.empty {
  flex-direction: column;
  gap: 8px;
  border-radius: 8px;
  background: var(--color-surface);
}

.usage-state strong {
  color: var(--color-text);
  font-size: 16px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.metric-card {
  display: flex;
  min-height: 110px;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  padding: 18px;
  border-radius: 8px;
  background: var(--color-surface);
}

.metric-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 15px;
}

.metric-icon {
  width: 18px;
  color: var(--color-text-secondary);
  font-size: 15px;
  text-align: center;
}

.metric-card strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: 38px;
  font-weight: 780;
  letter-spacing: 0;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-card .model-title {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.25;
}

.metric-card small {
  color: var(--color-text-muted);
  font-size: 14px;
}

.usage-card {
  border-radius: 8px;
  background: var(--color-surface);
  padding: 20px;
}

.usage-card h3,
.section-header h3 {
  margin: 0;
  color: var(--color-text);
  font-size: 16px;
  font-weight: 560;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.heat-legend {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.heat-legend i,
.heat-cell {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 5px;
}

.heatmap {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(7, 18px);
  justify-content: start;
  gap: 7px;
  overflow-x: auto;
  padding: 0 2px;
}

.heat-0 { background: color-mix(in srgb, var(--color-bg) 72%, var(--color-surface)); }
.heat-1 { background: #d7e9fb; }
.heat-2 { background: #acd0f4; }
.heat-3 { background: #7cb7ef; }
.heat-4 { background: #459bea; }
.heat-5 { background: #177fe8; }

.trend-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.trend-plot {
  position: relative;
  height: 330px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--color-bg);
  padding: 24px 24px 30px;
}

.grid-lines {
  position: absolute;
  inset: 24px 24px 52px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  pointer-events: none;
}

.grid-lines span {
  border-top: 1px dashed var(--border-color);
}

.trend-bars {
  position: relative;
  z-index: 1;
  display: flex;
  height: 100%;
  align-items: end;
  gap: 4px;
}

.trend-column {
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.trend-bar {
  width: min(24px, 70%);
  min-height: 4px;
  border-radius: 2px 2px 0 0;
  background: #1683f7;
  will-change: height;
}

.trend-bar.empty {
  min-height: 0;
  background: transparent;
}

.trend-bar.animate {
  transition: height 0.25s ease;
}

.trend-column span {
  width: 58px;
  height: 16px;
  color: var(--color-text-muted);
  font-size: 12px;
  opacity: 0;
  text-align: center;
  white-space: nowrap;
}

.trend-column span.visible {
  opacity: 1;
}

.model-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 18px 48px;
}

.model-legend span {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--color-text-muted);
  font-size: 15px;
}

.model-legend i,
.model-dot {
  display: block;
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.model-usage {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 36px;
  align-items: center;
  margin-top: 16px;
  padding: 36px 20px;
  border-radius: 8px;
  background: var(--color-bg);
}

.donut {
  display: flex;
  width: 232px;
  height: 232px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

.donut-hole {
  display: flex;
  width: 112px;
  height: 112px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--color-bg);
}

.donut-hole strong {
  color: var(--color-text);
  font-size: 24px;
  line-height: 1;
}

.donut-hole span {
  margin-top: 8px;
  color: var(--color-text-muted);
  font-size: 15px;
}

.model-breakdown {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.model-row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 74px;
  gap: 12px;
  align-items: center;
  min-height: 72px;
  border-bottom: 1px solid var(--border-color);
}

.model-row:last-child {
  border-bottom: 0;
}

.model-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.model-copy strong {
  overflow: hidden;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-copy small,
.model-percent {
  color: var(--color-text-muted);
  font-size: 15px;
}

.model-percent {
  font-family: var(--font-mono);
  text-align: right;
}

.no-data {
  margin: 18px 0 0;
  color: var(--color-text-muted);
  font-size: 14px;
}

@media (max-width: 980px) {
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .model-usage {
    grid-template-columns: 1fr;
    justify-items: center;
  }

  .model-breakdown {
    width: 100%;
  }
}

@media (max-width: 680px) {
  .usage-toolbar,
  .section-header {
    align-items: stretch;
    flex-direction: column;
  }

  .range-switch {
    align-self: flex-start;
  }

  .metric-grid {
    grid-template-columns: 1fr;
  }

  .trend-plot {
    height: 260px;
    padding-inline: 12px;
  }
}
</style>
