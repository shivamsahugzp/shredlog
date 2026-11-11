# ShredLog

Free, private, installable fitness tracker for Indian food and Indian gym life. No account, no ads, no server. Runs as a web app on iPhone (and Android).

## Install on iPhone

1. Open the site in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open ShredLog from the icon from then on. The Safari tab and the icon keep separate data.
4. Export a backup from Settings every few weeks (Files → iCloud Drive). Deleting the icon deletes the data.

## What it tracks

| Area | What you get |
|---|---|
| Food | 400 Indian foods with katori / roti / cup / glass servings, per-100 g scaling, oil & ghee teaspoon stepper, text logging ("2 roti, 1 katori dal"), pot-recipe builder (cook once, log by katori), saved meals and starter plates, custom foods, copy yesterday, partial-day flag |
| Macros & micros | Calories, protein, carbs, fat, fibre, sugar plus 10 micronutrients (iron, calcium, D, B12, C, zinc, magnesium, potassium, folate, sodium) against ICMR-NIN RDAs, with Indian food fixes and meal ideas for your gaps |
| Targets | Mifflin-St Jeor start, then an adaptive estimate of your real burn from your own food + weight logs (MacroFactor-style), weekly budget view |
| Training | Today's plan learned from your weekdays, Hevy-style set logging, share card for a finished session, set × reps × weight logger with last-session ghost values, auto rest timer that survives backgrounding, PR detection, double-progression suggestions, plateau and deload alerts, weekly hard sets per muscle, routine templates, plate calculator, warm-up generator, 600 exercises (machines, cables, free weights, bodyweight, mobility) with step-by-step form, start/end-position images, coach cues and common mistakes, a tap-to-pick muscle body map, and a weekday pattern learner that remembers what you train on each day |
| Habits | One-tap chai (with sugar), cigarettes (time since last, money, habit strength, 30-day grid, health milestones), water, sleep, steps. Every counter has a minus button and a long-press list, so an accidental tap is one tap to undo |
| Body & feel | Post-meal tags (bloating, gas, acidity, cramps, sleepy, garmi), evening check-in (energy, mood, hunger, cravings, stool, skin, sleep), measurements, and food-to-symptom pattern detection with statistical gates and plain-language guardrails |
| Budget | Protein per rupee ranking filtered by your diet (veg / egg / non-veg / vegan / Jain) and budget |

## Design

Dark-first "Iron & Haldi" look: warm graphite surfaces, one haldi-yellow accent (switchable to indigo, mint or red in Settings), condensed scoreboard numerals in Bricolage Grotesque, a floating glass tab bar, rings and counters that animate, swipe-to-delete rows, and bottom sheets with drag-to-dismiss. Light mode follows the phone. The full contract is in `docs/design.md`; the open-source patterns it borrows from are listed in `docs/references.md`.

## Data & privacy

Everything is stored on the device (IndexedDB with a localStorage mirror). Export/import is a single JSON file. Nothing is sent anywhere.

## Development

Static files, no build step. Serve the folder (`python3 -m http.server`) and open `index.html`. Regenerate the service worker precache with `python3 scripts/build-sw.py`. Headless smoke test: `node test/smoke.mjs`.

Food values are based on the Indian Food Composition Tables (NIN 2017) and typical home recipes. They are estimates. Nothing here is medical advice.

Exercise illustrations and step-by-step instructions: free-exercise-db (public domain, Unlicense); images load from GitHub when online.
