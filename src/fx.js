import { rand, rr } from "./util.js";
import { CONFIG as C } from "./config.js";
import { duckMusic, sfx } from "./audio.js";

// Particles + the "punch dispenser". All decay math is fps-independent.

// Style meter: only AIRBORNE actions count, so a chain is one unbroken flight
// (landing resets it, see onLand). Every module already holds `st`, so this is
// the single shared entry point for swing/pogo/dash/strike to feed the combo.
const rankIdx = (n) => {
  let r = -1;
  for (let i = 0; i < C.STYLE_RANKS.length; i++) if (n >= C.STYLE_RANKS[i][0]) r = i;
  return r;
};
export function bumpStyle(st, n = 1) {
  if (!st.style || st.player.onGround) return;
  const before = rankIdx(st.style.count);
  st.style.count += n;
  st.style.timer = C.STYLE_WINDOW;
  st.style.flash = Math.min(1.4, st.style.flash + 0.7);
  if (st.style.count > st.style.best) st.style.best = st.style.count;
  const after = rankIdx(st.style.count);
  if (after > before) sfx.rank(after); // crossing a tier gets its own chime
}

export function addParticle(st, o) {
  if (st.particles.length > 700) st.particles.shift();
  st.particles.push(o);
}

export function burst(st, x, y, n, spd, color, grav = 400, glow = false) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = rand(spd * 0.35, spd);
    addParticle(st, {
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: rand(0.25, 0.6), max: 0.6, grav, size: rand(2, 4), color, glow,
    });
  }
}

export function ringFx(st, x, y, color, maxR = 70, life = 0.3) {
  addParticle(st, { kind: "ring", x, y, maxR, color, life, max: life });
}

// hit-stop + trauma shake + screen flash, one call per impact — the music
// ducks in the same instant so the transient owns the mix (the Hades trick)
export function impact(st, stop, shake, flash) {
  if (stop > st.hitStop) st.hitStop = stop;
  st.trauma = Math.min(1, st.trauma + shake);
  if (flash) st.flash = { ...flash };
  duckMusic(0.25 + stop * 4 + shake * 0.3);
}

export function updateParticles(st, dt) {
  const damp = Math.exp(-1.1 * dt); // fps-independent drag
  for (let i = st.particles.length - 1; i >= 0; i--) {
    const q = st.particles[i];
    q.life -= dt;
    // swap-and-pop, not splice: O(1) removal, no array shift / GC churn.
    // Draw order is set by q.kind (drawParticles filters by layer), never by
    // index, so moving the tail element into the gap is invisible.
    if (q.life <= 0) {
      const last = st.particles.pop();
      if (i < st.particles.length) st.particles[i] = last;
      continue;
    }
    if (q.kind === "ring" || q.kind === "trail") continue;
    q.vy += (q.grav || 0) * dt;
    q.vx *= damp;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
  }
}

// per-shape mark for a normal particle. `shape` (set by skin-aware spawners)
// gives each dash skin a distinct silhouette; default is the plain square.
function drawShapedParticle(ctx, q, a) {
  const s = q.size;
  ctx.fillStyle = q.color;
  if (q.glow) { ctx.shadowColor = q.color; ctx.shadowBlur = 8; }
  switch (q.shape) {
    case "shard": { // ice sliver, angled along travel
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(Math.atan2(q.vy, q.vx));
      ctx.fillRect(-s * 1.6, -s * 0.35, s * 3.2, s * 0.7);
      ctx.restore();
      break;
    }
    case "petal": { // soft rounded bloom fleck
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, s * 1.1, s * 0.6, (q.spin || 0) + a * 3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "star": { // 4-point sparkle
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate((q.spin || 0) + (1 - a) * 2);
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const ang = (k / 4) * Math.PI * 2;
        ctx.lineTo(Math.cos(ang) * s * 1.7, Math.sin(ang) * s * 1.7);
        ctx.lineTo(Math.cos(ang + Math.PI / 4) * s * 0.5, Math.sin(ang + Math.PI / 4) * s * 0.5);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case "streak": { // comet dash — a line trailing the velocity
      ctx.save();
      ctx.globalAlpha *= 0.9;
      ctx.strokeStyle = q.color;
      ctx.lineWidth = s * 0.9;
      ctx.lineCap = "round";
      const l = 5 + s * 2;
      const vl = Math.hypot(q.vx, q.vy) || 1;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - (q.vx / vl) * l, q.y - (q.vy / vl) * l);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case "smoke": { // void wisp — a soft growing puff, fades early
      ctx.globalAlpha = a * a * 0.6;
      ctx.beginPath();
      ctx.arc(q.x, q.y, s * (1.4 + (1 - a) * 2.2), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "ember": // warm mote with a little rise (default-ish, glows)
      ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
      break;
    default:
      ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
  }
  ctx.shadowBlur = 0;
}

// layer "under" = dash afterimages (behind the player); "over" = sparks/rings
export function drawParticles(ctx, st, layer) {
  for (const q of st.particles) {
    const a = Math.max(0, q.life / q.max);
    if (layer === "under") {
      if (q.kind === "trail") {
        const tr = q.trail;
        if (q.tstyle === "streak") { // comet smear, elongated toward motion
          ctx.globalAlpha = a * 0.28;
          ctx.fillStyle = q.color || "#ffd9a0";
          ctx.save();
          ctx.translate(tr.x + tr.w / 2, tr.y + tr.h / 2);
          ctx.scale(1.35, 0.8);
          rr(ctx, -tr.w / 2, -tr.h / 2, tr.w, tr.h, 9);
          ctx.fill();
          ctx.restore();
        } else if (q.tstyle === "echo") { // a full silhouette double + eyes
          ctx.globalAlpha = a * 0.34;
          ctx.fillStyle = q.color || "#ffd9a0";
          if (q.glow) { ctx.shadowColor = q.color; ctx.shadowBlur = 12; }
          rr(ctx, tr.x, tr.y, tr.w, tr.h, 7);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = a * 0.5;
          ctx.fillStyle = "rgba(12,8,20,0.8)";
          const ex = tr.x + tr.w / 2, ey = tr.y + tr.h * 0.34;
          ctx.beginPath(); ctx.arc(ex - 4.5, ey, 2, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(ex + 4.5, ey, 2, 0, Math.PI * 2); ctx.fill();
        } else { // "box" — the original ghost
          ctx.globalAlpha = a * 0.3;
          ctx.fillStyle = q.color || "#ffd9a0";
          rr(ctx, tr.x, tr.y, tr.w, tr.h, 7);
          ctx.fill();
        }
      }
    } else {
      if (q.kind === "ring") {
        const t = 1 - a;
        ctx.globalAlpha = a * 0.9;
        ctx.strokeStyle = q.color;
        ctx.lineWidth = 3 * a + 1;
        ctx.beginPath();
        ctx.arc(q.x, q.y, q.maxR * (0.25 + 0.75 * t), 0, Math.PI * 2);
        ctx.stroke();
      } else if (!q.kind) {
        ctx.globalAlpha = a;
        if (q.shape) drawShapedParticle(ctx, q, a);
        else {
          if (q.glow) { ctx.shadowColor = q.color; ctx.shadowBlur = 8; }
          ctx.fillStyle = q.color;
          ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
          ctx.shadowBlur = 0;
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}
