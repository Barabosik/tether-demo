import { CONFIG as C } from "./config.js";
import { clamp, rr, rotAabb } from "./util.js";
import { LEVELS, refreshLevels, moveLevelInWorld } from "./levels.js";
import { instantiateLevel } from "./levelload.js";
import { drawSolids, drawSpikes, drawZones, drawProps } from "./platforms.js";
import { updateHazards, drawHazards } from "./hazards.js";
import { drawNodes } from "./combat.js";
import { drawEnemies } from "./enemies.js";
import { drawDecorLayer, DECOR_TYPES } from "./decor.js";
import { sfx } from "./audio.js";
import { normalizeLevelData, publishLevel, isAdminSession } from "./customLevels.js";
import { newFragId, drawFragment, FRAG_SKINS } from "./fragments.js";
import { drawNpcs, newNpcId } from "./npc.js";

/* The level editor. One rule: the editor manipulates the SAME plain data
 * objects the game loads (src/levels/*.json shapes) — terrain, spikes,
 * anchors, enemies, coins, triggers, hints, decor, spawn, goal are all
 * first-class edits on that data; there is no parallel format.
 *
 * Saving: under `npm run dev` a vite middleware writes the JSON file itself
 * (true edit-in-place, save-as-new creates a file + regenerates the
 * manifest). In the standalone/file:// build it falls back to localStorage
 * overlays (tether.levelOverrides / tether.customLevels) and offers a JSON
 * download. Playtest (T) hot-loads the working copy without any reload.
 *
 * Layers: every object lives on bg / game / trig (default by type — decor+
 * hints on bg, triggers on trig, the rest on game; an explicit `layer` field
 * on the object overrides). Only the ACTIVE layer is pickable, and each layer
 * has show/lock toggles. Render order is always bg → game → trig.
 *
 * Selection is a SET: shift+click toggles, an empty-space LMB drag box-selects,
 * ⌘C/⌘V copy/paste at the cursor, R rotates the group 90°, X deletes.
 *
 * Open from the level select: E edits the highlighted level, N starts blank.
 */

const GRID = 20; // base tile — snap steps are multiples of this
const SNAP_MODES = [0, 0.5, 1, 2]; // ×GRID; 0 = off
// ---- object palette: grouped by intent, each category with an accent color.
// [label, glyph, one-line description] per tool; CATEGORIES lists membership.
// Redesign is presentation only — the tool KEYS and placeAt() are unchanged.
const TOOL_META = {
  select:  ["Select", "⌖", "Pick · move · resize · multi-select · box-select"],
  plat:    ["Platform", "▬", "Solid ground you run and land on"],
  crumble: ["Crumble", "▨", "Breaks a beat after you stand on it, then regrows"],
  mover:   ["Mover", "⇄", "Platform patrolling a two-point rail"],
  path:    ["Path Mover", "⋰", "Waypoint platform — select then EDIT PATH (P)"],
  oneway:  ["One-way", "⤒", "Jump up through it, land on top"],
  spike:   ["Spikes", "▲", "Hazard — rotate via handle; PULSE/PIN chips for variants"],
  saw:     ["Saw Blade", "✹", "Spinning blade — orbits a center or rides a waypoint track"],
  pendulum: ["Pendulum", "⟟", "Spiked head on a chain — arc, period and phase are yours"],
  crusher: ["Crusher", "▣", "Telegraphs, slams along its angle, holds, retracts"],
  laser:   ["Laser", "‖", "Constant beam — only a DASH passes through"],
  anchor:  ["Anchor", "◎", "Grapple ring — swing from it"],
  zip:     ["Zip Anchor", "⇢", "Grapple ring that SLIDES its rail while latched — AXIS/LEN/SPEED chips"],
  sling:   ["Slingshot", "❂", "Rubber-band anchor — stretch away, release to LAUNCH"],
  grip:    ["Grip Wall", "▤", "Cling on contact from any face; wall-jump off"],
  node:    ["Strike Node", "◆", "Pogo/strike to redirect momentum + refresh dash"],
  pad:     ["Bounce Pad", "⇧", "Angled launch along its arrow"],
  grav:    ["Gravity Zone", "⤊", "Inverts gravity while you are inside it"],
  wind:    ["Wind Zone", "≈", "Constant directional push (angle + force)"],
  drone:   ["Drone", "◍", "Floating chaser"],
  dart:    ["Dart", "➤", "Telegraphs, then lunges; dizzy after"],
  ward:    ["Ward", "◈", "Mounted turret firing slow bolts"],
  bloom:   ["Bloom", "✳", "Proximity mine that regrows"],
  wisp:    ["Wisp", "❍", "Seeker that drifts THROUGH terrain; one hit kills it"],
  keeper:  ["Boss", "♛", "Boss placeholder"],
  reaper:  ["Reaper", "☠", "THE REAPER — cuts your rope; punish him exposed"],
  coin:    ["Coin", "◇", "Collectible"],
  gate:    ["Gate", "▯", "Door raised by a plate on the same link id"],
  valve:   ["Valve", "⊳", "One-way door — pass one direction only"],
  plate:   ["Plate", "▭", "Pressure plate; drives its linked gate"],
  frag:    ["Marker", "◈", "Collectible marker — pick style (K) + edit text (⏎)"],
  miner:   ["NPC", "⛏", "Talkable NPC marker; edit dialogue (⏎, ' | ' splits lines)"],
  harm:    ["Note", "♪", "Marker — edit line (⏎)"],
  secret:  ["Secret", "?", "Hidden trigger — fires 'SECRET FOUND'"],
  exit:    ["Alt Exit", "⎋", "Secret alternate finish"],
  split:   ["Split Gate", "⏱", "IL timing checkpoint — splits vs your PB pace"],
  hint:    ["Text / Hint", "T", "Tutorial prompt the player reads (editable)"],
  decor:   ["Decor", "❋", "Cosmetic dressing, no collision (V cycles type)"],
  pot:     ["Clutter", "⌂", "Destructible pot / crate / shard"],
};
const CATEGORIES = [
  ["Terrain",   "#7ce0a0", ["plat", "crumble", "mover", "path", "oneway"]],
  ["Hazards",   "#ff6b6b", ["spike", "saw", "pendulum", "crusher", "laser"]],
  ["Traversal", "#8CF2FF", ["anchor", "zip", "sling", "grip", "node", "pad", "grav", "wind"]],
  ["Enemies",   "#ff9d5c", ["drone", "dart", "ward", "bloom", "wisp", "keeper", "reaper"]],
  ["Pickups",   "#ffd166", ["coin", "gate", "valve", "plate"]],
  ["Meta",      "#c99aff", ["frag", "miner", "harm", "split", "secret", "exit", "hint", "decor", "pot"]],
];
const catOfTool = (key) => CATEGORIES.find(([, , ks]) => ks.includes(key));
const ANNOT_COLOR = "#63d0e0"; // editor-only annotation ink — never in-game

const LAYERS = ["bg", "game", "trig"];
const LAYER_NAME = { bg: "BG", game: "GAME", trig: "TRIG" };
const DEFAULT_LAYER = { decor: "bg", hints: "bg", triggers: "trig" };
const layerOfArr = (arr) => DEFAULT_LAYER[arr] || "game";
const effLayer = (arr, r) => (r && r.layer) || layerOfArr(arr);

const SURFACES = [null, "ice", "bouncy", "sticky", "conveyor"];

const ed = {
  active: false,
  levelIndex: null,   // registry index being edited; null = new custom
  data: null,         // the working copy (plain data)
  preview: null,      // instantiated view of data (render only)
  camX: 0, camY: 0, zoom: 1,
  tool: "select",
  decorType: 0,
  sel: [],            // selection SET: [{arr, i}] (spawn/goal use i = null)
  drag: null,
  snapMode: 1,        // index into nothing — the ×GRID factor itself (0=off)
  snapOpen: false,    // snap dropdown expanded
  settingsOpen: false,
  paletteCat: "Terrain", // active object-palette category tab
  showAnnot: true,    // editor annotations (SPAWN/GOAL/link/zone labels) visible
  helpOpen: false,    // the toggleable shortcut overlay (replaces the legend)
  hoverTip: null,     // {x, y, text} tooltip for the object under the cursor
  pathEdit: false,    // waypoint editing on the selected mover
  clipboard: null,
  textEdit: null,     // {sel} while the inline hint-text input is open
  layers: null,       // { bg: {vis, lock}, ... } (reset per editorOpen)
  activeLayer: "game",
  undo: [], redo: [],
  mx: 0, my: 0, wx: 0, wy: 0, // screen + world mouse
  buttons: [],
  toastMsg: "", toastT: 0,
  dirty: false,
  escArm: 0,
};

let H = null; // game hooks: {canvas, playtest(data), exitToSelect(), refreshThumbs()}

export function editorInit(hooks) {
  H = hooks;
  if (typeof window !== "undefined")
    window.__tetherEditor = {
      open: editorOpen,
      state: () => ed,
      data: () => ed.data,
      setTool: (t) => (ed.tool = t),
      place: placeAt,
      select: (arr, i) => (ed.sel = [{ arr, i }]),
      moveSel,
      save: saveLevel,
      playtest: startPlaytest,
      importData: loadImported, // programmatic import (same validation path)
    };
}

export const editorActive = () => ed.active;

const blankLevel = () => ({
  id: "untitled", order: 999, name: "UNTITLED", tag: "custom", tint: "#8CF2FF",
  world: { w: 2400, h: 1150 }, par: 120,
  spawn: { x: 160, y: 1000 - C.PLAYER_H },
  goal: { x: 2160, y: 890, w: 110, h: 110 },
  solids: [
    { x: 0, y: 1000, w: 2400, h: 150 },
    { x: 0, y: 720, w: 34, h: 280 },
    { x: 2366, y: 720, w: 34, h: 280 },
  ],
  spikes: [], anchors: [], nodes: [], enemies: [],
  hints: [], coins: [], fragments: [], npcs: [], triggers: [], decor: [], props: [], hazards: [],
});

export function editorOpen(levelIndex, opts = {}) {
  commitTextEdit(false);
  ed.levelIndex = levelIndex;
  ed.data = JSON.parse(JSON.stringify(levelIndex == null ? blankLevel() : LEVELS[levelIndex].data));
  ed.data.hazards ||= []; // pre-hazard levels normalize on open
  if (levelIndex == null && opts.worldId > 1) ed.data.worldId = opts.worldId;
  ed.undo = []; ed.redo = []; ed.sel = []; ed.drag = null; ed.dirty = false;
  ed.pathEdit = false; ed.snapOpen = false; ed.settingsOpen = false;
  ed.layers = {
    bg: { vis: true, lock: false },
    game: { vis: true, lock: false },
    trig: { vis: true, lock: false },
  };
  ed.activeLayer = "game";
  ed.zoom = 0.5; ed.camX = 0; ed.camY = Math.max(0, ed.data.world.h - C.VIEW_H / ed.zoom);
  ed.active = true;
  rebuild();
  toast(levelIndex == null ? "new level — place things, S saves" : `editing ${ed.data.id}`);
  return ed;
}

export function editorResume() { ed.active = true; }
export function editorClose() { commitTextEdit(true); ed.active = false; }

function rebuild() { ed.preview = instantiateLevel(ed.data); }

function toast(m) { ed.toastMsg = m; ed.toastT = 2.6; }

function pushUndo() {
  ed.undo.push(JSON.stringify(ed.data));
  if (ed.undo.length > 60) ed.undo.shift();
  ed.redo.length = 0;
  ed.dirty = true;
}
function doUndo() {
  commitTextEdit(false);
  if (!ed.undo.length) return toast("nothing to undo");
  ed.redo.push(JSON.stringify(ed.data));
  ed.data = JSON.parse(ed.undo.pop());
  ed.sel = []; ed.pathEdit = false; rebuild();
}
function doRedo() {
  commitTextEdit(false);
  if (!ed.redo.length) return;
  ed.undo.push(JSON.stringify(ed.data));
  ed.data = JSON.parse(ed.redo.pop());
  ed.sel = []; ed.pathEdit = false; rebuild();
}

const snapStep = () => GRID * ed.snapMode;
const snapv = (v) => (ed.snapMode ? Math.round(v / snapStep()) * snapStep() : Math.round(v));

