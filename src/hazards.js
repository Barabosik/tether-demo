import { CONFIG as C } from "./config.js";
import { aabb, circleRect, rr } from "./util.js";

/* Moving hazards — a separate top-level level array (`hazards`, default []).
 * Every kind is authored data the editor manipulates directly, damage is
 * player-only through the ONE shared mercy window (game.js hurt()), and the
 * telegraph IS the render: paths/arcs/cycles are always visible.
 *
 *  saw      — spinning blade. mode "orbit" (center, orbitR, rpm, phase) or
 *             "track" (waypoint path + speed, loop|pingpong). Punishes
 *             sloppy swing arcs and lazy dash lines.
 *  pendulum — spiked head on a chain (anchor, armLen, arcDeg, period,
 *             phase). Owns the space UNDER anchors — time your swing.
 *  crusher  — a block that telegraphs (shake), slams along `angle`
 *             (0°=up, cw; default 180=down) by `travel`, holds, retracts,
 *             on a `cycle` with `phase`. Forces route-timing. Not a solid —
 *             contact while extended hurts.
 *  laser    — a constant beam curtain that ONLY a dash passes (i-frames are
 *             irrelevant: the check is the dash itself). Verb-gated space.
 *
 * Spikes additionally accept two flags (see game.js / levelload.js):
 *  pulse: {on, off, phase} — phases in/out on a cycle (rhythm hazard)
 *  pin: 1 — keep the authored rect exactly (single teeth, floaters). */

export function instantiateHazards(list) {
  return (list || []).map((h) => {
    const o = { ...h };
    if (o.kind === "saw") {
      o.r = o.r || 26;
      if (o.mode === "track" && o.path?.length >= 2) {
        o.pts = o.path.map((p) => ({ x: p.x, y: p.y }));
        o.seg = 0; o.tt = 0; o.dir = 1;
        o.sx = o.pts[0].x; o.sy = o.pts[0].y;
      } else {
        o.mode = "orbit";
        o.orbitR = o.orbitR ?? 90;
        o.rpm = o.rpm ?? 26;
        o.sx = o.x + (o.orbitR || 0); o.sy = o.y;
      }
      o.spin = 0;
    } else if (o.kind === "pendulum") {
      o.armLen = o.armLen ?? 170;
      o.arcDeg = o.arcDeg ?? 55;
      o.period = o.period ?? 2.6;
      o.r = o.r || 20;
      o.hx = o.x; o.hy = o.y + o.armLen;
    } else if (o.kind === "crusher") {
      o.w = o.w || 90; o.h = o.h || 70;
      o.travel = o.travel ?? 140;
      o.cycle = o.cycle ?? 2.8;
      o.ext = 0; o.shake = 0;
    } else if (o.kind === "laser") {
      o.w = o.w || 26; o.h = o.h || 260;
    }
    return o;
  });
}

// crusher cycle envelope: idle → telegraph(shake) → SLAM → hold → retract
function crusherExt(tc) {
  if (tc < 0.42) return { f: 0, shake: 0 };
  if (tc < 0.5) return { f: 0, shake: (tc - 0.42) / 0.08 }; // wind-up tell
  if (tc < 0.56) return { f: (tc - 0.5) / 0.06, shake: 0 }; // slam
  if (tc < 0.74) return { f: 1, shake: 0 };                  // hold
  if (tc < 0.95) return { f: 1 - (tc - 0.74) / 0.21, shake: 0 }; // retract
  return { f: 0, shake: 0 };
}
const crusherRect = (h) => {
  const a = ((h.angle ?? 180) * Math.PI) / 180; // 0°=up, cw
  const dx = Math.sin(a), dy = -Math.cos(a);
  return { x: h.x + dx * h.travel * h.ext, y: h.y + dy * h.travel * h.ext, w: h.w, h: h.h };
};

