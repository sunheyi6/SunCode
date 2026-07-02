import { ref } from 'vue';

/**
 * Composable for streaming text rendering.
 * Provides gradual text reveal useful for animations.
 */
export function useStreaming() {
  const displayedText = ref('');
  let fullText = '';
  let animationFrame: number | null = null;

  function updateText(text: string): void {
    fullText = text;
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
    }
    // For now, just set directly (can add character-by-character animation later)
    displayedText.value = fullText;
  }

  function appendText(delta: string): void {
    fullText += delta;
    displayedText.value = fullText;
  }

  function reset(): void {
    fullText = '';
    displayedText.value = '';
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }

  return {
    displayedText,
    updateText,
    appendText,
    reset,
  };
}
