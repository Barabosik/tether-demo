/* Cuphead-style post-level rank — TWO independent axes, both published on the
 * results screen (no hidden math):
 *
 *   SPEED — time vs the level's authored par. <=0.75 par = S, ... , >2x = C.
 *   CLEAN — hits TAKEN (hearts lost to any source: spikes, void, enemies,
 *           boss, blast). 0 = S, 1 = A, 2 = B, 3+ = C.
 *
 * The final rank is the WORSE-leaning average of the two grade indices (a
 * fast-reckless clear and a slow-flawless clear land differently, and neither
 * can S alone). Falls (respawns) are shown but do NOT feed the rank — they're
 * already punished by the clock. Grades: S A B C.
 *
 * S-rank on a level unlocks a palette; all-coins on a level unlocks another.
 * Palettes are cosmetic player tints, chosen on the select screen. */

export const GRADES = ["S", "A", "B", "C"];
export const GRADE_COLOR = { S: "#ffd166", A: "#8CF2FF", B: "#a0ffa0", C: "#c9b8d8" };

// published thresholds — these EXACT strings render on the results screen
export const SPEED_RULE = [
  [0.75, "S"], [1.0, "A"], [1.5, "B"], [Infinity, "C"],
];
export const CLEAN_RULE = [
  [0, "S"], [1, "A"], [2, "B"], [Infinity, "C"],
];

export function speedGrade(time, par) {
  const r = time / (par || 120);
  for (const [thr, g] of SPEED_RULE) if (r <= thr) return g;
  return "C";
}

// A level may author an explicit sRankTime (seconds). When present it IS the
// S threshold; the effective par is derived so A/B/C keep their ratios.
// Levels without it fall back to par exactly as before.
export const effPar = (meta) =>
  meta?.sRankTime > 0 ? meta.sRankTime / 0.75 : (meta?.par || 120);
export const sRankTimeOf = (meta) =>
  meta?.sRankTime > 0 ? meta.sRankTime : (meta?.par || 120) * 0.75;
export function cleanGrade(hits) {
  for (const [thr, g] of CLEAN_RULE) if (hits <= thr) return g;
  return "C";
}

// final = ceil-average of the two indices (0=S). Rounding UP means the weaker
// axis pulls harder — you can't coast to S on speed alone.
export function finalRank(time, par, hits) {
  const si = GRADES.indexOf(speedGrade(time, par));
  const ci = GRADES.indexOf(cleanGrade(hits));
  return GRADES[Math.min(GRADES.length - 1, Math.ceil((si + ci) / 2))];
}

// human-readable threshold lines for the results panel
export function speedThresholds(par) {
  const p = par || 120;
  const f = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return [`S <=${f(p * 0.75)}`, `A <=${f(p)}`, `B <=${f(p * 1.5)}`, `C slower`];
}
export const CLEAN_THRESHOLDS = ["S no hits", "A 1 hit", "B 2 hits", "C 3+"];