// ------------------------------------------------------------ object model
// every editable thing resolves to a bbox + a ref into ed.data
function* allObjects() {
  const d = ed.data;
  // points first — they sit on top for picking
  for (let i = 0; i < d.anchors.length; i++) yield obj("anchors", i, d.anchors[i].x - 14, d.anchors[i].y - 14, 28, 28);
  for (let i = 0; i < d.nodes.length; i++) yield obj("nodes", i, d.nodes[i].x - 18, d.nodes[i].y - 18, 36, 36);
  for (let i = 0; i < d.coins.length; i++) yield obj("coins", i, d.coins[i].x - 12, d.coins[i].y - 12, 24, 24);
  for (let i = 0; i < (d.fragments || []).length; i++) yield obj("fragments", i, d.fragments[i].x - 14, d.fragments[i].y - 14, 28, 28);
  for (let i = 0; i < (d.npcs || []).length; i++) yield obj("npcs", i, d.npcs[i].x - 20, d.npcs[i].y - 34, 40, 44);
  for (let i = 0; i < d.enemies.length; i++) yield obj("enemies", i, d.enemies[i].x - 20, d.enemies[i].y - 20, 40, 40);
  for (let i = 0; i < d.decor.length; i++) {
    const s = (d.decor[i].s || 1) * 40;
    yield obj("decor", i, d.decor[i].x - s / 2, d.decor[i].y - s, s, s + 6);
  }
  for (let i = 0; i < d.hints.length; i++) {
    const w = Math.max(80, d.hints[i].text.length * 7.5);
    yield obj("hints", i, d.hints[i].x - w / 2, d.hints[i].y - 16, w, 24);
  }
  for (let i = 0; i < (d.props || []).length; i++) {
    const pr = d.props[i];
    if (pr.kind === "plate") yield obj("props", i, pr.x, pr.y - 10, pr.w, 14, false);
    else yield obj("props", i, pr.x - 14, pr.y - 24, 28, 26, false);
  }
  for (let i = 0; i < (d.hazards || []).length; i++) {
    const h = d.hazards[i];
    if (h.kind === "crusher" || h.kind === "laser")
      yield obj("hazards", i, h.x, h.y, h.w || 40, h.h || 40, true);
    else yield obj("hazards", i, h.x - 20, h.y - 20, 40, 40); // anchor knob
  }
  yield obj("spawn", null, d.spawn.x - 4, d.spawn.y - 4, C.PLAYER_W + 8, C.PLAYER_H + 8);
  yield obj("goal", null, d.goal.x, d.goal.y, d.goal.w, d.goal.h, true);
  for (let i = 0; i < d.triggers.length; i++) {
    const t = d.triggers[i];
    yield obj("triggers", i, t.x, t.y, t.w, t.h, true);
  }
  for (let i = 0; i < d.spikes.length; i++) {
    const s = d.spikes[i];
    if (s.rot) { // pick/select by the rotated footprint's world AABB
      const bb = rotAabb(s.x, s.y, s.w, s.h, (s.rot * Math.PI) / 180);
      yield obj("spikes", i, bb.x, bb.y, bb.w, bb.h, false);
    } else yield obj("spikes", i, s.x, s.y, s.w, s.h, true);
  }
  for (let i = 0; i < d.solids.length; i++) {
    const s = d.solids[i];
    yield obj("solids", i, s.x, s.y, s.w, s.h, true);
  }
}
const obj = (arr, i, x, y, w, h, resizable = false) => {
  const o = { arr, i, x, y, w, h, resizable };
  o.layer = effLayer(arr, ref(o));
  return o;
};

function ref(sel) {
  if (!sel) return null;
  if (sel.arr === "spawn") return ed.data.spawn;
  if (sel.arr === "goal") return ed.data.goal;
  return ed.data[sel.arr]?.[sel.i];
}
function bboxOf(sel) {
  for (const o of allObjects())
    if (o.arr === sel.arr && (o.i === sel.i || (o.i == null && sel.i == null))) return o;
  return null;
}
const isSel = (arr, i) => ed.sel.some((s) => s.arr === arr && (s.i === i || (s.i == null && i == null)));
const selOne = () => (ed.sel.length === 1 ? ed.sel[0] : null);

// objects with a draggable angle handle: spikes spin `rot`, angled pads and
// wind volumes aim `angle` (both conventions: 0° = up, clockwise; handle sits
// on the object's local "up")
function angleInfo(one) {
  const r = ref(one);
  if (!r) return null;
  if (one.arr === "spikes") return { r, field: "rot" };
  if (one.arr === "solids" && r.kind === "pad") return { r, field: "angle" };
  if (one.arr === "triggers" && r.kind === "wind") return { r, field: "angle" };
  if (one.arr === "hazards" && r.kind === "crusher") return { r, field: "angle" };
  return null;
}
function angleHandlePos(info) {
  const r = info.r;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const rad = (((r[info.field] || 0) - 90) * Math.PI) / 180;
  const dist = Math.max(Math.min(r.w, r.h) / 2 + 30, 46);
  return { cx, cy, hx: cx + Math.cos(rad) * dist, hy: cy + Math.sin(rad) * dist };
}
function unionBBox() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of ed.sel) {
    const b = bboxOf(s);
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// pick prefers the active layer, then falls back to any other VISIBLE and
// UNLOCKED layer — auto-hopping the active layer to the picked object so
// everything on screen is one click away (hide/lock still isolate a layer)
function pick(wx, wy) {
  let fallback = null;
  for (const o of allObjects()) {
    if (wx < o.x || wx > o.x + o.w || wy < o.y || wy > o.y + o.h) continue;
    const L = ed.layers[o.layer];
    if (!L.vis || L.lock) continue;
    if (o.layer === ed.activeLayer) return o;
    if (!fallback) fallback = o;
  }
  if (fallback) {
    ed.activeLayer = fallback.layer;
    toast(`layer → ${LAYER_NAME[fallback.layer]}`);
  }
  return fallback;
}

// ---- inline text editing: a real DOM input floated over the canvas (IME,
// cursor, selection — things a canvas field can't do). Opens on click-select
// of a hint, Enter, or the TEXT chip; commits on Enter/blur, Esc cancels.
let textInput = null;
function ensureTextInput() {
  if (textInput || typeof document === "undefined") return textInput;
  textInput = document.createElement("input");
  textInput.type = "text";
  textInput.id = "tether-textedit";
  Object.assign(textInput.style, {
    position: "fixed", display: "none", zIndex: 30,
    background: "#0d0916", color: "#ffe9c9",
    border: "1px solid #8CF2FF", borderRadius: "4px",
    padding: "4px 8px", font: "13px ui-monospace, Menlo, monospace",
    outline: "none", boxShadow: "0 0 14px rgba(140,242,255,0.3)",
    minWidth: "180px", textAlign: "center",
  });
  textInput.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing must never pan the camera / trigger tools
    if (e.key === "Enter") commitTextEdit(true);
    else if (e.key === "Escape") commitTextEdit(false);
  });
  // clicks inside the field stay inside the field
  textInput.addEventListener("mousedown", (e) => e.stopPropagation());
  // NO blur→commit: anything that transiently steals focus (render tick,
  // devtools, window juggling) must not close the edit — the per-frame
  // watchdog below takes focus back instead. Commits are EXPLICIT: Enter,
  // a canvas click, or an editor action; Esc cancels.
  // Parent into #wrap so the field exists inside the fullscreened subtree
  // (a body-parented overlay simply doesn't render in fullscreen mode).
  const cv = document.getElementById("game");
  (cv?.parentElement || document.body).appendChild(textInput);
  return textInput;
}
function openTextEdit(sel) {
  const r = ref(sel);
  if (!r || (sel.arr !== "hints" && sel.arr !== "fragments" && sel.arr !== "npcs") || !ensureTextInput()) return;
  ed.textEdit = { sel };
  textInput.value = r.text || "";
  textInput.style.display = "block";
  positionTextInput();
  textInput.focus();
  textInput.select();
}
// glued to the hint through pans/zooms/drags — repositioned every drawn
// frame, and the same tick RE-TAKES focus if anything stole it (the
// "canvas reclaims keyboard focus" failure mode). Intentional closes clear
// ed.textEdit synchronously before this ever runs again.
function positionTextInput() {
  if (!textInput || !ed.textEdit) return;
  const r = ref(ed.textEdit.sel);
  const cv = typeof document !== "undefined" && document.getElementById("game");
  if (!r || !cv) return;
  const rect = cv.getBoundingClientRect();
  const sx = (r.x - ed.camX) * ed.zoom, sy = (r.y - ed.camY) * ed.zoom;
  textInput.style.left = Math.round(rect.left + (sx / C.VIEW_W) * rect.width - 95) + "px";
  textInput.style.top = Math.round(rect.top + ((sy + 12) / C.VIEW_H) * rect.height) + "px";
  if (document.activeElement !== textInput) textInput.focus();
}
function commitTextEdit(apply) {
  if (!textInput || !ed.textEdit) return;
  const sel = ed.textEdit.sel;
  ed.textEdit = null; // clear FIRST — hiding fires blur, which re-enters here
  const v = textInput.value.trim();
  textInput.style.display = "none";
  textInput.blur();
  const r = ref(sel);
  if (apply && r && v && v !== r.text) {
    pushUndo();
    r.text = v;
    rebuild();
    toast("text updated");
  }
}

// move the whole selection by a delta; the FIRST item's position is snapped
// and everyone else keeps their relative offset (grid-aligned stays aligned)
function moveSel(dx, dy) {
  if (!ed.sel.length) return;
  const r0 = ref(ed.sel[0]);
  if (!r0) return;
  const ddx = snapv(r0.x + dx) - r0.x, ddy = snapv(r0.y + dy) - r0.y;
  for (const s of ed.sel) shiftObj(ref(s), ddx, ddy);
  rebuild();
}
function shiftObj(r, dx, dy) {
  if (!r) return;
  r.x += dx; r.y += dy;
  if (r.x2 != null) { r.x2 += dx; r.y2 += dy; }
  if (r.path) for (const pt of r.path) { pt.x += dx; pt.y += dy; }
}

function placeAt(tool, wx, wy) {
  const d = ed.data;
  const x = snapv(wx), y = snapv(wy);
  pushUndo();
  let sel = null;
  const push = (arr, o) => {
    if (!d[arr]) d[arr] = []; // older levels predate newer arrays (e.g. fragments)
    d[arr].push(o);
    sel = { arr, i: d[arr].length - 1 };
    ed.layers[layerOfArr(arr)].vis = true;   // never stamp into an invisible layer
    ed.activeLayer = layerOfArr(arr);        // fresh objects are instantly editable
  };
  switch (tool) {
    case "plat": push("solids", { x, y, w: 200, h: 40 }); break;
    case "crumble": push("solids", { kind: "crumble", x, y, w: 110, h: 22 }); break;
    case "mover": push("solids", { kind: "mover", x, y, w: 140, h: 22, x2: x + 200, y2: y, speed: 90 }); break;
    case "path": // waypoint mover — select it and hit PATH✎ (P) to author the route
      push("solids", { kind: "mover", x, y, w: 140, h: 22, speed: 90,
        path: [{ x, y }, { x: x + 200, y }], mode: "pingpong", easing: "linear" });
      break;
    case "grip": push("solids", { kind: "grip", x, y, w: 44, h: 300 }); break;
    case "spike": push("spikes", { x, y, w: 120, h: 60, deep: true }); break;
    case "saw": push("hazards", { kind: "saw", x, y, mode: "orbit", orbitR: 90, rpm: 26, r: 26 }); break;
    case "pendulum": push("hazards", { kind: "pendulum", x, y, armLen: 170, arcDeg: 55, period: 2.6, r: 20 }); break;
    case "crusher": push("hazards", { kind: "crusher", x, y, w: 90, h: 70, travel: 140, cycle: 2.8, angle: 180, phase: 0 }); break;
    case "laser": push("hazards", { kind: "laser", x, y, w: 26, h: 260 }); break;
    case "anchor": push("anchors", { x, y }); break;
    case "zip": push("anchors", { kind: "zip", x, y, x2: x + 240, y2: y, speed: 230 }); break;
    case "sling": push("anchors", { kind: "sling", x, y }); break;
    case "node": push("nodes", { x, y }); break;
    case "pad": push("solids", { kind: "pad", x, y, w: 64, h: 16, angle: 0 }); break;
    case "grav": push("triggers", { kind: "gravity", x, y, w: 180, h: 220 }); break;
    case "wind": push("triggers", { kind: "wind", x, y, w: 220, h: 180, angle: 0, force: 1000 }); break;
    case "drone": case "dart": case "ward": case "bloom": case "wisp": case "keeper": case "reaper":
      push("enemies", { kind: tool, x, y }); break;
    case "coin": push("coins", { x, y }); break;
    case "frag": push("fragments", { x, y, skin: "butterfly", text: "", id: newFragId() }); break;
    case "miner": push("npcs", { x, y, kind: "miner", text: "", id: newNpcId() }); break;
    case "harm": push("npcs", { x, y, kind: "harmonica", text: "", id: newNpcId() }); break;
    case "secret": push("triggers", { kind: "secret", x, y, w: 120, h: 120 }); break;
    case "exit": push("triggers", { kind: "exit", x, y, w: 110, h: 110 }); break;
    case "split": push("triggers", { kind: "split", x, y, w: 26, h: 380 }); break;
    case "hint":
      push("hints", { x, y, text: "new hint", big: 1 });
      break;
    case "decor": push("decor", { type: DECOR_TYPES[ed.decorType], x, y, s: 1, fg: 0 }); break;
    case "plate": push("props", { kind: "plate", x, y, w: 80, link: "g1" }); break;
    case "gate": push("solids", { kind: "gate", x, y, w: 36, h: 180, link: "g1" }); break;
    case "oneway": push("solids", { kind: "oneway", x, y, w: 160, h: 14 }); break;
    case "valve": push("solids", { kind: "valve", x, y, w: 18, h: 140, dir: 1 }); break;
    case "pot": {
      const kinds = ["pot", "crate", "shard"];
      push("props", { kind: kinds[(ed.potType = ((ed.potType || 0) + 1) % 3)], x, y });
      break;
    }
    default: return null;
  }
  rebuild();
  ed.sel = sel ? [sel] : [];
  return sel;
}

