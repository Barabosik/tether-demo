import { rr } from "./util.js";

/* Cosmetic decor library — zero collision, pure dressing. Each piece is
 * {type, x, y, s (scale), fg (0 = behind terrain, 1 = in front of player)}.
 * Drawn procedurally in the level tint family so decor inherits each level's
 * identity. Reactive behaviors (sway/swing near the player) live in the
 * environmental pass. */

export const DECOR_TYPES = ["crystal", "tuft", "chain", "banner", "column", "orb", "root", "shard"];

export function drawDecor(ctx, d, t, tint, px, py) {
  const s = d.s || 1;
  const react = d._sway || 0; // set by the reactive pass; 0 when calm
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.scale(s, s);
  switch (d.type) {
    case "crystal": {
      ctx.shadowColor = tint; ctx.shadowBlur = 10;
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      for (const [ox, h, w] of [[-14, 34, 10], [2, 52, 13], [18, 26, 8]]) {
        ctx.beginPath();
        ctx.moveTo(ox, 0); ctx.lineTo(ox + w / 2, -h); ctx.lineTo(ox + w, 0);
        ctx.closePath();
        ctx.fillStyle = tint + "55"; ctx.fill();
        ctx.strokeStyle = tint + "aa"; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.shadowBlur = 0;
      break;
    }
    case "tuft": {
      ctx.strokeStyle = "rgba(140,190,130,0.55)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const bx = (i - 2) * 6;
        const lean = Math.sin(t * 1.2 + d.x * 0.05 + i) * 2 + react * (6 + i);
        ctx.beginPath();
        ctx.moveTo(bx, 0);
        ctx.quadraticCurveTo(bx + lean * 0.4, -12, bx + lean, -20 - (i % 3) * 6);
        ctx.stroke();
      }
      break;
    }
    case "chain": {
      ctx.strokeStyle = "rgba(200,200,220,0.4)";
      ctx.lineWidth = 2.5;
      const sway = Math.sin(t * 0.8 + d.x * 0.02) * 3 + react * 14;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(sway * 0.5, 30, sway, 58);
      ctx.stroke();
      ctx.fillStyle = "rgba(200,200,220,0.5)";
      ctx.beginPath(); ctx.arc(sway, 62, 5, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "banner": {
      ctx.fillStyle = tint + "66";
      const wave = Math.sin(t * 1.6 + d.y * 0.03) * 4 + react * 8;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(26, 0);
      ctx.lineTo(24 + wave * 0.4, 40);
      ctx.lineTo(13 + wave, 52);
      ctx.lineTo(2 + wave * 0.4, 40);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-3, -4, 32, 4);
      break;
    }
    case "column": {
      ctx.fillStyle = "rgba(120,105,140,0.35)";
      rr(ctx, -12, -70, 24, 70, 3); ctx.fill();
      ctx.fillStyle = "rgba(120,105,140,0.5)";
      rr(ctx, -16, -78, 32, 8, 2); ctx.fill();
      rr(ctx, -16, -4, 32, 6, 2); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1;
      for (const lx of [-6, 0, 6]) {
        ctx.beginPath(); ctx.moveTo(lx, -68); ctx.lineTo(lx, -6); ctx.stroke();
      }
      break;
    }
    case "orb": {
      const pulse = 0.7 + 0.3 * Math.sin(t * 2 + d.x * 0.01);
      ctx.shadowColor = tint; ctx.shadowBlur = 18 * pulse;
      ctx.fillStyle = tint + "88";
      ctx.beginPath(); ctx.arc(0, 0, 7 * pulse + 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      break;
    }
    case "root": {
      ctx.strokeStyle = "rgba(150,120,90,0.45)";
      ctx.lineWidth = 3;
      for (const [dx, dy, cx, cy] of [[-30, 14, -14, -8], [34, 10, 12, -12], [8, 22, 2, 8]]) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(cx, cy, dx, dy);
        ctx.stroke();
      }
      break;
    }
    case "shard": {
      ctx.fillStyle = "rgba(150,140,170,0.4)";
      const bob = Math.sin(t * 1.1 + d.y * 0.02) * 3;
      for (const [ox, oy, r] of [[-16, bob, 7], [6, -10 + bob * 0.6, 10], [20, 6 + bob * 0.8, 5]]) {
        ctx.beginPath();
        ctx.moveTo(ox, oy - r); ctx.lineTo(ox + r, oy); ctx.lineTo(ox, oy + r); ctx.lineTo(ox - r, oy);
        ctx.closePath(); ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

// reactive pass: nearby fast movement makes tufts/chains/banners answer
export function updateDecor(list, dt, px, py, pvx) {
  for (const d of list || []) {
    if (d.type !== "tuft" && d.type !== "chain" && d.type !== "banner") continue;
    const near = Math.abs(d.x - px) < 80 && Math.abs(d.y - py) < 90;
    const target = near ? Math.max(-1, Math.min(1, pvx / 400)) : 0;
    d._sway = (d._sway || 0) + (target - (d._sway || 0)) * Math.min(1, dt * 6);
    if (!near) d._sway *= Math.exp(-2.5 * dt);
  }
}

export function drawDecorLayer(ctx, list, fg, t, tint, px, py) {
  for (const d of list || [])
    if ((d.fg ? 1 : 0) === fg) drawDecor(ctx, d, t, tint, px, py);
}
