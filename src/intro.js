import { CONFIG as C } from "./config.js";
import { clamp, easeOut } from "./util.js";
import { makeMoteField, stepMotes, drawMotes, drawWordmark, drawTitleLine } from "./titlecard.js";

/* THE TITLE — TETHER over the Sunken Shallows' dawn, drawn through titlecard.js.
 * A render set-piece; a key (an audio gesture) hands off to the level select.
 * Shown only to real players — automation boots straight to the select screen
 * (see the boot guard in game.js). */

export function startIntro(st) {
  st.intro = { t: 0, field: makeMoteField() };
}

export function updateIntro(st, dt) {
  const f = st.intro;
  if (!f) return;
  f.t += dt;
  stepMotes(f.field, dt);
}

export function drawIntro(ctx, st) {
  const f = st.intro;
  if (!f) return;
  const W = C.VIEW_W, H = C.VIEW_H, t = f.t;
  const fade = clamp(t / 1.2, 0, 1); // a gentle bloom on boot

  // the Sunken Shallows already drift behind (menubg.js); boot rises out
  // of the UI ground into it
  ctx.fillStyle = `rgba(13,17,15,${1 - fade})`;
  ctx.fillRect(0, 0, W, H);
  drawMotes(ctx, f.field, fade);
  const rise = (1 - easeOut(clamp(t / 1.4, 0, 1))) * 14;
  drawWordmark(ctx, H * 0.47 + rise, fade);
  drawTitleLine(ctx, "A grapple-swing platformer", H * 0.47 + 40 + rise, fade * 0.95, 17, "#c9c8bc");
  // the prompt arrives last, then breathes (the invitation to the first gesture)
  const pr = clamp((t - 0.9) / 0.6, 0, 1) * (0.72 + 0.28 * Math.sin(t * 2));
  drawTitleLine(ctx, "Press any key to begin", H * 0.82, pr, 15, "#9fc7b8");
}
