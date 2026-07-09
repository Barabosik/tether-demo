import { CONFIG as C } from "./config.js";
import { clamp } from "./util.js";

/* THE TITLE CARD — the shared image the game OPENS and CLOSES on. TETHER over
 *
 *
 * through these helpers so the bookends are provably identical — the same
 * anti-drift discipline as drawWanderer being the single source for the
 * player. Everything here is pure draw / pure state; no globals. */

// the calm blue dawn gradient, filled at `alpha`
export function drawDawn(ctx, alpha) {
  if (alpha <= 0) return;
  const g = ctx.createLinearGradient(0, 0, 0, C.VIEW_H);
  g.addColorStop(0, "#0c2c4c");
  g.addColorStop(0.55, "#0a1e39");
  g.addColorStop(1, "#061020");
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, C.VIEW_W, C.VIEW_H);
  ctx.globalAlpha = 1;
}

export const makeMoteField = () => ({ motes: [], gap: 0 });
export function stepMotes(field, dt) {
  field.gap -= dt;
  if (field.gap <= 0) {
    field.gap = 0.12;
    field.motes.push({ x: Math.random() * C.VIEW_W, y: C.VIEW_H + 16,
      vy: 24 + Math.random() * 34, drift: (Math.random() - 0.5) * 16,
      ph: Math.random() * Math.PI * 2, life: 0, warm: Math.random() < 0.4 });
  }
  for (let i = field.motes.length - 1; i >= 0; i--) {
    const m = field.motes[i];
    m.life += dt;
    m.y -= m.vy * dt;
    m.x += Math.sin(m.life * 1.6 + m.ph) * m.drift * dt;
    if (m.y < -20) field.motes.splice(i, 1);
  }
}
export function drawMotes(ctx, field, alpha) {
  for (const m of field.motes) {
    const a = clamp(Math.min(m.life, 1), 0, 1) * clamp(m.y / C.VIEW_H + 0.2, 0, 1) * alpha;
    if (a <= 0) continue;
    ctx.globalAlpha = a * (0.5 + 0.3 * Math.sin(m.life * 3 + m.ph));
    ctx.fillStyle = m.warm ? "#bfe6ff" : "#8CF2FF";
    ctx.shadowColor = "#8CF2FF"; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(m.x, m.y, 2.1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}

// the wordmark — TETHER, glowing cyan, centered on baseline y
export function drawWordmark(ctx, y, alpha) {
  ctx.textAlign = "center";
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#f0f8ff";
  ctx.shadowColor = "#8CF2FF"; ctx.shadowBlur = 26;
  ctx.font = "800 62px ui-monospace, Menlo, monospace";
  ctx.fillText("TETHER", C.VIEW_W / 2, y);
  ctx.shadowBlur = 0; ctx.globalAlpha = 1;
}

// a centered line under the wordmark (subtitle / prompt), at `alpha`
export function drawTitleLine(ctx, text, y, alpha, size = 16, color = "#9ec8f0") {
  ctx.textAlign = "center";
  ctx.globalAlpha = alpha;
  ctx.font = `500 ${size}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = color;
  ctx.fillText(text, C.VIEW_W / 2, y);
  ctx.globalAlpha = 1;
}
