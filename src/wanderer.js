import { clamp, len2 } from "./util.js";

/* The hooded wanderer — the player's procedural Canvas2D silhouette.
 * Silhouette-first (Furi / Hollow-Knight territory): a dark cloaked figure,
 * hood over the head, tattered cape trailing behind, two glowing eyes and a
 * chest crystal carrying the equipped skin's accent color. No sprites, no
 * atlas — pure paths, cheap enough to draw every frame (and reused verbatim
 * by the skins-screen swatch so the two can never drift apart again).
 *
 * Draws in a LOCAL frame: caller has already translated to the player
 * center, rotated (p.rot) and applied squash/stretch + gravity flip — this
 * function only shapes pixels inside that box.
 *
 * State → look:
 *   crystal "ready"    accent-bright crystal + eyes (dash available)
 *           "charging" dimmed crystal (cooldown) — the old dim-body read
 *           "dashing"  dash-color flare on eyes + crystal, cape stretches
 *   vx/vy   cape trails opposite the velocity (drag), lifts on falls,
 *           streams on dashes; a slow idle waft keeps it alive at rest.
 */

const CLOAK = "#221830";        // the dark body — constant across skins
const CLOAK_EDGE = "#2e2140";   // subtle rim so the silhouette reads on dark bg
const CAPE = "#1a1226";         // cape sits a step darker, behind
const FACE_VOID = "#0c0812";    // hood shadow the eyes glow out of

/* THE VESSEL — FOUR BURN STATES (Character Bible, 2026-07-08). The player is
 * ONE drawWanderer; it EVOLVES across the worlds by a config row, exactly like
 * worldbg.js — "evolution is a config row". Structure only (strip count/tempo,
 * jitter, slit eyes, split core, chipped halo, leak cracks, void fade); the
 * COLOR is the caller's (the equipped skin keeps its hue; only the default
 * EMBER vessel takes the phase core, set in game.js). Gameplay gauges — the
 * aim-tracking eyes and the dash crystal — stay lit/functional in EVERY phase
 * (a deviation from the bible's dark-eyed 6% void, for readability). */
const VESSEL_PHASES = {
  //         W       cloak      edge       strips len  waftA waftHz jit slit halo leak fill shard bigEye
  pure:      { cloak: CLOAK,    edge: CLOAK_EDGE, strips: 3, stripLen: 1,    waftAmp: 0.16, waftHz: 2.2,  jitter: 0,   slit: 0, halo: 0, leaks: 0, fill: 1,    shards: 0, bigEye: 0 },
  corrupted: { cloak: "#241521", edge: "#4a2434", strips: 5, stripLen: 0.62, waftAmp: 0.22, waftHz: 6.5,  jitter: 0.6, slit: 1, halo: 0, leaks: 0, fill: 1,    shards: 2, bigEye: 0 },
  divine:    { cloak: "#241d2e", edge: "#3a3148", strips: 2, stripLen: 1.6,  waftAmp: 0.30, waftHz: 0.95, jitter: 0,   slit: 0, halo: 1, leaks: 3, fill: 1,    shards: 0, bigEye: 0 },
  void:      { cloak: "#232a34", edge: "#9aa4ad", strips: 1, stripLen: 0.85, waftAmp: 0.05, waftHz: 0.7,  jitter: 0,   slit: 0, halo: 0, leaks: 0, fill: 0.55, shards: 0, bigEye: 0 },
};
// the per-phase CORE hue (used by game.js for the default vessel's accent):
// ember → furnace → gold-white → memory-pale (void kept lit + blue, not dark)
export const VESSEL_CORE = {
  pure: { core: "#ffb454", dash: "#ffd9a0" }, corrupted: { core: "#ff5c38", dash: "#ffb08a" },
  divine: { core: "#ffe9c4", dash: "#ffffff" }, void: { core: "#8fb4d8", dash: "#dce8ff" },
};
// which burn state a world is in (W1–2 pure · 3–4 corrupted · 5–6 divine · 7 void)
export function vesselPhase(worldId) {
  const w = worldId | 0;
  const id = w >= 7 ? "void" : w >= 5 ? "divine" : w >= 3 ? "corrupted" : "pure";
  return { id, ...VESSEL_PHASES[id] };
}

