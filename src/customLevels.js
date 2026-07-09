import { supabase } from "./supabaseClient.js";
import { setOnlineLevels } from "./levels.js";

/* Online custom levels — public read, admin-only write. Requires the
 * `custom_levels` table + RLS policies from the Supabase setup SQL (see
 * project notes): anyone can SELECT; only ADMIN_EMAIL can INSERT/UPDATE/DELETE.
 * `level_data` is the exact same JSON shape as src/levels/*.json (what the
 * editor's Shift+E export produces), so uploads and shipped levels share one
 * loader (levelload.js's instantiateLevel). */
export const ADMIN_EMAIL = "admin26Tehter@gmail.com";

function emailIsAdmin(email) {
  return !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

export async function isAdminUser() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return emailIsAdmin(user?.email);
}

// live-updating cached flag — a synchronous read of the same check, so DOM
// widgets (adminModal.js) and the canvas-drawn editor toolbar can gate a
// button without an async getUser() round-trip each time. Event-driven
// consumers (the admin gear) subscribe via onAdminChange instead of polling.
export let isAdminSession = false;
const adminWatchers = new Set();
export function onAdminChange(fn) {
  adminWatchers.add(fn);
  return () => adminWatchers.delete(fn);
}
function setAdminSession(v) {
  v = !!v;
  if (v === isAdminSession) return;
  isAdminSession = v;
  for (const fn of [...adminWatchers]) fn(v);
}
supabase.auth.onAuthStateChange((_event, session) => {
  setAdminSession(emailIsAdmin(session?.user?.email));
});
supabase.auth.getSession().then(({ data }) => {
  setAdminSession(emailIsAdmin(data.session?.user?.email));
});

const num = (v) => typeof v === "number" && isFinite(v);

// validate/normalize an arbitrary parsed level JSON — throws Error with a
// human-readable message on the first problem found (surfaced in the upload UI)
export function normalizeLevelData(raw, fallback = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("not a level object");
  const d = {};
  d.id = String(raw.id || fallback.id || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  if (!d.id) throw new Error("missing level id");
  d.name = String(raw.name || fallback.name || d.id).toUpperCase();
  d.tag = raw.tag ? String(raw.tag) : "community level";
  d.tint = raw.tint || "#8d7a9e";
  if (!raw.world || !num(raw.world.w) || !num(raw.world.h))
    throw new Error("world {w,h} missing");
  d.world = {
    w: Math.max(1200, Math.round(raw.world.w)),
    h: Math.max(700, Math.round(raw.world.h)),
  };
  if (!raw.spawn || !num(raw.spawn.x) || !num(raw.spawn.y))
    throw new Error("spawn {x,y} missing");
  d.spawn = { x: raw.spawn.x, y: raw.spawn.y };
  if (!raw.goal || !num(raw.goal.x) || !num(raw.goal.y))
    throw new Error("goal rect missing");
  d.goal = { w: 110, h: 110, ...raw.goal };
  for (const k of [
    "solids",
    "spikes",
    "anchors",
    "nodes",
    "enemies",
    "hints",
    "coins",
    "fragments",
    "npcs",
    "triggers",
    "decor",
    "props",
    "hazards",
  ]) {
    if (raw[k] != null && !Array.isArray(raw[k]))
      throw new Error(`${k} is not an array`);
    d[k] = raw[k] || [];
    for (const o of d[k])
      if (!num(o.x) || !num(o.y))
        throw new Error(`${k} entry without numeric x/y`);
  }
  // anchors — plain swing, or zip-line (a rail) / slingshot (a spring). Keep the
  // authored fields per kind so admin/custom levels can use the new mechanics.
  d.anchors = d.anchors.map((a) => {
    if (a.kind === "zip")
      return { kind: "zip", x: a.x, y: a.y,
               x2: num(a.x2) ? a.x2 : a.x + 240, y2: num(a.y2) ? a.y2 : a.y,
               speed: num(a.speed) && a.speed > 0 ? a.speed : 230 };
    if (a.kind === "sling") return { kind: "sling", x: a.x, y: a.y };
    return { x: a.x, y: a.y };
  });
  // NPCs — keep only the authored fields; default the kind
  d.npcs = d.npcs.map((n) => ({
    x: n.x, y: n.y,
    kind: n.kind === "harmonica" ? "harmonica" : "miner",
    text: String(n.text || ""),
    id: String(n.id || "n-" + Math.random().toString(36).slice(2, 8)),
  }));
  // credits set-piece config; preserved (+ shape-checked) for admin/custom levels
  if (raw.credits && typeof raw.credits === "object" && !Array.isArray(raw.credits)) {
    d.credits = {
      roll: Array.isArray(raw.credits.roll) ? raw.credits.roll.map((s) => String(s)) : [],
      director: String(raw.credits.director || "Directed by Barab0s1k"),
    };
  }
  // full-fidelity passthrough (PR8) — an admin OVERRIDE of a shipped campaign
  // level must not strip its music/boss/background plumbing on the way through
  if (raw.music && typeof raw.music === "object" && !Array.isArray(raw.music)) d.music = raw.music;
  if (raw.track) d.track = String(raw.track);
  if (num(raw.voidY)) d.voidY = raw.voidY;
  if (num(raw.bgT)) d.bgT = raw.bgT;             // per-level background evolution
  if (num(raw.bgWorld)) d.bgWorld = raw.bgWorld; // W4 inherit-parent pick
  if (raw.bside) d.bside = true;                 // B-side gating survives too
  if (raw.unlock) d.unlock = raw.unlock;
  if (raw.parent) d.parent = String(raw.parent);
  d.fragments = d.fragments.map((f) => ({
    x: f.x, y: f.y,
    skin: ["butterfly", "spark", "feather"].includes(f.skin) ? f.skin : "butterfly",
    text: String(f.text || ""),
    id: String(f.id || "f-" + Math.random().toString(36).slice(2, 8)),
  }));
  if (raw.par != null && !(num(raw.par) && raw.par > 0))
    throw new Error("par must be a positive number");
  d.par = num(raw.par) && raw.par > 0 ? raw.par : 60;
  if (raw.sRankTime != null) {
    if (!(num(raw.sRankTime) && raw.sRankTime > 0))
      throw new Error("sRankTime must be a positive number");
    d.sRankTime = raw.sRankTime;
  }
  d.worldId =
    num(raw.worldId) && raw.worldId >= 1 ? Math.round(raw.worldId) : 1;
  d.order = num(raw.order) ? raw.order : 999;
  return d;
}

export async function fetchCustomLevelRows() {
  const { data, error } = await supabase
    .from("custom_levels")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("fetchCustomLevelRows failed:", error.message);
    return [];
  }
  return data;
}

