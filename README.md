# TETHER — Demo (Worlds 1–3)

A grapple-swing precision platformer in a single HTML file. Swing, dash, and
pogo through **19 hand-tuned levels** across three worlds — **The Sunken
Shallows**, **The Mines**, and **The Inferno** — each capped by a boss.

This is the **public demo**. It's the first three worlds of a larger game,
opened up because I want honest feedback on the **level design** (see below).

> ⚡ **Play now:** [barabosik.github.io/tether-demo](https://barabosik.github.io/tether-demo)
> *(or download [`TETHER.html`](TETHER.html) and double-click it — no install, works offline)*

---

## The 5 core verbs

Everything in TETHER is built from five moves. Mastery is combining them
without touching the ground.

| Verb | Keyboard | Feel |
|------|----------|------|
| **Swing** (grapple) | `RMB` / `E` | Fire a rope at an anchor and arc. **Refire mid-swing to chain** anchor to anchor. |
| **Release / Jump** | `Space` | Let go at the top of an arc to launch — or a plain jump on the ground. |
| **Dash** | `Shift` | A short burst in the aimed direction. The crystal on your back tells you it's ready. |
| **Attack** | `LMB` / `J` | A crescent slash. **Aim down + attack = pogo** — bounce off enemies and hazards. |
| **Steer / Reel** | `A` `D` steer · `W` `S` reel | Pump the swing, shorten or lengthen the rope, redirect momentum. |

Mouse aims. `Down` fast-falls. `F` fullscreen · `M` mute · `O` settings
(rebind everything). **Full controller support** — left stick moves, right
stick aims, and every verb also lives on a shoulder button.

---

## What's in the demo

- **19 levels, 3 worlds, 3 bosses** — a full vertical slice, start to finish
- **Momentum-first movement** — grapple chains, swing-pumping, rope reeling,
  dash, and pogo bounces that redirect your speed
- **A real hazard gauntlet** — saws, pendulums, crushers, dash-gated lasers,
  pulsing spikes, gravity-flip and wind zones
- **Ghost replays, S-ranks, and split timing** against your own PB pace
- **THE LINE** — run a whole world back-to-back on one clock, per-level splits
- **Unlockable skins** with distinct per-skin dash trails
- **Practice flags** — press `P` to drill a hard room, unranked
- **Built-in level editor** — press `E` on the level select: layers,
  multi-select, waypoint paths, JSON import/export
- **Settings that stick** — volume buses, screen-shake & impact-flash
  accessibility scales, full key remapping (all saved locally)

---

## 🎯 Feedback wanted: level design (Worlds 1–3)

This is why the repo is public. I'm a solo dev and **level design is where I
most want a second pair of eyes.** If you play the demo, I'd love notes on:

- **Difficulty curve** — does the ramp from Shallows → Mines → Inferno feel
  fair, or does it spike/sag anywhere?
- **Readability** — did any jump, hazard, or anchor read as unfair or unclear?
- **Flow** — where did you lose momentum and have to stop? Where did it *sing*?
- **Teaching** — is each new mechanic introduced clearly before it's tested?
- **Standout & weak rooms** — name the best level and the one that dragged.

**How to send feedback:** open a [GitHub Issue](../../issues/new) with the
level name (e.g. `m04-deep-gallery`) in the title. Rough notes are welcome —
"level 7 felt cheap here's why" is more useful than a polished report.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for what kind of help I'm looking for.

---

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
git clone https://github.com/Barabosik/tether-demo
cd tether-demo
npm install
npm run dev        # opens the game + editor with hot reload
```

Other scripts:

```bash
npm run build       # static build into dist/  (this is what GitHub Pages serves)
npm run standalone  # bundles everything into a single TETHER.html
npm run preview     # preview the production build locally
```

---

## Credits & licensing

- **Code:** MIT © 2026 Nikita Andreiev — see [`LICENSE`](LICENSE).
- **Music:** third-party, under its own license — see
  [`public/music/CREDITS.md`](public/music/CREDITS.md) for per-track
  attribution. Music is **not** covered by the MIT license above.
- **Sound effects:** generated procedurally (original).

Made by [@Barab0s1k](https://github.com/Barabosik).