function deleteSel() {
  commitTextEdit(false); // the edited hint may be in the doomed selection
  const del = ed.sel.filter((s) => s.arr !== "spawn" && s.arr !== "goal");
  if (!del.length) return;
  pushUndo();
  const byArr = {};
  for (const s of del) (byArr[s.arr] ||= []).push(s.i);
  for (const arr in byArr)
    for (const i of byArr[arr].sort((a, b) => b - a)) ed.data[arr].splice(i, 1);
  ed.sel = [];
  ed.pathEdit = false;
  rebuild();
}

function duplicateSel() {
  const dup = ed.sel.filter((s) => s.arr !== "spawn" && s.arr !== "goal");
  if (!dup.length) return;
  pushUndo();
  const fresh = [];
  for (const s of dup) {
    const copy = JSON.parse(JSON.stringify(ref(s)));
    shiftObj(copy, GRID * 2, GRID);
    ed.data[s.arr].push(copy);
    fresh.push({ arr: s.arr, i: ed.data[s.arr].length - 1 });
  }
  ed.sel = fresh;
  rebuild();
}

// ---- clipboard: copy keeps the selection's union-bbox origin; paste drops
// the group so that origin lands on the (snapped) cursor
function copySel() {
  const items = ed.sel.filter((s) => s.arr !== "spawn" && s.arr !== "goal");
  if (!items.length) return toast("nothing copyable selected");
  const bb = unionBBox();
  ed.clipboard = {
    ox: bb.x, oy: bb.y,
    items: items.map((s) => ({ arr: s.arr, data: JSON.parse(JSON.stringify(ref(s))) })),
  };
  toast(`copied ${items.length} object${items.length > 1 ? "s" : ""}`);
}
function pasteClip() {
  const clip = ed.clipboard;
  if (!clip || !clip.items.length) return;
  pushUndo();
  const dx = snapv(ed.wx) - clip.ox, dy = snapv(ed.wy) - clip.oy;
  const fresh = [];
  for (const it of clip.items) {
    const copy = JSON.parse(JSON.stringify(it.data));
    shiftObj(copy, dx, dy);
    ed.data[it.arr].push(copy);
    fresh.push({ arr: it.arr, i: ed.data[it.arr].length - 1 });
  }
  ed.sel = fresh;
  rebuild();
  toast(`pasted ${fresh.length}`);
}

// ---- rotate the selection 90° CW around the group's center. Spikes keep
// their rect and spin their `rot` (real OBB); other rects swap w/h; points
// and waypoints just orbit. Free-angle spike rotation is the drag handle.
function rotateSel() {
  if (!ed.sel.length) return;
  const bb = unionBBox();
  if (!bb) return;
  const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
  const rot = (x, y) => ({ x: cx - (y - cy), y: cy + (x - cx) });
  pushUndo();
  for (const s of ed.sel) {
    const r = ref(s);
    if (!r) continue;
    if (s.arr === "spikes") {
      const c = rot(r.x + r.w / 2, r.y + r.h / 2);
      r.x = Math.round(c.x - r.w / 2); r.y = Math.round(c.y - r.h / 2);
      r.rot = (((r.rot || 0) + 90) % 360 + 360) % 360;
      if (r.rot && r.deep) delete r.deep; // deep-fill is an axis-aligned story
    } else if (r.w != null && r.h != null && s.arr !== "spawn") {
      const c = rot(r.x + r.w / 2, r.y + r.h / 2);
      const nw = r.h, nh = r.w;
      r.x = Math.round(c.x - nw / 2); r.y = Math.round(c.y - nh / 2);
      r.w = nw; r.h = nh;
      if (r.angle != null) r.angle = ((r.angle + 90) % 360 + 360) % 360; // pads + wind aim along
      if (r.x2 != null) {
        const c2 = rot(r.x2 + nh / 2, r.y2 + nw / 2); // old dims at the far end
        r.x2 = Math.round(c2.x - nw / 2); r.y2 = Math.round(c2.y - nh / 2);
      }
      if (r.path) for (const pt of r.path) {
        const c2 = rot(pt.x + nh / 2, pt.y + nw / 2);
        pt.x = Math.round(c2.x - nw / 2); pt.y = Math.round(c2.y - nh / 2);
      }
    } else { // points (anchors, nodes, coins, enemies, decor, hints, props, spawn)
      const c = rot(r.x, r.y);
      r.x = Math.round(c.x); r.y = Math.round(c.y);
    }
  }
  rebuild();
}

// ---------------------------------------------------------------- persist
const SHIPPED = new Set(LEVELS.map((l) => l.id)); // ids at boot (pre-custom)

// shared by saveLevel(asNew) and publishToSupabase() — prompts for an id +
// name when the level hasn't been named yet (still the blank "untitled")
function promptForNewId() {
  const d = ed.data;
  const id = (typeof window !== "undefined" && window.prompt
    ? window.prompt("new level id (kebab-case):", d.id === "untitled" ? "my-level" : d.id + "-b")
    : d.id + "-b");
  if (!id || !/^[a-z0-9-]+$/.test(id)) { toast("bad id — kebab-case only"); return false; }
  d.id = id;
  d.order = Math.max(...LEVELS.map((l) => l.data.order || 0), 0) + 1;
  d.name = (window.prompt?.("level name:", d.name) || d.name).toUpperCase();
  return true;
}

async function saveLevel(asNew) {
  const d = ed.data;
  if (asNew && !promptForNewId()) return false;
  if (d.id === "untitled") return saveLevel(true); // first save of a blank = name it
  // 1) dev middleware: true edit-in-place on src/levels/<id>.json
  try {
    const res = await fetch("/__tether/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: d }),
    });
    if (res.ok) {
      ed.dirty = false;
      toast(`saved → src/levels/${d.id}.json`);
      finishSave();
      return true;
    }
  } catch {}
  // 2) standalone fallback: localStorage overlay
  try {
    if (SHIPPED.has(d.id)) {
      const ov = JSON.parse(localStorage.getItem("tether.levelOverrides") || "{}");
      ov[d.id] = d;
      localStorage.setItem("tether.levelOverrides", JSON.stringify(ov));
    } else {
      const customs = JSON.parse(localStorage.getItem("tether.customLevels") || "[]");
      const at = customs.findIndex((c) => c.id === d.id);
      if (at >= 0) customs[at] = d; else customs.push(d);
      localStorage.setItem("tether.customLevels", JSON.stringify(customs));
    }
    ed.dirty = false;
    toast(`saved locally (${d.id}) — export: Shift+E`);
    finishSave();
    return true;
  } catch (e) {
    toast("save failed: " + e);
    return false;
  }
}

function finishSave() {
  refreshLevels();
  H?.refreshThumbs?.();
  const at = LEVELS.findIndex((l) => l.id === ed.data.id);
  if (at >= 0) ed.levelIndex = at;
}

// ---- publish: push the current level straight into Supabase `custom_levels`
// so it appears online for everyone — no export/re-import round trip needed.
// PR8: an UPSERT keyed on the level id — republish updates the same row, and
// publishing a SHIPPED level makes the row a live OVERRIDE of it (the admin
// "fix main levels" flow; levels.js merges it over the repo JSON at load).
// RLS enforces the real admin check server-side; isAdminSession only gates
// whether the button is shown (see the topActions list in editorDraw).
async function publishToSupabase() {
  const d = ed.data;
  if (d.id === "untitled" && !promptForNewId()) return;

  let levelData;
  try { levelData = normalizeLevelData(JSON.parse(JSON.stringify(d))); }
  catch (e) { toast(`publish failed: ${e?.message || e}`); return; }

  toast("publishing…");
  try {
    const { updated } = await publishLevel(levelData.name, levelData);
    ed.dirty = false;
    if (window.__reloadCustomLevels) await window.__reloadCustomLevels();
    else refreshLevels();
    H?.refreshThumbs?.();
    const at = LEVELS.findIndex((l) => l.id === d.id);
    if (at >= 0) ed.levelIndex = at;
    toast(SHIPPED.has(d.id)
      ? `published — ${updated ? "updated the" : "now a"} LIVE OVERRIDE of shipped "${d.id}"`
      : `published "${levelData.name}" online${updated ? " (updated)" : ""}`);
  } catch (e) {
    toast(`publish failed: ${e?.message || e}`);
  }
}

