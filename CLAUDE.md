# ASSEMBLY OS — engineering & design guide

Internal management platform for the Uzbekistan Economy Assembly. Next.js 16
(App Router, RSC), React 19, TypeScript, Tailwind v4, `node:sqlite`. Rendered in
a browser **and** inside the Telegram Mini App webview, in four languages
(uz / uzc / ru / en), light and dark.

---

## 1. Non-negotiables

1. **Never break a working feature to improve its looks.** Refine, don't rewrite.
2. **Reuse before you create.** Everything shared lives in `src/components/ui.tsx`.
   If you are about to paste a `className` you have written before, it belongs
   there instead.
3. **Tokens, not values.** Colour, spacing, radius and shadow come from the
   tokens below. A raw hex or a one-off `p-[13px]` is a defect.
4. **Both themes, always.** Every colour must resolve in light and dark. Test
   both before calling anything done.
5. **Four languages.** German-length words happen: Uzbek is long, Russian longer.
   Never size a control to fit one language's string.
6. **No horizontal scroll on the page.** Wide content (tables, charts) scrolls
   inside its own `overflow-x-auto` container. The Mini App webview is 360px.
7. **Text comes from the dictionaries.** No literal user-facing strings in JSX.
   All four dictionaries must carry identical key sets.

## 2. What this should look like

Reference points for *feel*, not for copying: **Linear** (density, restraint),
**Vercel** (typographic clarity, neutral surfaces), **Stripe** (data legibility),
**Raycast** (compact controls, keyboard-first).

Aim for: premium, minimal, technical, intentional. Every element earns its place.

**Banned outright**

- Gradients as decoration (a chart ramp is not decoration)
- Glassmorphism, blur-behind panels
- Display-size type in an application UI — nothing above `text-2xl`
- Rounded corners above `rounded-2xl`
- Heavy or coloured shadows; only `--shadow-soft` / `--shadow-lift`
- Colours outside the token set
- Emoji as interface icons (`Icon` only; emoji is fine inside Telegram messages)
- Animation that does not communicate a state change
- Borders, dividers, boxes or badges that carry no information

## 3. Tokens

Defined in `src/app/globals.css`. Never hard-code these values.

| Token | Use |
|---|---|
| `--surface` | Page background |
| `--panel` | Raised card / panel background |
| `--ink` | Primary text |
| `--muted` | Secondary text, icons, captions |
| `--line` | Every border and divider |
| `--shadow-soft` / `--shadow-lift` | Resting / hovered elevation |
| `--series-1..5` + `--series-N-ink` | Charts only. One hue, stepped lightness, label colour that clears 4.5:1 on its own step |
| `navy-*` | Structural accent (buttons, active nav) |
| `gold-*` | Single brand accent. Sparingly — a page with three gold elements has none |

**Semantic colour** — `emerald` done/positive, `amber` waiting/attention,
`rose` overdue/destructive, `sky` informational. Never for decoration.

### Spacing

4px base. Use `1 / 2 / 3 / 4 / 5 / 6 / 8 / 10 / 12` only.

- Inside a control: `px-3 py-2` (sm), `px-4 py-2.5` (md), `px-5 py-3` (lg)
- Panel padding: `p-5` desktop, `p-4` mobile
- Panel header: `px-5 py-3.5`
- Between sections: `gap-6` / `space-y-6`
- Between related rows: `gap-2` / `gap-3`

### Radius

`rounded-lg` controls · `rounded-xl` fields and buttons · `rounded-2xl` panels ·
`rounded-full` avatars, badges, progress. Nothing else.

### Typography

System stack (`--font-sans`). No web fonts — the Mini App loads over a phone
network.

| Role | Class |
|---|---|
| Page title | `text-xl font-bold lg:text-2xl` |
| Section / panel title | `text-sm font-semibold` |
| Body | `text-sm` |
| Secondary | `text-xs muted` |
| Caption / meta | `text-[11px] muted` |
| Metric value | `text-2xl font-bold tabular-nums` |
| Overline | `text-[11px] font-semibold uppercase tracking-wide muted` |

**Always `tabular-nums` on numbers** that sit in a column or update in place.
One weight step at a time — never jump `font-normal` → `font-bold` in adjacent
elements.

## 4. Components

`src/components/ui.tsx` is the source of truth.

- `Button` — `variant`: `primary | secondary | ghost | danger`; `size`: `sm | md | lg`.
  Renders `<a>` when given `href`. Handles disabled and busy. **Never hand-roll
  a button.**