export function updateHazards(st, dt) {
  const T = st.simTime;
  for (const h of st.hazards) {
    if (h.kind === "saw") {
      h.spin += dt * 9;
      if (h.mode === "orbit") {
        const ang = (T * (h.rpm ?? 26) * Math.PI * 2) / 60 + (h.phase || 0);
        h.sx = h.x + Math.cos(ang) * h.orbitR;
        h.sy = h.y + Math.sin(ang) * h.orbitR;
      } else { // track: compact waypoint traversal (no dwell — blades roll)
        const pts = h.pts;
        const segN = h.mode2 === "loop" || h.loop ? pts.length : pts.length - 1;
        const a = pts[h.seg], b = pts[(h.seg + 1) % pts.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        h.tt += (h.dir * (h.speed || 120) * dt) / len;
        if (h.tt >= 1) {
          if (h.loop) { h.seg = (h.seg + 1) % segN; h.tt = 0; }
          else if (h.seg < segN - 1) { h.seg++; h.tt = 0; }
          else { h.tt = 1; h.dir = -1; }
        } else if (h.tt <= 0 && h.dir < 0) {
          if (h.seg > 0) { h.seg--; h.tt = 1; }
          else { h.tt = 0; h.dir = 1; }
        }
        const a2 = pts[h.seg], b2 = pts[(h.seg + 1) % pts.length];
        const k = Math.max(0, Math.min(1, h.tt));
        h.sx = a2.x + (b2.x - a2.x) * k;
        h.sy = a2.y + (b2.y - a2.y) * k;
      }
    } else if (h.kind === "pendulum") {
      const ang = ((h.arcDeg * Math.PI) / 180) *
        Math.sin((Math.PI * 2 * T) / h.period + (h.phase || 0));
      h.hx = h.x + Math.sin(ang) * h.armLen;
      h.hy = h.y + Math.cos(ang) * h.armLen;
    } else if (h.kind === "crusher") {
      const tc = (((T / h.cycle) + (h.phase || 0)) % 1 + 1) % 1;
      const e = crusherExt(tc);
      h.ext = e.f;
      h.shake = e.shake;
    }
  }
}

// does any hazard bite the player THIS step? (gated by the caller's mercy
// window exactly like spikes — one shared damage entry point)
export function hazardHit(st) {
  const p = st.player;
  for (const h of st.hazards) {
    if (h.kind === "saw") {
      if (circleRect(h.sx, h.sy, h.r - 3, p.x, p.y, p.w, p.h)) return true;
    } else if (h.kind === "pendulum") {
      if (circleRect(h.hx, h.hy, h.r - 2, p.x, p.y, p.w, p.h)) return true;
    } else if (h.kind === "crusher") {
      if (h.ext > 0.08) {
        const r = crusherRect(h);
        if (aabb(p.x + 3, p.y + 3, p.w - 6, p.h - 6, r.x, r.y, r.w, r.h)) return true;
      }
    } else if (h.kind === "laser") {
      // the verb gate, E1-keyed: only an INFERNAL dash passes the beam. The
      // base dash is movement, not phasing — before the unlock the curtain
      // is simply a wall of harm (WORLDS.md binding; lasers are W3+ geometry).
      if (!(p.dashing && st.infernal) &&
          aabb(p.x + 4, p.y + 4, p.w - 8, p.h - 8, h.x, h.y, h.w, h.h)) return true;
    }
  }
  return false;
}

export function drawHazards(ctx, st, t) {
  for (const h of st.hazards) {
    if (h.kind === "saw") {
      // the promise: orbit ring / track line is always visible
      ctx.strokeStyle = "rgba(255,107,107,0.16)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 8]);
      if (h.mode === "orbit") {
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.orbitR, 0, Math.PI * 2);
        ctx.stroke();
      } else if (h.pts) {
        ctx.beginPath();
        ctx.moveTo(h.pts[0].x, h.pts[0].y);
        for (let i = 1; i < h.pts.length; i++) ctx.lineTo(h.pts[i].x, h.pts[i].y);
        if (h.loop) ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // the blade
      ctx.save();
      ctx.translate(h.sx, h.sy);
      ctx.rotate(h.spin);
      ctx.shadowColor = "#ff6b6b";
      ctx.shadowBlur = 10;
      ctx.fillStyle = "#7e2a35";
      ctx.beginPath(); ctx.arc(0, 0, h.r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#d0455a";
      for (let i = 0; i < 8; i++) { // teeth
        const a = (i / 8) * Math.PI * 2;
        ctx.save();
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(h.r - 4, -5);
        ctx.lineTo(h.r + 7, 0);
        ctx.lineTo(h.r - 4, 5);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = "#2a0d15";
      ctx.beginPath(); ctx.arc(0, 0, h.r * 0.35, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

    } else if (h.kind === "pendulum") {
      // chain from anchor to head
      ctx.strokeStyle = "rgba(255,150,170,0.14)"; // faint arc telegraph
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 7]);
      ctx.beginPath();
      const arc = (h.arcDeg * Math.PI) / 180;
      ctx.arc(h.x, h.y, h.armLen, Math.PI / 2 - arc, Math.PI / 2 + arc);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = "#8d7a9e";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(h.hx, h.hy);
      ctx.stroke();
      ctx.fillStyle = "#5b4358"; // anchor pin
      ctx.beginPath(); ctx.arc(h.x, h.y, 5, 0, Math.PI * 2); ctx.fill();
      // spiked head
      ctx.save();
      ctx.translate(h.hx, h.hy);
      ctx.rotate(t * 0.8);
      ctx.shadowColor = "#ff6b6b";
      ctx.shadowBlur = 10;
      ctx.fillStyle = "#7e2a35";
      ctx.beginPath(); ctx.arc(0, 0, h.r * 0.75, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#d0455a";
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.save();
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(h.r * 0.55, -4);
        ctx.lineTo(h.r + 4, 0);
        ctx.lineTo(h.r * 0.55, 4);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.restore();

    } else if (h.kind === "crusher") {
      const a = ((h.angle ?? 180) * Math.PI) / 180;
      const dx = Math.sin(a), dy = -Math.cos(a);
      // travel guide + end plate
      ctx.strokeStyle = "rgba(255,107,107,0.2)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 6]);
      ctx.strokeRect(h.x + dx * h.travel, h.y + dy * h.travel, h.w, h.h);
      ctx.setLineDash([]);
      const r = crusherRect(h);
      const sh = h.shake * 2.5;
      const ox = (Math.random() * 2 - 1) * sh, oy = (Math.random() * 2 - 1) * sh;
      ctx.fillStyle = "#3a2028";
      rr(ctx, r.x + ox, r.y + oy, r.w, r.h, 4); ctx.fill();
      ctx.strokeStyle = h.ext > 0.08 || h.shake > 0 ? "#ff6b6b" : "rgba(255,107,107,0.45)";
      ctx.lineWidth = 2;
      rr(ctx, r.x + ox, r.y + oy, r.w, r.h, 4); ctx.stroke();
      // crush face teeth on the leading edge
      ctx.fillStyle = "#d0455a";
      const n = Math.max(2, Math.round((Math.abs(dy) > 0.5 ? r.w : r.h) / 22));
      for (let i = 0; i < n; i++) {
        ctx.beginPath();
        if (Math.abs(dy) > 0.5) { // vertical slam: teeth on top/bottom face
          const bx = r.x + (i + 0.5) * (r.w / n), fy = dy > 0 ? r.y + r.h : r.y;
          ctx.moveTo(bx - 7, fy); ctx.lineTo(bx, fy + dy * 10); ctx.lineTo(bx + 7, fy);
        } else {
          const by = r.y + (i + 0.5) * (r.h / n), fx = dx > 0 ? r.x + r.w : r.x;
          ctx.moveTo(fx, by - 7); ctx.lineTo(fx + dx * 10, by); ctx.lineTo(fx, by + 7);
        }
        ctx.closePath(); ctx.fill();
      }

    } else if (h.kind === "laser") {
      const hum = 0.55 + 0.25 * Math.sin(t * 12);
      ctx.save();
      ctx.fillStyle = `rgba(255,80,120,${0.10 + 0.05 * hum})`;
      ctx.fillRect(h.x, h.y, h.w, h.h);
      ctx.shadowColor = "#ff5078";
      ctx.shadowBlur = 12;
      ctx.strokeStyle = `rgba(255,110,150,${hum})`;
      ctx.lineWidth = 2;
      const cx = h.x + h.w / 2;
      if (h.h >= h.w) {
        ctx.beginPath(); ctx.moveTo(cx, h.y); ctx.lineTo(cx, h.y + h.h); ctx.stroke();
        ctx.fillStyle = "#9a4a5c"; // emitters
        ctx.fillRect(h.x, h.y - 6, h.w, 6);
        ctx.fillRect(h.x, h.y + h.h, h.w, 6);
      } else {
        const cy = h.y + h.h / 2;
        ctx.beginPath(); ctx.moveTo(h.x, cy); ctx.lineTo(h.x + h.w, cy); ctx.stroke();
        ctx.fillStyle = "#9a4a5c";
        ctx.fillRect(h.x - 6, h.y, 6, h.h);
        ctx.fillRect(h.x + h.w, h.y, 6, h.h);
      }
      ctx.shadowBlur = 0;
      // the tell: dash chevrons across the beam — "pass THROUGH me"
      ctx.fillStyle = `rgba(255,233,201,${0.35 + 0.2 * hum})`;
      ctx.font = "bold 11px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText("» dash «", h.x + h.w / 2, h.y + h.h / 2 + 4);
      ctx.restore();
    }
  }
}

// pulse envelope for phased spikes: 1 = fully out (deadly), stubs while
// telegraphing the next extension, ~0 while safe
export function pulseK(s, simTime) {
  if (!s.pulse) return 1;
  const on = s.pulse.on ?? 1.2, off = s.pulse.off ?? 1.2;
  const cyc = on + off;
  const ph = (((simTime + (s.pulse.phase || 0)) % cyc) + cyc) % cyc;
  if (ph < on) return Math.min(1, ph / 0.12); // snap out fast
  const offLeft = cyc - ph;
  return offLeft < 0.3 ? 0.18 : 0.04; // stubs warn before the next pulse
}
export const pulseActive = (s, simTime) => !s.pulse || pulseK(s, simTime) >= 0.99;

void C;
