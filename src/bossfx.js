import { CONFIG as C } from "./config.js";
import { clamp } from "./util.js";
import { impact, ringFx } from "./fx.js";
import { sfx } from "./audio.js";

/* BOSS PRESENTATION — the shared cinematic layer that turns every boss fight
 * into an EVENT, so all seven read the same instead of each just popping a
 * text toast:
 *   INTRO   — a title-card band on the wake (name + epithet, boss accent)
 *   PHASE   — a felt punctuation when it escalates (flash + shake + ring + chime)
 *   KILL    — a slow-motion final blow before the death set-piece
 * All render-space / timescale beats — no new gameplay systems. Bosses call
 * bossIntro/bossPhaseBeat/bossKillBeat; game.js drives updateBossFx + draws it. */

// ---------------------------------------------------------------- INTRO card
export function bossIntro(st, name, title, accent = "#ffffff") {
  st.bossIntro = { t: 0, name, title: title || "", accent, dur: 2.6 };
}
export function updateBossFx(st, dt) {
  const bi = st.bossIntro;
  if (bi) { bi.t += dt; if (bi.t >= bi.dur) st.bossIntro = null; }
}
export function drawBossIntro(ctx, st) {
  const bi = st.bossIntro;
  if (!bi) return;
  const W = C.VIEW_W, H = C.VIEW_H, t = bi.t, d = bi.dur, cy = H * 0.5;
  // a title band across the middle (NOT full letterbox — the HUD corners stay
  // clear): dark, transparent at the edges, fading in then out
  const band = clamp(Math.min(t / 0.4, (d - t) / 0.5), 0, 1);
  const bh = 92 * band;
  const g = ctx.createLinearGradient(0, cy - bh, 0, cy + bh);
  g.addColorStop(0, "rgba(4,4,8,0)");
  g.addColorStop(0.5, `rgba(4,4,8,${0.82 * band})`);
  g.addColorStop(1, "rgba(4,4,8,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, cy - bh, W, bh * 2);

  // the name — fades in, holds, fades; an accent line sweeps out beneath it
  const a = clamp(Math.min(t / 0.5, (d - t) / 0.45), 0, 1);
  ctx.save();
  ctx.textAlign = "center";
  const slide = (1 - clamp(t / 0.5, 0, 1)) * 14; // a small settle from below
  ctx.globalAlpha = a;
  ctx.fillStyle = bi.accent;
  ctx.shadowColor = bi.accent; ctx.shadowBlur = 28;
  ctx.font = "800 46px ui-monospace, Menlo, monospace";
  ctx.fillText(bi.name, W / 2, cy - 2 + slide);
  ctx.shadowBlur = 0;
  const lw = clamp((t - 0.25) / 0.5, 0, 1) * 230 * a;
  ctx.strokeStyle = bi.accent; ctx.globalAlpha = a * 0.9; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2 - lw, cy + 12); ctx.lineTo(W / 2 + lw, cy + 12); ctx.stroke();
  if (bi.title) {
    ctx.globalAlpha = a;
    ctx.font = "500 15px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "rgba(228,234,244,0.85)";
    ctx.fillText(bi.title.toUpperCase(), W / 2, cy + 34);
  }
  ctx.restore();
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}

// ---------------------------------------------------------------- PHASE beat
// call every frame with the boss's current phase (1..3); fires ONCE per rise.
// e._fxPhase tracks the last seen phase; a drop (boss revived in a fixture)
export function bossPhaseBeat(st, e, phase, accent = "#ffffff") {
  if (e._fxPhase == null) { e._fxPhase = phase; return; }
  if (phase > e._fxPhase) {
    e._fxPhase = phase;
    impact(st, 0.085, 0.5, flashOf(accent, 0.32));
    ringFx(st, e.x, e.y, accent, 170, 0.42);
    ringFx(st, e.x, e.y, "rgba(255,255,255,0.7)", 90, 0.24);
    sfx.rank?.(phase); // the style-tier chime doubles as the escalation sting
  } else if (phase < e._fxPhase) {
    e._fxPhase = phase;
  }
}

// ---------------------------------------------------------------- KILL beat
// the final blow: a hard freeze that eases into slow-motion so the killing hit
// LANDS before the death set-piece plays out.
export function bossKillBeat(st, e, accent = "#ffffff") {
  st.hitStop = Math.max(st.hitStop, 0.16);
  st.slowmo = 0.55;
  impact(st, 0.16, 0.7, flashOf(accent, 0.4));
  ringFx(st, e.x, e.y, "rgba(255,255,255,0.95)", 130, 0.3);
}

// "#rrggbb" → an impact-flash {r,g,b,a} (impact() wants channels, not a string)
function flashOf(hex, a) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16), a };
}
