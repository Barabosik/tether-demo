// Math + drawing helpers. Pure functions only.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const approach = (v, t, d) => (v < t ? Math.min(v + d, t) : Math.max(v - d, t));
export const rand = (a, b) => a + Math.random() * (b - a);
export const len2 = (x, y) => Math.hypot(x, y);
export const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);

export const aabb = (ax, ay, aw, ah, bx, by, bw, bh) =>
  ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

export const circleRect = (cx, cy, r, rx, ry, rw, rh) => {
  const nx = clamp(cx, rx, rx + rw), ny = clamp(cy, ry, ry + rh);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
};

// smallest absolute difference between two angles (radians)
export const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
};

// Liang-Barsky segment vs rect: entry param t in [0,1], or Infinity on miss.
export function segRectT(x1, y1, x2, y2, r) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) {
      if (q[i] < 0) return Infinity;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return Infinity;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return Infinity;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0;
}

// Capsule-swept segment vs oriented box: transform the segment into the box's
// local frame, then reuse the Liang-Barsky rect test against the rect inflated
// by radius r. Returns entry t in [0,1] or Infinity. Used by rotated spikes.
export function segObbT(x1, y1, x2, y2, cx, cy, hw, hh, rotRad, r) {
  const c = Math.cos(-rotRad), s = Math.sin(-rotRad);
  const lx1 = (x1 - cx) * c - (y1 - cy) * s, ly1 = (x1 - cx) * s + (y1 - cy) * c;
  const lx2 = (x2 - cx) * c - (y2 - cy) * s, ly2 = (x2 - cx) * s + (y2 - cy) * c;
  return segRectT(lx1, ly1, lx2, ly2,
    { x: -hw - r, y: -hh - r, w: (hw + r) * 2, h: (hh + r) * 2 });
}

// world-space AABB of a rotated rect (editor picking/selection of spikes)
export function rotAabb(x, y, w, h, rotRad) {
  const cx = x + w / 2, cy = y + h / 2;
  const c = Math.abs(Math.cos(rotRad)), s = Math.abs(Math.sin(rotRad));
  const hw = (w * c + h * s) / 2, hh = (w * s + h * c) / 2;
  return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
}

export const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${m}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};

export function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawStarPath(ctx, cx, cy, spikes, outer, inner) {
  let rot = -Math.PI / 2;
  const step = Math.PI / spikes;
  ctx.beginPath();
  ctx.moveTo(cx, cy - outer);
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer); rot += step;
    ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner); rot += step;
  }
  ctx.closePath();
}

export function drawDiamondPath(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}
