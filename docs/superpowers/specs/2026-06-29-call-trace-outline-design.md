# Call Trace Outline Design

## Goal

Make the chat and call trace experience read like Codex: the chat stays focused on the answer and lightweight progress, while the call trace panel shows a complete, structured agent flow with an outline-first layout.

## Requirements

- The call trace panel must show the full run flow as an ordered outline: user request, model turns, model input, thinking, requested tools, tool results, next turns, and final response.
- All trace detail sections are collapsed by default. Running items may be visually highlighted and expanded only while active.
- Summary rows must be useful without expansion: turn number, model label, duration, token counts, tool counts, and success/failure state where available.
- Tool details continue to reuse existing command, file edit, file inspect, and subagent cards.
- The implementation should prefer existing renderer data and `RunEvent` / `TurnDetail` structures. Worker protocol changes are out of scope unless renderer data is insufficient.
- Chat messages should remain lighter than the trace panel. They may show compact progress summaries, but detailed parameters, outputs, diffs, and model context belong in the trace panel.

## Architecture

Add a renderer-side trace view model that converts persisted `ChatMessage` objects into outline groups. `CallTracePanel.vue` renders that view model instead of directly mixing timeline construction and markup. Existing `TurnDetail` records remain the source for model request/response details, and existing `ToolCallContent` records remain the source for tool execution state.

The first implementation stays within the renderer: it improves the data shaping and UI hierarchy without changing worker events. If a future pass needs exact event ordering across concurrent tools, the store can persist raw `RunEvent` entries, but this design does not require that.

## Testing

Add focused renderer tests for the trace view model. Tests verify behavior, not Chinese UI text: grouping by user message and assistant turns, matching model tool calls with executed tool results, collapsed-by-default metadata, and fallback behavior for legacy assistant messages.
