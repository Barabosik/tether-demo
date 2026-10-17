import { initWorldBg, updateWorldBg, drawWorldBg } from "./worldbg.js";

/* Menu backdrops: the real parallax art of a world (worldbg.js), drifting
 * slowly behind the title and the level select so the menus sit IN the
 * game's world instead of on a blank page. One cached backdrop per world;
 * switching worlds cross-fades. A scrim in the UI ground keeps every label
 * readable over the art. Pure render — no gameplay state is touched. */

const WORLD = { w: 3400, h: 1300 };
const cache = new Map();
let cur = null, prev = null, fade = 1, lastT = null, vignette = null;

function backdrop(worldId) {
  if (!cache.has(worldId)) {
    const wbg = initWorldBg({ id: "menu-" + worldId, worldId, data: { solids: [] } }, WORLD);
    cache.set(worldId, wbg && {
      worldbg: wbg, world: WORLD,
      cam: { x: 900 + 260 * worldId, y: WORLD.h - 630 },
      dir: 1,
    });
  }
  return cache.get(worldId);
}

function step(b, dt) {
  // a slow pan across the skyline, turning at the ends; the far planes move
  // least, so the drift reads as depth
  b.cam.x += b.dir * 16 * dt;
  if (b.cam.x > WORLD.w - 1120 - 40) b.dir = -1;
  if (b.cam.x < 40) b.dir = 1;
  updateWorldBg(b.worldbg, b.world, dt, b.cam);
}

// draw the backdrop for `worldId` at `t` (seconds); `scrim` 0..1 darkens it
// toward the UI ground. Returns false when the world has no configured art.
export function drawMenuBg(ctx, worldId, t, W, H, scrim = 0.55) {
  const b = backdrop(worldId);
  if (!b) return false;
  const dt = lastT == null ? 0 : Math.min(0.05, Math.max(0, t - lastT));
  lastT = t;
  if (cur !== b) { prev = cur; cur = b; fade = prev ? 0 : 1; }
  if (fade < 1) fade = Math.min(1, fade + dt / 0.35);
  step(b, dt);
  if (prev && fade < 1) {
    step(prev, dt);
    drawWorldBg(ctx, prev, W, H, t);
    ctx.globalAlpha = fade;
  }
  drawWorldBg(ctx, b, W, H, t);
  ctx.globalAlpha = 1;
  if (scrim > 0) {
    ctx.fillStyle = `rgba(13,17,15,${scrim})`;
    ctx.fillRect(0, 0, W, H);
  }
  // a soft lens vignette pulls the eye to the centre and seats the art
  // into the frame edges (cached; the canvas size never changes)
  if (!vignette || vignette.W !== W || vignette.H !== H) {
    const g = ctx.createRadialGradient(W / 2, H * 0.46, H * 0.32, W / 2, H * 0.46, W * 0.72);
    g.addColorStop(0, "rgba(13,17,15,0)");
    g.addColorStop(1, "rgba(13,17,15,0.62)");
    vignette = { g, W, H };
  }
  ctx.fillStyle = vignette.g;
  ctx.fillRect(0, 0, W, H);
  return true;
}
