import { lerp } from "./util.js";

/* Parametric world backgrounds — ONE renderer, per-world CONFIGS.
 *
 * The contract is docs/VISUAL-BUDGET.md (the hard ceiling) + docs/WORLDS.md
 * (which world looks like what): backgrounds are 3 parallax layers (far /
 * mid / near — never 4) assembled from the SHARED 10-primitive silhouette
 * library below, recolored per world. 4 colors max per world (base + accent
 * glow + neutral + one secondary), 1 particle type + direction + density,
 * 1 glow direction. A new world is a WORLD_BG row, not new code — and a new
 * primitive is over-scope by definition: recombine instead.
 *
 * Structural mechanisms the budget demands (probed in shallows-audit):
 *  - inherit + overlay: W4 corrupts the W1/W2 configs instead of drawing
 *    new backgrounds ({ inherit: <worldId>, overlay: { tint, alpha } })
 *  - invert: light base / dark silhouettes as a CONFIG FLAG (W5/W6) — the
 *    depth ramp flips so far fades toward the light base and near carries
 *    the darkest material
 *
 *    the visual)
 *
 * Perf contract: flat rgba fills only — no shadowBlur, no composite modes,
 * no backdrop-filter, no per-frame gradient creation (glow gradients are
 * cached, the legacy bgGrad cost class). Placements are precomputed at
 * level load with a SEEDED rng (stable screenshots per level id). Ambient
 * particles update on the same hit-stop-scaled clock as the gameplay dust
 * they replace; all gameplay juice stays in fx.js.
 *
 * Worlds WITHOUT an entry keep the legacy gradient+grid+dust path in
 * game.js — zero regression for shipped content. */