export function drawWanderer(ctx, o) {
  // o: { w, h, facing, aimX, aimY, vx, vy, accent, dashColor, crystal, t, idle, phase }
  const hw = o.w / 2, hh = o.h / 2;
  const face = o.facing >= 0 ? 1 : -1;
  const speed = len2(o.vx, o.vy);
  const speedK = clamp(speed / 2400, 0, 1);
  // the world's BURN STATE (Character Bible) — structure only; absent = today's
  const P = o.phase || null;
  const cloakCol = P ? P.cloak : CLOAK;
  const edgeCol = P ? P.edge : CLOAK_EDGE;
  const fill = P ? P.fill : 1;

  // CORRUPTED jitter (P2): stillness is no longer available — the whole body
  // twitches ±jitter px on two detuned sines. Applied to the body center so the
  // cape rides along (the "cannot stand still" read).
  if (P && P.jitter) ctx.translate(Math.sin(o.t * 13) * P.jitter + Math.sin(o.t * 31) * P.jitter * 0.5, 0);

  // PARAGON (`special: "prism"`, the all-S capstone): the accent is a LIVING
  // aurora — it walks the spectrum over time — and a radiant halo rings the
  // figure. Every other skin passes its fixed accent straight through.
  const prism = o.special === "prism";
  const hue = prism ? Math.floor((o.t * 46) % 360) : 0;
  const accent = prism ? `hsl(${hue}, 92%, 66%)` : o.accent;
  if (prism) {
    const R = o.h * 0.98, cy = -hh * 0.1;
    const halo = ctx.createRadialGradient(0, cy, 2, 0, cy, R);
    halo.addColorStop(0, `hsla(${hue}, 95%, 72%, 0.5)`);
    halo.addColorStop(0.55, `hsla(${(hue + 45) % 360}, 95%, 66%, 0.2)`);
    halo.addColorStop(1, `hsla(${hue}, 95%, 66%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, cy, R, 0, Math.PI * 2); ctx.fill();
  }

  // ---- cape (behind the body): tattered streamers pointing away from
  // velocity; drag physics fall out of -v for free (run → trails back,
  // fall → lifts up, jump → streams down). Idle: a slow waft. The COUNT,
  // length, and tempo are phase params (3 pure · 5 twitchy · 2 long · 1 damped)
  // — the shear that turns a whole body into a burn state.
  {
    let dx, dy;
    if (speed > 60) { dx = -o.vx / speed; dy = -o.vy / speed * 0.6; }
    else { dx = -face; dy = -0.12; }
    const nStrips = P ? P.strips : 3;
    const stripLenM = P ? P.stripLen : 1;
    const waftHz = P ? P.waftHz : 2.2;
    const waftAmp = speed > 60 ? 0.05 : (P ? P.waftAmp : 0.16);
    const stretch = o.crystal === "dashing" ? 1.7 : 1;
    const len = hh * (0.55 + 1.05 * speedK) * stretch;
    const anchorY = -hh * 0.15; // shoulders
    ctx.fillStyle = P && P.id === "void" ? "rgba(154,164,173,0.16)" : CAPE;
    for (let i = 0; i < nStrips; i++) {
      const side = nStrips === 1 ? 0 : -1 + (2 * i) / (nStrips - 1);
      const lk = (1 - Math.abs(side) * 0.28) * stripLenM;
      const spread = -side * 0.3;
      const waft = Math.sin(o.t * waftHz + i * 1.3) * waftAmp; // per-strip offset = organic, not lockstep
      const cs = Math.cos(waft), sn = Math.sin(waft);
      const wx = dx * cs - dy * sn, wy = dx * sn + dy * cs;
      const ax = side * hw * 0.42, ay = anchorY + Math.abs(side) * 2;
      const tx = ax + (wx + spread * wy) * len * lk;
      const ty = ay + (wy - spread * wx) * len * lk + hh * 0.55;
      ctx.beginPath();
      ctx.moveTo(ax - hw * 0.22, ay);
      ctx.lineTo(ax + hw * 0.22, ay + 1.5);
      ctx.lineTo(tx, ty);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---- the silhouette: hood + robe as one path, ragged hem
  ctx.beginPath();
  ctx.moveTo(-hw * 0.92, hh);                                  // hem left
  ctx.quadraticCurveTo(-hw * 1.05, hh * 0.15, -hw * 0.82, -hh * 0.28); // left side
  ctx.quadraticCurveTo(-hw * 0.72, -hh * 0.72, face * hw * 0.14, -hh * 1.02); // hood rise
  ctx.quadraticCurveTo(hw * 0.78, -hh * 0.68, hw * 0.82, -hh * 0.28);  // hood fall
  ctx.quadraticCurveTo(hw * 1.05, hh * 0.15, hw * 0.92, hh);   // right side
  // tattered hem: three notches
  ctx.lineTo(hw * 0.5, hh * 0.78);
  ctx.lineTo(hw * 0.16, hh);
  ctx.lineTo(-hw * 0.2, hh * 0.76);
  ctx.lineTo(-hw * 0.55, hh);
  ctx.closePath();
  ctx.fillStyle = cloakCol;
  if (fill < 1) {
    // VOID (P4): a person-shaped hole — the body fades, the pale edge carries
    // the read (kept at 0.55, not the bible's 6%, so you can still see yourself)
    ctx.globalAlpha = fill;
    ctx.fill();
    ctx.globalAlpha = 1;
  } else {
    // a soft accent underglow rims the dark shape — the silhouette stays
    // findable in dark rooms (and wears the skin, Hollow-Knight rim style)
    ctx.shadowColor = accent;
    ctx.shadowBlur = prism ? 18 : o.crystal === "dashing" ? 14 : 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.strokeStyle = edgeCol; // faint rim keeps the shape readable on dark
  ctx.lineWidth = fill < 1 ? 1 : 1.25;
  ctx.stroke();

  // DIVINE (P3): hairline cracks leak the stolen light — kintsugi never repaired
  if (P && P.leaks) {
    ctx.strokeStyle = accent; ctx.lineWidth = 0.7; ctx.globalAlpha = 0.5;
    for (const [x1, y1, x2, y2] of [[-6, 1, -2.5, 6.5], [3.5, -3, 7, 3.5], [-1.5, 9, 4, 13]]) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---- hood shadow (the face void)
  ctx.beginPath();
  ctx.ellipse(face * 1.2, -hh * 0.45, hw * 0.56, hh * 0.30, 0, 0, Math.PI * 2);
  ctx.fillStyle = FACE_VOID;
  ctx.fill();

  // ---- eyes: the skin's accent, aim-following — the one part that never
  // slumps. Shape is a phase param: round (pure) · slits (corrupted) ·
  // asymmetric, one torn wide (divine). Always LIT (the aim gauge).
  const flare = o.crystal === "dashing";
  const eyeC = flare ? o.dashColor : accent;
  const al = len2(o.aimX, o.aimY) || 1;
  const exo = (o.aimX / al) * 2.6, eyo = (o.aimY / al) * 2.2;
  const ey = -hh * 0.45 + eyo;
  const rx = P && P.slit ? 1.15 : 2.1, ry = P && P.slit ? 2.7 : 2.1;
  const rL = P && P.bigEye ? 1.5 : 1, rR = P && P.bigEye ? 0.85 : 1;
  ctx.save();
  ctx.fillStyle = eyeC;
  ctx.shadowColor = eyeC;
  ctx.shadowBlur = flare ? 10 : 6;
  ctx.beginPath(); ctx.ellipse(exo - 4.2, ey, rx * rL, ry * rL, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(exo + 4.2, ey, rx * rR, ry * rR, 0, 0, Math.PI * 2); ctx.fill();

  // ---- chest crystal: carries the dash-ready read the body color used to.
  // CORRUPTED (P2) splits it into two off-center shards that never rest.
  const bright = o.crystal === "ready" || flare;
  ctx.globalAlpha = bright ? 1 : 0.38;
  ctx.shadowBlur = flare ? 12 : bright ? 8 : 0;
  ctx.translate(0, hh * 0.14);
  if (P && P.shards) {
    for (let i = 0; i < P.shards; i++) {
      const a = o.t * 4 + i * Math.PI;
      ctx.save();
      ctx.translate(Math.cos(a) * 3.2, Math.sin(a) * 2.0);
      ctx.rotate(Math.PI / 4 + a * 0.5);
      const s = flare ? 2.4 : 1.9;
      ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.restore();
    }
  } else {
    ctx.rotate(Math.PI / 4);
    const cr = flare ? 4.2 : 3.4;
    ctx.fillRect(-cr / 2, -cr / 2, cr, cr);
  }
  ctx.restore();

  // DIVINE (P3): a chipped halo above the hood, rotating slowly, lagging the
  // body — stolen light the vessel can't quite wear.
  if (P && P.halo) {
    const hx = -Math.sin(o.t * 0.8) * 1.6;
    ctx.save();
    ctx.strokeStyle = accent; ctx.lineWidth = 1;
    ctx.shadowColor = accent; ctx.shadowBlur = 6;
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([13, 5, 7, 8]);
    ctx.lineDashOffset = o.t * 3;
    ctx.beginPath();
    ctx.arc(hx, -hh * 1.28, hw * 0.85, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}
