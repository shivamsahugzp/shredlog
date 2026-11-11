# ShredLog design system — "Iron & Haldi"

This is the contract every screen is built against. Read it fully before touching a view.
Tokens and shared components live in `css/app.css`, `css/motion.css`, `js/ui.js`, `js/motion.js`.
Screen agents do **not** edit those four files; they build their screen with what is here, and keep
screen-specific CSS in their own prefixed stylesheet (`fd-`, `tr-`, `bd-`, `pg-`, `st-`, `on-`, `sc-`).

## Who this is for

An Indian lifter, 20–35, logging on a phone: often in a dim gym or late at night, one thumb, in a hurry.
Food is roti, dal, paneer, chai. Training is machines, cables and barbells. The app has to feel like
**gym iron and a haldi-yellow highlighter**: dark, dense, confident numbers, one bright accent, no fluff.
Everything must still look right in light mode (it follows the phone, and the user can force it).

## Palette (OKLCH-derived, not a stock scale)

Semantic tokens only. Never hard-code a hex in a view; never invent a new colour.

| Token | Role | Dark | Light |
|---|---|---|---|
| `--bg` | page | `#120F0C` warm graphite | `#F5F3F0` chalk |
| `--card` | raised surface | `#1C1915` | `#FEFDFC` |
| `--card-2` | inset surface (inputs, tracks) | `#27231F` | `#EFECE8` |
| `--card-3` | pressed / hover | `#33302B` | `#E6E2DC` |
| `--line` | hairlines | `rgba(255,255,255,.08)` | `rgba(31,26,20,.09)` |
| `--ink` / `--ink-2` / `--muted` | text | `#F5F1EA` / `#BBB7AF` / `#908B84` | `#1F1A14` / `#524C45` / `#736E67` |
| `--accent` | **haldi**: the one CTA colour, active states, highlights | `#F9CC21` | `#EDBE1A` |
| `--accent-ink` | text on accent | `#1F1A14` | `#1F1A14` |
| `--accent-text` | accent used as text/links on surfaces | `#F3C530` | `#9D7200` |
| `--accent-soft` | tinted fills behind accent content | 12 % accent mix | 16 % accent mix |
| `--p` protein | indigo | `#8B9BFE` | `#5862E1` |
| `--c` carbs | teal | `#31C3B5` | `#05877C` |
| `--f` fat | rose | `#F471AA` | `#D43B86` |
| `--fiber` | sage | `#6FC082` | `#1D7D3E` |
| `--water` | sky | `#64BCED` | `#0E84B7` |
| `--chai` | clay | `#CC9874` | `#905A33` |
| `--cig` | smoke | `#A39D98` | `#6D6863` |
| `--sleep` | lavender | `#B39EDC` | `#8766BB` |
| `--good` / `--warn` / `--bad` | status | `#6FC884` / `#F9CC21` / `#F0584B` | `#17843F` / `#B88A04` / `#D03830` |
| `--g1..--g6` | muscle groups Chest, Back, Shoulders, Arms, Legs, Core (fixed order) | coral `#F87B5C`, teal `#31C3B5`, haldi `#F3C530`, indigo `#8B9BFE`, rose `#F471AA`, mint `#6FC884` | `#D25030`, `#05877C`, `#C29817`, `#5862E1`, `#D43B86`, `#17843F` |

Each colour has a `-soft` variant (`--p-soft`, `--water-soft`, …) for tinted chips/icon wells: use
`color-mix(in srgb, var(--x) 14%, transparent)` if a soft token is missing. Status colours always ship
with an icon or a word, never colour alone.

The background is not flat: `body` carries two large, very faint radial glows (accent top-left, indigo top-right)
and a grain layer. Views never set their own page background.

## Type: one family, three voices

Bricolage Grotesque variable (weight 200–800, width 75–100 %, optical size). `--font` for everything.

- **Display numbers** `.num-xl / .num-lg / .num-md`: weight 800, width 88 %, tight tracking (`-0.03em`), tabular.
  This condensed scoreboard numeral is the signature of the app. Big numbers are never body weight.
- **Headlines** `h1 28/800`, `h2 19/750`, `h3 16/700`, width 96 %.
- **Body** 15/500, `--ink-2` for secondary, `.small` 13, `.micro` 12. Line length under 60 characters.
- Sentence case everywhere. No ALL-CAPS labels. No eyebrow labels above headings. Avoid `·` chains longer
  than two items; prefer a second line or a chip.

## Surfaces & shape

- `.card` radius 20 px, 1 px hairline, inset top highlight in dark, soft warm shadow in light.
  `.card.pad-s` 12/14. `.card.inset` is the `--card-2` well inside a card. `.card.accent` is a haldi-tinted card
  for the single most important call to action on a screen. `.glass` is blurred translucent (tab bar, sticky heads).