// ---- per-world configs (the VISUAL-BUDGET table, one row per world) ----
// glow: contributions from {"ambient","top","bottom"} (point/player-only
// arrive with the worlds that need them). particles.density: vlow|low|med|high.
export const WORLD_BG = {
  1: { // W1 THE SUNKEN SHALLOWS — deep navy, cyan glow, sunken ruins. MOOD PILOT
    // (ported from Claude Design 2026-07-08): a drowned LEVIATHAN drifts the mid
    // deep (foreshadows W3), the near drapes SWAY, and light dapples down in
    // breathing POOLS. New schema fields discovered here (planes[].motion,
    base: "#0a1420",
    accent: "#4fd6e0",
    neutral: "#2a3542",
    secondary: "#3a5570",
    glow: ["ambient", "pools"], // dappled light through the water surface
    glowA: { ambient: 0.06, pools: 0.13 }, // per-direction (was a single number)
    particles: { type: "mote", density: "low", dirX: 3, dirY: -12, size: 1 },
    planes: [ // far: sunken ruins / mid: stalactites + the leviathan / near: spores+weeds.
      // ridge (one of the 10) anchors each layer's ground line so features
      // grow from mass — the table lists the feature prims, recombination
      // is free (VISUAL-BUDGET "Implementation state").
      { prims: ["slab", "arch"], density: 0.9, floor: true, ridge: "floor" },
      { prims: ["spire"], density: 1.0, ceil: true, floor: true, ridge: "both",
        motion: { type: "sine-path", composite: ["orb", "ridge"], speed: 12, scale: 1.4 } },
      { prims: ["cluster", "drape"], density: 0.8, ceil: true, floor: true, float: true, ridge: "floor",
        motion: { type: "drift", target: "drape", amp: 6, freq: 0.16 } },
    ],
  },
  2: { // W2 THE MINES — the descent. deeper = darker + hotter, so the BASE
    // and every plane color LERP with the camera's depth (baseDepth), not a
    // static fill. Warm lamp pools (glow: point) hang along the shaft.
    base: "#111318", // mid-depth stand-in (thumbnails / any static draw)
    baseDepth: { from: "#0f1826", to: "#181410" }, // cave-blue high → charcoal low
    accent: "#d89040",   // warm amber lamplight
    neutral: "#33302b",  // ash-grey rock/timber
    secondary: "#2a3848", // dim cave-blue (tints the far upper haze)
    glow: ["point"],     // lamps, warm — a FEW pools, not a wash
    glowA: 0.34,
    lamps: { count: 6, r: 118, sway: 0.6 },
    particles: { type: "ash", density: "med", dirX: -3, dirY: 34, color: "#8a8578" },
    planes: [ // far: shaft walls / mid: supports+chains / near: debris+teeth
      { prims: ["slab"], density: 1.0, floor: true, ceil: true, ridge: "both" },
      { prims: ["pillar", "beam"], density: 1.1, ceil: true, floor: true, ridge: "floor" },
      { prims: ["cluster", "spire"], density: 0.85, floor: true, ridge: "floor" },
    ],
  },
  41: {
    // Inherits row 1 wholesale; the corruption is a LAYER: a blood veil
    // (overlay), a red accent, drape growths hung into every plane, ash
    // and red drift falling where the motes used to rise. The Shallows'
    // silhouette stays readable underneath — that is the tragedy.
    inherit: 1,
    accent: "#e0304a",    // corruption red
    neutral: "#3a3038",   // the slate, bruised + desaturated
    secondary: "#5a1218", // blood haze
    glow: ["ambient", "top", "bottom"], // the old fall of light + the fire below
    glowA: 0.16,
    overlay: { tint: "#3a0e12", alpha: 0.34 },
    particles: { type: "ashdrift", density: "high", dirX: -4, dirY: 30, color: "#c0424e" },
    planes: [ // the parent's prims + demonic drape growths overhead
      { prims: ["slab", "arch", "drape"], density: 0.95, ceil: true, floor: true, ridge: "floor" },
      { prims: ["spire", "drape"], density: 1.05, ceil: true, floor: true, ridge: "both" },
      { prims: ["cluster", "drape"], density: 0.9, ceil: true, floor: true, ridge: "floor" },
    ],
  },
  42: {
    // Inherits row 2 (the depth-responsive base and the lamp pools still
    // burn) under the same blood veil; drapes infest the supports.
    inherit: 2,
    accent: "#e0304a",
    neutral: "#38302e",
    secondary: "#5a1218",
    glow: ["point", "bottom"], // the lamps that survived + the fire below
    glowA: 0.3,
    overlay: { tint: "#3a0e12", alpha: 0.34 },
    particles: { type: "ashdrift", density: "high", dirX: -4, dirY: 34, color: "#c0424e" },
    planes: [
      { prims: ["slab", "drape"], density: 1.0, ceil: true, floor: true, ridge: "both" },
      { prims: ["pillar", "beam", "drape"], density: 1.1, ceil: true, floor: true, ridge: "floor" },
      { prims: ["cluster", "spire", "drape"], density: 0.9, ceil: true, floor: true, ridge: "floor" },
    ],
  },
  3: { // W3 THE INFERNO — Hell proper. The world is ALIVE red: the base
    // warms toward the depths (the magma nears — where the Mines faded to
    // dark, Hell brightens to heat), the lava sea lights everything from
    // BELOW (glow: bottom — this world's one glow direction), and embers
    // RISE on the updraft where the Mines' ash fell. Obsidian shards in the
    // near plane carry the accent lit-core (the shard identity).
    base: "#1c0e10", // mid-depth stand-in (thumbnails / static draws)
    baseDepth: { from: "#170c10", to: "#2a1210" }, // charcoal high → magma-warm low
    accent: "#ff5a3d",    // hellfire
    neutral: "#342020",   // charred rock
    secondary: "#6e2418", // deep magma red — the far haze
    glow: ["ambient", "bottom"],
    glowA: 0.17,
    particles: { type: "ember", density: "med", dirX: 4, dirY: -26, color: "#ff8a5a" },
    planes: [ // far: volcanic skyline / mid: hell arches / near: obsidian teeth
      { prims: ["spire"], density: 0.95, floor: true, ridge: "floor" },
      { prims: ["arch", "pillar"], density: 1.0, ceil: true, floor: true, ridge: "floor" },
      { prims: ["shard", "cluster"], density: 0.9, ceil: true, floor: true, ridge: "floor" },
    ],
  },
  5: {
    // `invert` flips the material blend so the silhouettes read DARK against a
    // bright sky (marble ruins backlit by the light above). The base is a
    // HEIGHT gradient like the Mines' depth — but inverted in meaning: the
    // burning surface is dark-red at the BOTTOM (depthFrac→1) and Heaven's
    // white light floods the TOP (depthFrac→0), so climbing UP brightens the
    // world. The one glow is `top` — the heavenly light pouring down.
    invert: true,
    base: "#7a5a52", // mid stand-in (thumbnails / any static draw)
    baseDepth: { from: "#e8e4d8", to: "#2a0e0e" }, // Heaven-white high → burning-red low
    accent: "#f0d060",   // holy gold
    neutral: "#544e46",  // marble-charcoal — the ruins read as dark silhouettes
    secondary: "#e8dca0", // pale-gold — the holy haze on the far layer
    glow: ["top"],       // the light from above
    glowA: 0.22,
    particles: { type: "mote", density: "med", dirX: 2, dirY: -16, color: "#f0d060" }, // rising toward the light
    planes: [ // far: clouds / mid: marble ruins / near: monument fragments + rays
      { prims: ["cluster"], density: 0.85, ceil: true, floor: true, ridge: "floor" },
      { prims: ["pillar", "arch"], density: 1.0, ceil: true, floor: true, ridge: "floor" },
      { prims: ["shard", "beam"], density: 0.9, ceil: true, floor: true, ridge: "floor" },
    ],
  },
  6: {
    // FULL light world: ambient glow (light EVERYWHERE — the exact opposite
    // of the dark worlds' single sources). And it EVOLVES with the slaughter
    // (per-level bgT): the ichor-blue accent STAINS toward red as you carve
    // through the angelic host, and the glass-shard density climbs as the
    // sky shatters. No new prims — slab+pillar / arch+beam / shard; the
    // particles are falling white glass.
    invert: true,
    base: "#e8e0c8",        // blinding white-gold
    accent: "#40a0e0",      // glowing ichor-blue…
    accentShift: "#e04040", // …staining to red as the carnage progresses (bgT)
    densityRamp: 0.8,       // the sky breaks — shard density climbs +80% by the end
    neutral: "#d0c8b0",     // pale marble
    secondary: "#302820",   // crack-black — the growing fractures behind the light
    glow: ["ambient"],
    glowA: 0.3,
    particles: { type: "ash", density: "high", dirX: 4, dirY: 42, color: "#ffffff" }, // falling glass
    planes: [ // far: architecture / mid: gates + cracks / near: shattering sky
      { prims: ["slab", "pillar"], density: 0.9, ceil: true, floor: true, ridge: "floor" },
      { prims: ["arch", "beam"], density: 1.0, ceil: true, floor: true, ridge: "floor" },
      { prims: ["shard"], density: 0.95, ceil: true, floor: true, ridge: "both" },
    ],
  },
};

// ---- deterministic rng (stable screenshots per level) ------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

