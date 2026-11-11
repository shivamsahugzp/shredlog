# Open-source references used for the v2 redesign (researched 2026-11-12)

Licences: everything named here is MIT/ISC/Apache/OFL/Unlicense unless marked IDEAS ONLY (GPL/AGPL: borrow the idea, never the code).

## Motion
- Vaul (MIT, emilkowalski/vaul): drawer curve `cubic-bezier(.32,.72,0,1)` 500 ms; close when 25 % of height is dragged or release speed > 0.4 px/ms; drag starts after 10 px; ignore drags while inner scrollTop > 0. Used by `sheet()`.
- Sonner (MIT, emilkowalski/sonner): toast stack scales `1 - .05*i`, 3 visible, 4 s life, one 400 ms transition. Used by `toast()`.
- NumberFlow (MIT, barvian/number-flow): per-digit columns, only changed digits move, spring-shaped `linear()`; honours reduced motion. Used by `odometer()`.
- Motion (MIT) + Apple WWDC23 springs: bounce .15 barely bouncy, .3 noticeable. `springEase(d, bounce)` in motion.js generates the `linear()` curve; `SPRING_SOFT`/`SPRING_POP` are ready.
- Emil Kowalski's rules: under 300 ms, ease-out for enters, origin-aware, transform/opacity only, skip motion on high-frequency actions, reduced motion becomes a fade.
- Swipe-to-reveal: pan-y, axis lock, snap open at 40 % or 0.3 px/ms, rubber band `x*d*c/(d+c*x)` c=.55. Used by `swipeReveal()`.
- Long-press counters: 350 ms delay, repeat 140 ms ramping to 40 ms, haptic per step. Used by `stepper()`.
- Rings: `stroke-dasharray` + `stroke-dashoffset`, rotate -90°, 900 ms; a lighter second lap above 100 %.
- Confetti: canvas-confetti (ISC) defaults 50 particles, spread 45; only on PR / streak milestones. We keep the lighter CSS burst in `celebrate()`.

## Apps (layout ideas)
- Liftosaur (AGPL, IDEAS ONLY): global + per-exercise rest timers, last results shown for the same sets/reps, plate calculator on the progress screen.
- wger (AGPL, IDEAS ONLY): primary/secondary muscle overlays per exercise.
- Loop Habit Tracker (GPL, IDEAS ONLY): a "habit strength" score that survives a few misses, plus checkmark history. Use for cigarettes/water instead of brittle streaks.
- OpenNutriTracker (GPL, IDEAS ONLY): calories-left ring with macro bars, four meal sections, quick-add (title + kcal), recents re-add in one tap.
- Hevy (closed, screenshots): set row `SET | PREVIOUS | KG | REPS | ✓`; the tick turns the row green and starts the rest timer.
- MacroFactor (closed): trend weight line over raw dots; recents-first food search.
- Share card: draw 1080×1350 on a canvas, `toBlob`, `navigator.share({files})` behind `navigator.canShare`; fall back to download.

## Tokens
- Radix Colors (MIT) 12-step role scale; dark scales hand-tuned, never inverted. Open Props / Tailwind v4 OKLCH ladders. Our tokens follow the same idea (docs/design.md).
- Glass: `backdrop-filter: blur(20px) saturate(1.8)`, inset top highlight; SVG-filter refraction does not render on Safari, so no "liquid glass" filters. Cap at 3 glass surfaces per screen; never animate blur radius.
- Grain: `feTurbulence fractalNoise baseFrequency .8-.9`, opacity .04-.08, `mix-blend-mode: overlay` (in app.css).

## Typography
- Bricolage Grotesque variable (OFL): opsz 12–96, wdth 75–100, wght 200–800, tabular numerals, rupee glyph. Numbers at `font-stretch: 88%` are the signature. Always `font-variant-numeric: tabular-nums`.

## Charts
- Monotone cubic (d3-shape `curveMonotoneX`, ISC): no false dips, use for weight and calories. Catmull-Rom overshoots: decorative only.
- Draw-in: `pathLength="1"`, dashoffset 1→0, 900 ms; area fades after; bars `scaleY` from the baseline with 30 ms stagger.
- Trend weight: `trend += 0.1 * (w - trend)` (Hacker's Diet); show raw dots plus the trend line.
- Habit grid: 7×N CSS grid with a level variable mapped to colour alpha (cal-heatmap style).

## Body map
- react-body-highlighter (MIT) polygon ids for a second look at muscle shapes; our own SVG in body-map.js stays.
- free-exercise-db (Unlicense) is the exercise source already used.

## iPhone ergonomics
- Primary actions in the bottom 40 %; floating tab bar inset 12 px above the safe area; 44 pt targets; inputs ≥ 16 px; `100dvh`; `overscroll-behavior: none`; `touch-action: manipulation`.
- Haptics: hidden `<input type=checkbox switch>` + label click inside a user gesture (iOS 17.4+). `haptic()` in ui.js does this. Fire on set done, PR, timer end, counter ticks.