- Radii: `--r-xl 24`, `--r-lg 20`, `--r-md 14`, `--r-sm 10`, pills `999`. Smaller things get smaller radii.
- Hairlines, not shadows, separate rows. One shadow level only (`--shadow`), light mode only.
- Spacing scale: 4, 8, 12, 16, 20, 24, 32. Screen gutter 16. Section gap 24. Card gap 10.

## Components (in `js/ui.js`) — use these, do not rebuild them

| Helper | What it gives |
|---|---|
| `h, append, clear, frag` | DOM |
| `icon(name, size, cls)` | 24-grid stroke icons (`P` map). Add icons there only via the integrator. |
| `sheet({title, content, actions, full, dismissable, onClose})` | bottom sheet: spring entry, drag-to-dismiss, sticky actions |
| `actionSheet(title, items)` | list of `{icon, label, sub, danger, onClick}` |
| `confirmSheet(msg, {ok, danger, title})`, `promptSheet(title, value)` | |
| `toast(msg, {undo, action, onAction, ms})` | stacked toasts (Sonner-style), max 3 |
| `segmented(options, value, onChange, cls)` | sliding-thumb control |
| `chips(options, value, onChange)` | horizontal chips with edge fade |
| `stepper({value, min, max, step, onChange})` | hold-to-repeat stepper |
| `toggle(label, on, onChange, sub)` | switch row |
| `field(label, control, hint)`, `emptyState(title, sub, action, {ico})` | |
| `ring({size, stroke, pct, color, track, label, sub})` | SVG progress ring; `fill(el,pct,{axis:'ring'})` animates it |
| `counterTile({cls, ico, label, count, sub, onAdd, onRemove, onOpen, under})` | quick-log tile: tap = +1, "−" button when count>0, long-press = open list |
| `longPress(el, fn, ms)` | |
| `hero(num, unit, {size})` | display number with unit |
| `fmt, fmtG, fmtTime, fmtDur, fmtClock, relTime, sinceText, ago, fmtDateLabel, fmtShortDate, fmtDow` | formatting |
| `haptic(kind)` | tap / success / warn |

Motion helpers (`js/motion.js`): `countUp`, `odometer` (digit roll), `fill` (bars/rings), `growBars`, `pulse`, `pop`,
`ripple`, `celebrate`, `stagger`, `swipeNav`, `swipeReveal` (swipe row to reveal delete), `spring` constants,
session memory `seen/remember/recall/once`, chart gating `quiet/isQuiet/canIntro`, `prefersReducedMotion`.

## Motion rules

- Durations: micro 120–180 ms, enter 220–320 ms, hero 400–600 ms. Easings: `EASE_OUT` cubic-bezier(.22,1,.36,1)
  for enters, `EASE_SPRING` cubic-bezier(.2,.9,.25,1.15) for pops, `ease-in` 90–160 ms for exits.
- Animate only `transform`, `opacity`, `stroke-dashoffset`. Never layout.
- One orchestrated moment per screen on first open (hero number counts, ring fills, list staggers ≤ 6 items).
  Redraws caused by data changes are quiet (`quiet(fn)`), except the element that changed, which pops.
- Everything you add must be a no-op under `prefers-reduced-motion` (use the helpers; they already are).
- Feedback for every tap: ripple or press scale (`.pressable`), a toast with Undo for every log/delete.

## Layout rules for phones

- Test at 390 × 844 **and** 360 × 740. Nothing may overflow horizontally; nothing may overlap.
  Rows with a label and a value: label `min-width:0` + ellipsis, value `flex:none; white-space:nowrap`.
- Tap targets ≥ 44 px. Primary action for a screen sits in the thumb zone (bottom), sticky if the screen is long.
- Sticky heads use `.glass`. The floating tab bar is 64 px + 12 px inset; `#app` already pads for it.
- Chips rows: edge fade is automatic, keep the first chip visible, never let a chip label truncate.
- Empty states: one short sentence, one spot illustration (inline SVG, 2 tones from the palette), one action.

## Copy

Plain, active, specific. Buttons say what happens ("Log chai", "Start Push day", "Save weight"). The same action
keeps the same name across the flow. Numbers carry units. Errors say what to do next. No exclamation marks.

## Data safety (non-negotiable)

No state keys renamed, no ids changed, no migrations that drop fields. New settings go under existing objects
(`state.settings.*`) with defaults applied on read. The 31-check smoke test (`node test/smoke.mjs`) must keep passing;
DOM hooks it uses are listed at the top of that file and must survive.
