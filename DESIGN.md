---
version: alpha
name: SunCode
description: Dark-first Catppuccin Mocha coding agent. Low-contrast borders, blue accent, compact density.
colors:
  bg: "#1e1e2e"
  bg-secondary: "#1c1c2a"
  bg-tertiary: "#16161f"
  surface: "#28283a"
  surface-hover: "#33334a"
  overlay: "#585870"
  text: "#cdd6f4"
  text-secondary: "#a6adc8"
  text-muted: "#6c7086"
  accent: "#89b4fa"
  accent-hover: "#74c7ec"
  green: "#a6e3a1"
  red: "#f38ba8"
  yellow: "#f9e2af"
  orange: "#fab387"
  purple: "#cba6f7"
  teal: "#94e2d5"
  border: rgba(108, 112, 134, 0.15)
  border-strong: rgba(108, 112, 134, 0.25)
typography:
  body-xs:
    fontSize: 10px
  body-sm:
    fontSize: 11px
  body-md:
    fontSize: 13px
    lineHeight: 1.4
  body-lg:
    fontSize: 14px
    lineHeight: 1.5
  heading:
    fontSize: 18px
    fontWeight: 600
  stat:
    fontSize: 22px
    fontWeight: 700
  mono:
    fontFamily: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace
    fontSize: 12px
  sans:
    fontFamily: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
  card-nested:
    backgroundColor: "{colors.bg-tertiary}"
    rounded: "{rounded.sm}"
  card-hover:
    backgroundColor: "{colors.surface-hover}"
  sidebar:
    backgroundColor: "{colors.bg-secondary}"
    width: 260px
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
  button-icon:
    width: 38px
    height: 36px
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-strong}"
  input:
    backgroundColor: "{colors.bg}"
    borderColor: "{colors.border-strong}"
    rounded: 20px
    typography: "{typography.body-md}"
  modal:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.xl}"
    borderColor: "{colors.border}"
  statusbar:
    height: 28px
    backgroundColor: "{colors.bg-secondary}"
  tool-card:
    backgroundColor: transparent
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
  subagent-card:
    borderColor-running: "{colors.accent}"
    borderColor-done: "#2da44e"
    borderColor-error: "#e5534b"
---

## Overview

SunCode is an Electron desktop AI coding agent. The UI follows a dark-first strategy with Catppuccin Mocha as the base palette, softened borders, and compact information density. Every interactive element uses 150ms ease transitions for state changes.

Key principles:
- **Dark first** — light theme is a mirror palette, not a redesign.
- **Compact** — information is dense; padding is minimal.
- **Subtle borders** — borders are `rgba(108, 112, 134, 0.15)`, almost invisible.
- **Blue accent** — `#89b4fa` marks focus, progress, and primary actions.
- **CSS custom properties** — all tokens referenced via `var(--color-*)`, never hardcoded.

## Colors

All colors are defined as CSS custom properties in `src/renderer/styles/variables.css`. Two themes: dark (default) and light (`[data-theme='light']`).

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--color-bg` | `#1e1e2e` | `#eff1f5` | Page background |
| `--color-bg-secondary` | `#1c1c2a` | `#e8eaf0` | Sidebar, footer |
| `--color-bg-tertiary` | `#16161f` | `#dce0e8` | Code editor, search |
| `--color-surface` | `#28283a` | `#e0e3eb` | Cards, dropdowns |
| `--color-surface-hover` | `#33334a` | `#ccd0da` | Hover state |
| `--color-text` | `#cdd6f4` | `#4c4f69` | Body text |
| `--color-text-secondary` | `#a6adc8` | `#5c5f77` | Labels, descriptions |
| `--color-text-muted` | `#6c7086` | `#8c8fa1` | Meta, timestamps |
| `--color-accent` | `#89b4fa` | `#1e66f5` | Primary action, focus |
| `--color-green` | `#a6e3a1` | `#40a02b` | Success, added lines |
| `--color-red` | `#f38ba8` | `#d20f39` | Error, removed lines |
| `--color-border` | `rgba(108,112,134,0.15)` | same alpha | Card/panel borders |
| `--color-border-strong` | `rgba(108,112,134,0.25)` | same alpha | Input/button borders |

**Do not** use hardcoded hex values in component styles. Always reference `var(--color-*)`.

## Typography

Two font families: system sans-serif stack for UI, monospace for code.

| Scale | Size | Weight | Usage |
|---|---|---|---|
| `body-xs` | 10px | 400 | Badges, meta |
| `body-sm` | 11px | 400–600 | Labels, section headers |
| `body-md` | 13px | 400–550 | Body text, list items |
| `body-lg` | 14px | 400 | Chat messages |
| `heading` | 18px | 600 | Modal titles |
| `stat` | 22px | 700 | Stat cards |
| `mono` | 12px | 400 | Code, file paths, pre |

Font sizes outside this scale (9px, 15px, 16px, 21px, etc.) should be migrated to the nearest scale value.

## Layout & Spacing

| Token | Value | Usage |
|---|---|---|
| `--spacing-xs` | 4px | Gap between inline items |
| `--spacing-sm` | 8px | Card padding, row gap |
| `--spacing-md` | 12px | Section padding |
| `--spacing-lg` | 16px | Modal padding |
| `--spacing-xl` | 24px | Message container |
| `--border-radius-sm` | 5px | Buttons, badges |
| `--border-radius` | 8px | Cards, panels, dropdowns |
| `--modal-radius` | 12px | Modal, backdrop |

Sidebar width: `260px` (default), resizable `180px–500px`.

## Components

All interactive components must have:
- `border: 1px solid var(--border-color)` (or `--border-color-strong` for inputs)
- `border-radius: var(--border-radius)` (or `sm`/`xl`)
- `transition: all 0.15s ease` on hover/active state changes
- `background: var(--color-surface)` for cards, transparent for rows

Hover feedback: `background: var(--color-surface-hover)` or `color-mix(in srgb, var(--color-accent) X%, transparent)` for subtle accent tints.

Status colors for tool cards and sub-agents:
- Running: `var(--color-accent)` with pulse animation
- Done: `var(--color-green)` or `#2da44e`
- Error: `var(--color-red)` or `#e5534b`

## Do's and Don'ts

✅ Do use `var(--spacing-*)` tokens instead of raw px values.
✅ Do use `var(--border-color)` for top-level container borders only.
✅ Do use **background color hierarchy** (`bg` → `surface` → `bg-tertiary` → `bg-secondary`) for nested content — no borders on nested elements.
✅ Do add `transition: all 0.15s ease` to interactive elements.
✅ Do use `color-mix()` for subtle accent backgrounds.
✅ Do keep components within the 6 font-size scale.

❌ Don't hardcode hex colors in component `<style>` blocks.
❌ Don't put borders on elements nested inside a card — use background color difference instead.
❌ Don't use box-shadows (the design is flat).
❌ Don't use font sizes outside `10|11|12|13|14|18|22`.
❌ Don't use padding values outside `4|8|12|16|24`.
