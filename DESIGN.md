# Design

Pi-Anzeige's control panel and kiosk start page share one visual world: **teletext**. It is an Operate surface: standard web controls and layout, with teletext supplying type, palette, density and one signature move. Source of truth for values: `public/app.css`.

## Palette

Black ground, teletext primaries. Every colour has one job; none is decoration.

| Token | Value | Job |
|---|---|---|
| `--ground` | `#050506` | page background |
| `--ink` | `#000` | header, footer, inputs, preview frame; text on bright fills |
| `--rule` | `#26262c` | hairlines between rows and regions |
| `--line` | `#3a3a42` | input and step-button borders |
| `--hover` | `#17171c` | row hover |
| `--white` | `#f1f1ee` | primary text, page numbers in header |
| `--dim` | `#a9a9a3` | secondary text, labels, meta line |
| `--yellow` | `#ffe417` | current page (row fill), clock, zoom value, page numbers in index, caret, selection |
| `--cyan` | `#2ee6e6` | section titles, brand, text links, focus ring |
| `--green` | `#2bd94a` | connected status, save |
| `--red` | `#ff3b30` | black mode, live indicator, errors, delete |
| `--blue` | `#2f5bff` | reload key |
| `--magenta` | `#f04ae8` | outline on a page row changed from another panel |

No gradients, glass, soft shadows or rounded corners.

## Type

- **Bedstead** (public domain teletext face, self-hosted at `public/fonts/bedstead.otf`) for the header row, section titles, page numbers, fastext keys, zoom value and preview messages.
- **System monospace stack** (`ui-monospace, SF Mono, Cascadia Mono, DejaVu Sans Mono, Menlo, Consolas`) for body text, inputs and URLs, at 15 px / 1.45; labels 12 px uppercase with 0.06em tracking.
- Numerals are tabular wherever they line up.

## Layout

- Sticky header row: `P<number>  PI-ANZEIGE  <status>  <date>  <clock>`, with a seeded sixel mosaic strip (10 px) in the seven colours beneath.
- Desktop: preview column (fluid) + side column (300–380 px): page index, page form (when open), address form, zoom.
- Sticky footer: four fastext keys (red SCHWARZ, green SPEICHERN, yellow ZOOM 100 %, blue NEU LADEN), each with its keyboard shortcut.
- ≤ 900 px: single column, fastext keys 2×2, edit links always visible. ≤ 420 px: brand hidden, connection status kept.
- Spacing scale 4 / 8 / 12 / 24 px; side gutter ≥ 16 px with safe-area insets.

## Signature move

Typing digits anywhere (outside inputs) counts the header up like a TV set — `P1__` → `P10_` → `P103` — and switches to that page. `B`, `R`, `S`, `0` mirror the fastext keys.

## States

Connected / reconnecting (yellow) / page unreachable (red) in the header; preview starting, paused, screen not connected, black active (red label over a black frame); empty index text; inline field errors in red under the field; inline delete confirmation.

## Motion

Only two: the live indicator blinks in steps (off under `prefers-reduced-motion`), and the black overlay fades in 280 ms.
