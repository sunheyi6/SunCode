# Chat Input Redesign

## Goal

Redesign the SunCode chat composer to closely follow the supplied reference: one large,
rounded container with the text input above and all controls arranged in a bottom toolbar.
The component must retain its current behavior and adapt to both SunCode themes.

## Scope

The change is limited to `ChatInput.vue` and any small theme-token additions required for
the composer. Message rendering, agent execution, queues, settings persistence, and other
panels remain unchanged.

## Layout

- Wrap the text area and toolbar in one bordered, rounded composer surface.
- Keep the text area visually borderless inside that surface.
- Place the add action and permission selector on the left side of the bottom toolbar.
- Place the status indicator, model selector, thinking-level selector, and send button on
  the right side.
- Open selector menus upward so they do not collide with the application window edge.
- On narrow widths, reduce gaps and truncate long model labels instead of overflowing.

## Visual Behavior

- Follow the active SunCode light or dark theme rather than forcing a white composer.
- Use a subtle border and shadow, with a stronger border on focus-within.
- Use the theme accent for active controls and a neutral surface for inactive controls.
- Give the send button a compact rounded-square shape matching the reference.
- Disable and mute the send button when the trimmed input is empty.
- Preserve a visually distinct queued state while the agent is streaming.

## Interaction

- Enter sends the message; Shift+Enter inserts a line break.
- Existing model, thinking-level, and permission settings continue to use their stores.
- Only one dropdown may be open at a time; clicking outside closes all dropdowns.
- Sending clears the input and returns it to its minimum height.
- The textarea grows with multiline content up to a bounded maximum height.
- The add button is present as a toolbar action but does not invent attachment behavior
  that the application does not currently support.

## Content and Accessibility

- Replace malformed Chinese labels and symbols in the current component with valid text.
- Use accessible button labels, menu state attributes, and disabled state semantics.
- Keep visible focus treatment for keyboard navigation.

## Verification

- Run `bun run typecheck`, `bun run lint`, and `bun run build`.
- Manually verify the composer in dark and light themes.
- Manually verify sending, multiline input, empty-input disabling, dropdown selection,
  outside-click closing, narrow-window truncation, and streaming queue presentation.
