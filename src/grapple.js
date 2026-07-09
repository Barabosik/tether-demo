import { CONFIG as C } from "./config.js";
import { clamp, lerp, len2, segRectT, easeOut } from "./util.js";
import { burst, ringFx, impact, bumpStyle } from "./fx.js";
import { sfx } from "./audio.js";

/* The grapple. Attach is instant hit-scan (feel first); the rope visual
 * extends over ROPE_VISUAL_T. While taut it is a real pendulum: gravity in,
 * radial velocity projected out, tangential velocity fully conserved — no
 * damping anywhere. Releasing just deletes the constraint, so whatever
 * velocity the swing built is exactly what you launch with. */

// Aim-assisted target pick: best anchor inside the assist cone with clear
// line-of-sight. ANCHORS ONLY — the old exact-ray wall hook (Just Cause
// style surface attach) let players cheese past the authored ring routes,
// so the rope now answers to the yellow rings and nothing else.
export function findGrappleTarget(st, fx, fy, tx, ty) {
  const dx0 = tx - fx, dy0 = ty - fy;
  const L0 = len2(dx0, dy0);
  if (L0 < 4) return null;
  const ux = dx0 / L0, uy = dy0 / L0;
  // stick aim is coarser than a mouse — widen the assist cone on pad
  const assist = C.AIM_ASSIST_DEG +
    (st.input && st.input.padAiming ? C.PAD_ASSIST_EXTRA_DEG : 0);
  const maxAng = (assist * Math.PI) / 180;

  let best = null, bestScore = Infinity;
  for (const a of st.anchors) {
    const ax = a.x - fx, ay = a.y - fy;
    const d = len2(ax, ay);
    if (d < 30 || d > C.GRAPPLE_RANGE) continue;
    const ang = Math.acos(clamp((ax * ux + ay * uy) / d, -1, 1));
    if (ang > maxAng) continue;
    let blocked = false;
    for (const s of st.solids)
      if (!s.gone && s.kind !== "oneway" && s.kind !== "valve" &&
          segRectT(fx, fy, a.x, a.y, s) <= 1) { blocked = true; break; }
    if (blocked) continue;
    const score = ang + d * 0.0005; // prefer closest-to-aim, then closest
    if (score < bestScore) { bestScore = score; best = { x: a.x, y: a.y, kind: a.kind || "anchor", ref: a }; }
  }
  return best; // no anchor in the cone = fizzle — walls don't take the hook
}

// Fire or, if already attached, chain: the constraint swaps to the new anchor
// in the same sim step — velocity is untouched, momentum routes seamlessly.
export function tryFireGrapple(st) {
  const p = st.player;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const target = findGrappleTarget(st, pcx, pcy, st.aim.x, st.aim.y);
  if (!target) {
    sfx.fizzle();
    burst(st, pcx, pcy, 4, 120, "#8d7a9e", 0, false); // fizzle
    return false;
  }
  // refiring at the SAME anchor is a release, not a free reattach — the old
  // behavior re-slacked the rope every press (len := current distance), an
  // infinite-energy reset that also farmed the style meter. Chaining to a
  // DIFFERENT anchor is untouched.
  if (p.grapple && Math.hypot(target.x - p.grapple.ax, target.y - p.grapple.ay) < 12) {
    releaseGrapple(st);
    return false;
  }
  sfx.attach(!!p.grapple); // a chain re-fire chirps higher than a fresh hook
  if (p.grapple) ringFx(st, p.grapple.ax, p.grapple.ay, "rgba(255,224,176,0.8)", 30, 0.2);
  const dist = len2(target.x - pcx, target.y - pcy);
  const len = clamp(dist, C.ROPE_MIN, C.GRAPPLE_RANGE);
  p.grapple = {
    ax: target.x, ay: target.y, len,
    visT: 0, taut: false,
    ref: target.ref,          // the live anchor (zip rides its rail)
    kind: target.kind,        // "anchor" | "zip" | "sling"
    rest: len,                // slingshot spring rest length
  };
  burst(st, target.x, target.y, 8, 200, "#ffd166", 200, true);
  impact(st, 0, 0.06, null); // tiny attach thunk
  bumpStyle(st, 1); // a fresh grapple (incl. mid-air chains) feeds the combo
  return true;
}

