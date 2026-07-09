import { rand } from "./util.js";
import { LEVELS_DATA } from "./levels/index.js";
import { instantiateLevel, alignSpikes } from "./levelload.js";

export { alignSpikes };

/* The level registry. Shipped levels are the src/levels/*.json directory
 * (via the generated manifest — adding a level is a data change, not a code
 * change). Two localStorage overlays make the editor's saves real without a
 * dev server:
 *   tether.levelOverrides — { id: fullData }  edited shipped levels
 *   tether.customLevels   — [ fullData, ... ] save-as-new levels
 * Under `npm run dev` the editor instead writes the JSON files themselves
 * through the vite middleware (true edit-in-place).
 *
 * The curriculum contract is unchanged and enforced by the claims audit:
 * every verb's first exposure is a safe classroom, then a low-stakes rep,
 * then the test. */

function overlay() {
  try {
    return {
      ov: JSON.parse(localStorage.getItem("tether.levelOverrides") || "{}"),
      customs: JSON.parse(localStorage.getItem("tether.customLevels") || "[]"),
    };
  } catch {
    return { ov: {}, customs: [] };
  }
}

// levels fetched from the Supabase `custom_levels` table (see customLevels.js)
// — set once at boot and again whenever the admin uploads a new one
let onlineLevels = [];
let ONLINE_IDS = new Set();
export function setOnlineLevels(list) {
  onlineLevels = Array.isArray(list) ? list : [];
  ONLINE_IDS = new Set(onlineLevels.map((d) => d.id));
  refreshLevels();
}

function makeRegistry() {
  const { ov, customs } = overlay();
  // slot order: tether.orderOverrides re-ranks SHIPPED levels without copying
  // them; customs carry their own (mutable) order field
  let oov = {};
  try { oov = JSON.parse(localStorage.getItem("tether.orderOverrides") || "{}"); } catch {}
  // PR8 — an ONLINE row whose id matches a shipped level REPLACES that level's
  // data for everyone (the admin "fix main levels" publish flow). Precedence:
  // local editor save (ov, this browser only — the admin mid-edit) > online
  // override > repo JSON. An online override keeps the shipped slot when its
  // own order is missing/defaulted, so sh01 can't teleport to the grid's end.
  const online = new Map(onlineLevels.map((d) => [d.id, d]));
  const shippedIds = new Set(LEVELS_DATA.map((d) => d.id));
  const all = [
    ...LEVELS_DATA.map((d) => {
      const o = ov[d.id] || online.get(d.id);
      if (!o) return d;
      return (o.order == null || o.order === 999) && d.order != null ? { ...o, order: d.order } : o;
    }),
    ...customs,
    ...onlineLevels.filter((d) => !shippedIds.has(d.id)),
  ];
  const entries = all.map((d, k) => ({ d, k, order: oov[d.id] ?? d.order ?? 999 }));
  entries.sort((a, b) => a.order - b.order || a.k - b.k);
  return entries.map(({ d, order }) => ({
    id: d.id,
    name: d.name,
    tag: d.tag,
    tint: d.tint,
    world: d.world,
    par: d.par,
    sRankTime: d.sRankTime,   // optional authored S-time (see rank.js effPar)
    worldId: d.worldId || 1,  // which world's select grid lists this level
    bside: !!d.bside,         // gated B-side: hidden from world grids, lives
    unlock: d.unlock || null, //   in the SECRETS tab behind `unlock` (rank.js)
    parent: d.parent || null, // A-side level whose card carries this B-side
    order,                    // effective slot rank (overrides applied)
    data: d,
    build: () => instantiateLevel(d),
  }));
}

export const LEVELS = makeRegistry();

// the editor mutates the registry in place after a save (no reload cycle)
export function refreshLevels() {
  LEVELS.length = 0;
  LEVELS.push(...makeRegistry());
  return LEVELS;
}

// ---- deletion: custom/imported levels only — the shipped campaign is sacred.
// Derived from the MANIFEST, never hand-listed: a frozen id list once let all
// of DEATH WORLD masquerade as deletable customs (✕ chips on every card), and
// every future shipped world would have re-broken it the same way.
export const PROTECTED_IDS = new Set(LEVELS_DATA.map((d) => d.id));
export const isDeletable = (id) => !PROTECTED_IDS.has(id) && !ONLINE_IDS.has(id);

export async function deleteLevel(id) {
  if (!isDeletable(id)) return false;
  try { // dev middleware: remove the real src/levels/<id>.json + regen manifest
    await fetch("/__tether/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch {}
  try { // standalone: clear the overlay entry + every per-level record
    const customs = JSON.parse(localStorage.getItem("tether.customLevels") || "[]");
    localStorage.setItem("tether.customLevels", JSON.stringify(customs.filter((c) => c.id !== id)));
    const ov = JSON.parse(localStorage.getItem("tether.levelOverrides") || "{}");
    delete ov[id];
    localStorage.setItem("tether.levelOverrides", JSON.stringify(ov));
    const oov = JSON.parse(localStorage.getItem("tether.orderOverrides") || "{}");
    delete oov[id];
    localStorage.setItem("tether.orderOverrides", JSON.stringify(oov));
    for (const k of ["best", "ghost", "coins", "coinmax", "alt", "rank", "pbsplits", "goldsegs"])
      localStorage.removeItem(`tether.${k}.${id}`);
  } catch {}
  refreshLevels();
  return true;
}

// ---- slot management: move a level one cell left/right inside its world's
// select grid. The world's EXISTING order slots are re-dealt to the new
// sequence (unique + ascending), so other worlds never shift.
export function moveLevelInWorld(id, dir) {
  const me = LEVELS.find((l) => l.id === id);
  if (!me) return false;
  const world = LEVELS.filter((l) => (l.worldId || 1) === (me.worldId || 1));
  const at = world.findIndex((l) => l.id === id);
  const to = at + dir;
  if (to < 0 || to >= world.length) return false;
  const base = Math.min(...world.map((l) => l.order ?? 999));
  const seq = world.map((l) => l.id);
  [seq[at], seq[to]] = [seq[to], seq[at]];
  let oov = {}, customs = [];
  try { oov = JSON.parse(localStorage.getItem("tether.orderOverrides") || "{}"); } catch {}
  try { customs = JSON.parse(localStorage.getItem("tether.customLevels") || "[]"); } catch {}
  seq.forEach((lid, k) => {
    const c = customs.find((x) => x.id === lid);
    if (c) c.order = base + k;      // customs own their order field
    else oov[lid] = base + k;       // shipped levels re-rank via the overlay
  });
  try {
    localStorage.setItem("tether.orderOverrides", JSON.stringify(oov));
    localStorage.setItem("tether.customLevels", JSON.stringify(customs));
  } catch {}
  refreshLevels();
  return true;
}

export function makeDust(world) {
  const dust = [];
  for (let i = 0; i < 170; i++) {
    dust.push({
      x: Math.random() * world.w,
      y: Math.random() * world.h,
      z: rand(0.15, 0.6),
      s: rand(1, 2.6),
      t: Math.random() * Math.PI * 2,
    });
  }
  return dust;
}
