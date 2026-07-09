import { CONFIG as C } from "./config.js";
import { aabb, rand, rr, approach, clamp } from "./util.js";
import { addParticle, burst, ringFx, impact } from "./fx.js";
import { sfx } from "./audio.js";
import { depenetrate } from "./physics.js";
import { pulseK } from "./hazards.js";

/* Dynamic terrain. Solids may carry a `kind`:
 *   (none)    — static terrain, exactly as before
 *   "crumble" — shakes on touch, breaks after CRUMBLE_DELAY, regrows after
 *               CRUMBLE_REGROW (a dashed ghost shows where it will return).
 *               Hooking it with the grapple also wakes it. Once it starts
 *               crumbling it COMMITS — leaving doesn't save the platform.
 *   "mover"   — patrols A<->B at `speed`, pausing at the ends. Riders are
 *               carried by the platform's delta; a platform moving INTO the
 *               player pushes them (then depenetrates cleanly).
 *   "grip"    — climbable wall faces: press INTO the side while airborne to
 *               cling (slow slide), SPACE wall-jumps up-and-away. Doesn't
 *               refill the dash — only landing/pogo/node do.
 * Physics knows one extra bit: solids with `gone` are skipped everywhere
 * (collision, rope LOS/attach, dart walls, ward bolts). */

export const mkCrumble = (x, y, w, h) =>
  ({ kind: "crumble", x, y, w, h, crumbleT: 0, gone: false, regrowT: 0, shake: 0 });
// Movers are waypoint-path platforms. The legacy 2-point rail (x2/y2 data) is
// just a 2-waypoint pingpong path with linear easing — identical motion.
export const mkMover = (x, y, w, h, x2, y2, speed = 90) =>
  mkMoverPath({ x, y, w, h, speed, path: [{ x, y }, { x: x2, y: y2 }] });
export function mkMoverPath(o) {
  const src = o.path && o.path.length >= 2
    ? o.path : [{ x: o.x, y: o.y }, { x: o.x + 200, y: o.y }];
  const pts = src.map((p) => ({ x: p.x, y: p.y }));
  return {
    kind: "mover", x: pts[0].x, y: pts[0].y, w: o.w, h: o.h,
    speed: o.speed || 90,
    mode: o.mode === "loop" ? "loop" : "pingpong",
    easing: o.easing === "easeinout" ? "easeinout" : "linear",
    pts, seg: 0, t: 0, dir: 1, pauseT: 0,
    // rail ends kept for anything that still reads them (fx distance gates)
    ax: pts[0].x, ay: pts[0].y, bx: pts[pts.length - 1].x, by: pts[pts.length - 1].y,
  };
}
export const mkGrip = (x, y, w, h) => ({ kind: "grip", x, y, w, h });

const easeT = (s, t) => (s.easing === "easeinout" ? t * t * (3 - 2 * t) : t);