const mixHex = (a, b, k) => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) * (1 - k) + ((pb >> sh) & 255) * k);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
};
const hexRgb = (hex) => {
  const p = parseInt(hex.slice(1), 16);
  return `${(p >> 16) & 255},${(p >> 8) & 255},${p & 255}`;
};
// depth blend: colors that lerp with the camera's descent (The Mines).
// Kept as [r,g,b] triples so the per-frame mix is three adds, no parse.
const hexTrip = (hex) => {
  const p = parseInt(hex.slice(1), 16);
  return [(p >> 16) & 255, (p >> 8) & 255, p & 255];
};
const mixTrip = (a, b, k) => [
  a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const tripStr = (t) => `rgb(${t[0] | 0},${t[1] | 0},${t[2] | 0})`;
// a plane/base material at BOTH depth stops, so draw() lerps between them
const matStops = (fromHex, toHex, matHex, k) =>
  [mixTrip(hexTrip(fromHex), hexTrip(matHex), k), mixTrip(hexTrip(toHex), hexTrip(matHex), k)];

// ---- the 10-primitive library (the whole visual vocabulary) -------------
// Each returns a closed silhouette polygon as [x,y,...] in LOCAL coords:
// x spans ±w/2 around 0; y grows AWAY from the attach edge (the placer
// negates for floor anchoring). Rotation/scale/mirror happen at placement.
// `r` is the seeded rng — every instance is an individual, reloads identical.
const PRIMS = {
  spire(r, w, h) { // vertical spike — stalactite/stalagmite/peak by flip
    return [-w / 2, 0,
      -w * lerp(0.1, 0.28, r()), h * lerp(0.3, 0.5, r()),
      0, h,
      w * lerp(0.08, 0.2, r()), h * lerp(0.45, 0.65, r()),
      w / 2, 0];
  },
  arch(r, w, h) { // opening — cave mouth / gate / rift (a simple ∏ outline)
    const t = w * lerp(0.18, 0.26, r()), oh = h * lerp(0.6, 0.72, r());
    return [-w / 2, 0,
      -w * lerp(0.42, 0.48, r()), h * lerp(0.8, 0.9, r()),
      -w * lerp(0.2, 0.3, r()), h,
      w * lerp(0.2, 0.3, r()), h * lerp(0.92, 1, r()),
      w * lerp(0.42, 0.48, r()), h * lerp(0.78, 0.88, r()),
      w / 2, 0,
      w / 2 - t, 0,
      w / 2 - t, oh * lerp(0.7, 0.85, r()),
      w * lerp(0.12, 0.2, r()), oh,
      -w * lerp(0.12, 0.2, r()), oh * lerp(0.92, 1, r()),
      -w / 2 + t, oh * lerp(0.68, 0.82, r()),
      -w / 2 + t, 0];
  },
  slab(r, w, h) { // block — wall / monolith / ruin fragment
    return [-w / 2, 0,
      -w / 2 + w * lerp(0, 0.08, r()), h * lerp(0.9, 1, r()),
      w / 2 - w * lerp(0, 0.1, r()), h,
      w / 2, h * lerp(0.15, 0.4, r()),
      w / 2 - w * lerp(0, 0.06, r()), 0];
  },
  ridge() { return null; }, // span-long jagged strip — built by ridgeStrip()
  pillar(r, w, h) { // column with a broken taper
    const wr = w * lerp(0.28, 0.4, r());
    return [-w / 2, 0,
      -wr, h * lerp(0.75, 0.9, r()),
      -wr * lerp(0.3, 0.7, r()), h,
      wr * lerp(0.4, 0.8, r()), h * lerp(0.85, 0.98, r()),
      wr, h * lerp(0.55, 0.75, r()),
      w / 2, 0];
  },
  beam(r, w, h) { // thin long line — chain / ray / crack (tilted quad)
    const t = Math.max(3, w * 0.08), dx = w * lerp(-0.4, 0.4, r());
    return [-t / 2, 0, dx - t / 2, h, dx + t / 2, h, t / 2, 0];
  },
  orb(r, w) { // circle — moon / core / bubble (12-gon)
    const R = w / 2, n = 12, v = [];
    const squish = lerp(0.85, 1, r());
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      v.push(Math.cos(a) * R, Math.sin(a) * R * squish);
    }
    return v;
  },
  cluster(r, w, h) { // mass of small shapes — debris / spores / weeds
    const n = 10, v = []; // a lumpy dome over the attach edge (grows +y like
    for (let i = 0; i < n; i++) { // every prim; the floor placer flips it)
      const a = (i / (n - 1)) * Math.PI;
      const R = lerp(0.55, 1, r());
      v.push(-Math.cos(a) * (w / 2) * R, Math.sin(a) * h * R);
    }
    return v;
  },
  drape(r, w, h) { // torn hanging form — cloak / growth / root
    const v = [-w / 2, 0];
    let x = -w / 2;
    while (x < w / 2 - 4) {
      const nx = Math.min(w / 2, x + w * lerp(0.18, 0.36, r()));
      v.push((x + nx) / 2, h * lerp(0.45, 1, r())); // ragged tooth
      v.push(nx, h * lerp(0.1, 0.3, r()));
      x = nx;
    }
    v.push(w / 2, 0);
    return v;
  },
  shard(r, w, h) { // sharp splinter — crystal / glass / rock fragment
    const lean = w * lerp(-0.15, 0.15, r());
    return [-w / 2, 0,
      -w * 0.18 + lean, h,
      w * lerp(0.0, 0.12, r()) + lean, h * lerp(0.55, 0.75, r()),
      w * 0.3 + lean * 0.5, h * lerp(0.5, 0.8, r()),
      w / 2, 0];
  },
};
// which band a primitive naturally attaches to
const CEIL_PRIMS = new Set(["spire", "drape", "beam"]);
const FLOOR_PRIMS = new Set(["spire", "arch", "slab", "pillar", "cluster", "shard"]);
const FLOAT_PRIMS = new Set(["orb", "cluster", "slab", "shard"]);

const DENSITY = { vlow: 18, low: 50, med: 90, high: 150 };

// ---- ambient LIFE — the drifting creatures that make a world read as a PLACE
// (Silksong's fireflies/bats). Background actors: no collision, no gameplay,
// scattered in the far atmosphere behind the silhouettes, culled off-screen,
// flat fills only (glow = layered alpha discs, never shadowBlur). Keyed like
// WORLD_BG; 41/42 (W4) carry the corrupted things over the ruined lake/mines.
const AMBIENT = {
  1: [{ type: "butterfly", n: 5, cols: ["#8CF2FF", "#a6e2ff", "#c8ecff"], size: 1 },
      { type: "firefly", n: 10, col: "#9fe8c0", size: 0.95 }],
  2: [{ type: "bat", n: 6, col: "#6a6278", size: 1.15 }], // lighter + bigger so it reads on the dark cave
  3: [{ type: "imp", n: 4, col: "#280c0c", glow: "#ff5a3d", size: 1 },
      { type: "soul", n: 5, col: "#ffc4a4", size: 1.1 }],
  41: [{ type: "bat", n: 6, col: "#241018", glow: "#e0304a", size: 1.1 }],
  42: [{ type: "bat", n: 8, col: "#241018", glow: "#e0304a", size: 1.1 }],
  5: [{ type: "feather", n: 8, col: "#a89868", size: 1 }],   // mid-gold — reads on the bright→red climb
  6: [{ type: "feather", n: 7, col: "#524a3e", size: 1.05 }], // dark fallen feathers on the white-gold light
  7: [{ type: "butterfly", n: 3, cols: ["#6ab0ff"], size: 0.9, faint: true }],
};
// per-type motion: base drift (px/s, ×parallax z) + a sinusoidal wander so the
// path reads organic, and the draw fn. dir randomizes the drift sign per body.
const CREATURE_M = 90; // creatures cycle through a viewport + this margin
const CREATURE = {
  butterfly: { vx: 11, vy: -3, wf: 1.6, wa: 22, wf2: 2.1, wa2: 17, draw: drawButterfly },
  firefly:   { vx: 6, vy: -2, wf: 0.9, wa: 26, wf2: 1.3, wa2: 22, draw: drawFirefly },
  bat:       { vx: 28, vy: 0, wf: 3.0, wa: 34, wf2: 4.2, wa2: 16, draw: drawBat },
  imp:       { vx: 17, vy: -4, wf: 2.3, wa: 28, wf2: 3.1, wa2: 20, draw: drawImp },
  soul:      { vx: 3, vy: -15, wf: 0.8, wa: 18, wf2: 1.1, wa2: 9, draw: drawSoul },
  feather:   { vx: 9, vy: 13, wf: 0.7, wa: 36, wf2: 0.5, wa2: 11, draw: drawFeather },
};

