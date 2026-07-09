import { CONFIG as C } from "./config.js";
import { clamp } from "./util.js";
import { drawDawn, makeMoteField, stepMotes, drawMotes, drawWordmark, drawTitleLine } from "./titlecard.js";

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
  const H = C.VIEW_H, t = f.t;
  const fade = clamp(t / 1.2, 0, 1); // a gentle bloom on boot

  drawDawn(ctx, fade);
  drawMotes(ctx, f.field, fade);
  drawWordmark(ctx, H * 0.46, fade);
  // the prompt — pulsing (also the invitation to the first gesture)
  const pr = fade * (0.4 + 0.3 * Math.sin(t * 3));
  drawTitleLine(ctx, "press anything to begin", H * 0.46 + 44, pr, 15);
}
