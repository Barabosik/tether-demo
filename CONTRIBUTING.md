# Contributing to the TETHER demo

Thanks for playing! This repo is public for **one reason**: I want honest
feedback on the **level design** of Worlds 1–3. That's the help I'm looking
for — not code contributions.

## What's most useful

Open a [GitHub Issue](../../issues/new) after playing. The best feedback is
specific and names the level (e.g. `m04-deep-gallery`):

- **Difficulty & pacing** — where did the ramp spike or sag? Which level was
  the wall? Which was too easy?
- **Readability** — a jump, hazard, or anchor that read as unfair or unclear.
- **Flow** — where you lost all momentum, and where a room really *sang*.
- **Teaching** — a mechanic that got tested before it was taught.
- **Best & worst room** — name one of each, and why.

Rough notes beat polished reports. "level 6 felt cheap at the second saw — I
couldn't see it coming" is gold.

## Editing levels to show what you mean

The game ships with its level editor (`npm run dev`, then press `E` on the
level select). If it's easier to *show* a tweak than describe it, export the
level JSON (editor → export) and paste it in your issue, or open a PR that
touches **only** a file in `src/levels/`.

## On code changes

I'm keeping the engine code as-is for now, so please **don't** open PRs that
refactor systems, restyle, or add features — they'll likely be closed. Bug
reports (something broke, a level is unbeatable, a crash) are very welcome as
issues.

## Scope

This is a **3-world demo** of a larger game. Please don't file issues asking
for more worlds, story, or the full release — those exist, they're just not
part of this public slice. 🙂