export function releaseGrapple(st) {
  const p = st.player, g = p.grapple;
  if (!g) return;
  sfx.release();
  ringFx(st, p.x + p.w / 2, p.y + p.h / 2, "rgba(255,224,176,0.6)", 26, 0.18);
  burst(st, g.ax, g.ay, 5, 140, "#ffd166", 300, false);
  p.grapple = null; // velocity untouched = full conservation launch
}

// ZIP-LINE anchors slide their rail while a player is latched (and ease back
// home when idle). The taut rope then rides the moving center — the pendulum
// math is untouched; it just pins to a point that travels. Run each step
// BEFORE the swing forces so the whole chain uses the fresh center.
export function updateAnchors(st, dt) {
  const g = st.player.grapple;
  for (const a of st.anchors) {
    if (a.kind !== "zip") continue;
    const active = !!g && g.ref === a;
    const dx = a.x2 - a.x0, dy = a.y2 - a.y0;
    const L = len2(dx, dy) || 1;
    a.zt = clamp(a.zt + (active ? a.speed : -C.ZIP_RETRACT) * dt / L, 0, 1);
    a.x = a.x0 + dx * a.zt;
    a.y = a.y0 + dy * a.zt;
  }
  if (g && g.ref && g.ref.kind === "zip") { g.ax = g.ref.x; g.ay = g.ref.y; }
}

