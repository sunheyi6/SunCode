<script setup lang="ts">
import { computed } from 'vue';
import { useUpdateStore } from '../../stores/update';

const store = useUpdateStore();

const progressPercent = computed(() => Math.round(store.status.downloadProgress ?? 0));

const speedLabel = computed(() => {
  const bps = store.status.downloadBytesPerSecond;
  if (!bps || bps <= 0) return '';
  if (bps > 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps > 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${bps} B/s`;
});
</script>

<template>
  <Transition name="slide-down">
    <div
      v-if="store.status.state !== 'idle' && store.status.state !== 'no-update'"
      class="update-banner"
      :class="`state-${store.status.state}`"
    >
      <!-- Checking -->
      <div v-if="store.status.state === 'checking'" class="banner-content">
        <span class="spinner" />
        <span>正在检查更新...</span>
      </div>

      <!-- Update available -->
      <div v-else-if="store.status.state === 'update-available'" class="banner-content">
        <span class="banner-icon">&#x1F4E6;</span>
        <span class="banner-text">
          新版本 <strong>{{ store.status.version }}</strong> 可用
        </span>
        <button class="btn-primary" @click="store.startUpdate()">下载更新</button>
        <button class="btn-dismiss" title="跳过此版本" @click="store.dismiss()">&times;</button>
      </div>

      <!-- Downloading -->
      <div v-else-if="store.status.state === 'downloading'" class="banner-content">
        <span class="banner-icon">&#x2B07;</span>
        <div class="progress-wrapper">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
          </div>
          <span class="progress-text">
            {{ progressPercent }}%
            <span v-if="speedLabel" class="speed">&middot; {{ speedLabel }}</span>
          </span>
        </div>
        <button class="btn-dismiss" title="隐藏" @click="store.dismiss()">&times;</button>
      </div>

      <!-- Downloaded -->
      <div v-else-if="store.status.state === 'downloaded'" class="banner-content">
        <span class="banner-icon">&#x2705;</span>
        <span class="banner-text">
          更新已就绪，重启以安装 <strong>{{ store.status.version }}</strong>
        </span>
        <button class="btn-primary" @click="store.installUpdate()">立即安装</button>
        <button class="btn-text" @click="store.dismiss()">稍后</button>
      </div>

      <!-- Error -->
      <div v-else-if="store.status.state === 'error'" class="banner-content">
        <span class="banner-icon">&#x26A0;</span>
        <span class="banner-text">检查更新失败：{{ store.status.error }}</span>
        <button class="btn-primary" @click="store.checkForUpdates()">重试</button>
        <button class="btn-dismiss" title="关闭" @click="store.dismiss()">&times;</button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.update-banner {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-surface);
  user-select: none;
}

.banner-content {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--color-text);
  min-height: 34px;
}

.banner-icon {
  font-size: 15px;
  flex-shrink: 0;
}

.banner-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.banner-text strong {
  color: var(--color-accent);
  font-weight: 600;
}

/* ── Buttons ── */
.btn-primary {
  flex-shrink: 0;
  padding: 3px 12px;
  border: none;
  border-radius: var(--border-radius-sm);
  background: var(--color-accent);
  color: var(--color-bg);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s;
}
.btn-primary:hover {
  background: var(--color-accent-hover);
}

.btn-text {
  flex-shrink: 0;
  padding: 3px 8px;
  border: none;
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.12s;
}
.btn-text:hover {
  color: var(--color-text);
}

.btn-dismiss {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 16px;
  cursor: pointer;
  transition: all 0.12s;
}
.btn-dismiss:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

/* ── Spinner ── */
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color-strong);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Progress bar ── */
.progress-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.progress-bar {
  flex: 1;
  height: 5px;
  background: var(--color-bg-tertiary);
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--color-accent);
  border-radius: 3px;
  transition: width 0.3s ease;
}
.progress-text {
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}
.speed {
  color: var(--color-text-muted);
}

/* ── State accent colors ── */
.state-downloading .banner-content {
  /* subtle blue tint */
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
}
.state-downloaded .banner-content {
  background: color-mix(in srgb, var(--color-green) 8%, transparent);
}
.state-error .banner-content {
  background: color-mix(in srgb, var(--color-red) 8%, transparent);
}

/* ── Transition ── */
.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.25s ease;
}
.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  max-height: 0;
  transform: translateY(-4px);
}
.slide-down-enter-to,
.slide-down-leave-from {
  opacity: 1;
  max-height: 40px;
}
</style>