export async function uploadCustomLevel(name, levelData) {
  const { data, error } = await supabase
    .from("custom_levels")
    .insert([{ name, level_data: levelData }])
    .select();
  if (error) throw error;
  return data[0];
}

// PR8 — publish is an UPSERT keyed on the level id EMBEDDED in level_data:
// republishing sh01 updates the existing sh01 row instead of stacking
// duplicates. A row whose id matches a SHIPPED level becomes a live OVERRIDE
// of that level for every player (see levels.js makeRegistry).
export async function publishLevel(name, levelData) {
  const { data: rows, error: qErr } = await supabase
    .from("custom_levels")
    .select("id")
    .eq("level_data->>id", levelData.id)
    .limit(1);
  if (qErr) throw qErr;
  if (rows && rows.length) {
    const { data, error } = await supabase
      .from("custom_levels")
      .update({ name, level_data: levelData })
      .eq("id", rows[0].id)
      .select();
    if (error) throw error;
    return { row: data[0], updated: true };
  }
  const row = await uploadCustomLevel(name, levelData);
  return { row, updated: false };
}

// PR8 — delete an online row by its DB id (admin panel manage list). Deleting
// an override row reverts that shipped level to its repo version.
export async function deleteCustomLevelRow(rowId) {
  const { error } = await supabase.from("custom_levels").delete().eq("id", rowId);
  if (error) throw error;
}

// fetch + validate every online level, then merge the good ones into LEVELS —
// a row that fails validation is skipped (warned), never crashes the boot.
// The `name` column is the source of truth for display — it always wins over
// whatever happens to be baked into level_data (e.g. a level exported from a
// blank/untitled editor session before the admin named it).
export async function loadCustomLevels() {
  const rows = await fetchCustomLevelRows();
  const levels = [];
  for (const row of rows) {
    try {
      const levelData = { ...row.level_data, name: row.name };
      levels.push(normalizeLevelData(levelData));
    } catch (e) {
      console.warn(`skipping custom level ${row.id}:`, e.message);
    }
  }
  setOnlineLevels(levels);
}