// While attached: A/D steers tangentially (the radial part dies at the
// constraint), W/S reels the rope, gravity does the rest. The gravity SIGN
// feeds the pendulum directly — inside a flip zone the arc inverts for real
// (same constraint math, opposite restoring force), no special-case state.
//
// Two ACTIVE momentum tools live here:
//  • PUMP — steering WITH the motion while the taut rope is on its upswing
//    multiplies the steer accel (SWING_PUMP) up to a speed ceiling. Timing
//    the window is skill expression; steering off-window is plain accel.
//  • REEL — shortening the rope while taut does work on the pendulum:
//    angular-momentum conservation (len0/len1) amplifies the TANGENTIAL
//    velocity by REEL_ENERGY of the ideal gain. Reel in for a fast tight
//    arc, pay out to trade speed for reach.
export function applySwingForces(st, dt, steerX, climbY) {
  const p = st.player, g = p.grapple;
  const gd = st.gravityDir || 1;
  if (steerX) {
    let acc = C.SWING_ACCEL;
    if (g.taut && p.vy * gd < 0 && steerX * p.vx > 0 &&
        len2(p.vx, p.vy) < C.SWING_PUMP_MAX)
      acc *= C.SWING_PUMP;
    p.vx += steerX * acc * dt;
  }
  if (climbY) {
    const len0 = g.len;
    g.len = clamp(g.len + climbY * C.CLIMB_SPEED * dt, C.ROPE_MIN, C.GRAPPLE_RANGE);
    if (g.taut && g.len < len0) {
      const gain = 1 + (len0 / g.len - 1) * C.REEL_ENERGY;
      const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
      const dx = pcx - g.ax, dy = pcy - g.ay;
      const d = len2(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const vr = p.vx * ux + p.vy * uy; // radial part is the constraint's problem
      p.vx = vr * ux + (p.vx - vr * ux) * gain;
      p.vy = vr * uy + (p.vy - vr * uy) * gain;
    }
  }
  p.vy += C.GRAVITY * dt * gd;
  // SLINGSHOT: the rope is a spring — stretch past its rest length and it pulls
  // back toward the anchor, harder the further you draw (accel = K × stretch).
  // Swing out to load it, release near the anchor to launch. Rope can't push,
  // so a compressed (inside-rest) sling is free-fall.
  if (g.kind === "sling") {
    const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    const dx = pcx - g.ax, dy = pcy - g.ay;
    const d = len2(dx, dy) || 1;
    const stretch = d - g.rest;
    if (stretch > 0) {
      const k = C.SLING_K * stretch;
      p.vx -= (dx / d) * k * dt;
      p.vy -= (dy / d) * k * dt;
    }
  }
}

// Taut-rope constraint, run after collision resolution each step:
// project the player back onto the rope circle and remove only the OUTWARD
// radial velocity component. Slack rope (inside the circle) is free-fall.
export function ropeConstraint(st) {
  const p = st.player, g = p.grapple;
  if (!g || p.dashing) return;
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  const dx = cx - g.ax, dy = cy - g.ay;
  const d = len2(dx, dy);
  if (g.kind === "sling") {
    // a spring, not a rigid rope — no per-frame pin (the spring does the work).
    // Only a HARD MAX stretch stops you flinging to infinity if you fight it.
    g.taut = d >= g.rest;
    const maxD = g.rest * C.SLING_MAX;
    if (d > maxD && d > 1e-6) {
      const ux = dx / d, uy = dy / d;
      p.x = g.ax + ux * maxD - p.w / 2;
      p.y = g.ay + uy * maxD - p.h / 2;
      const vr = p.vx * ux + p.vy * uy;
      if (vr > 0) { p.vx -= ux * vr; p.vy -= uy * vr; }
    }
    return;
  }
  g.taut = d >= g.len - 0.5;
  if (d <= g.len || d < 1e-6) return;
  const ux = dx / d, uy = dy / d;
  p.x = g.ax + ux * g.len - p.w / 2;
  p.y = g.ay + uy * g.len - p.h / 2;
  const vr = p.vx * ux + p.vy * uy;
  if (vr > 0) { p.vx -= ux * vr; p.vy -= uy * vr; }
}

// ------------------------------------------------------------------ render

export function drawRope(ctx, st, pcx, pcy) {
  const g = st.player.grapple;
  if (!g) return;
  const vis = easeOut(g.visT);
  const ex = lerp(pcx, g.ax, vis), ey = lerp(pcy, g.ay, vis);
  const dist = len2(g.ax - pcx, g.ay - pcy);
  const slack = Math.max(0, g.len - dist);
  const sag = clamp(slack * 0.5, 0, 110) * vis;
  const speed = len2(st.player.vx, st.player.vy);
  const hot = g.taut && speed > 800;
  if (g.kind === "sling") {
    // the elastic glows with its charge — the more it's drawn, the hotter/thicker
    const stretch = clamp((dist - (g.rest || 0)) / 260, 0, 1);
    ctx.strokeStyle = `rgb(${255},${Math.round(120 - 70 * stretch)},${Math.round(200 - 120 * stretch)})`;
    ctx.lineWidth = 2 + stretch * 2.5;
    ctx.shadowColor = "#ff5ca0"; ctx.shadowBlur = 4 + stretch * 10;
  } else {
    ctx.strokeStyle = g.taut ? (hot ? "#fff3dd" : "#ffe0b0") : "rgba(202,167,122,0.75)";
    ctx.lineWidth = g.taut ? 2.5 : 2;
    if (hot) { ctx.shadowColor = "#ffdba0"; ctx.shadowBlur = 8; }
  }
  ctx.beginPath();
  ctx.moveTo(pcx, pcy);
  ctx.quadraticCurveTo((pcx + ex) / 2, (pcy + ey) / 2 + sag, ex, ey);
  ctx.stroke();
  ctx.shadowBlur = 0;
  if (g.visT >= 1) {
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.arc(g.ax, g.ay, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Lock brackets on the aim-assist target + faint fire preview. Also caches
// the target on st.lock so the crosshair can react.
export function drawLockUI(ctx, st, pcx, pcy, t) {
  const target = findGrappleTarget(st, pcx, pcy, st.aim.x, st.aim.y);
  st.lock = target;
  if (!target) return; // zip + sling take the hook too — bracket every kind
  const r = C.ANCHOR_R + 7 + 2 * Math.sin(t * 6);
  ctx.strokeStyle = target.kind === "sling" ? "rgba(255,92,160,0.9)"
    : target.kind === "zip" ? "rgba(140,242,255,0.9)" : "rgba(255,180,84,0.9)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const mid = (i * Math.PI) / 2 + Math.PI / 4;
    ctx.beginPath();
    ctx.arc(target.x, target.y, r, mid - 0.35, mid + 0.35);
    ctx.stroke();
  }
  ctx.setLineDash([4, 8]);
  ctx.strokeStyle = "rgba(255,180,84,0.22)";
  ctx.beginPath();
  ctx.moveTo(pcx, pcy);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.setLineDash([]);
}
