export interface StreamingTextRenderOptions {
  final: boolean;
  smoothStreaming: 'auto' | false;
  fade: boolean;
  typewriter: boolean;
  maxLiveNodes?: number;
}

export function buildStreamingTextRenderOptions(isStreaming: boolean): StreamingTextRenderOptions {
  return {
    final: !isStreaming,
    smoothStreaming: isStreaming ? 'auto' : false,
    fade: !isStreaming,
    typewriter: isStreaming,
    maxLiveNodes: isStreaming ? 0 : undefined,
  };
}