export function updatePlatforms(st, dt) {
  const p = st.player;
  let pushed = false;

  const gDir = st.gravityDir || 1;
  // gravity-aware "standing on it": feet on the top face, or on the underside
  // once gravity is flipped
  const standingOn = (s) => p.onGround &&
    (gDir > 0 ? Math.abs(p.y + p.h - s.y) < 3 : Math.abs(p.y - (s.y + s.h)) < 3);

  for (const s of st.solids) {
    if (s.contactT > 0) s.contactT -= dt; // bouncy squash-stretch decay
    if (s.padCd > 0) s.padCd -= dt;       // angled-pad re-trigger lockout
    if (s.kind === "crumble") {
      if (s.gone) {
        s.regrowT -= dt;
        if (s.regrowT <= 0 && !aabb(p.x, p.y, p.w, p.h, s.x, s.y, s.w, s.h)) {
          s.gone = false;
          s.crumbleT = 0;
          sfx.crumbleBack();
          ringFx(st, s.x + s.w / 2, s.y + s.h / 2, "rgba(214,168,120,0.6)", 40, 0.25);
        }
        continue;
      }
      // standing on it (or having hooked it) commits the collapse
      const standing = standingOn(s) && p.x + p.w > s.x + 2 && p.x < s.x + s.w - 2;
      if (standing && s.crumbleT <= 0) {
        s.crumbleT = C.CRUMBLE_DELAY;
        sfx.crumbleWarn();
      }
      if (s.crumbleT > 0) {
        s.crumbleT -= dt;
        s.shake = 1 - s.crumbleT / C.CRUMBLE_DELAY;
        if (Math.random() < 0.5)
          addParticle(st, { x: rand(s.x + 4, s.x + s.w - 4), y: s.y + s.h - 2,
            vx: rand(-20, 20), vy: rand(20, 80), life: 0.4, max: 0.4, grav: 500,
            size: rand(1.5, 3), color: "#a8815e" });
        if (s.crumbleT <= 0) {
          s.gone = true;
          s.shake = 0;
          s.regrowT = C.CRUMBLE_REGROW;
          sfx.crumbleBreak();
          impact(st, 0, 0.14, null);
          burst(st, s.x + s.w / 2, s.y + s.h / 2, 14, 240, "#a8815e", 500, false);
        }
      }

    } else if (s.kind === "mover") {
      if (s.pauseT > 0) { s.pauseT -= dt; continue; }
      const pts = s.pts;
      const segN = s.mode === "loop" ? pts.length : pts.length - 1;
      const a = pts[s.seg], b = pts[(s.seg + 1) % pts.length];
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      s.t += (s.dir * s.speed * dt) / dist;
      if (s.t >= 1) {
        if (s.mode === "loop") { s.seg = (s.seg + 1) % segN; s.t = 0; }
        else if (s.seg < segN - 1) { s.seg++; s.t = 0; }
        else { // end of the path — clunk if anyone's nearby
          s.t = 1; s.dir = -1; s.pauseT = C.MOVER_PAUSE;
          if (Math.hypot(p.x - s.x, p.y - s.y) < 900) sfx.moverClunk();
        }
      } else if (s.t <= 0 && s.dir < 0) {
        if (s.seg > 0) { s.seg--; s.t = 1; }
        else {
          s.t = 0; s.dir = 1; s.pauseT = C.MOVER_PAUSE;
          if (Math.hypot(p.x - s.x, p.y - s.y) < 900) sfx.moverClunk();
        }
      }
      const a2 = pts[s.seg], b2 = pts[(s.seg + 1) % pts.length];
      const k = easeT(s, clamp(s.t, 0, 1));
      const nx = a2.x + (b2.x - a2.x) * k, ny = a2.y + (b2.y - a2.y) * k;
      const dx = nx - s.x, dy = ny - s.y;
      if (!dx && !dy) continue;
      // carry the rider BEFORE the platform moves out from under them
      const riding = standingOn(s) && p.x + p.w > s.x - 2 && p.x < s.x + s.w + 2;
      s.x = nx; s.y = ny;
      // feet track the riding face EXACTLY (a += dy carry accumulates float
      // dust that can leave the rider 1e-13 INSIDE the platform — the x-axis
      // resolver then sees a paper-thin y-overlap and ejects them by penL)
      if (riding) { p.x += dx; p.y = gDir > 0 ? s.y - p.h : s.y + s.h; }
      else if (aabb(p.x, p.y, p.w, p.h, s.x, s.y, s.w, s.h)) {
        p.x += dx; p.y += dy; // shoved by the face
        pushed = true;
      }
    }
  }
  if (pushed) depenetrate(st);
}

/* ---- environmental props: pressure plates drive linked gates; clutter is
 * destructible juice (slash near it, dash through it, or land hard on it).
 * Gates are kinded SOLIDS whose height retracts (bottom lifts like a door),
 * so collision/LOS need no special cases beyond kind exclusion in audits. */
export function updateProps(st, dt) {
  const p = st.player;
  const pressed = {};
  for (const pr of st.props) {
    if (pr.kind === "plate") {
      const on = p.onGround && Math.abs(p.y + p.h - pr.y) < 6 &&
        p.x + p.w > pr.x && p.x < pr.x + pr.w;
      if (on && !pr.pressed && !pr.latched) {
        sfx.plate();
        burst(st, pr.x + pr.w / 2, pr.y, 6, 120, "#8CF2FF", 200, true);
      }
      if (on && pr.latch) pr.latched = true;
      pr.pressed = on || pr.latched;
      if (pr.pressed) pressed[pr.link || "g1"] = true;
    } else if (pr.kind === "pot" || pr.kind === "crate" || pr.kind === "shard") {
      if (pr.broken) continue;
      const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
      const near = Math.hypot(pr.x - pcx, pr.y - pcy);
      if ((p.attack && near < C.ATTACK_REACH + 16) ||
          (p.dashing && near < 44) ||
          (p.vy > 480 && near < 38)) {
        pr.broken = true;
        sfx.clutter();
        impact(st, 0, 0.05, null);
        const col = pr.kind === "pot" ? "#c99a63" : pr.kind === "crate" ? "#a5793f" : "#9fb8d8";
        burst(st, pr.x, pr.y - 8, 12, 240, col, 420, false);
      }
    }
  }
  if (st.bossDown) pressed["boss"] = true; // the seal breaks
  for (const s of st.solids) {
    if (s.kind !== "gate") continue;
    const target = pressed[s.link] ? 1 : 0;
    const before = s.openT;
    // asymmetric: snaps open, closes SLOWLY — a hold-plate leaves a hustle
    // window to sprint through before the door beats you back
    s.openT = approach(s.openT, target, dt / (target ? 0.35 : 1.2));
    if (before !== s.openT && (s.openT === 1 || s.openT === 0)) sfx.moverClunk();
    s.h = Math.max(0, s.baseH * (1 - s.openT));
  }
}