// ---- palette unlocks ---------------------------------------------------
// `fx` gives each skin a DISTINCT dash flourish (not just a recolor):
//   shape — the burst/afterimage particle form (see fx.js drawParticles)
//   trail — the afterimage style: "box" ghost, "streak" comet, "echo" full
//           silhouette double (the elaborate one)
//   tier  — 1..3 escalation: higher tiers spawn more particles + extra
//           sparkle, so rarer unlocks visibly read as fancier
export const PALETTES = [
  { id: "default", name: "EMBER", body: "#ffb454", ready: "#ffb454", dash: "#ffffff", need: null,
    fx: { shape: "ember", trail: "box", tier: 1 } },
  { id: "ice", name: "FROST", body: "#8CF2FF", ready: "#8CF2FF", dash: "#ffffff",
    need: "S-rank any level", fx: { shape: "shard", trail: "box", tier: 1 } },
  { id: "rose", name: "BLOOM", body: "#ff8ac0", ready: "#ff8ac0", dash: "#ffe0f0",
    need: "all coins in any level", fx: { shape: "petal", trail: "box", tier: 2 } },
  { id: "coin50", name: "MIDAS", body: "#ffe08a", ready: "#fff3c4", dash: "#fff8dc",
    need: "collect 12 total coins", fx: { shape: "star", trail: "streak", tier: 2 } },
  { id: "sworld1", name: "APEX", body: "#7dffc8", ready: "#7dffc8", dash: "#ffffff",
    need: "S-rank all of THE SUNKEN SHALLOWS", fx: { shape: "streak", trail: "streak", tier: 2 } },
  { id: "void", name: "VOID", body: "#c99aff", ready: "#c99aff", dash: "#e8d8ff",
    need: "silence THE REAPER", fx: { shape: "smoke", trail: "echo", tier: 3 } },
  { id: "gold", name: "GILDED", body: "#ffd166", ready: "#fff3c4", dash: "#ffffff",
    need: "S-rank every level", fx: { shape: "star", trail: "echo", tier: 3 } },
  // W2 rewards — APPENDED (tether.palette saves the INDEX; inserting
  // mid-array would silently re-skin every existing save)
  { id: "sworld2", name: "LANTERN", body: "#d89040", ready: "#f2b166", dash: "#fff1dc",
    need: "S-rank all of THE MINES", fx: { shape: "ember", trail: "streak", tier: 2 } },
  { id: "brand", name: "BRAND", body: "#ff6a45", ready: "#ffb454", dash: "#ffd9a0",
    need: "fell BAPHOMET", fx: { shape: "ember", trail: "echo", tier: 3 } },
  // W3 rewards
  { id: "sworld3", name: "MOLTEN", body: "#ff5a3d", ready: "#ff8a5a", dash: "#ffd9c0",
    need: "S-rank all of THE INFERNO", fx: { shape: "shard", trail: "streak", tier: 2 } },
  { id: "serpent", name: "ASH", body: "#9a8578", ready: "#ff8a5a", dash: "#ffd9c0",
    need: "sink the LEVIATHAN", fx: { shape: "smoke", trail: "streak", tier: 3 } },
  // The all-S capstone: a living-aurora accent + halo (special: "prism").
  { id: "paragon", name: "PARAGON", body: "#fff0c0", ready: "#ffffff", dash: "#ffffff",
    need: "S-rank every level — total mastery", special: "prism",
    fx: { shape: "star", trail: "echo", tier: 3 } },
];

// the standard saved-progress reader over localStorage + the level registry
export const saveReader = (LEVELS) => (k) => {
  try {
    if (k === "ids") return LEVELS.map((l) => l.id);
    if (k === "worlds") return LEVELS.map((l) => l.worldId || l.data?.worldId || 1);
    if (k === "bsides") return LEVELS.map((l) => !!(l.bside || l.data?.bside));
    const v = localStorage.getItem("tether." + k);
    return v == null ? null : (/^\d+$/.test(v) ? Number(v) : v);
  } catch { return null; }
};

