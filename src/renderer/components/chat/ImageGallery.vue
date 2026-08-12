<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import { imageAttachmentDataUrl } from '@shared/image-attachments';
import type { ImageAttachment } from '@shared/types';
import Viewer from 'viewerjs';
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import 'viewerjs/dist/viewer.css';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

const props = withDefaults(
  defineProps<{
    images: ImageAttachment[];
    removable?: boolean;
    compact?: boolean;
  }>(),
  {
    removable: false,
    compact: false,
  },
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const emit = defineEmits<{
  remove: [id: string];
}>();

const galleryRef = ref<HTMLElement | null>(null);
let viewer: Viewer | undefined;

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function openImage(index: number): void {
  viewer?.view(index);
}

function createViewer(): void {
  if (!galleryRef.value) return;
  viewer = new Viewer(galleryRef.value, {
    url: 'data-original',
    className: 'suncode-image-viewer',
    title: false,
    navbar: props.images.length > 1,
    toolbar: {
      zoomIn: true,
      zoomOut: true,
      oneToOne: true,
      reset: true,
      prev: props.images.length > 1,
      next: props.images.length > 1,
      rotateLeft: true,
      rotateRight: true,
    },
    movable: true,
    zoomable: true,
    rotatable: true,
    scalable: false,
    keyboard: true,
    zoomOnWheel: true,
    toggleOnDblclick: true,
    zIndex: 10_000,
  });
}

onMounted(createViewer);
onUnmounted(() => viewer?.destroy());

watch(
  () => props.images.map((image) => `${image.id}:${image.data.length}`).join('|'),
  async () => {
    await nextTick();
    viewer?.destroy();
    viewer = undefined;
    createViewer();
  },
);
</script>

<template>
  <div ref="galleryRef" class="image-gallery" :class="{ compact }">
    <div v-for="(image, index) in props.images" :key="image.id" class="image-thumbnail-wrap">
      <button
        class="image-thumbnail"
        type="button"
        :aria-label="`放大图片 ${image.name}`"
        @click.stop="openImage(index)"
      >
        <img
          :src="imageAttachmentDataUrl(image)"
          :data-original="imageAttachmentDataUrl(image)"
          :alt="image.name"
          draggable="false"
        />
      </button>
      <button
        v-if="removable"
        class="image-remove"
        type="button"
        :aria-label="`移除图片 ${image.name}`"
        @click="emit('remove', image.id)"
      >
        <AppIcon name="x" :size="12" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.image-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.image-thumbnail-wrap {
  position: relative;
}

.image-thumbnail {
  display: block;
  width: 72px;
  height: 72px;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-color-strong);
  border-radius: 10px;
  background: var(--color-bg-tertiary);
  cursor: zoom-in;
}

.image-thumbnail:hover {
  border-color: var(--color-accent);
}

.image-thumbnail img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.image-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-color-strong);
  border-radius: 50%;
  background: var(--color-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
  box-shadow: var(--shadow-sm);
}

.image-remove:hover {
  border-color: var(--color-red);
  color: var(--color-red);
}

.compact .image-thumbnail {
  width: 56px;
  height: 56px;
}

</style>
