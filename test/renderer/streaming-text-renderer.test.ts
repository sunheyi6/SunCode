import { describe, expect, test } from 'vitest';
import { buildStreamingTextRenderOptions } from '../../src/renderer/components/chat/streaming-text-renderer';

describe('buildStreamingTextRenderOptions', () => {
  test('uses smooth chat rendering while text is streaming', () => {
    const options = buildStreamingTextRenderOptions(true);

    expect(options).toMatchObject({
      final: false,
      smoothStreaming: 'auto',
      fade: false,
      typewriter: true,
      maxLiveNodes: 0,
    });
  });

  test('renders completed text immediately without streaming pacing', () => {
    const options = buildStreamingTextRenderOptions(false);

    expect(options).toMatchObject({
      final: true,
      smoothStreaming: false,
      fade: true,
      typewriter: false,
    });
    expect(options.maxLiveNodes).toBeUndefined();
  });
});