export function drawProps(ctx, st, t) {
  for (const pr of st.props || []) {
    if (pr.kind === "plate") {
      const down = pr.pressed ? 3 : 0;
      ctx.fillStyle = pr.pressed ? "#8CF2FF" : "rgba(140,242,255,0.45)";
      rr(ctx, pr.x, pr.y - 6 + down, pr.w, 6 - down + 2, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(20,25,35,0.9)";
      rr(ctx, pr.x - 4, pr.y - 2, pr.w + 8, 4, 2);
      ctx.fill();
    } else if (pr.kind === "pot" || pr.kind === "crate" || pr.kind === "shard") {
      if (pr.broken) continue;
      ctx.save();
      ctx.translate(pr.x, pr.y);
      if (pr.kind === "pot") {
        ctx.fillStyle = "#c99a63";
        ctx.beginPath();
        ctx.moveTo(-8, 0); ctx.quadraticCurveTo(-11, -14, -5, -18);
        ctx.lineTo(5, -18); ctx.quadraticCurveTo(11, -14, 8, 0);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#8a6a44";
        ctx.fillRect(-6, -20, 12, 3);
      } else if (pr.kind === "crate") {
        ctx.fillStyle = "#a5793f";
        rr(ctx, -11, -22, 22, 22, 2); ctx.fill();
        ctx.strokeStyle = "rgba(60,40,20,0.6)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-11, -22, 22, 22);
        ctx.beginPath(); ctx.moveTo(-11, -22); ctx.lineTo(11, 0); ctx.stroke();
      } else {
        ctx.fillStyle = "#9fb8d8";
        ctx.beginPath();
        ctx.moveTo(0, -20); ctx.lineTo(8, -6); ctx.lineTo(4, 0); ctx.lineTo(-6, 0); ctx.lineTo(-9, -8);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
  }
}

// ---- grip walls + sticky surfaces: stick ON CONTACT, no input needed.
// Every face the geometry presents is grabbable:
//   lateral faces — cling with a slow slide toward gravity (GRIP_SLIDE for
//     grip walls, the slower STICKY_SLIDE for sticky surfaces); holding AWAY
//     from the wall peels you off deliberately; SPACE wall-jumps up-and-away.
//   anti-gravity face (the underside, or the TOP once gravity is flipped) —
//     hang with an even slower peel; SPACE drop-jumps off (gripDir 0).
//   gravity-side face — that's just standing on it; normal ground rules.
// Dash/grapple own the player while active (a stick never interrupts them),
// but both FIRE cleanly from a stuck position. Gravity-aware throughout via
// st.gravityDir so flip zones keep every face grippable.
export function checkGrip(st, dt, leftHeld, rightHeld) {
  const p = st.player;
  const g = st.gravityDir || 1;
  p.sliding = false;
  p.ceilStick = false;
  if (p.onGround || p.dashing || p.grapple) return;
  if (p.vy * g < -120) return; // launching against gravity — don't glue mid-jump
  for (const s of st.solids) {
    const grippy = s.kind === "grip" || (!s.kind && s.surface === "sticky");
    if (!grippy || s.gone) continue;
    const cap = s.kind === "grip" ? C.GRIP_SLIDE : C.STICKY_SLIDE;
    // lateral faces: y-overlap + flush in x
    if (p.y + p.h > s.y + 4 && p.y < s.y + s.h - 4) {
      const wallRight = Math.abs(p.x + p.w - s.x) < 2.5;
      const wallLeft = Math.abs(p.x - (s.x + s.w)) < 2.5;
      if (wallRight || wallLeft) {
        const dir = wallRight ? 1 : -1;
        const away = dir > 0 ? leftHeld && !rightHeld : rightHeld && !leftHeld;
        if (!away) {
          p.sliding = true;
          p.gripDir = dir; // toward the wall
          p.wallCoyote = C.WALL_COYOTE;
          if (p.vy * g > cap) p.vy = cap * g;
          if (Math.random() < 0.1 && p.vy * g > 40) sfx.gripScuff();
          if (Math.random() < 0.3) {
            const fx = wallRight ? p.x + p.w : p.x;
            addParticle(st, { x: fx, y: p.y + p.h * 0.7, vx: wallRight ? -30 : 30,
              vy: rand(-10, 40), life: 0.25, max: 0.25, grav: 300 * g,
              size: rand(1.5, 2.5), color: s.kind === "grip" ? "#9fd8a8" : "#c99aff" });
          }
          break;
        }
      }
    }
    // anti-gravity face: hang from the underside (top face when flipped)
    if (p.x + p.w > s.x + 4 && p.x < s.x + s.w - 4) {
      const headTouch = g > 0
        ? Math.abs(p.y - (s.y + s.h)) < 2.5
        : Math.abs(p.y + p.h - s.y) < 2.5;
      if (headTouch) {
        p.ceilStick = true;
        p.sliding = true;
        p.gripDir = 0; // game.js turns SPACE into a drop-jump for this
        p.wallCoyote = C.WALL_COYOTE;
        const hangCap = cap * 0.75;
        if (p.vy * g > hangCap) p.vy = hangCap * g; // the slow peel
        if (Math.random() < 0.25) {
          const fy = g > 0 ? p.y : p.y + p.h;
          addParticle(st, { x: p.x + rand(4, p.w - 4), y: fy, vx: rand(-15, 15),
            vy: 20 * g, life: 0.3, max: 0.3, grav: 260 * g,
            size: rand(1.5, 2.5), color: s.kind === "grip" ? "#9fd8a8" : "#c99aff" });
        }
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ render
// replaces the flat solids loop — statics draw exactly as before
export function drawSolids(ctx, st, t) {
  for (const s of st.solids) {
    if (s.brittle) {
      // = a broken floor, not a cycle). Intact: corruption-veined terrain
      // with a warning glow; shattered: a brief red flash, then nothing.
      if (s.gone) {
        if (s.shatterT > 0) {
          s.shatterT -= 1 / 60;
          ctx.strokeStyle = `rgba(224,48,74,${Math.max(0, s.shatterT / 0.5) * 0.7})`;
          ctx.lineWidth = 2;
          rr(ctx, s.x, s.y, s.w, s.h, 5); ctx.stroke();
        }
        continue;
      }
      ctx.fillStyle = "#2a1820";
      rr(ctx, s.x, s.y, s.w, s.h, 5); ctx.fill();
      ctx.fillStyle = "#5a2632"; // the corrupted cap
      rr(ctx, s.x, s.y, s.w, 5, 3); ctx.fill();
      ctx.strokeStyle = `rgba(224,48,74,${0.28 + 0.14 * Math.sin(t * 3 + s.x * 0.02)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); // the veins warn: this floor will fall
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      for (const [a, b, c, d] of [[-0.4, -0.3, 0.2, 0.35], [0.3, -0.35, -0.1, 0.3], [-0.15, 0.36, 0.4, -0.1]]) {
        ctx.moveTo(cx + s.w * a, cy + s.h * b);
        ctx.lineTo(cx + s.w * c, cy + s.h * d);
      }
      ctx.stroke();
      continue;
    }
    if (s.kind === "crumble") {
      if (s.gone) { // dashed ghost + regrow sweep: it's coming back, count on it
        const k = 1 - s.regrowT / C.CRUMBLE_REGROW;
        ctx.strokeStyle = `rgba(214,168,120,${0.14 + k * 0.2})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 7]);
        rr(ctx, s.x, s.y, s.w, s.h, 6);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      const sh = s.crumbleT > 0 ? s.shake * 2.4 : 0;
      const ox = rand(-sh, sh), oy = rand(-sh, sh);
      ctx.fillStyle = "#3a2c22";
      rr(ctx, s.x + ox, s.y + oy, s.w, s.h, 6); ctx.fill();
      ctx.fillStyle = "#7c5a3e";
      rr(ctx, s.x + ox, s.y + oy, s.w, 5, 3); ctx.fill();
      ctx.strokeStyle = "rgba(20,12,8,0.55)"; // cracks
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x + ox + s.w * 0.3, s.y + oy + 3);
      ctx.lineTo(s.x + ox + s.w * 0.42, s.y + oy + s.h - 4);
      ctx.moveTo(s.x + ox + s.w * 0.68, s.y + oy + 2);
      ctx.lineTo(s.x + ox + s.w * 0.58, s.y + oy + s.h * 0.6);
      ctx.stroke();

    } else if (s.kind === "scorch") {
      // SCORCHED STONE (E1) — a burnt pane an INFERNAL dash shatters. Gone =
      // gone (a broken door, not a cycle); a brief flare marks the break.
      if (s.gone) {
        if (s.shatterT > 0) {
          s.shatterT -= 1 / 60;
          ctx.strokeStyle = `rgba(255,140,70,${Math.max(0, s.shatterT / 0.35) * 0.7})`;
          ctx.lineWidth = 2;
          rr(ctx, s.x, s.y, s.w, s.h, 4); ctx.stroke();
        }
        continue;
      }
      ctx.fillStyle = "#241412"; // charred base
      rr(ctx, s.x, s.y, s.w, s.h, 4); ctx.fill();
      const hot = st.infernal ? 0.32 + 0.16 * Math.abs(Math.sin(t * 3)) : 0.12;
      ctx.strokeStyle = `rgba(255,110,50,${hot})`; // ember cracks — hot when
      ctx.lineWidth = 1.5;                          // the unlock can break it
      ctx.beginPath();
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      for (const [dx1, dy1, dx2, dy2] of [[-0.5, -0.36, 0.24, 0.1], [0.34, -0.42, -0.14, 0.4], [-0.3, 0.42, 0.42, -0.06]]) {
        ctx.moveTo(cx + s.w * dx1 * 0.9, cy + s.h * dy1 * 0.9);
        ctx.lineTo(cx + s.w * dx2 * 0.9, cy + s.h * dy2 * 0.9);
      }
      ctx.stroke();
      ctx.strokeStyle = `rgba(120,60,40,0.6)`;
      rr(ctx, s.x, s.y, s.w, s.h, 4); ctx.stroke();

    } else if (s.kind === "mover") {
      // rail through every waypoint — the path is a promise
      ctx.strokeStyle = "rgba(140,180,255,0.14)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 9]);
      ctx.beginPath();
      const pts = s.pts || [{ x: s.ax, y: s.ay }, { x: s.bx, y: s.by }];
      ctx.moveTo(pts[0].x + s.w / 2, pts[0].y + s.h / 2);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + s.w / 2, pts[i].y + s.h / 2);
      if (s.mode === "loop") ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#233046";
      rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.fillStyle = "#5b78a8";
      rr(ctx, s.x, s.y, s.w, 5, 3); ctx.fill();
      ctx.fillStyle = "rgba(140,180,255,0.28)"; // direction chevrons
      const fw = s.dir * (s.bx >= s.ax ? 1 : -1) >= 0 ? 1 : -1;
      for (let i = 0; i < 2; i++) {
        const cx = s.x + s.w / 2 + (i - 0.5) * 18;
        ctx.beginPath();
        ctx.moveTo(cx - 4 * fw, s.y + s.h / 2 + 1);
        ctx.lineTo(cx + 3 * fw, s.y + s.h / 2 + 5);
        ctx.lineTo(cx - 4 * fw, s.y + s.h / 2 + 9);
        ctx.stroke();
      }

    } else if (s.kind === "gate") {
      // door: slats retract upward as it opens; frame shows the full travel
      ctx.strokeStyle = "rgba(140,242,255,0.25)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(s.x - 2, s.y - 2, s.w + 4, s.baseH + 4);
      if (s.h > 1) {
        ctx.fillStyle = "#2a3a4a";
        rr(ctx, s.x, s.y, s.w, s.h, 3); ctx.fill();
        ctx.strokeStyle = "#8CF2FF";
        ctx.lineWidth = 2;
        rr(ctx, s.x, s.y, s.w, s.h, 3); ctx.stroke();
        ctx.strokeStyle = "rgba(140,242,255,0.35)";
        ctx.lineWidth = 1;
        for (let y = s.y + 8; y < s.y + s.h - 4; y += 12) {
          ctx.beginPath(); ctx.moveTo(s.x + 3, y); ctx.lineTo(s.x + s.w - 3, y); ctx.stroke();
        }
      }
    } else if (s.kind === "oneway") {
      ctx.fillStyle = "rgba(160,190,230,0.5)";
      rr(ctx, s.x, s.y, s.w, Math.max(6, s.h), 3); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      for (let x = s.x + 10; x < s.x + s.w - 6; x += 24) { // up-chevrons: pass from below
        ctx.beginPath();
        ctx.moveTo(x, s.y + 5); ctx.lineTo(x + 5, s.y + 1); ctx.lineTo(x + 10, s.y + 5);
        ctx.stroke();
      }
    } else if (s.kind === "valve") {
      ctx.fillStyle = "rgba(140,242,255,0.18)";
      rr(ctx, s.x, s.y, s.w, s.h, 4); ctx.fill();
      ctx.strokeStyle = "rgba(140,242,255,0.6)";
      ctx.lineWidth = 1.5;
      rr(ctx, s.x, s.y, s.w, s.h, 4); ctx.stroke();
      for (let y = s.y + 14; y < s.y + s.h - 8; y += 26) { // arrows: pass direction
        ctx.beginPath();
        const cx = s.x + s.w / 2, d = (s.dir || 1) * 5;
        ctx.moveTo(cx - d, y - 5); ctx.lineTo(cx + d, y); ctx.lineTo(cx - d, y + 5);
        ctx.stroke();
      }
    } else if (s.kind === "pad") {
      // angled launch pad: plate + chevrons streaming along the launch angle
      const rad = ((s.angle || 0) * Math.PI) / 180; // 0° = launch straight up
      const k = s.contactT > 0 ? s.contactT / 0.22 : 0;
      ctx.save();
      ctx.translate(s.x + s.w / 2, s.y + s.h / 2);
      ctx.fillStyle = "#3a2c16";
      rr(ctx, -s.w / 2, -s.h / 2, s.w, s.h, 5); ctx.fill();
      ctx.shadowColor = "#ffb454"; ctx.shadowBlur = 8 + k * 14;
      ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 2;
      rr(ctx, -s.w / 2, -s.h / 2, s.w, s.h, 5); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.rotate(rad); // chevrons live in the launch frame
      ctx.strokeStyle = "rgba(255,209,102,0.9)";
      ctx.lineWidth = 2.5;
      const reach = 1 + k * 0.6;
      for (let i = 0; i < 2; i++) {
        const oy = (-8 - i * 9) * reach;
        ctx.beginPath();
        ctx.moveTo(-8, oy + 6); ctx.lineTo(0, oy - 2); ctx.lineTo(8, oy + 6);
        ctx.stroke();
      }
      ctx.restore();

    } else if (s.kind === "grip") {
      ctx.fillStyle = "#20301f";
      rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.strokeStyle = "rgba(159,216,168,0.6)";
      ctx.lineWidth = 2;
      rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.stroke();
      // ridges on EVERY face — all four are grabbable now
      ctx.strokeStyle = "rgba(159,216,168,0.35)";
      ctx.lineWidth = 1.5;
      for (let y = s.y + 10; y < s.y + s.h - 6; y += 22) {
        ctx.beginPath();
        ctx.moveTo(s.x + 2, y); ctx.lineTo(s.x + 7, y + 5);
        ctx.moveTo(s.x + s.w - 2, y); ctx.lineTo(s.x + s.w - 7, y + 5);
        ctx.stroke();
      }
      for (let x = s.x + 10; x < s.x + s.w - 6; x += 22) {
        ctx.beginPath();
        ctx.moveTo(x, s.y + 2); ctx.lineTo(x + 5, s.y + 7);
        ctx.moveTo(x, s.y + s.h - 2); ctx.lineTo(x + 5, s.y + s.h - 7);
        ctx.stroke();
      }

    } else if (s.surface === "ice") {
      // pale blue tint + a gloss highlight riding the surface edge
      ctx.fillStyle = "#22333f"; rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.fillStyle = "rgba(140,200,255,0.14)"; rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.fillStyle = "#9fd4ef"; rr(ctx, s.x, s.y, s.w, 5, 3); ctx.fill();
      ctx.fillStyle = "rgba(220,245,255,0.6)";
      rr(ctx, s.x + 6, s.y + 1.5, Math.max(10, s.w * 0.35), 2.5, 1.5); ctx.fill();
      ctx.fillStyle = "rgba(200,235,255,0.07)"; // inner sheen
      rr(ctx, s.x + 4, s.y + 6, s.w - 8, Math.min(s.h - 8, 12), 3); ctx.fill();

    } else if (s.surface === "bouncy") {
      // bright accent pad; squashes for a beat when something bounces off it
      const k = s.contactT > 0 ? s.contactT / 0.22 : 0;
      ctx.save();
      ctx.translate(s.x + s.w / 2, s.y + s.h);
      ctx.scale(1 + k * 0.08, 1 - k * 0.3);
      ctx.translate(-(s.x + s.w / 2), -(s.y + s.h));
      ctx.fillStyle = "#25352a"; rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.shadowColor = "#a8ff7a"; ctx.shadowBlur = k > 0 ? 18 : 8;
      ctx.fillStyle = "#a8ff7a"; rr(ctx, s.x, s.y, s.w, 6, 3); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(168,255,122,0.4)";
      ctx.lineWidth = 1.5;
      rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.stroke();
      ctx.restore();

    } else if (s.surface === "sticky") {
      // darker, tar-like face with drip texture
      ctx.fillStyle = "#1c1426"; rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.fillStyle = "#3d2b55"; rr(ctx, s.x, s.y, s.w, 5, 3); ctx.fill();
      ctx.fillStyle = "rgba(120,90,170,0.28)";
      for (let x = s.x + 8; x < s.x + s.w - 6; x += 26) {
        const dh = 8 + ((x * 7919) % 12); // stable pseudo-random drip lengths
        rr(ctx, x, s.y + 4, 5, Math.min(dh, s.h - 8), 2.5); ctx.fill();
      }
      for (let y = s.y + 12; y < s.y + s.h - 8; y += 30) { // side beads
        ctx.beginPath(); ctx.arc(s.x + 2.5, y, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(s.x + s.w - 2.5, y + 14, 2.5, 0, Math.PI * 2); ctx.fill();
      }

    } else if (s.surface === "conveyor") {
      // rolling belt: chevrons stream in the carry direction
      const cs = s.conveyorSpeed ?? C.CONVEYOR_SPEED;
      ctx.fillStyle = "#2b2436"; rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.fillStyle = "#171220"; rr(ctx, s.x, s.y, s.w, 9, 4); ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.rect(s.x + 2, s.y, s.w - 4, 9); ctx.clip();
      ctx.strokeStyle = "rgba(255,209,102,0.85)";
      ctx.lineWidth = 2;
      const dir = cs >= 0 ? 1 : -1;
      const off = ((t * Math.abs(cs)) % 22) * dir;
      for (let x = s.x - 22; x < s.x + s.w + 22; x += 22) {
        const cx = x + off;
        ctx.beginPath();
        ctx.moveTo(cx - 3 * dir, s.y + 1.5);
        ctx.lineTo(cx + 3 * dir, s.y + 4.5);
        ctx.lineTo(cx - 3 * dir, s.y + 7.5);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = "rgba(255,209,102,0.5)"; // roller caps
      ctx.beginPath(); ctx.arc(s.x + 5, s.y + 4.5, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(s.x + s.w - 5, s.y + 4.5, 3, 0, Math.PI * 2); ctx.fill();

    } else if (s.hidden) {
      // collision is ALWAYS live; only VISIBILITY modulates). The dark shows
      // its shapes NEAR you, and the dash PULSES the whole room readable
      // (game.js sets st.revealT on every dash).
      const p = st.player;
      const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
      const nx = Math.max(s.x, Math.min(pcx, s.x + s.w));
      const ny = Math.max(s.y, Math.min(pcy, s.y + s.h));
      const d = Math.hypot(pcx - nx, pcy - ny);
      const near = d < 170 ? 1 : d > 440 ? 0 : 1 - (d - 170) / 270;
      const pulse = (st.revealT || 0) > 0 ? Math.min(1, st.revealT / 0.25) : 0;
      const a = Math.max(0.05, Math.max(near, pulse * 0.9));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = "#10121c"; rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.strokeStyle = "rgba(106,176,255,0.55)"; // the memory-blue edge
      ctx.lineWidth = 1.5; rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.stroke();
      ctx.fillStyle = "rgba(106,176,255,0.2)"; rr(ctx, s.x, s.y, s.w, 4, 2); ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = "#262033"; rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
      ctx.fillStyle = "#5b4358"; rr(ctx, s.x, s.y, s.w, 5, 3); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.045)";
      rr(ctx, s.x + 4, s.y + 6, s.w - 8, Math.min(s.h - 8, 10), 3); ctx.fill();
    }
  }
}

// ---- gravity-flip + wind volumes: VISIBLE play-space (secret triggers stay
// invisible in-game; these two change the physics, so the player must read
// them at a glance). One painter for game + editor.
export function drawZones(ctx, triggers, t) {
  for (const tr of triggers) {
    if (tr.kind === "gravity") {
      ctx.save();
      ctx.fillStyle = "rgba(201,154,255,0.07)";
      ctx.fillRect(tr.x, tr.y, tr.w, tr.h);
      ctx.strokeStyle = "rgba(201,154,255,0.5)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(tr.x, tr.y, tr.w, tr.h);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.rect(tr.x, tr.y, tr.w, tr.h);
      ctx.clip();
      // anti-gravity arrows drifting UP — things fall the other way in here
      ctx.strokeStyle = "rgba(201,154,255,0.5)";
      ctx.lineWidth = 2;
      const period = 90;
      const off = period - ((t * 55) % period);
      for (let x = tr.x + 22; x < tr.x + tr.w - 8; x += 46) {
        for (let y = tr.y - period + off; y < tr.y + tr.h + period; y += period) {
          ctx.beginPath();
          ctx.moveTo(x - 6, y + 7); ctx.lineTo(x, y); ctx.lineTo(x + 6, y + 7);
          ctx.stroke();
        }
      }
      ctx.restore();

    } else if (tr.kind === "split") {
      // IL split gate: a slim timing shimmer — bright pulse when crossed
      if (tr.flashT > 0) tr.flashT -= 1 / 60;
      const hot = Math.max(0, tr.flashT || 0) * 2;
      const cx = tr.x + tr.w / 2;
      ctx.save();
      ctx.strokeStyle = `rgba(255,209,102,${0.28 + 0.12 * Math.sin(t * 3 + tr.x) + hot})`;
      ctx.lineWidth = 2 + hot * 3;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.moveTo(cx, tr.y);
      ctx.lineTo(cx, tr.y + tr.h);
      ctx.stroke();
      ctx.setLineDash([]);
      // the little timing flag on top
      ctx.fillStyle = tr.hit ? "#7dffc8" : "rgba(255,209,102,0.85)";
      ctx.beginPath();
      ctx.moveTo(cx, tr.y - 14);
      ctx.lineTo(cx + 12, tr.y - 8);
      ctx.lineTo(cx, tr.y - 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

    } else if (tr.kind === "wind") {
      const rad = ((tr.angle || 0) * Math.PI) / 180; // 0° = up
      ctx.save();
      ctx.fillStyle = "rgba(140,242,255,0.05)";
      ctx.fillRect(tr.x, tr.y, tr.w, tr.h);
      ctx.strokeStyle = "rgba(140,242,255,0.35)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 8]);
      ctx.strokeRect(tr.x, tr.y, tr.w, tr.h);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.rect(tr.x, tr.y, tr.w, tr.h);
      ctx.clip();
      // streaks flowing along the wind direction
      const cx = tr.x + tr.w / 2, cy = tr.y + tr.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate(rad);
      ctx.strokeStyle = "rgba(140,242,255,0.4)";
      ctx.lineWidth = 1.5;
      const ext = (Math.hypot(tr.w, tr.h) / 2) + 40;
      const period = 70;
      const off = period - ((t * ((tr.force || 1000) / 12)) % period);
      for (let x = -ext + 12; x < ext; x += 34) {
        for (let y = -ext + off - period; y < ext + period; y += period) {
          const wob = Math.sin(x * 0.3 + t * 2) * 3;
          ctx.beginPath();
          ctx.moveTo(x + wob, y + 16);
          ctx.lineTo(x + wob, y);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
}

// ---- spikes: one painter for game + editor. Rotation (degrees) spins the
// whole tooth strip around the rect center; rot 0 draws exactly as before.
// Pulsing spikes (s.pulse) retract/extend their TEETH with the phase —
// pass simTime for the live envelope (the editor passes none: always out).
export function drawSpikes(ctx, spikes, simTime = null) {
  for (const s of spikes) {
    const k = s.pulse && simTime != null ? pulseK(s, simTime) : 1;
    ctx.save();
    if (s.rot) {
      ctx.translate(s.x + s.w / 2, s.y + s.h / 2);
      ctx.rotate((s.rot * Math.PI) / 180);
      ctx.translate(-(s.x + s.w / 2), -(s.y + s.h / 2));
    }
    // teeth exactly tile the full width (no bare strip at either wall),
    // sitting on a dark base that fills the rest of the rect
    const teeth = Math.max(1, Math.round(s.w / 26));
    const tw = s.w / teeth;
    const toothFull = Math.min(26, s.h);
    const toothH = toothFull * k;
    const baseY = s.y + toothFull - 6; // base stays put — the tell lives here
    ctx.fillStyle = "#2a0d15";
    ctx.fillRect(s.x, baseY, s.w, Math.max(0, s.y + s.h - baseY));
    ctx.fillStyle = k >= 0.99 ? "#d0455a" : "#8a3644"; // dimmer while phased
    const tipY = s.y + (toothFull - toothH);
    for (let i = 0; i < teeth; i++) {
      const bx = s.x + i * tw;
      ctx.beginPath();
      ctx.moveTo(bx, s.y + toothFull);
      ctx.lineTo(bx + tw / 2, tipY);
      ctx.lineTo(bx + tw, s.y + toothFull);
      ctx.closePath(); ctx.fill();
    }
    if (k >= 0.99) { // subtle highlight ridge along the tips
      ctx.fillStyle = "rgba(255,150,170,0.35)";
      for (let i = 0; i < teeth; i++) {
        const bx = s.x + i * tw;
        ctx.fillRect(bx + tw / 2 - 1, tipY + 3, 2, 6);
      }
    }
    ctx.restore();
  }
}