// ---- import / export -----------------------------------------------------
// export: level_<id>.json with the layer resolved onto EVERY object (implicit
// defaults become explicit in the file; loading tolerates both)
function exportJson() {
  const d = JSON.parse(JSON.stringify(ed.data));
  for (const arr of ["solids", "spikes", "anchors", "nodes", "enemies", "hints",
    "coins", "fragments", "npcs", "triggers", "decor", "props", "hazards"])
    for (const o of d[arr] || []) o.layer = o.layer || layerOfArr(arr);
  const blob = new Blob([JSON.stringify(d, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `level_${d.id}.json`;
  a.click();
  toast(`exported level_${d.id}.json`);
}

// validate an arbitrary parsed JSON into a well-formed level (throws strings)
function normalizeLevel(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw "not a level object";
  const num = (v) => typeof v === "number" && isFinite(v);
  const d = { ...blankLevel(), ...raw };
  d.id = String(raw.id || "imported").toLowerCase().replace(/[^a-z0-9-]/g, "-") || "imported";
  d.name = String(raw.name || d.id).toUpperCase();
  if (!raw.world || !num(raw.world.w) || !num(raw.world.h)) throw "world {w,h} missing";
  d.world = { w: Math.max(1200, Math.round(raw.world.w)), h: Math.max(700, Math.round(raw.world.h)) };
  if (!raw.spawn || !num(raw.spawn.x) || !num(raw.spawn.y)) throw "spawn {x,y} missing";
  if (!raw.goal || !num(raw.goal.x) || !num(raw.goal.y)) throw "goal rect missing";
  d.goal = { w: 110, h: 110, ...raw.goal };
  for (const k of ["solids", "spikes", "anchors", "nodes", "enemies", "hints",
    "coins", "fragments", "npcs", "triggers", "decor", "props", "hazards"]) {
    if (raw[k] != null && !Array.isArray(raw[k])) throw `${k} is not an array`;
    d[k] = raw[k] || [];
    for (const o of d[k]) if (!num(o.x) || !num(o.y)) throw `${k} entry without numeric x/y`;
  }
  if (raw.par != null && !(num(raw.par) && raw.par > 0)) throw "par must be a positive number";
  if (raw.sRankTime != null) {
    if (!(num(raw.sRankTime) && raw.sRankTime > 0)) throw "sRankTime must be a positive number";
    d.sRankTime = raw.sRankTime;
  }
  d.worldId = num(raw.worldId) && raw.worldId >= 1 ? Math.round(raw.worldId) : 1;
  return d;
}

function loadImported(raw) {
  const d = normalizeLevel(raw); // throws → caller toasts
  pushUndo();
  ed.data = d;
  ed.sel = []; ed.pathEdit = false;
  const at = LEVELS.findIndex((l) => l.id === d.id);
  ed.levelIndex = at >= 0 ? at : null;
  rebuild();
  toast(`imported ${d.id} — S saves it`);
  return d;
}

function importJson() {
  if (typeof document === "undefined") return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,application/json";
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    f.text().then((txt) => {
      try { loadImported(JSON.parse(txt)); }
      catch (e) { toast("import failed: " + (e?.message || e)); }
    });
  };
  inp.click();
}

function startPlaytest() {
  commitTextEdit(true);
  ed.active = false;
  H.playtest(JSON.parse(JSON.stringify(ed.data)));
}

// ---- settings panel edits (prompt-driven inputs, canvas-native UI)
function promptNum(label, cur, min, fn) {
  const v = Number(window.prompt?.(label, String(cur)));
  if (isFinite(v) && v >= min) { pushUndo(); fn(v); rebuild(); }
  else if (!Number.isNaN(v) && v !== 0) toast(`needs a number ≥ ${min}`);
}

// ------------------------------------------------------------------ input
export function editorKeyDown(e) {
  if (!ed.active) return false;
  // an open text edit owns the keyboard — if focus was momentarily stolen,
  // swallow the key here (no pans/deletes) and let the watchdog refocus
  if (ed.textEdit) return true;
  const c = e.code, meta = e.metaKey || e.ctrlKey;
  if (meta && c === "KeyZ") { e.shiftKey ? doRedo() : doUndo(); return true; }
  if (meta && c === "KeyD") { duplicateSel(); return true; }
  if (meta && c === "KeyC") { copySel(); return true; }
  if (meta && c === "KeyV") { pasteClip(); return true; }
  // '?' (Shift+/) toggles the help overlay from anywhere
  if (c === "Slash" && e.shiftKey) { ed.helpOpen = !ed.helpOpen; return true; }
  if (c === "Escape") {
    if (ed.helpOpen) { ed.helpOpen = false; return true; }
    if (ed.settingsOpen) { ed.settingsOpen = false; return true; }
    if (ed.drag) { ed.drag = null; return true; }
    if (ed.pathEdit) { ed.pathEdit = false; return true; }
    if (ed.snapOpen) { ed.snapOpen = false; return true; }
    if (ed.tool !== "select") { ed.tool = "select"; return true; }
    if (ed.sel.length) { ed.sel = []; return true; }
    if (ed.dirty && ed.escArm <= 0) {
      ed.escArm = 2; toast("unsaved changes — Esc again discards, S saves");
      return true;
    }
    ed.active = false;
    H.exitToSelect();
    return true;
  }
  // layer hotkeys: 1/2/3 activate, shift+1/2/3 assign the selection
  if (/^Digit[1-3]$/.test(c)) {
    const L = LAYERS[Number(c.slice(5)) - 1];
    if (e.shiftKey) assignLayer(L);
    else { ed.activeLayer = L; toast(`layer: ${LAYER_NAME[L]}`); }
    return true;
  }
  switch (c) {
    case "KeyG": { // cycle snap: off → 0.5x → 1x → 2x
      const at = SNAP_MODES.indexOf(ed.snapMode);
      ed.snapMode = SNAP_MODES[(at + 1) % SNAP_MODES.length];
      toast("snap " + (ed.snapMode ? ed.snapMode + "× (" + snapStep() + "px)" : "OFF"));
      return true;
    }
    case "KeyZ": ed.zoom = ed.zoom === 1 ? 0.5 : ed.zoom === 0.5 ? 0.25 : 1; return true;
    case "KeyT": startPlaytest(); return true;
    case "KeyS":
      if (e.shiftKey) saveLevel(true); else saveLevel(false);
      return true;
    case "KeyE": if (e.shiftKey) { exportJson(); return true; } break;
    case "KeyI": ed.settingsOpen = !ed.settingsOpen; return true;
    case "KeyR": rotateSel(); return true;
    case "KeyP": togglePathEdit(); return true;
    case "KeyX": case "Delete": case "Backspace": deleteSel(); return true;
    case "KeyB": { // big toggle on selected hints
      const hs = ed.sel.filter((s) => s.arr === "hints");
      if (hs.length) { pushUndo(); for (const s of hs) { const r = ref(s); r.big = r.big ? 0 : 1; } rebuild(); }
      return true;
    }
    case "KeyK": {
      const fs = ed.sel.filter((s) => s.arr === "fragments");
      if (fs.length) { pushUndo(); for (const s of fs) { const r = ref(s); r.skin = FRAG_SKINS[(FRAG_SKINS.indexOf(r.skin) + 1) % FRAG_SKINS.length]; } rebuild(); }
      const ns = ed.sel.filter((s) => s.arr === "npcs");
      if (ns.length) { pushUndo(); for (const s of ns) { const r = ref(s); r.kind = r.kind === "harmonica" ? "miner" : "harmonica"; } rebuild(); }
      return true;
    }
    case "KeyV": { // cycle decor type (selected or the stamp)
      const ds = ed.sel.filter((s) => s.arr === "decor");
      if (ds.length) {
        pushUndo();
        for (const s of ds) {
          const r = ref(s);
          r.type = DECOR_TYPES[(DECOR_TYPES.indexOf(r.type) + 1) % DECOR_TYPES.length];
        }
        rebuild();
      } else ed.decorType = (ed.decorType + 1) % DECOR_TYPES.length;
      return true;
    }
    case "KeyF": { // decor fg/bg toggle — F is fullscreen elsewhere, editor owns it here
      const ds = ed.sel.filter((s) => s.arr === "decor");
      if (ds.length) { pushUndo(); for (const s of ds) { const r = ref(s); r.fg = r.fg ? 0 : 1; } rebuild(); }
      return true;
    }
    case "BracketLeft": case "BracketRight": {
      const ds = ed.sel.filter((s) => s.arr === "decor");
      if (ds.length) {
        pushUndo();
        for (const s of ds) {
          const r = ref(s);
          r.s = clamp((r.s || 1) + (c === "BracketRight" ? 0.2 : -0.2), 0.4, 3);
        }
        rebuild();
      }
      return true;
    }
    case "KeyD": { // deep toggle on selected spikes (no meta)
      const ss = ed.sel.filter((s) => s.arr === "spikes");
      if (ss.length) {
        pushUndo();
        for (const s of ss) { const r = ref(s); if (!r.rot) r.deep = r.deep ? 0 : 1; }
        rebuild();
        return true;
      }
      break;
    }
    case "KeyL": { // edit link id on gate/plate; flip a valve
      const r = ref(selOne());
      if (r && (r.kind === "gate" || r.kind === "plate")) {
        const link = window.prompt?.("link id:", r.link || "g1");
        if (link) { pushUndo(); r.link = link; rebuild(); }
      } else if (r && r.kind === "valve") {
        pushUndo(); r.dir = -(r.dir || 1); rebuild(); // L flips a valve
      }
      return true;
    }
    case "Enter": {
      const one = selOne();
      if (one?.arr === "hints" || one?.arr === "fragments" || one?.arr === "npcs") { openTextEdit(one); return true; }
      break;
    }
  }
  // pan
  const pan = (e.shiftKey ? 300 : 90) / ed.zoom;
  if (c === "ArrowLeft" || c === "KeyA") { ed.camX -= pan; return true; }
  if (c === "ArrowRight") { ed.camX += pan; return true; }
  if (c === "ArrowUp" || c === "KeyW") { ed.camY -= pan; return true; }
  if (c === "ArrowDown") { ed.camY += pan; return true; }
  return true; // editor swallows the rest while active
}

function assignLayer(L) {
  const items = ed.sel.filter((s) => s.arr !== "spawn" && s.arr !== "goal");
  if (!items.length) return toast("select something to assign");
  pushUndo();
  for (const s of items) {
    const r = ref(s);
    if (L === layerOfArr(s.arr)) delete r.layer; // default stays implicit
    else r.layer = L;
  }
  rebuild();
  toast(`→ layer ${LAYER_NAME[L]}`);
}

function togglePathEdit() {
  const one = selOne();
  const r = ref(one);
  const pathable = r && ((one.arr === "solids" && r.kind === "mover") ||
    (one.arr === "hazards" && r.kind === "saw" && r.mode === "track"));
  if (!pathable) {
    if (ed.pathEdit) { ed.pathEdit = false; return; }
    return toast("select a mover (or track saw) to edit its path");
  }
  if (!ed.pathEdit && !r.path) {
    if (r.kind === "mover") { // legacy rail → waypoint path, once
      pushUndo();
      r.path = [{ x: r.x, y: r.y }, { x: r.x2 ?? r.x + 200, y: r.y2 ?? r.y }];
      delete r.x2; delete r.y2;
      r.mode = r.mode || "pingpong";
      r.easing = r.easing || "linear";
    } else {
      pushUndo();
      r.path = [{ x: r.x, y: r.y }, { x: r.x + 220, y: r.y }];
    }
    rebuild();
  }
  ed.pathEdit = !ed.pathEdit;
  toast(ed.pathEdit ? "PATH EDIT — click adds · drag moves · RMB deletes · P/Esc done" : "path saved");
}

export function editorWheel(e) {
  if (!ed.active) return;
  e.preventDefault();
  const oldZoom = ed.zoom;
  ed.zoom = clamp(ed.zoom * (e.deltaY > 0 ? 0.9 : 1.11), 0.2, 2);
  // zoom around the cursor
  ed.camX += ed.mx / oldZoom - ed.mx / ed.zoom;
  ed.camY += ed.my / oldZoom - ed.my / ed.zoom;
}

export function editorMouseMove(sx, sy) {
  if (!ed.active) return;
  ed.mx = sx; ed.my = sy;
  ed.wx = ed.camX + sx / ed.zoom;
  ed.wy = ed.camY + sy / ed.zoom;
  const dr = ed.drag;
  if (!dr) return;
  if (dr.mode === "pan") {
    ed.camX = dr.cx - (sx - dr.sx) / ed.zoom;
    ed.camY = dr.cy - (sy - dr.sy) / ed.zoom;
  } else if (dr.mode === "box") {
    dr.x1 = ed.wx; dr.y1 = ed.wy;
  } else if (dr.mode === "move") {
    const r0 = ref(dr.items[0].s);
    if (!r0) return;
    const dwx = ed.wx - dr.wx, dwy = ed.wy - dr.wy;
    const ddx = snapv(dr.items[0].ox + dwx) - dr.items[0].ox;
    const ddy = snapv(dr.items[0].oy + dwy) - dr.items[0].oy;
    for (const it of dr.items) {
      const r = ref(it.s);
      if (!r) continue;
      r.x = it.ox + ddx; r.y = it.oy + ddy;
      if (it.ox2 != null) { r.x2 = it.ox2 + ddx; r.y2 = it.oy2 + ddy; }
      if (it.path) r.path = it.path.map((pt) => ({ x: pt.x + ddx, y: pt.y + ddy }));
    }
    rebuild();
  } else if (dr.mode === "rail") {
    const r = ref(selOne());
    if (!r) return;
    r.x2 = snapv(ed.wx - r.w / 2); r.y2 = snapv(ed.wy - r.h / 2);
    rebuild();
  } else if (dr.mode === "waypoint") {
    const r = ref(selOne());
    if (!r?.path?.[dr.idx]) return;
    r.path[dr.idx].x = snapv(ed.wx - (r.w || 0) / 2);
    r.path[dr.idx].y = snapv(ed.wy - (r.h || 0) / 2);
    if (dr.idx === 0) { r.x = r.path[0].x; r.y = r.path[0].y; }
    rebuild();
  } else if (dr.mode === "rot") {
    const one = selOne();
    const info = one && angleInfo(one);
    if (!info) return;
    const r = info.r;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let deg = (Math.atan2(ed.wy - cy, ed.wx - cx) * 180) / Math.PI + 90;
    deg = ((deg % 360) + 360) % 360;
    r[info.field] = dr.shift ? Math.round(deg / 45) * 45 % 360 : Math.round(deg);
    if (info.field === "rot" && r.rot && r.deep) delete r.deep;
    rebuild();
  } else if (dr.mode === "resize") {
    const r = ref(selOne());
    if (!r) return;
    let x0 = dr.ox, y0 = dr.oy, x1 = dr.ox + dr.ow, y1 = dr.oy + dr.oh;
    if (dr.corner.includes("l")) x0 = snapv(ed.wx);
    if (dr.corner.includes("r")) x1 = snapv(ed.wx);
    if (dr.corner.includes("t")) y0 = snapv(ed.wy);
    if (dr.corner.includes("b")) y1 = snapv(ed.wy);
    r.x = Math.min(x0, x1 - 20);
    r.y = Math.min(y0, y1 - 12);
    r.w = Math.max(20, x1 - x0);
    r.h = Math.max(12, y1 - y0);
    rebuild();
  }
}

export function editorMouseDown(sx, sy, button, shiftKey) {
  if (!ed.active) return;
  commitTextEdit(true); // clicking anywhere lands the pending text edit
  ed.mx = sx; ed.my = sy;
  ed.wx = ed.camX + sx / ed.zoom;
  ed.wy = ed.camY + sy / ed.zoom;
  const shift = shiftKey ?? (typeof window !== "undefined" && window.event?.shiftKey) ?? false;

  // toolbar first (screen space)
  const b = ed.buttons.find((b) => sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h);
  if (b) { b.fn(); return; }
  if (ed.snapOpen) { ed.snapOpen = false; return; } // clicked past the dropdown

  // ---- path-edit mode owns the canvas while active
  if (ed.pathEdit) {
    const r = ref(selOne());
    if (!r?.path) { ed.pathEdit = false; return; }
    const near = r.path.findIndex((pt) =>
      Math.hypot(ed.wx - (pt.x + (r.w || 0) / 2), ed.wy - (pt.y + (r.h || 0) / 2)) < 14 / ed.zoom);
    if (button === 1 || button === 2) {
      if (near >= 0 && r.path.length > 2) { // RMB deletes a waypoint
        pushUndo();
        r.path.splice(near, 1);
        r.x = r.path[0].x; r.y = r.path[0].y;
        rebuild();
      } else ed.drag = { mode: "pan", sx, sy, cx: ed.camX, cy: ed.camY };
      return;
    }
    if (near >= 0) { pushUndo(); ed.drag = { mode: "waypoint", idx: near }; return; }
    pushUndo(); // click appends a waypoint at the cursor
    r.path.push({ x: snapv(ed.wx - (r.w || 0) / 2), y: snapv(ed.wy - (r.h || 0) / 2) });
    rebuild();
    return;
  }

  if (button === 1 || button === 2) { // middle/right = pan
    ed.drag = { mode: "pan", sx, sy, cx: ed.camX, cy: ed.camY };
    return;
  }

  if (ed.tool !== "select") { // stamp
    placeAt(ed.tool, ed.wx, ed.wy);
    return;
  }

  // angle handle of a single selected spike / pad / wind volume
  const one = selOne();
  {
    const info = one && angleInfo(one);
    if (info) {
      const { hx, hy } = angleHandlePos(info);
      if (Math.hypot(ed.wx - hx, ed.wy - hy) < 12 / ed.zoom) {
        pushUndo();
        ed.drag = { mode: "rot", shift };
        return;
      }
    }
  }
  // resize handles of a single selection
  const bb = one && bboxOf(one);
  if (bb && bb.resizable) {
    const hs = 8 / ed.zoom;
    const corners = [["tl", bb.x, bb.y], ["tr", bb.x + bb.w, bb.y], ["bl", bb.x, bb.y + bb.h], ["br", bb.x + bb.w, bb.y + bb.h]];
    for (const [corner, cx, cy] of corners)
      if (Math.abs(ed.wx - cx) < hs && Math.abs(ed.wy - cy) < hs) {
        pushUndo();
        const r = ref(one);
        ed.drag = { mode: "resize", corner, ox: r.x, oy: r.y, ow: r.w, oh: r.h };
        return;
      }
  }
  // mover rail endpoint handle (legacy x2/y2 movers)
  const selRef = ref(one);
  if (selRef?.kind === "mover" && selRef.x2 != null) {
    const ex = selRef.x2 + selRef.w / 2, ey = selRef.y2 + selRef.h / 2;
    if (Math.hypot(ed.wx - ex, ed.wy - ey) < 14 / ed.zoom) {
      pushUndo();
      ed.drag = { mode: "rail" };
      return;
    }
  }

  const hit = pick(ed.wx, ed.wy);
  if (hit) {
    if (shift) { // shift+click toggles membership, never starts a drag
      if (isSel(hit.arr, hit.i))
        ed.sel = ed.sel.filter((s) => !(s.arr === hit.arr && (s.i === hit.i || (s.i == null && hit.i == null))));
      else ed.sel = [...ed.sel, { arr: hit.arr, i: hit.i }];
      return;
    }
    if (!isSel(hit.arr, hit.i)) ed.sel = [{ arr: hit.arr, i: hit.i }];
    pushUndo();
    ed.drag = {
      mode: "move", wx: ed.wx, wy: ed.wy, wx0: ed.wx, wy0: ed.wy,
      items: ed.sel.map((s) => {
        const r = ref(s);
        return { s, ox: r.x, oy: r.y, ox2: r.x2, oy2: r.y2,
          path: r.path ? r.path.map((pt) => ({ ...pt })) : null };
      }),
    };
  } else {
    // empty space: LMB drags a selection box (pan lives on MMB/RMB)
    ed.drag = { mode: "box", x0: ed.wx, y0: ed.wy, x1: ed.wx, y1: ed.wy, additive: shift };
  }
}

export function editorMouseUp() {
  const dr = ed.drag;
  // a CLICK on a hint (a "move" that never moved) opens the inline text field
  if (dr?.mode === "move" && dr.wx0 != null &&
      Math.hypot(ed.wx - dr.wx0, ed.wy - dr.wy0) < 3 / ed.zoom) {
    const one = selOne();
    if (one?.arr === "hints" || one?.arr === "fragments" || one?.arr === "npcs") openTextEdit(one);
  }
  if (dr?.mode === "box") { // commit the marquee
    const x0 = Math.min(dr.x0, dr.x1), x1 = Math.max(dr.x0, dr.x1);
    const y0 = Math.min(dr.y0, dr.y1), y1 = Math.max(dr.y0, dr.y1);
    const picked = [];
    const L = ed.layers[ed.activeLayer];
    if (L.vis && !L.lock && (x1 - x0 > 4 || y1 - y0 > 4)) {
      for (const o of allObjects())
        if (o.layer === ed.activeLayer &&
            o.x < x1 && o.x + o.w > x0 && o.y < y1 && o.y + o.h > y0)
          picked.push({ arr: o.arr, i: o.i });
    }
    if (dr.additive) {
      const merged = [...ed.sel];
      for (const p of picked) if (!merged.some((s) => s.arr === p.arr && s.i === p.i)) merged.push(p);
      ed.sel = merged;
    } else ed.sel = picked;
  }
  if (dr && dr.mode !== "pan" && dr.mode !== "box") ed.dirty = true;
  ed.drag = null;
}

// ------------------------------------------------------------------ render
export function editorDraw(ctx, t, dt) {
  if (ed.toastT > 0) ed.toastT -= dt;
  if (ed.escArm > 0) ed.escArm -= dt;
  positionTextInput(); // the inline text field stays glued through pan/zoom
  const W = C.VIEW_W, HH = C.VIEW_H;
  const d = ed.data, p = ed.preview;

  ctx.fillStyle = "#151020";
  ctx.fillRect(0, 0, W, HH);

  ctx.save();
  ctx.scale(ed.zoom, ed.zoom);
  ctx.translate(-ed.camX, -ed.camY);

  // world bounds — the hard level border (resize via SET panel)
  ctx.strokeStyle = "rgba(140,242,255,0.4)";
  ctx.lineWidth = 2.5 / ed.zoom;
  ctx.setLineDash([10 / ed.zoom, 6 / ed.zoom]);
  ctx.strokeRect(0, 0, d.world.w, d.world.h);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(140,242,255,0.5)";
  ctx.font = `${12 / ed.zoom}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = "left";
  ctx.fillText(`${d.world.w} × ${d.world.h}`, 8 / ed.zoom, -8 / ed.zoom);

  // grid — the lines ARE the snap: step follows the current snap setting
  if (ed.snapMode) {
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1 / ed.zoom;
    let step = snapStep();
    while (step * ed.zoom < 7) step *= 4; // coarsen when zoomed way out
    const x0 = Math.max(0, Math.floor(ed.camX / step) * step);
    const x1 = Math.min(d.world.w, ed.camX + W / ed.zoom);
    const y0 = Math.max(0, Math.floor(ed.camY / step) * step);
    const y1 = Math.min(d.world.h, ed.camY + HH / ed.zoom);
    for (let x = x0; x <= x1; x += step) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); }
    for (let y = y0; y <= y1; y += step) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
  }

  // ---- world content, one pass per layer: bg → game → trig. Each pass draws
  // every object type filtered to that layer (preview and data index-align).
  const inLayer = (arr, L) => (o, i) => effLayer(arr, d[arr][i]) === L;
  for (const L of LAYERS) {
    if (!ed.layers[L].vis) continue;
    const sol = p.solids.filter(inLayer("solids", L));
    const stLike = { solids: sol, nodes: p.nodes.filter(inLayer("nodes", L)),
      enemies: p.enemies.filter(inLayer("enemies", L)), shots: [], rtime: t,
      props: p.props.filter(inLayer("props", L)) };
    drawDecorLayer(ctx, p.decor.filter(inLayer("decor", L)), 0, t, d.tint);
    drawSolids(ctx, stLike, t);
    drawProps(ctx, stLike, t);
    if (ed.showAnnot) { // link labels — editor annotations, cyan + tagged
      ctx.fillStyle = ANNOT_COLOR;
      ctx.font = `${11 / ed.zoom}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "left";
      for (const pr of stLike.props)
        if (pr.kind === "plate") ctx.fillText("⚙" + (pr.link || "g1"), pr.x, pr.y - 12 / ed.zoom);
      for (const s2 of sol)
        if (s2.kind === "gate") ctx.fillText("⚙" + (s2.link || "g1"), s2.x, s2.y - 6 / ed.zoom);
    }

    drawSpikes(ctx, p.spikes.filter(inLayer("spikes", L)));
    { // hazards — live-animated in the editor so cycles/orbits are honest
      const hz = { hazards: p.hazards.filter(inLayer("hazards", L)), simTime: t };
      updateHazards(hz, 0.016);
      drawHazards(ctx, hz, t);
      if (ed.showAnnot) { // spike variant badges (annotation ink)
        ctx.fillStyle = ANNOT_COLOR;
        ctx.font = `${11 / ed.zoom}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = "left";
        const spikesL = ed.data.spikes;
        for (let i = 0; i < spikesL.length; i++) {
          const sp = spikesL[i];
          if (effLayer("spikes", sp) !== L) continue;
          const tags = [sp.pulse ? "◷" : "", sp.pin ? "⌖" : ""].join("");
          if (tags) ctx.fillText(tags, sp.x + sp.w + 4 / ed.zoom, sp.y + 10 / ed.zoom);
        }
      }
    }

    // anchors
    for (const a of p.anchors.filter(inLayer("anchors", L))) {
      const lw = 2.5 / Math.max(ed.zoom, 0.5);
      const hue = a.kind === "zip" ? "140,242,255" : a.kind === "sling" ? "255,92,160" : "255,209,102";
      if (a.kind === "zip") { // the rail the ring travels
        ctx.strokeStyle = "rgba(140,242,255,0.35)"; ctx.lineWidth = lw;
        ctx.setLineDash([6, 8]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x2 ?? a.x + 240, a.y2 ?? a.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(140,242,255,0.7)"; // the end knob
        ctx.beginPath(); ctx.arc(a.x2 ?? a.x + 240, a.y2 ?? a.y, 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = `rgba(${hue},0.85)`; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(a.x, a.y, C.ANCHOR_R, 0, Math.PI * 2); ctx.stroke();
      if (a.kind === "sling") { ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(a.x, a.y, C.ANCHOR_R + 3.5, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.fillStyle = `rgb(${hue})`;
      ctx.beginPath(); ctx.arc(a.x, a.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    drawNodes(ctx, stLike, t);
    // bosses track st.player with their eyes — give the preview a stand-in
    drawEnemies(ctx, { ...stLike, enemies: stLike.enemies,
      player: { x: d.spawn.x, y: d.spawn.y, w: 26, h: 36 } }, 1, d.spawn.x, d.spawn.y);

    // coins
    for (const c2 of p.coins.filter(inLayer("coins", L))) {
      ctx.save();
      ctx.translate(c2.x, c2.y);
      ctx.rotate(t * 1.5);
      ctx.fillStyle = "#ffd166";
      ctx.strokeStyle = "#fff3c4";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(7, 0); ctx.lineTo(0, 9); ctx.lineTo(-7, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    for (const f of (p.fragments || []).filter(inLayer("fragments", L))) drawFragment(ctx, f, t, false);

    drawNpcs(ctx, { npcs: (p.npcs || []).filter(inLayer("npcs", L)) }, t);

    // triggers — zones draw their live look; the dashed box + KIND label are
    // editor annotations (hidden in preview)
    const trigsL = p.triggers.filter(inLayer("triggers", L));
    drawZones(ctx, trigsL, t);
    if (ed.showAnnot)
      for (const tr of trigsL) {
        const col = { exit: "255,120,220", gravity: "201,154,255", wind: "140,242,255", split: "255,209,102" }[tr.kind] || "140,242,255";
        ctx.strokeStyle = `rgba(${col},0.8)`;
        ctx.setLineDash([6 / ed.zoom, 6 / ed.zoom]);
        ctx.lineWidth = 2 / ed.zoom;
        ctx.strokeRect(tr.x, tr.y, tr.w, tr.h);
        ctx.setLineDash([]);
        ctx.fillStyle = `rgba(${col},0.9)`;
        ctx.font = `${12 / ed.zoom}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = "left";
        ctx.fillText("⧉ " + tr.kind.toUpperCase(), tr.x + 4 / ed.zoom, tr.y + 14 / ed.zoom);
      }

    if (L === "game") { // goal + spawn live on the gameplay layer
      ctx.strokeStyle = "rgba(255,209,102,0.9)";
      ctx.lineWidth = 2 / ed.zoom;
      rr(ctx, d.goal.x, d.goal.y, d.goal.w, d.goal.h, 10); ctx.stroke();
      ctx.fillStyle = "rgba(255,209,102,0.25)";
      rr(ctx, d.goal.x, d.goal.y, d.goal.w, d.goal.h, 10); ctx.fill();
      ctx.fillStyle = "#ffb454";
      rr(ctx, d.spawn.x, d.spawn.y, C.PLAYER_W, C.PLAYER_H, 6); ctx.fill();
      if (ed.showAnnot) { // SPAWN/GOAL captions are editor-only labels
        ctx.fillStyle = ANNOT_COLOR;
        ctx.font = `${11 / ed.zoom}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = "left";
        ctx.fillText("⌂ SPAWN", d.spawn.x - 6, d.spawn.y - 6 / ed.zoom);
        ctx.fillText("★ GOAL", d.goal.x, d.goal.y - 6 / ed.zoom);
      }
    }

    // hints — the REAL in-game text, drawn exactly as the player sees it
    ctx.textAlign = "center";
    for (const h of p.hints.filter(inLayer("hints", L))) {
      ctx.font = h.big ? "bold 14px ui-monospace, Menlo, monospace" : "13px ui-monospace, Menlo, monospace";
      ctx.fillStyle = h.big ? "rgba(255,233,201,0.95)" : "rgba(216,196,232,0.6)";
      ctx.fillText(h.text, h.x, h.y);
    }
    drawDecorLayer(ctx, p.decor.filter(inLayer("decor", L)), 1, t, d.tint);
  }

  // ---- selection: shared bbox + per-object outlines
  if (ed.sel.length) {
    ctx.strokeStyle = "#8CF2FF";
    ctx.lineWidth = 2 / ed.zoom;
    ctx.setLineDash([5 / ed.zoom, 4 / ed.zoom]);
    for (const s of ed.sel) {
      const b = bboxOf(s);
      if (b) ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    }
    ctx.setLineDash([]);
    const ub = unionBBox();
    if (ub && ed.sel.length > 1) {
      ctx.strokeStyle = "rgba(140,242,255,0.6)";
      ctx.setLineDash([8 / ed.zoom, 6 / ed.zoom]);
      ctx.strokeRect(ub.x - 8, ub.y - 8, ub.w + 16, ub.h + 16);
      ctx.setLineDash([]);
      ctx.fillStyle = "#8CF2FF"; // group handles (move anywhere inside)
      for (const [cx, cy] of [[ub.x - 8, ub.y - 8], [ub.x + ub.w + 8, ub.y - 8],
        [ub.x - 8, ub.y + ub.h + 8], [ub.x + ub.w + 8, ub.y + ub.h + 8]]) {
        const hs = 5 / ed.zoom;
        ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2);
      }
    }
    const one = selOne();
    const bb = one && bboxOf(one);
    if (bb && bb.resizable) {
      ctx.fillStyle = "#8CF2FF";
      for (const [cx, cy] of [[bb.x, bb.y], [bb.x + bb.w, bb.y], [bb.x, bb.y + bb.h], [bb.x + bb.w, bb.y + bb.h]]) {
        const hs = 5 / ed.zoom;
        ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2);
      }
    }
    const r = one && ref(one);
    if (r?.kind === "mover" && r.x2 != null) { // legacy rail endpoint
      ctx.fillStyle = "#ffd166";
      ctx.beginPath();
      ctx.arc(r.x2 + r.w / 2, r.y2 + r.h / 2, 8 / ed.zoom, 0, Math.PI * 2);
      ctx.fill();
    }
    {
      const info = one && angleInfo(one); // spike rot / pad + wind angle
      if (info) {
        const { cx, cy, hx, hy } = angleHandlePos(info);
        ctx.strokeStyle = "rgba(255,180,84,0.8)";
        ctx.lineWidth = 1.5 / ed.zoom;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.fillStyle = "#ffb454";
        ctx.beginPath(); ctx.arc(hx, hy, 7 / ed.zoom, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,233,201,0.9)";
        ctx.font = `${11 / ed.zoom}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = "left";
        ctx.fillText(`${Math.round(info.r[info.field] || 0)}°`, hx + 10 / ed.zoom, hy);
      }
    }
    if ((r?.kind === "mover" || r?.kind === "saw") && r.path && (ed.pathEdit || ed.sel.length === 1)) {
      // waypoints — numbered knobs; bright while editing
      for (let i = 0; i < r.path.length; i++) {
        const px2 = r.path[i].x + (r.w || 0) / 2, py2 = r.path[i].y + (r.h || 0) / 2;
        ctx.fillStyle = ed.pathEdit ? "#ffd166" : "rgba(255,209,102,0.55)";
        ctx.beginPath(); ctx.arc(px2, py2, (ed.pathEdit ? 9 : 6) / ed.zoom, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#1b1220";
        ctx.font = `bold ${10 / ed.zoom}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = "center";
        ctx.fillText(String(i + 1), px2, py2 + 3.5 / ed.zoom);
      }
    }
  }

  // marquee
  if (ed.drag?.mode === "box") {
    const dr = ed.drag;
    ctx.strokeStyle = "rgba(140,242,255,0.9)";
    ctx.fillStyle = "rgba(140,242,255,0.08)";
    ctx.lineWidth = 1.5 / ed.zoom;
    ctx.setLineDash([4 / ed.zoom, 4 / ed.zoom]);
    const x = Math.min(dr.x0, dr.x1), y = Math.min(dr.y0, dr.y1);
    ctx.fillRect(x, y, Math.abs(dr.x1 - dr.x0), Math.abs(dr.y1 - dr.y0));
    ctx.strokeRect(x, y, Math.abs(dr.x1 - dr.x0), Math.abs(dr.y1 - dr.y0));
    ctx.setLineDash([]);
  }
  ctx.restore();

  drawToolbar(ctx, t);
}

const MONO = "ui-monospace, Menlo, monospace";
const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// a labeled button; `accent` recolors the active/hover state (default cyan)
function chip(ctx, x, y, w, h, label, on, fn, accent = "#8CF2FF") {
  const hov = ed.mx >= x && ed.mx <= x + w && ed.my >= y && ed.my <= y + h;
  ctx.fillStyle = on ? hexA(accent, 0.22) : hov ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.055)";
  rr(ctx, x, y, w, h, 4); ctx.fill();
  ctx.strokeStyle = on ? accent : hov ? hexA(accent, 0.6) : "rgba(140,110,160,0.3)";
  ctx.lineWidth = on ? 1.5 : 1;
  rr(ctx, x, y, w, h, 4); ctx.stroke();
  ctx.fillStyle = on ? "#eaffff" : "#c9b8d8";
  ctx.textAlign = "center";
  ctx.fillText(label, x + w / 2, y + h / 2 + 3.5);
  ed.buttons.push({ x, y, w, h, fn });
}

// icon + label object-palette chip; registers ed.toolChips[key] + a hover tip
function toolChipDraw(ctx, x, y, w, h, key, accent) {
  const on = ed.tool === key;
  const [label, glyph, desc] = TOOL_META[key];
  const hov = ed.mx >= x && ed.mx <= x + w && ed.my >= y && ed.my <= y + h;
  ctx.fillStyle = on ? hexA(accent, 0.22) : hov ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.05)";
  rr(ctx, x, y, w, h, 4); ctx.fill();
  ctx.strokeStyle = on ? accent : hov ? hexA(accent, 0.55) : "rgba(140,110,160,0.28)";
  ctx.lineWidth = on ? 1.5 : 1;
  rr(ctx, x, y, w, h, 4); ctx.stroke();
  ctx.fillStyle = on ? accent : hexA(accent, 0.85);
  ctx.font = `bold 13px ${MONO}`;
  ctx.textAlign = "center";
  ctx.fillText(glyph, x + 13, y + h / 2 + 4.5);
  ctx.fillStyle = on ? "#eaffff" : "#cbbcd8";
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = "left";
  const lbl = key === "decor" ? `${label} ${DECOR_TYPES[ed.decorType].slice(0, 4)}` : label;
  ctx.fillText(lbl, x + 26, y + h / 2 + 3.5);
  ed.buttons.push({ x, y, w, h, fn: () => {
    if (key === "decor" && ed.tool === "decor") ed.decorType = (ed.decorType + 1) % DECOR_TYPES.length;
    ed.tool = key;
  } });
  ed.toolChips[key] = { x, y, w, h };
  if (hov) ed.hoverTip = { x, y: y - 6, text: `${label} — ${desc}` };
}

function drawToolbar(ctx, t) {
  const W = C.VIEW_W, HH = C.VIEW_H;
  ed.buttons.length = 0;
  ed.toolChips = {};
  ed.hoverTip = null;
  const d = ed.data;

  // ============================ TOP BAR: status + file/view actions
  ctx.fillStyle = "rgba(10,7,16,0.95)";
  ctx.fillRect(0, 0, W, 30);
  ctx.strokeStyle = "rgba(140,110,160,0.35)";
  ctx.beginPath(); ctx.moveTo(0, 30); ctx.lineTo(W, 30); ctx.stroke();
  ctx.textAlign = "left";
  ctx.font = `bold 11px ${MONO}`;
  ctx.fillStyle = ed.dirty ? "#ffb454" : "rgba(210,190,230,0.85)";
  ctx.fillText(`${d.id}${ed.dirty ? " ✱" : ""}`, 10, 19);
  ctx.font = `11px ${MONO}`;
  ctx.fillStyle = "rgba(180,160,205,0.7)";
  ctx.fillText(`W${d.worldId || 1} · ${d.solids.length} solids · ${d.spikes.length} spikes · ${d.enemies.length} foes · sel ${ed.sel.length || "—"}`,
    10 + ctx.measureText(`${d.id}${ed.dirty ? " ✱" : ""}`).width + 74, 19);
  // right-aligned action chips (file + view); lay out from the right edge
  const topActions = [
    ["EXIT", () => { commitTextEdit(true); ed.active = false; H.exitToSelect(); }, "#ff9d5c"],
    [ed.helpOpen ? "HELP ✕" : "HELP ?", () => (ed.helpOpen = !ed.helpOpen), "#8CF2FF"],
    [`ANNOT ${ed.showAnnot ? "◉" : "◌"}`, () => (ed.showAnnot = !ed.showAnnot), "#63d0e0"],
    ["EXPORT", exportJson, "#8CF2FF"],
    ["IMPORT", importJson, "#8CF2FF"],
    [ed.settingsOpen ? "SETTINGS ✕" : "SETTINGS", () => (ed.settingsOpen = !ed.settingsOpen), "#c99aff"],
    ["PLAY ▶", startPlaytest, "#7ce0a0"],
    ["SAVE-AS", () => saveLevel(true), "#ffd166"],
    ["SAVE", () => saveLevel(false), "#ffd166"],
  ];
  // admin-only: pushes the level straight to Supabase (no export/re-import
  // round trip through the Admin Panel's Upload Level form)
  if (isAdminSession) topActions.push(["PUBLISH", publishToSupabase, "#a0ffa0"]);
  ctx.font = `bold 10px ${MONO}`;
  let ax = W - 8;
  for (const [label, fn, accent] of topActions) {
    const w = ctx.measureText(label).width + 16;
    ax -= w;
    chip(ctx, ax, 5, w, 20, label, false, fn, accent);
    ax -= 4;
  }

  // ============================ BOTTOM BAR: object palette (tabs + tools)
  const bar = 68, y0 = HH - bar;
  ctx.fillStyle = "rgba(10,7,16,0.95)";
  ctx.fillRect(0, y0, W, bar);
  ctx.strokeStyle = "rgba(140,110,160,0.4)";
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  // row 0 — SELECT + category tabs
  ctx.font = `bold 10px ${MONO}`;
  let x = 8;
  chip(ctx, x, y0 + 5, 66, 20, "⌖ SELECT", ed.tool === "select", () => (ed.tool = "select"), "#8CF2FF");
  ed.toolChips.select = { x, y: y0 + 5, w: 66, h: 20 };
  if (ed.mx >= x && ed.mx <= x + 66 && ed.my >= y0 + 5 && ed.my <= y0 + 25)
    ed.hoverTip = { x, y: y0 - 1, text: `Select — ${TOOL_META.select[2]}` };
  x += 72;
  ctx.fillStyle = "rgba(140,110,160,0.4)";
  ctx.fillRect(x - 4, y0 + 6, 1, 18); // divider
  for (const [name, accent, keys] of CATEGORIES) {
    const w = 82;
    chip(ctx, x, y0 + 5, w, 20, `${name} ${keys.length}`, ed.paletteCat === name,
      () => (ed.paletteCat = name), accent);
    x += w + 4;
  }

  // row 1 — tools of the active category, icon + label
  const cat = CATEGORIES.find((c) => c[0] === ed.paletteCat) || CATEGORIES[0];
  const accent = cat[1];
  x = 8;
  for (const key of cat[2]) {
    toolChipDraw(ctx, x, y0 + 32, 118, 24, key, accent);
    x += 122;
  }
  // view controls trail the tools (right side): snap dropdown, zoom, undo
  const snapLbl = ed.snapMode === 0 ? "OFF" : ed.snapMode === 0.5 ? "½x" : ed.snapMode + "x";
  const viewCtl = [
    [`SNAP ${snapLbl} ▾`, () => (ed.snapOpen = !ed.snapOpen), ed.snapOpen, "#8CF2FF", 78],
    [`ZOOM ${ed.zoom.toFixed(2)}`, () => (ed.zoom = ed.zoom === 1 ? 0.5 : ed.zoom === 0.5 ? 0.25 : 1), false, "#8CF2FF", 78],
    ["UNDO ⌘Z", doUndo, false, "#8CF2FF", 66],
  ];
  let vx = W - 8;
  ctx.font = `bold 10px ${MONO}`;
  let snapChipX = 0;
  for (const [label, fn, on, acc, w] of viewCtl) {
    vx -= w;
    if (label.startsWith("SNAP")) snapChipX = vx;
    chip(ctx, vx, y0 + 32, w, 24, label, !!on, fn, acc);
    vx -= 5;
  }

  // snap dropdown opens above its chip
  if (ed.snapOpen) {
    const opts = SNAP_MODES, w = 104, h = 20;
    for (let i = 0; i < opts.length; i++) {
      const oy = y0 - 4 - (opts.length - i) * (h + 3);
      const m = opts[i];
      const lbl = m === 0 ? "OFF" : m === 0.5 ? "0.5x (10px)" : `${m}x (${GRID * m}px)`;
      chip(ctx, snapChipX, oy, w, h, lbl, ed.snapMode === m, () => { ed.snapMode = m; ed.snapOpen = false; });
    }
  }

  // legacy bar height for placements that anchor to it (context chips, panels)
  drawLayersPanel(ctx);
  drawSelectionContext(ctx, y0);
  if (ed.settingsOpen) drawSettingsPanel(ctx);
  drawHoverTip(ctx);
  drawEditorStatus(ctx, y0);
  if (ed.helpOpen) drawHelpOverlay(ctx);

  if (ed.toastT > 0) {
    ctx.textAlign = "center";
    ctx.font = `bold 14px ${MONO}`;
    ctx.fillStyle = `rgba(255,233,201,${Math.min(1, ed.toastT)})`;
    ctx.fillText(ed.toastMsg, W / 2, y0 - 40);
  }
}

// coords + snap readout, bottom-left just above the palette
function drawEditorStatus(ctx, y0) {
  ctx.textAlign = "left";
  ctx.font = `11px ${MONO}`;
  ctx.fillStyle = "rgba(180,160,205,0.75)";
  ctx.fillText(
    `${Math.round(ed.wx)}, ${Math.round(ed.wy)}${ed.snapMode ? " ▦" + snapStep() : ""} · ${ed.tool}` +
    `${ed.pathEdit ? " · PATH EDIT" : ""}${ed.showAnnot ? "" : " · PREVIEW"}`, 10, y0 - 10);
}

// tooltip for the hovered palette chip — floats above the bar
function drawHoverTip(ctx) {
  if (!ed.hoverTip) return;
  const { text } = ed.hoverTip;
  ctx.font = `11px ${MONO}`;
  const w = ctx.measureText(text).width + 16;
  const x = clamp(ed.hoverTip.x, 6, C.VIEW_W - w - 6), y = ed.hoverTip.y - 22;
  ctx.fillStyle = "rgba(8,5,14,0.96)";
  rr(ctx, x, y, w, 20, 5); ctx.fill();
  ctx.strokeStyle = "rgba(140,242,255,0.5)";
  ctx.lineWidth = 1;
  rr(ctx, x, y, w, 20, 5); ctx.stroke();
  ctx.fillStyle = "#dfeff5";
  ctx.textAlign = "left";
  ctx.fillText(text, x + 8, y + 14);
}

// ---- layers: eye + lock affordances, an accent stripe on the active layer
const LAYER_ACCENT = { bg: "#7d9bd0", game: "#8CF2FF", trig: "#c99aff" };
function drawLayersPanel(ctx) {
  ctx.textAlign = "left";
  ctx.font = `bold 10px ${MONO}`;
  ctx.fillStyle = "rgba(180,160,205,0.6)";
  ctx.fillText("LAYERS", 12, 50);
  ctx.font = `9px ${MONO}`;
  ctx.fillStyle = "rgba(150,130,175,0.6)";
  ctx.fillText("1/2/3 active · ⇧ assign", 56, 50);
  let ly = 56;
  for (const L of LAYERS) {
    const s = ed.layers[L], active = ed.activeLayer === L, accent = LAYER_ACCENT[L];
    // row background + active accent stripe
    ctx.fillStyle = active ? hexA(accent, 0.16) : "rgba(255,255,255,0.04)";
    rr(ctx, 12, ly, 128, 22, 5); ctx.fill();
    ctx.strokeStyle = active ? accent : "rgba(140,110,160,0.28)";
    ctx.lineWidth = active ? 1.5 : 1;
    rr(ctx, 12, ly, 128, 22, 5); ctx.stroke();
    if (active) { ctx.fillStyle = accent; rr(ctx, 12, ly, 3, 22, 2); ctx.fill(); }
    // eye toggle
    const eye = { x: 20, y: ly + 3, w: 22, h: 16 };
    const eyeHov = ed.mx >= eye.x && ed.mx <= eye.x + eye.w && ed.my >= eye.y && ed.my <= eye.y + eye.h;
    ctx.fillStyle = eyeHov ? "rgba(255,255,255,0.1)" : "transparent";
    if (eyeHov) { rr(ctx, eye.x, eye.y, eye.w, eye.h, 3); ctx.fill(); }
    ctx.fillStyle = s.vis ? accent : "rgba(150,130,175,0.55)";
    ctx.font = `12px ${MONO}`;
    ctx.textAlign = "center";
    ctx.fillText(s.vis ? "◉" : "◌", eye.x + eye.w / 2, ly + 15);
    ed.buttons.push({ ...eye, fn: () => (s.vis = !s.vis) });
    // lock toggle
    const lock = { x: 44, y: ly + 3, w: 22, h: 16 };
    const lockHov = ed.mx >= lock.x && ed.mx <= lock.x + lock.w && ed.my >= lock.y && ed.my <= lock.y + lock.h;
    if (lockHov) { ctx.fillStyle = "rgba(255,255,255,0.1)"; rr(ctx, lock.x, lock.y, lock.w, lock.h, 3); ctx.fill(); }
    ctx.fillStyle = s.lock ? "#ff9d5c" : "rgba(150,130,175,0.5)";
    ctx.font = `11px ${MONO}`;
    ctx.fillText(s.lock ? "🔒" : "🔓", lock.x + lock.w / 2, ly + 15);
    ed.buttons.push({ ...lock, fn: () => (s.lock = !s.lock) });
    // name — click to activate
    ctx.fillStyle = active ? "#eaffff" : "#c9b8d8";
    ctx.font = `bold 11px ${MONO}`;
    ctx.textAlign = "left";
    ctx.fillText(LAYER_NAME[L], 74, ly + 15);
    ed.buttons.push({ x: 68, y: ly, w: 72, h: 22, fn: () => (ed.activeLayer = L) });
    ly += 25;
  }
}

// selection action chips — float just above the palette when a selection exists
function drawSelectionContext(ctx, y0) {
  const one = selOne();
  const r = one && ref(one);
  const chips = [];
  if (ed.sel.length > 1) {
    chips.push([`${ed.sel.length} SELECTED`, () => {}, false]);
    chips.push(["ROTATE 90° (R)", rotateSel]);
    chips.push(["DUP ⌘D", duplicateSel]);
    chips.push(["COPY ⌘C", copySel]);
    chips.push(["DELETE (X)", deleteSel]);
  } else if (r) {
    if (one.arr === "solids" && !r.kind) {
      chips.push([`SURFACE: ${r.surface || "normal"}`, () => {
        pushUndo();
        const at = SURFACES.indexOf(r.surface || null);
        const nx = SURFACES[(at + 1) % SURFACES.length];
        if (nx) r.surface = nx; else delete r.surface;
        if (r.surface !== "conveyor") delete r.conveyorSpeed;
        rebuild();
      }]);
      if (r.surface === "conveyor")
        chips.push([`BELT: ${r.conveyorSpeed ?? C.CONVEYOR_SPEED}px/s`, () => {
          const v = Number(window.prompt?.("conveyor speed (px/s, negative = left):", String(r.conveyorSpeed ?? C.CONVEYOR_SPEED)));
          if (isFinite(v) && v !== 0) { pushUndo(); r.conveyorSpeed = Math.round(v); rebuild(); }
        }]);
    }
    if (r.kind === "mover") {
      chips.push([ed.pathEdit ? "DONE (P)" : "EDIT PATH (P)", togglePathEdit, ed.pathEdit]);
      chips.push([`SPEED: ${r.speed || 90}`, () => {
        const v = Number(window.prompt?.("speed (px/s):", String(r.speed || 90)));
        if (v > 0) { pushUndo(); r.speed = Math.round(v); rebuild(); }
      }]);
      if (r.path) {
        chips.push([`MODE: ${r.mode || "pingpong"}`, () => { pushUndo(); r.mode = r.mode === "loop" ? "pingpong" : "loop"; rebuild(); }]);
        chips.push([`EASE: ${r.easing === "easeinout" ? "in-out" : "linear"}`, () => { pushUndo(); r.easing = r.easing === "easeinout" ? "linear" : "easeinout"; rebuild(); }]);
      }
    }
    if (one.arr === "anchors" && r.kind === "zip") {
      // the rail is axis-aligned (H/V) with an adjustable length — free-angle
      // rails need endpoint-drag (a follow-up); this covers the common cases.
      const horiz = Math.abs((r.x2 ?? r.x) - r.x) >= Math.abs((r.y2 ?? r.y) - r.y);
      const railLen = Math.round(Math.hypot((r.x2 ?? r.x) - r.x, (r.y2 ?? r.y) - r.y)) || 240;
      chips.push([`RAIL: ${horiz ? "↔ H" : "↕ V"}`, () => {
        pushUndo();
        if (horiz) { r.x2 = r.x; r.y2 = r.y + railLen; } else { r.x2 = r.x + railLen; r.y2 = r.y; }
        rebuild();
      }]);
      chips.push([`LEN: ${railLen}`, () => {
        const v = Number(window.prompt?.("rail length (px):", String(railLen)));
        if (v > 20) { pushUndo(); const s = v / (railLen || 1); r.x2 = r.x + ((r.x2 ?? r.x) - r.x) * s; r.y2 = r.y + ((r.y2 ?? r.y) - r.y) * s; rebuild(); }
      }]);
      chips.push([`FLIP`, () => { pushUndo(); r.x2 = 2 * r.x - (r.x2 ?? r.x); r.y2 = 2 * r.y - (r.y2 ?? r.y); rebuild(); }]);
      chips.push([`SPEED: ${r.speed || 230}`, () => {
        const v = Number(window.prompt?.("slide speed (px/s):", String(r.speed || 230)));
        if (v > 0) { pushUndo(); r.speed = Math.round(v); rebuild(); }
      }]);
    }
    if (one.arr === "spikes") {
      chips.push([`ROT: ${Math.round(r.rot || 0)}°`, () => {
        const v = Number(window.prompt?.("rotation (degrees 0–360):", String(r.rot || 0)));
        if (isFinite(v)) { pushUndo(); r.rot = ((Math.round(v) % 360) + 360) % 360; if (!r.rot) delete r.rot; else if (r.deep) delete r.deep; rebuild(); }
      }]);
      chips.push([r.pulse ? `PULSE ${r.pulse.on}/${r.pulse.off}s` : "PULSE: off", () => {
        const sIn = window.prompt?.("pulse on/off seconds (e.g. 1.2/1.0 — empty turns it off):",
          r.pulse ? `${r.pulse.on}/${r.pulse.off}` : "1.2/1.0");
        if (sIn == null) return;
        pushUndo();
        const m = sIn.match(/([\d.]+)\s*\/\s*([\d.]+)/);
        if (m) r.pulse = { on: +m[1], off: +m[2], phase: r.pulse?.phase || 0 };
        else delete r.pulse;
        rebuild();
      }]);
      if (r.pulse) chips.push([`PHASE: ${(r.pulse.phase || 0).toFixed(1)}s`, () => {
        const v = Number(window.prompt?.("pulse phase offset (seconds):", String(r.pulse.phase || 0)));
        if (isFinite(v)) { pushUndo(); r.pulse.phase = v; rebuild(); }
      }]);
      chips.push([r.pin ? "PIN ◉" : "PIN ◌", () => {
        pushUndo();
        if (r.pin) delete r.pin; else { r.pin = 1; delete r.deep; }
        rebuild();
      }]);
    }
    if (one.arr === "hazards") {
      const num = (label, key, min = 1) => chips.push([`${label}: ${r[key]}`, () => {
        const v = Number(window.prompt?.(`${label.toLowerCase()}:`, String(r[key])));
        if (isFinite(v) && v >= min) { pushUndo(); r[key] = v; rebuild(); }
      }]);
      if (r.kind === "saw") {
        chips.push([`MODE: ${r.mode === "track" ? "track" : "orbit"}`, () => {
          pushUndo();
          if (r.mode === "track") { r.mode = "orbit"; r.orbitR ??= 90; r.rpm ??= 26; delete r.path; delete r.loop; }
          else { r.mode = "track"; r.path ??= [{ x: r.x, y: r.y }, { x: r.x + 220, y: r.y }]; r.speed ??= 120; }
          ed.pathEdit = false;
          rebuild();
        }]);
        if (r.mode === "track") {
          chips.push([ed.pathEdit ? "DONE (P)" : "EDIT PATH (P)", togglePathEdit, ed.pathEdit]);
          num("SPEED", "speed");
          chips.push([`LOOP: ${r.loop ? "on" : "off"}`, () => { pushUndo(); if (r.loop) delete r.loop; else r.loop = 1; rebuild(); }]);
        } else {
          num("ORBIT R", "orbitR", 10);
          num("RPM", "rpm", 1);
        }
        num("BLADE R", "r", 8);
      } else if (r.kind === "pendulum") {
        num("ARM", "armLen", 30);
        num("ARC°", "arcDeg", 5);
        num("PERIOD", "period", 0.4);
        chips.push([`PHASE: ${(r.phase || 0).toFixed(2)}`, () => {
          const v = Number(window.prompt?.("phase (radians):", String(r.phase || 0)));
          if (isFinite(v)) { pushUndo(); r.phase = v; rebuild(); }
        }]);
      } else if (r.kind === "crusher") {
        num("TRAVEL", "travel", 20);
        num("CYCLE", "cycle", 0.8);
        chips.push([`PHASE: ${(r.phase || 0).toFixed(2)}`, () => {
          const v = Number(window.prompt?.("phase (0–1 of the cycle):", String(r.phase || 0)));
          if (isFinite(v)) { pushUndo(); r.phase = v; rebuild(); }
        }]);
        chips.push([`ANGLE: ${Math.round(r.angle ?? 180)}° (0=up)`, () => {
          const v = Number(window.prompt?.("slam angle (degrees, 0 = up, clockwise):", String(r.angle ?? 180)));
          if (isFinite(v)) { pushUndo(); r.angle = ((Math.round(v) % 360) + 360) % 360; rebuild(); }
        }]);
      }
    }
    if (r.kind === "pad" || r.kind === "wind")
      chips.push([`ANGLE: ${Math.round(r.angle || 0)}° (0=up)`, () => {
        const v = Number(window.prompt?.("launch/flow angle (degrees, 0 = up, clockwise):", String(r.angle || 0)));
        if (isFinite(v)) { pushUndo(); r.angle = ((Math.round(v) % 360) + 360) % 360; rebuild(); }
      }]);
    if (r.kind === "wind")
      chips.push([`FORCE: ${r.force || 1000}`, () => {
        const v = Number(window.prompt?.("wind force (px/s² — gravity is 1900):", String(r.force || 1000)));
        if (v > 0) { pushUndo(); r.force = Math.round(v); rebuild(); }
      }]);
    if (r.kind === "gate" || r.kind === "plate")
      chips.push([`LINK: ${r.link || "g1"} (L)`, () => {
        const link = window.prompt?.("link id:", r.link || "g1");
        if (link) { pushUndo(); r.link = link; rebuild(); }
      }]);
    if (r.kind === "valve")
      chips.push([`DIR: ${(r.dir || 1) > 0 ? "→" : "←"} (L)`, () => { pushUndo(); r.dir = -(r.dir || 1); rebuild(); }]);
    if (one.arr === "hints") {
      const short = (r.text || "").length > 14 ? r.text.slice(0, 13) + "…" : r.text;
      chips.push([`TEXT ✎ "${short}" (⏎)`, () => openTextEdit(one)]);
      chips.push([`${r.big ? "BIG" : "small"} (B)`, () => { pushUndo(); r.big = r.big ? 0 : 1; rebuild(); }]);
    }
    if (one.arr === "fragments") {
      const short = (r.text || "").length > 14 ? r.text.slice(0, 13) + "…" : r.text;
      chips.push([`LORE ✎ "${short}" (⏎)`, () => openTextEdit(one)]);
      chips.push([`SKIN: ${r.skin || "butterfly"} (K)`, () => {
        pushUndo(); r.skin = FRAG_SKINS[(FRAG_SKINS.indexOf(r.skin) + 1) % FRAG_SKINS.length]; rebuild();
      }]);
    }
    if (one.arr === "npcs") {
      const short = (r.text || "").length > 14 ? r.text.slice(0, 13) + "…" : r.text;
      chips.push([`DIALOGUE ✎ "${short}" (⏎)`, () => openTextEdit(one)]);
      chips.push([`KIND: ${r.kind || "miner"} (K)`, () => { pushUndo(); r.kind = r.kind === "harmonica" ? "miner" : "harmonica"; rebuild(); }]);
    }
    if (one.arr === "decor") {
      chips.push([`TYPE: ${r.type} (V)`, () => { pushUndo(); r.type = DECOR_TYPES[(DECOR_TYPES.indexOf(r.type) + 1) % DECOR_TYPES.length]; rebuild(); }]);
      chips.push([`${r.fg ? "FRONT" : "back"} (F)`, () => { pushUndo(); r.fg = r.fg ? 0 : 1; rebuild(); }]);
    }
    if (one.arr !== "spawn" && one.arr !== "goal") {
      chips.push([`LAYER: ${LAYER_NAME[effLayer(one.arr, r)]}`, () => {
        const cur = LAYERS.indexOf(effLayer(one.arr, r));
        assignLayer(LAYERS[(cur + 1) % LAYERS.length]);
      }, false, LAYER_ACCENT[effLayer(one.arr, r)]]);
      chips.push(["DUP ⌘D", duplicateSel]);
      chips.push(["DELETE (X)", deleteSel]);
    }
  }
  if (!chips.length) return;
  ctx.font = `bold 10px ${MONO}`;
  let cx2 = 150; // clear the layers panel on the left
  const cy = y0 - 30;
  for (const [label, fn, on, acc] of chips) {
    const w = ctx.measureText(label).width + 16;
    if (cx2 + w > C.VIEW_W - 8) break; // never overflow the row
    chip(ctx, cx2, cy, w, 22, label, !!on, fn, acc || "#8CF2FF");
    cx2 += w + 5;
  }
}

// ---- level settings, grouped with section dividers (Identity / Geometry /
// Scoring / Progression). Presentation only — the same prompt-driven edits.
function drawSettingsPanel(ctx) {
  const d = ed.data;
  const groups = [
    ["IDENTITY", [
      [`Name: ${d.name}`, () => { const v = window.prompt?.("level name:", d.name); if (v) { pushUndo(); d.name = v.toUpperCase(); } }],
      [`Tag: ${d.tag}`, () => { const v = window.prompt?.("tag:", d.tag); if (v) { pushUndo(); d.tag = v; } }],
      [`Tint: ${d.tint}`, () => { const v = window.prompt?.("tint (hex):", d.tint); if (v && /^#[0-9a-fA-F]{6}$/.test(v)) { pushUndo(); d.tint = v; } }],
    ]],
    ["GEOMETRY", [
      [`World W: ${d.world.w}px`, () => promptNum("world width (px, ≥1200):", d.world.w, 1200, (v) => (d.world.w = Math.round(v)))],
      [`World H: ${d.world.h}px`, () => promptNum("world height (px, ≥700):", d.world.h, 700, (v) => (d.world.h = Math.round(v)))],
    ]],
    ["SCORING", [
      [`S-rank: ${d.sRankTime ? d.sRankTime + "s" : (d.par * 0.75).toFixed(0) + "s (par)"}`, () => {
        const s = window.prompt?.("S-rank time (seconds; 0 derives from par):", String(d.sRankTime || Math.round(d.par * 0.75)));
        if (s == null || s === "") return;
        const v = Number(s);
        if (!isFinite(v) || v < 0) return toast("needs a number ≥ 0");
        pushUndo(); if (v > 0) d.sRankTime = v; else delete d.sRankTime; rebuild();
      }],
      [`Par: ${d.par}s`, () => promptNum("par time (s):", d.par, 1, (v) => (d.par = v))],
    ]],
    ["PROGRESSION", (() => {
      const rows = [[`World #: ${d.worldId || 1}`, () => promptNum("world number (1 = classic, 2+ = new):", d.worldId || 1, 1, (v) => (d.worldId = Math.round(v)))]];
      if (LEVELS.some((l) => l.id === d.id)) {
        const wl = LEVELS.filter((l) => (l.worldId || 1) === (d.worldId || 1));
        const cur = wl.findIndex((l) => l.id === d.id);
        if (cur >= 0) rows.push([`Slot: ${cur + 1}/${wl.length}`, () => {
          const s = window.prompt?.(`slot in world ${d.worldId || 1} (1–${wl.length}):`, String(cur + 1));
          if (s == null || s === "") return;
          const target = Math.round(Number(s));
          if (!(target >= 1 && target <= wl.length)) return toast("slot out of range");
          let now = cur, guard = 40;
          while (now !== target - 1 && guard-- > 0) { const dir = target - 1 > now ? 1 : -1; if (!moveLevelInWorld(d.id, dir)) break; now += dir; }
          ed.levelIndex = LEVELS.findIndex((l) => l.id === d.id);
          H?.refreshThumbs?.(); toast(`slot ${now + 1}/${wl.length}`);
        }]);
      }
      return rows;
    })()],
  ];
  const pw = 216, px = C.VIEW_W - pw - 8;
  let rowN = 0; for (const [, rows] of groups) rowN += rows.length;
  const ph = 40 + groups.length * 20 + rowN * 24;
  let py = 38;
  ctx.fillStyle = "rgba(9,6,15,0.96)";
  rr(ctx, px, py, pw, ph, 8); ctx.fill();
  ctx.strokeStyle = "rgba(201,154,255,0.4)";
  ctx.lineWidth = 1.5;
  rr(ctx, px, py, pw, ph, 8); ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = "#c99aff";
  ctx.font = `bold 11px ${MONO}`;
  ctx.fillText("LEVEL SETTINGS", px + pw / 2, py + 18);
  let ry = py + 30;
  for (const [title, rows] of groups) {
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(160,140,190,0.7)";
    ctx.font = `bold 9px ${MONO}`;
    ctx.fillText(title, px + 12, ry + 10);
    ctx.strokeStyle = "rgba(201,154,255,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + 12 + ctx.measureText(title).width + 8, ry + 7); ctx.lineTo(px + pw - 12, ry + 7); ctx.stroke();
    ry += 18;
    ctx.font = `bold 10px ${MONO}`;
    for (const [label, fn] of rows) {
      const lbl = label.length > 26 ? label.slice(0, 25) + "…" : label;
      chip(ctx, px + 10, ry, pw - 20, 20, lbl, false, fn, "#c99aff");
      ry += 24;
    }
    ry += 2;
  }
}

// ---- HELP overlay: the full shortcut reference, replacing the old always-on
// legend. Toggle with the HELP chip or '?'; any click / Esc dismisses it.
function drawHelpOverlay(ctx) {
  const W = C.VIEW_W, H = C.VIEW_H;
  ctx.fillStyle = "rgba(6,4,12,0.82)";
  ctx.fillRect(0, 0, W, H);
  const pw = 830, ph = 420, px = (W - pw) / 2, py = (H - ph) / 2;
  ctx.fillStyle = "rgba(12,8,20,0.98)";
  rr(ctx, px, py, pw, ph, 12); ctx.fill();
  ctx.strokeStyle = "rgba(140,242,255,0.5)";
  ctx.lineWidth = 2;
  rr(ctx, px, py, pw, ph, 12); ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = "#8CF2FF";
  ctx.font = `bold 20px ${MONO}`;
  ctx.fillText("EDITOR — SHORTCUTS", W / 2, py + 34);
  const cols = [
    ["BUILD", [
      "click palette — pick a tool",
      "click canvas — stamp it",
      "drag — move · corners — resize",
      "⇧click / drag box — multi-select",
      "R — rotate 90° · handle: free angle",
      "⌘C / ⌘V — copy / paste",
      "⌘D — duplicate · X — delete",
      "P — edit mover path",
    ]],
    ["OBJECT", [
      "⏎ — edit hint text (inline)",
      "B — hint big / small",
      "V — decor type · F — layer",
      "[ ] — decor scale",
      "D — spike deep-fill",
      "L — gate link · valve flip",
      "1/2/3 — layer (⇧ assign)",
    ]],
    ["VIEW / FILE", [
      "wheel / Z — zoom · drag bg — pan",
      "G — cycle snap · SNAP ▾ picker",
      "ANNOT — hide editor labels",
      "⌘Z — undo · ⇧⌘Z — redo",
      "T / PLAY — playtest · Esc — back",
      "S — save · ⇧S — save-as-new",
      "IMPORT / EXPORT — JSON files",
    ]],
  ];
  const colW = (pw - 60) / 3;
  for (let c = 0; c < cols.length; c++) {
    const cx = px + 30 + c * colW;
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffd166";
    ctx.font = `bold 12px ${MONO}`;
    ctx.fillText(cols[c][0], cx, py + 74);
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = "rgba(215,200,235,0.85)";
    let yy = py + 96;
    for (const line of cols[c][1]) { ctx.fillText(line, cx, yy); yy += 22; }
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(160,140,190,0.8)";
  ctx.font = `11px ${MONO}`;
  ctx.fillText("click anywhere or press ? / Esc to close", W / 2, py + ph - 18);
  // a dismiss button spanning the overlay
  ed.buttons.push({ x: 0, y: 0, w: W, h: H, fn: () => (ed.helpOpen = false) });
}


// silence unused-import warnings in some bundlers
void sfx;