- `IconButton` — square, icon-only, requires `label` (becomes `aria-label`).
- `Panel` — the standard card. Optional `title` / `action` header.
- `PageHeader` — `title`, optional `description` and `action`.
- `StatCard` — one metric. Optional `href` makes the whole card a link.
- `Badge` — status. Pass one of the `TONE` maps, never an ad-hoc colour.
- `EmptyState` — empty result. Give it a `title`, optional `hint` and `action`.
- `Skeleton` — loading placeholder in the shape of the content it replaces.
- `Table` / `Th` / `Td` — always inside `TableWrap` (which owns the scroll).
- `Select`, `DateField`, `FIELD` — form controls; one skin for all of them.

**Composition rules**

- Server Component by default. `"use client"` only for interaction.
- One level of nesting inside a panel. Panel → content. Not panel → box → box.
- A component that takes more than six props is two components.

## 5. Layout & responsive

Breakpoints: base (≥360) → `sm` 640 → `lg` 1024 → `xl` 1280.

- Mobile first. Write the narrow case, then add `lg:` for the wide one.
- Grids: `grid gap-4 sm:grid-cols-2 xl:grid-cols-3`. Never a fixed column count
  without a narrow fallback.
- **Put `items-start` on any grid whose cells are panels of different heights** —
  otherwise a short panel is stretched to match a tall neighbour and renders as
  a box of dead space. This is the single most common layout defect here.
- Touch targets ≥ 40px. The Mini App is used one-handed.
- Long lists are capped and paginated. An unbounded list becomes a 14,000-pixel
  page on a phone.

## 6. States — every list has four

| State | Requirement |
|---|---|
| **Loading** | `Skeleton` in the shape of the result. Never a spinner alone, never a layout jump. |
| **Empty** | `EmptyState` with what it means and, where there is one, the action that fills it. Never a bare "no data". |
| **Error** | What failed, in the user's language, and what to do. Never a raw code. |
| **Partial** | Say what is missing and why (e.g. "no conclusion stored — transcript only"). |

Disabled controls state *why* they are disabled — in helper text or a title.

## 7. Data display

**Tables** — left-align text, right-align numbers, `tabular-nums`, sticky header
on long tables, one row action column. Under `sm`, a table becomes a card list.

**Charts** — see `dataviz` skill for palettes. In short: the `--series-*` ramp,
never a rainbow. Label directly instead of relying on a legend where it fits. A
chart with one category above 90% is a number, not a donut — show the number.

**Numbers** — group thousands, no false precision (`10,03 mlrd`, not
`10030000000`). A percentage always says what of.

## 8. Motion

Purposeful only. `transition duration-150` for hover/focus, `.animate-rise`
(280ms) for content arriving. No entrance animation on content that was already
there. Everything respects `prefers-reduced-motion` — already wired in
`globals.css`.

## 9. Accessibility

- Contrast ≥ 4.5:1 body, ≥ 3:1 large text and UI edges. `muted` on `panel` is
  the floor — do not go lighter.
- Visible focus on every interactive element. Use the shared focus ring; never
  `outline: none` without a replacement.
- Icon-only controls carry `aria-label`. Decorative icons carry `aria-hidden`.
- Semantic elements: `<button>` for actions, `<a>` for navigation, real `<th>`.
- Colour is never the only signal — pair it with text or an icon.
- Keyboard: every action reachable, visible focus order, `Esc` closes overlays.

## 10. Working on this repo

```bash
npm run build            # Turbopack; must pass
npx tsc --noEmit         # must be clean
npx eslint src --ext .ts,.tsx
npm run start            # production server on :3000
node scripts/ui-audit.mjs /tmp/ui-audit   # screenshots every page × 3 widths
```

**Always finish a UI change by looking at it.** Run the audit, open the PNGs,
and judge the rendered result — not the markup. Check: dead space, alignment,
density, both themes, 390px width.

Gotchas particular to this codebase:

- **`dark:` is bound to `data-theme`, not to the OS.** `globals.css` declares a
  `@custom-variant dark` covering both an explicit `data-theme="dark"` and the
  system preference. Without it Tailwind v4 ships `prefers-color-scheme` only,
  and the theme toggle silently moves the CSS variables while leaving every
  `dark:` utility inert — light badge fills on dark panels. Never remove it, and
  test the toggle on a light-set machine.
- `node:path` with a non-literal argument breaks the Turbopack build
  (`DirAssetReference` over the project root). Build strings instead.
- Timestamps are stored UTC; `formatDate*` converts to Assembly time. A
  date-only value is a calendar date and must not be shifted.
- The dictionaries are typed as `typeof uz` — a key added to one must be added
  to all four or the build fails.
