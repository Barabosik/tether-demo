// Level-boundary audit — the "no unbounded drop by omission" gate.
//
// Guarantees, for every level (checked AFTER alignSpikes, i.e. what ships):
//  1. SPAWN GROUND   — the spawn stands on a solid.
//  2. LEFT CAP       — ground is flush to x=0 AND a wall rises above it
//                      (you cannot walk or hop off the level's start).
//  3. RIGHT CAP      — ground is flush to x=world.w AND a wall rises above it
//                      (you cannot walk past the finish into a fall).
//  4. COLUMN COVER   — every x-column is floored by a floor-reaching solid or
//                      a spike field (flush to the world floor by alignSpikes),
//                      so every possible fall ends on terrain or an
//                      INTENTIONAL hazard — never in the void below the world.
//  5. GOAL SUPPORT   — the goal rests flush on a solid.
//
// Run:  npm run audit   (also executed as a gate inside the standalone build)
// Audit another levels file:  node tools/level-audit.mjs path/to/levels.js

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const WALL_MIN_RISE = 110; // a cap must rise ≥ this above its standing surface
const STEP = 4;            // column scan granularity (px)

export async function auditLevels(levelsPath = "src/levels.js") {
  const mod = await import(pathToFileURL(resolve(levelsPath)).href);
  const { LEVELS, alignSpikes } = mod;
  const { CONFIG } = await import(pathToFileURL(resolve("src/config.js")).href);
  const problems = [];

  for (const L of LEVELS) {
    const d = L.build();
    alignSpikes(d.solids, d.spikes, L.world.h, d.nodes);
    const W = L.world.w, H = L.world.h;
    const bad = (msg) => problems.push(`[${L.id}] ${msg}`);
    // dynamic terrain can't be a boundary: movers roam, crumbles vanish —
    // caps, coverage, and spawn/goal support must come from STATIC solids
    const statics = d.solids.filter((s) => !s.kind);

    // 1 — spawn stands on a solid
    const feet = d.spawn.y + CONFIG.PLAYER_H;
    if (!statics.some((s) => Math.abs(s.y - feet) < 2 &&
        d.spawn.x >= s.x - 4 && d.spawn.x + CONFIG.PLAYER_W <= s.x + s.w + 4))
      bad(`spawn (${d.spawn.x},${d.spawn.y}) does not stand on a solid`);

    // 2/3 — edge caps: flush ground + a wall above it
    for (const side of ["left", "right"]) {
      const atEdge = (s) => (side === "left" ? s.x <= 0 : s.x + s.w >= W);
      const grounds = statics.filter((s) => atEdge(s) && s.y + s.h >= H - 1);
      if (!grounds.length) {
        bad(`${side} edge has NO ground flush to the world edge (void slot at level ${side === "left" ? "start" : "end"})`);
        continue;
      }
      const groundTop = Math.min(...grounds.map((s) => s.y));
      const wall = statics.some((s) => atEdge(s) && s !== null &&
        s.y <= groundTop - WALL_MIN_RISE && s.y + s.h >= groundTop - 2);
      if (!wall)
        bad(`${side} edge ground (top ${groundTop}) has no wall cap rising ≥${WALL_MIN_RISE}px above it`);
    }

    // 4 — no void columns: every x is floored by terrain or intentional hazard
    const floored = (x) =>
      statics.some((s) => x >= s.x && x < s.x + s.w && s.y + s.h >= H - 1) ||
      d.spikes.some((sp) => x >= sp.x && x < sp.x + sp.w && sp.y + sp.h >= H - 1);
    let voidFrom = -1;
    for (let x = 0; x <= W - STEP; x += STEP) {
      if (!floored(x)) { if (voidFrom < 0) voidFrom = x; }
      else if (voidFrom >= 0) { bad(`void columns ${voidFrom}..${x} — a fall there exits the world`); voidFrom = -1; }
    }
    if (voidFrom >= 0) bad(`void columns ${voidFrom}..${W} — a fall there exits the world`);

    // 5 — goal support
    const gb = d.goal.y + d.goal.h;
    if (!statics.some((s) => Math.abs(s.y - gb) < 2 &&
        d.goal.x >= s.x - 4 && d.goal.x + d.goal.w <= s.x + s.w + 4))
      bad(`goal (${d.goal.x},${d.goal.y}) does not rest flush on a solid`);
  }
  return problems;
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2] || "src/levels.js";
  const problems = await auditLevels(target);
  if (problems.length) {
    console.error(`LEVEL AUDIT FAILED (${target}) — ${problems.length} problem(s):`);
    for (const p of problems) console.error("  ✗ " + p);
    process.exit(1);
  }
  console.log(`level audit: all levels capped + fully floored (${target})`);
}