// ---- B-side (SECRETS tab) unlocks -----------------------------------------
// A B-side carries an `unlock` descriptor; this resolves it against saved
// progress into { open, label, progress }. The SECRETS screen shows the label
// + live progress always, but only lets you PLAY an open one — gated by the
// actual achievement, never hardcoded-visible.
export function bsideUnlock(meta, get) {
  const u = meta?.unlock;
  if (!u) return { open: true, label: "", progress: "" };
  if (u.kind === "srank") {
    const rk = get("rank." + u.level);
    return { open: rk === "S", label: `S-rank ${u.name || u.level}`, progress: rk ? `rank ${rk}` : "not yet ranked" };
  }
  if (u.kind === "allcoins") {
    const c = get("coins." + u.level) || 0, m = get("coinmax." + u.level) || 0;
    return { open: m > 0 && c >= m, label: `all coins in ${u.name || u.level}`, progress: `${c}/${m || "?"} coins` };
  }
  if (u.kind === "pogochain") {
    const best = get("pogochain") || 0;
    return { open: best >= u.n, label: `chain pogo ${u.n}× without landing`, progress: `best ${best}/${u.n}` };
  }
  if (u.kind === "world") { // clear EVERY level of a world (the Reaper's gate)
    const ids = get("ids") || [], worlds = get("worlds") || [], bs = get("bsides") || [];
    let total = 0, done = 0;
    for (let i = 0; i < ids.length; i++) {
      if (bs[i] || (worlds[i] || 1) !== u.worldId) continue;
      total++;
      if (get("best." + ids[i])) done++;
    }
    return { open: total > 0 && done >= total,
      label: `clear all of ${u.name || `world ${u.worldId}`}`, progress: `${done}/${total} cleared` };
  }
  return { open: false, label: "???", progress: "" };
}

// which palettes are unlocked, given saved progress (pure — takes a reader).
// get("ids") = all level ids; get("worlds") = worldId aligned with ids;
// per-level keys are the localStorage tails ("rank.<id>", "coins.<id>", ...).
export function unlockedPalettes(get) {
  const un = new Set(["default"]);
  const ids = get("ids") || [];
  const worlds = get("worlds") || ids.map(() => 1);
  const bsides = get("bsides") || ids.map(() => false);
  let anyS = false, allS = ids.length > 0, anyCoins = false, reaper = false, baph = false;
  let lev = false, gate = false, uriel = false, architect = false, shadow = false;
  let coinTotal = 0, w1Count = 0, w1AllS = true, w2Count = 0, w2AllS = true;
  let w3Count = 0, w3AllS = true, w4Count = 0, w4AllS = true;
  let w5Count = 0, w5AllS = true, w6Count = 0, w6AllS = true, w7Count = 0, w7AllS = true;
  for (let i = 0; i < ids.length; i++) {
    if (bsides[i]) continue; // gated B-sides never count toward campaign unlocks
    const id = ids[i];
    const rk = get("rank." + id);
    if (rk === "S") anyS = true; else allS = false;
    if ((worlds[i] || 1) === 1) { w1Count++; if (rk !== "S") w1AllS = false; }
    if ((worlds[i] || 1) === 2) { w2Count++; if (rk !== "S") w2AllS = false; }
    if ((worlds[i] || 1) === 3) { w3Count++; if (rk !== "S") w3AllS = false; }
    if ((worlds[i] || 1) === 4) { w4Count++; if (rk !== "S") w4AllS = false; }
    if ((worlds[i] || 1) === 5) { w5Count++; if (rk !== "S") w5AllS = false; }
    if ((worlds[i] || 1) === 6) { w6Count++; if (rk !== "S") w6AllS = false; }
    if ((worlds[i] || 1) === 7) { w7Count++; if (rk !== "S") w7AllS = false; }
    const c = get("coins." + id) || 0, ct = get("coinmax." + id) || 0;
    coinTotal += c;
    if (ct > 0 && c >= ct) anyCoins = true;
    if (id === "sh05-reaper-below" && get("best." + id)) reaper = true;
    if (id === "m07-baphomet" && get("best." + id)) baph = true;
    if (id === "i07-leviathan" && get("best." + id)) lev = true;
  }
  if (anyS) un.add("ice");
  if (anyCoins) un.add("rose");
  if (coinTotal >= 12) un.add("coin50");
  if (w1Count > 0 && w1AllS) un.add("sworld1");
  if (w2Count > 0 && w2AllS) un.add("sworld2");
  if (w3Count > 0 && w3AllS) un.add("sworld3");
  if (reaper) un.add("void");   // the world's boss answers directly
  if (baph) un.add("brand");    // … and the second
  if (lev) un.add("serpent");   // … and the serpent
  if (allS) { un.add("gold"); un.add("paragon"); } // total mastery: the capstone
  return un;
}