function drawButterfly(ctx, c, sx, sy, t) {
  const s = 7 * c.size, flap = 0.32 + 0.68 * Math.abs(Math.sin(t * 9 + c.ph));
  ctx.globalAlpha = (c.faint ? 0.42 : 0.72) * (0.75 + 0.25 * Math.sin(t * 2 + c.wob));
  ctx.fillStyle = c.col;
  for (const side of [-1, 1]) { // an upper + lower wing each side, pivoting
    ctx.beginPath(); ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(sx + side * s * flap * 1.25, sy - s * 0.95, sx + side * s * flap, sy - s * 0.15);
    ctx.quadraticCurveTo(sx + side * s * flap * 1.05, sy + s * 0.9, sx, sy + s * 0.28);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha *= 0.9; ctx.fillStyle = "#141420";
  ctx.fillRect(sx - 0.7, sy - s * 0.5, 1.4, s * 0.95);
}
function drawFirefly(ctx, c, sx, sy, t) {
  const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 3 + c.ph)), R = 2.3 * c.size;
  ctx.fillStyle = c.col;
  ctx.globalAlpha = 0.45 * pulse; ctx.beginPath(); ctx.arc(sx, sy, R * 2.3, 0, 6.2832); ctx.fill();
  ctx.globalAlpha = 0.8 * pulse; ctx.beginPath(); ctx.arc(sx, sy, R, 0, 6.2832); ctx.fill();
  ctx.globalAlpha = pulse; ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(sx, sy, R * 0.42, 0, 6.2832); ctx.fill();
}
function drawBat(ctx, c, sx, sy, t) {
  const s = 9.5 * c.size, flap = Math.sin(t * 11 + c.ph);
  ctx.globalAlpha = 0.88; ctx.fillStyle = c.col;
  ctx.beginPath(); ctx.moveTo(sx, sy);
  ctx.lineTo(sx - s, sy - s * 0.55 * flap); ctx.lineTo(sx - s * 0.5, sy + s * 0.16);
  ctx.lineTo(sx - s * 0.28, sy - s * 0.1 * flap); ctx.lineTo(sx, sy + s * 0.3);
  ctx.lineTo(sx + s * 0.28, sy - s * 0.1 * flap); ctx.lineTo(sx + s * 0.5, sy + s * 0.16);
  ctx.lineTo(sx + s, sy - s * 0.55 * flap); ctx.closePath(); ctx.fill();
  // a body mass so it reads as a bat, not a thin line, against the dark cave
  ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.06, s * 0.17, s * 0.3, 0, 0, 6.2832); ctx.fill();
  if (c.glow) { ctx.globalAlpha = 0.9; ctx.fillStyle = c.glow;
    ctx.fillRect(sx - 1.8, sy - 1, 1.3, 1.3); ctx.fillRect(sx + 0.5, sy - 1, 1.3, 1.3); }
}
function drawImp(ctx, c, sx, sy, t) {
  const s = 7 * c.size, flap = Math.sin(t * 12 + c.ph);
  ctx.globalAlpha = 0.72; ctx.fillStyle = c.col;
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(sx, sy);
    ctx.lineTo(sx + side * s * 1.1, sy - s * 0.6 * (0.5 + 0.5 * flap));
    ctx.lineTo(sx + side * s * 0.5, sy + s * 0.32); ctx.closePath(); ctx.fill(); }
  ctx.fillRect(sx - s * 0.28, sy - s * 0.55, 1.4, s * 0.34); // horns
  ctx.fillRect(sx + s * 0.14, sy - s * 0.55, 1.4, s * 0.34);
  ctx.globalAlpha = 0.4 + 0.3 * Math.sin(t * 4 + c.ph); ctx.fillStyle = c.glow; // red core
  ctx.beginPath(); ctx.arc(sx, sy, s * 0.5, 0, 6.2832); ctx.fill();
  ctx.globalAlpha = 0.95; ctx.beginPath(); ctx.arc(sx, sy, s * 0.17, 0, 6.2832); ctx.fill();
}
function drawSoul(ctx, c, sx, sy, t) {
  const s = 6 * c.size;
  ctx.fillStyle = c.col;
  ctx.globalAlpha = 0.24 * (0.6 + 0.4 * Math.sin(t * 1.5 + c.wob));
  ctx.beginPath(); ctx.arc(sx, sy, s * 1.6, 0, 6.2832); ctx.fill(); // halo
  ctx.globalAlpha = 0.5; // a rising teardrop
  ctx.beginPath(); ctx.moveTo(sx, sy - s * 1.2);
  ctx.quadraticCurveTo(sx + s * 0.7, sy, sx, sy + s * 0.6);
  ctx.quadraticCurveTo(sx - s * 0.7, sy, sx, sy - s * 1.2); ctx.fill();
}
function drawFeather(ctx, c, sx, sy, t) {
  const s = 9 * c.size, rot = Math.sin(t * 1.4 + c.ph) * 0.5 + c.wob;
  ctx.save(); ctx.translate(sx, sy); ctx.rotate(rot);
  ctx.globalAlpha = 0.5; ctx.fillStyle = c.col;
  ctx.beginPath(); ctx.moveTo(0, -s);
  ctx.quadraticCurveTo(s * 0.5, 0, 0, s); ctx.quadraticCurveTo(-s * 0.5, 0, 0, -s);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ---- build (level load) -------------------------------------------------
// Plane space: a prim at (px,py) renders at (px - cam.x*z, py - cam.y*z);
// plane span = (world - VIEW) * z + VIEW per axis. Ceiling prims hang from
// plane-space top, floor prims stand on the bottom, floats scatter the
// middle band. Depth ramp: far fades toward the base (atmosphere), near
// carries the strongest material color — `invert` flips which end of the
// base↔material blend each layer gets, so light worlds read correctly.
export function initWorldBg(meta, world) {
  // a level may pick its OWN background row (bgWorld) — W4's corruption
  // remixes ride the W1/W2 configs via inherit, chosen per level
  const worldId = meta?.data?.bgWorld || meta?.bgWorld ||
    meta?.worldId || meta?.data?.worldId || 1;
  let cfg = WORLD_BG[worldId];
  if (!cfg) return null;
  if (cfg.inherit && WORLD_BG[cfg.inherit])
    cfg = { ...WORLD_BG[cfg.inherit], ...cfg }; // overlay/tweaks ride on the parent
  // a world may EVOLVE across its levels (WORLDS.md W6 engine mapping:
  // "shattering sky = worldbg config evolution") — a level's `bgT` (0..1)
  // lerps the accent toward `accentShift` (Heaven stains blue→red as the
  // slaughter progresses) and thickens planes/particles by `densityRamp`
  // (the sky breaking into ever more glass). Config, not a new renderer.
  const bgT = meta?.data?.bgT ?? meta?.bgT ?? 0;
  if (bgT > 0 && (cfg.accentShift || cfg.densityRamp)) {
    cfg = { ...cfg };
    if (cfg.accentShift) cfg.accent = mixHex(cfg.accent, cfg.accentShift, bgT);
    if (cfg.densityRamp) {
      const ramp = 1 + cfg.densityRamp * bgT;
      cfg.planes = (cfg.planes || []).map((pl) => ({ ...pl, density: pl.density * ramp }));
      const pp = cfg.particles || {};
      cfg.particles = { ...pp, density: Math.round((DENSITY[pp.density] ?? 90) * ramp) };
    }
  }
  const rng = mulberry32(hashStr(String(meta?.id || "wbg") + worldId));
  const VIEW_W = 1120, VIEW_H = 630;
  const Z = [0.16, 0.34, 0.58];
  // the level's dominant ground line (highest WIDE solid top): floor-band
  // silhouettes anchor to it, not to the world's bottom edge — a level
  // whose walkway sits high above its pit floor would otherwise render its
  // whole background skyline below the camera frame
  const wideTops = (meta?.data?.solids || meta?.solids || [])
    .filter((s) => !s.kind && s.w >= world.w * 0.22).map((s) => s.y);
  const worldFloor = wideTops.length ? Math.min(...wideTops) : world.h;
  // material blend per depth: [far, mid, near] toward neutral (secondary
  // tints the far layer when authored — the 4th color is the haze)
  const K = cfg.invert ? [0.2, 0.45, 0.75] : [0.72, 0.45, 0.2];
  const KFAR = cfg.invert ? K[0] : 0.72;
  // depth-responsive worlds carry a from/to base; static worlds pin both ends
  const baseFrom = cfg.baseDepth ? cfg.baseDepth.from : cfg.base;
  const baseTo = cfg.baseDepth ? cfg.baseDepth.to : cfg.base;
  const planes = (cfg.planes || []).slice(0, 3).map((pl, pi) => {
    const z = Z[pi] ?? 0.3;
    const spanW = Math.max(0, world.w - VIEW_W) * z + VIEW_W;
    const spanH = Math.max(0, world.h - VIEW_H) * z + VIEW_H;
    const mat = pi === 0 ? (cfg.secondary || cfg.neutral) : cfg.neutral;
    const kk = pi === 0 ? KFAR : K[pi];
    const color = mixHex(cfg.base, mat, kk);          // static fallback
    const stops = matStops(baseFrom, baseTo, mat, kk); // [topColor, deepColor]
    const placements = [];
    if (!pl || !(pl.prims || []).length && !pl.ridge)
      return { z, color, stops, spanW, spanH, placements, motion: pl?.motion || null };
    const groundY = Math.min(spanH + 2, spanH * ((worldFloor + 140) / world.h));
    const ridgeStrip = (edge) => {
      const depth = lerp(34, 66, rng()) * (1.6 - z);
      const verts = [];
      const sgn = edge === "ceil" ? 1 : -1;
      const y0 = edge === "ceil" ? 0 : groundY;
      verts.push(0, y0 - sgn * 12);
      for (let x = 0; x <= spanW;) {
        const tooth = rng() < 0.18;
        const d = tooth ? depth * lerp(1.8, 3.2, rng()) : depth * lerp(0.5, 1.2, rng());
        verts.push(x, y0 + sgn * d);
        x += lerp(50, 130, rng()) * (tooth ? 0.5 : 1);
      }
      verts.push(spanW, y0 - sgn * 12);
      placements.push({ x: 0, y: 0, verts, w: spanW * 4, kind: "ridge" });
    };
    if (pl.ridge === "ceil" || pl.ridge === "both") ridgeStrip("ceil");
    if (pl.ridge === "floor" || pl.ridge === "both") ridgeStrip("floor");
    const put = (kind, px, py, w, h, flipY, accent) => {
      const raw = PRIMS[kind](rng, w, h);
      if (!raw) return;
      const verts = flipY ? raw.map((c, i) => (i % 2 ? -c : c)) : raw;
      placements.push({ x: px, y: py, verts, w, accent: accent || null, kind, hh: h, ph: rng() * 6.283 });
    };
    const prims = (pl.prims || []).filter((k) => k !== "ridge");
    const n = Math.max(2, Math.round((spanW / 1000) * (pl.density ?? 1) * 6));
    for (let i = 0; i < n && prims.length; i++) {
      const kind = prims[Math.floor(rng() * prims.length)];
      const px = rng() * spanW;
      const big = 1 - z * 0.6; // nearer planes draw slightly smaller shapes
      const canCeil = pl.ceil && CEIL_PRIMS.has(kind);
      const canFloor = pl.floor && FLOOR_PRIMS.has(kind);
      const canFloat = pl.float && FLOAT_PRIMS.has(kind);
      const picks = [canCeil && "ceil", canFloor && "floor", canFloat && "float"].filter(Boolean);
      if (!picks.length) continue;
      const band = picks[Math.floor(rng() * picks.length)];
      const dims = {
        spire: [lerp(60, 150, rng()), lerp(120, 300, rng())],
        arch: [lerp(160, 300, rng()), lerp(110, 220, rng())],
        slab: [lerp(70, 170, rng()), lerp(80, 260, rng())],
        pillar: [lerp(50, 90, rng()), lerp(220, 420, rng())],
        beam: [lerp(40, 90, rng()), lerp(160, 380, rng())],
        orb: [lerp(40, 110, rng()), 0],
        cluster: [lerp(90, 200, rng()), lerp(40, 90, rng())],
        drape: [lerp(70, 150, rng()), lerp(90, 220, rng())],
        shard: [lerp(60, 140, rng()), lerp(80, 200, rng())],
      }[kind];
      const w = dims[0] * big, h = dims[1] * big;
      if (band === "ceil") put(kind, px, -2, w, h, false, null);
      else if (band === "floor")
        put(kind, px, groundY, w, h, true, kind === "shard" ? cfg.accent : null);
      else put(kind, px, groundY * lerp(0.3, 0.75, rng()), w, h, rng() < 0.5, null);
    }
    return { z, color, stops, spanW, spanH, placements, motion: pl?.motion || null };
  });
  // a drowned LEVIATHAN drifting the mid deep (a plane's motion:"sine-path"
  // composite) — orb-segment body + ridge dorsal riding ONE slow sine path.
  // Composite of existing prims, not a new one; foreshadows W3's Leviathan.
  let leviathan = null;
  const levPi = planes.findIndex((pl) => pl.motion && pl.motion.type === "sine-path");
  if (levPi >= 0) {
    const m = planes[levPi].motion;
    const lrng = mulberry32(hashStr("leviathan" + (meta?.id || "")));
    const radii = [22, 19, 15.5, 11.5, 8, 5];
    leviathan = {
      planeI: levPi, speed: m.speed ?? 12, scale: m.scale ?? 1, spacing: 34,
      segs: radii.map((R) => PRIMS.orb(lrng, R * 2)),
      teeth: Array.from({ length: 13 }, () => lerp(6, 15, lrng())),
      x: planes[levPi].spanW * 0.55,
      cy: planes[levPi].spanH * 0.42, // the deep mid-band (kept above the walkway)
    };
  }
  // lamps: warm point-glow pools hung across the shaft on a mid-ish plane
  const lamps = [];
  if (cfg.lamps) {
    const lz = 0.34; // rides the mid plane's parallax
    const span = Math.max(0, world.w - VIEW_W) * lz + VIEW_W;
    for (let i = 0; i < cfg.lamps.count; i++)
      lamps.push({ x: rng() * span, y: lerp(120, world.h * lz * 0.85, rng()),
        z: lz, r: cfg.lamps.r * lerp(0.7, 1.15, rng()), ph: rng() * Math.PI * 2 });
  }
  const pcfg = cfg.particles || {};
  const motes = [];
  const mn = DENSITY[pcfg.density] ?? (typeof pcfg.density === "number" ? pcfg.density : 90);
  for (let i = 0; i < mn; i++)
    motes.push({
      x: rng() * world.w, y: rng() * world.h,
      z: lerp(0.18, 0.65, rng()), s: lerp(1.2, 2.8, rng()),
      t: rng() * Math.PI * 2,
    });
  // ambient LIFE — a handful of drifting creatures that CYCLE through a
  // viewport-sized window (they wrap around the camera in updateWorldBg, not
  // the whole huge world), so the same few are always in view. Seeded into the
  // spawn camera's window at each creature's own parallax depth.
  const creatures = [];
  const spawnX = meta?.data?.spawn?.x ?? meta?.spawn?.x ?? world.w / 2;
  const spawnY = meta?.data?.spawn?.y ?? meta?.spawn?.y ?? world.h / 2;
  const cam0x = Math.min(Math.max(0, spawnX - VIEW_W / 2), Math.max(0, world.w - VIEW_W));
  const cam0y = Math.min(Math.max(0, spawnY - VIEW_H / 2), Math.max(0, world.h - VIEW_H));
  for (const spec of AMBIENT[worldId] || [])
    for (let i = 0; i < spec.n; i++) {
      const z = lerp(0.22, 0.58, rng());
      creatures.push({
        type: spec.type, z, ph: rng() * Math.PI * 2, wob: rng() * Math.PI * 2,
        dir: rng() < 0.5 ? -1 : 1, spd: lerp(0.7, 1.3, rng()),
        size: (spec.size ?? 1) * lerp(0.82, 1.2, rng()),
        col: spec.cols ? spec.cols[Math.floor(rng() * spec.cols.length)] : spec.col,
        glow: spec.glow || null, faint: !!spec.faint,
        x: cam0x * z + rng() * (VIEW_W + 2 * CREATURE_M) - CREATURE_M,
        y: cam0y * z + rng() * (VIEW_H + 2 * CREATURE_M) - CREATURE_M,
      });
    }
  return { cfg, planes, motes, creatures, lamps, leviathan, glowGrads: null, pools: null,
    depth: !!cfg.baseDepth, worldH: world.h };
}

// how deep the camera is, 0 (top) → 1 (bottom) — drives the depth blend
function depthFrac(st) {
  const span = Math.max(1, (st.worldbg.worldH || st.world.h) - 630);
  return Math.min(1, Math.max(0, st.cam.y / span));
}

// ---- update (sim step, hit-stop-scaled dt like the dust it replaces) ----
export function updateWorldBg(wbg, world, dt, cam) {
  const p = wbg.cfg.particles || {};
  const dx = p.dirX || 0, dy = p.dirY ?? -6; // unset = gentle rise
  for (const m of wbg.motes) {
    m.x += dx * m.z * dt;
    m.y += dy * m.z * dt;
    if (m.y < -10) { m.y += world.h + 20; m.x = Math.random() * world.w; }
    if (m.y > world.h + 10) { m.y -= world.h + 20; m.x = Math.random() * world.w; }
    if (m.x < -10) m.x += world.w + 20;
    if (m.x > world.w + 10) m.x -= world.w + 20;
  }
  // ambient creatures drift on their own base velocity (the wander is added at
  // draw time), and WRAP around a viewport-sized window that follows the camera
  // — so the same handful is always in view, not scattered across a huge world
  const cx = cam?.x || 0, cy = cam?.y || 0, VW = 1120, VH = 630;
  const win = VW + 2 * CREATURE_M, winH = VH + 2 * CREATURE_M;
  for (const c of wbg.creatures || []) {
    const b = CREATURE[c.type];
    if (!b) continue;
    c.x += b.vx * c.dir * c.spd * c.z * dt;
    c.y += b.vy * c.spd * c.z * dt;
    const lo = cx * c.z - CREATURE_M, loY = cy * c.z - CREATURE_M;
    if (c.x < lo) c.x += win; else if (c.x > lo + win) c.x -= win;
    if (c.y < loY) c.y += winH; else if (c.y > loY + winH) c.y -= winH;
  }
  // the leviathan drifts steadily left, then wraps to the far right (one slow
  // pass always somewhere across the mid deep)
  if (wbg.leviathan) {
    const L = wbg.leviathan, len = L.spacing * (L.segs.length - 1) * L.scale;
    L.x -= L.speed * dt;
    if (L.x < -(len + 260)) L.x = (wbg.planes[L.planeI]?.spanW || 2200) + 240;
  }
}

// the drowned leviathan — orb-segment body + ridge dorsal on ONE slow sine
// path, drawn in its plane's silhouette color (flat fill, culled off-screen)
function drawLeviathan(ctx, lev, t, color, ox, oy, W) {
  const sc = lev.scale;
  const cy = lev.cy + Math.sin(t * 0.07) * 16;
  const A = 40 * sc, k = 6.283 / 560;
  const pathY = (x) => cy + A * Math.sin(x * k - t * 0.35);
  const hx = lev.x, L = lev.spacing * (lev.segs.length - 1) * sc;
  const sx0 = hx - ox;
  if (sx0 + L + 60 * sc < -80 || sx0 - 40 * sc > W + 80) return; // whole beast off-screen
  ctx.fillStyle = color;
  ctx.beginPath(); // the ridge dorsal riding the back
  for (let j = 0; j < lev.teeth.length; j++) {
    const f = j / (lev.teeth.length - 1), x = hx + f * L;
    const y = pathY(x) - (lerp(24, 5, f) + lev.teeth[j]) * sc;
    if (j) ctx.lineTo(x - ox, y - oy); else ctx.moveTo(x - ox, y - oy);
  }
  for (let j = lev.teeth.length - 1; j >= 0; j--) {
    const f = j / (lev.teeth.length - 1), x = hx + f * L;
    ctx.lineTo(x - ox, pathY(x) - oy);
  }
  ctx.closePath(); ctx.fill();
  for (let i = 0; i < lev.segs.length; i++) { // orb body segments along the path
    const x = hx + i * lev.spacing * sc, v = lev.segs[i];
    const cx = x - ox, cyy = pathY(x) - oy;
    ctx.beginPath(); ctx.moveTo(cx + v[0] * sc, cyy + v[1] * sc);
    for (let q = 2; q < v.length; q += 2) ctx.lineTo(cx + v[q] * sc, cyy + v[q + 1] * sc);
    ctx.closePath(); ctx.fill();
  }
}

// ---- draw (pre-camera-translate: planes carry their own parallax) -------
export function drawWorldBg(ctx, st, W, H, t) {
  const wbg = st.worldbg, cfg = wbg.cfg;
  // deeper = darker/hotter: the base + every plane color lerp with the
  // camera's descent. Still ONE flat rgba fillRect per surface (no gradient
  // on a large surface — the depth response is a per-frame solid color).
  const df = wbg.depth ? depthFrac(st) : 0;
  const baseTop = hexTrip(cfg.baseDepth ? cfg.baseDepth.from : cfg.base);
  const baseDeep = hexTrip(cfg.baseDepth ? cfg.baseDepth.to : cfg.base);
  ctx.fillStyle = wbg.depth ? tripStr(mixTrip(baseTop, baseDeep, df)) : cfg.base;
  ctx.fillRect(0, 0, W, H);

  // the glow — cached directional gradients + flat ambient wash. Point glow
  // (lamps) draws below, after the planes, as pooled light.
  // glowA is a number (one alpha for all) OR a per-direction map {ambient,top,…}
  const glowAOf = (dir, dflt) =>
    (cfg.glowA && typeof cfg.glowA === "object") ? (cfg.glowA[dir] ?? dflt) : (cfg.glowA ?? dflt);
  if (!wbg.glowGrads) {
    const rgb = hexRgb(cfg.accent);
    wbg.glowGrads = (cfg.glow || []).map((dir) => {
      if (dir === "ambient") {
        const aa = glowAOf("ambient", 0.13 * 0.45); // object gives it straight; number keeps the 0.45× cap
        return { flat: `rgba(${rgb},${Math.min(0.07, aa)})` };
      }
      if (dir === "point" || dir === "pools") return null; // dynamic passes below
      const a = glowAOf(dir, 0.13);
      const up = dir === "bottom";
      const g = ctx.createLinearGradient(0, up ? H : 0, 0, up ? H * 0.45 : H * 0.55);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      return { grad: g };
    }).filter(Boolean);
  }
  for (const g of wbg.glowGrads) {
    ctx.fillStyle = g.flat || g.grad;
    ctx.fillRect(0, 0, W, H);
  }

  // POOLS — dappled light filtering down (W1): a few cached radial pools along
  // the top that breathe on a slow damp sine (cheap: fixed count, small radius)
  if ((cfg.glow || []).includes("pools")) {
    if (!wbg.pools) {
      const prng = mulberry32(hashStr("pools" + (cfg.accent || "")));
      const rgb = hexRgb(cfg.accent), topA = glowAOf("pools", 0.13);
      wbg.pools = [];
      for (let i = 0; i < 6; i++) {
        const x = ((i + 0.5) / 6) * W + (prng() - 0.5) * 130;
        const g = ctx.createRadialGradient(x, -46, 10, x, -46, 190);
        g.addColorStop(0, `rgba(${rgb},${topA})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        wbg.pools.push({ x, g, ph: prng() * 6.283 });
      }
    }
    for (const pl of wbg.pools) {
      ctx.globalAlpha = 0.82 + 0.18 * Math.sin(t * 0.21 + pl.ph);
      ctx.fillStyle = pl.g;
      ctx.fillRect(pl.x - 190, 0, 380, 146);
    }
    ctx.globalAlpha = 1;
  }

  // silhouette planes, far → near (flat fills, culled by x)
  for (const pl of wbg.planes) {
    const ox = st.cam.x * pl.z, oy = st.cam.y * pl.z;
    const col = wbg.depth && pl.stops
      ? tripStr(mixTrip(pl.stops[0], pl.stops[1], df)) : pl.color;
    ctx.fillStyle = col;
    // the leviathan swims in its own plane's depth, behind that plane's ruins
    if (wbg.leviathan && pl === wbg.planes[wbg.leviathan.planeI])
      drawLeviathan(ctx, wbg.leviathan, t, col, ox, oy, W);
    // a plane may SWAY a target prim (near drapes shear on a slow sine)
    const drift = pl.motion && pl.motion.type === "drift" ? pl.motion : null;
    for (const pm of pl.placements) {
      const sx = pm.x - ox;
      if (sx < -pm.w * 1.5 || sx > W + pm.w * 1.5) continue;
      const sy = pm.y - oy;
      if (drift && pm.kind === drift.target) { // shear-sway (drapes drifting in the current)
        const sh = (drift.amp * Math.sin(t * (drift.freq ?? 0.16) * 6.283 + (pm.ph || 0))) / Math.max(1, pm.hh || 120);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.transform(1, 0, sh, 1, 0, 0);
        ctx.beginPath();
        ctx.moveTo(pm.verts[0], pm.verts[1]);
        for (let i = 2; i < pm.verts.length; i += 2) ctx.lineTo(pm.verts[i], pm.verts[i + 1]);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(sx + pm.verts[0], sy + pm.verts[1]);
      for (let i = 2; i < pm.verts.length; i += 2)
        ctx.lineTo(sx + pm.verts[i], sy + pm.verts[i + 1]);
      ctx.closePath();
      ctx.fill();
      if (pm.accent) { // faint lit core on accent prims (shard identity)
        ctx.save();
        ctx.globalAlpha = 0.28 + 0.1 * Math.sin(t * 1.3 + pm.x * 0.02);
        ctx.fillStyle = pm.accent;
        ctx.beginPath();
        ctx.moveTo(sx + pm.verts[0] * 0.35, sy + pm.verts[1] * 0.35);
        for (let i = 2; i < pm.verts.length; i += 2)
          ctx.lineTo(sx + pm.verts[i] * 0.35, sy + pm.verts[i + 1] * 0.35);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = pl.color;
      }
    }
  }

  // point glow — warm lamp pools hung across the shaft (The Mines). Concentric
  // flat-alpha discs (NO gradient object, NO large surface): a few cheap
  // additive-looking rings per lamp, culled off-screen. This is the world's
  // only light, so it sits ABOVE the silhouettes it pools onto.
  if (wbg.lamps && wbg.lamps.length) {
    const rgb = hexRgb(cfg.accent), a = cfg.glowA ?? 0.34, sway = cfg.lamps?.sway ?? 0;
    ctx.globalCompositeOperation = "lighter"; // pooled light adds, not covers
    // falloff steps: a wide dim halo, a tighter warm pool, a small bright
    // core — reads as a hung lamp, not a soft cloud (few lamps, culled)
    const steps = [[1.0, 0.06], [0.55, 0.13], [0.24, 0.30]];
    for (const L of wbg.lamps) {
      const sx = L.x - st.cam.x * L.z, sy = L.y - st.cam.y * L.z;
      if (sx < -L.r || sx > W + L.r || sy < -L.r || sy > H + L.r) continue;
      const flick = 1 + sway * 0.1 * Math.sin(t * 2.3 + L.ph);
      for (const [rf, af] of steps) {
        ctx.fillStyle = `rgba(${rgb},${a * af * flick})`;
        ctx.beginPath();
        ctx.arc(sx, sy, L.r * rf * flick, 0, Math.PI * 2);
        ctx.fill();
      }
      // the hot filament — a small near-white core so it reads as a LIGHT,
      // not a brown disc, even against the near-black deep shaft
      ctx.fillStyle = `rgba(255,240,214,${0.55 * flick})`;
      ctx.beginPath();
      ctx.arc(sx, sy, L.r * 0.08 * flick, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // corruption overlay (W4 mechanism): a flat veil over the inherited world
  if (cfg.overlay && cfg.overlay.tint) {
    ctx.fillStyle = `rgba(${hexRgb(cfg.overlay.tint)},${cfg.overlay.alpha ?? 0.3})`;
    ctx.fillRect(0, 0, W, H);
  }

  // ambient LIFE — the drifting creatures (the wander is added here so each
  // path reads organic; culled off-screen; flat fills only). Drawn over the
  // silhouettes but under the dust — background actors, never gameplay.
  for (const c of wbg.creatures || []) {
    const b = CREATURE[c.type];
    if (!b) continue;
    const wx = Math.sin(t * b.wf + c.ph) * b.wa, wy = Math.cos(t * b.wf2 + c.wob) * b.wa2;
    const sx = c.x - st.cam.x * c.z + wx, sy = c.y - st.cam.y * c.z + wy;
    if (sx < -34 || sx > W + 34 || sy < -34 || sy > H + 34) continue;
    b.draw(ctx, c, sx, sy, t);
  }
  ctx.globalAlpha = 1;

  // ambient particles (the world's dust — accent-tinted, hit-stop-aware).
  const pcol = (cfg.particles && cfg.particles.color) || cfg.accent;
  const szMul = cfg.particles?.size ?? 1;
  ctx.fillStyle = pcol;
  for (const m of wbg.motes) {
    const sx = m.x - st.cam.x * m.z, sy = m.y - st.cam.y * m.z;
    if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) continue;
    ctx.globalAlpha = 0.16 + 0.16 * Math.sin(t * 1.7 + m.t);
    ctx.fillRect(sx, sy, m.s * szMul, m.s * szMul);
  }
  ctx.globalAlpha = 1;
}
