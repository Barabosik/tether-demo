import { CONFIG as C } from "./config.js";
import { fmtTime } from "./util.js";
import { WORLD_NAME } from "./worlds.js";
import { drawWanderer } from "./wanderer.js";
import { LEVELS } from "./levels.js";
import { isMuted } from "./audio.js";
import { sfx } from "./audio.js";
import { emit, onScreen } from "./uiBus.js";
import * as SET from "./settings.js";
import { padList, padChoice } from "./gamepad.js";
import {
  finalRank, effPar, speedGrade, cleanGrade, speedThresholds,
  CLEAN_THRESHOLDS, GRADE_COLOR, PALETTES, unlockedPalettes, saveReader,
  bsideUnlock,
} from "./rank.js";

/* DOM pause / results / LINE-results (Phase 2 of the Canvas→DOM UI
 * conversion). Same contract as selectScreen.js: game.js stays the input
 * entry point and delegates arrows/Enter/Space; activations leave as uiBus
 * "action" events into the unchanged uiAction reducer; the canvas keeps
 * rendering the (frozen) world behind — the scrim is the screen's own
 * background. Buttons carry data-action/data-arg for the audit harness.
 *
 * Focus is a plain vertical list per screen: pointer hover focuses
 * silently, pointerdown activates (parity with the old mousedown feel),
 * and a click with e.detail === 0 (programmatic el.click() — audits,
 * or keyboard activation of a native button) activates too. */

let state = null;

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }

// ---- shared primitives ------------------------------------------------------
function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function btn(cls, target, label) {
  const b = el("button", cls, label);
  b.type = "button";
  b.tabIndex = -1;
  b._target = target;
  b.dataset.action = target.action;
  if (target.arg != null) b.dataset.arg = String(target.arg);
  return b;
}

// a screen with a linear focus list. wire() is called once per show/refresh
// after the subtree is rebuilt; it collects the [data-action] buttons.
function makePanel(id) {
  const root = el("div", "screen screen-panel");
  root.id = id;
  root.style.display = "none";
  (document.getElementById("ui-root") || document.body).appendChild(root);

  const p = {
    root,
    buttons: [],
    focusIndex: 0,
    focusSource: "key",   // "key" | "pointer" — only pointer-set focus clears on hover-out
    hoverCleared: false,  // highlight dropped because the mouse wandered off
    visible: () => root.style.display !== "none",
    collect() {
      p.buttons = [...root.querySelectorAll("button[data-action]")];
      p.setFocus(Math.min(p.focusIndex, Math.max(0, p.buttons.length - 1)), true, p.focusSource);
      if (p.hoverCleared) p.buttons.forEach((b) => b.classList.remove("focused"));
    },
    setFocus(i, silent, source = "key") {
      if (!p.buttons.length) return;
      p.focusIndex = Math.max(0, Math.min(p.buttons.length - 1, i));
      p.focusSource = source;
      p.hoverCleared = false;
      p.buttons.forEach((b, j) => b.classList.toggle("focused", j === p.focusIndex));
      try { p.buttons[p.focusIndex].focus({ preventScroll: true }); } catch {}
      if (!silent) sfx.tick();
    },
    // the mouse left every interactive element: a hover-set highlight clears
    // (keyboard/gamepad-set focus is never cleared by an idling mouse)
    clearHover() {
      if (p.focusSource !== "pointer" || p.hoverCleared) return;
      p.hoverCleared = true;
      p.buttons.forEach((b) => b.classList.remove("focused"));
    },
    nav(d) {
      // first key after a hover-clear RE-SUMMONS the highlight in place
      if (p.hoverCleared) { p.setFocus(p.focusIndex, false, "key"); return; }
      p.setFocus(p.focusIndex + d, false, "key");
    },
    activateFocused() {
      if (p.hoverCleared) { p.setFocus(p.focusIndex, false, "key"); return; } // never fire an invisible selection
      const b = p.buttons[p.focusIndex];
      if (b) emit("action", b._target);
    },
    focusedTarget() { return p.hoverCleared ? null : (p.buttons[p.focusIndex]?._target ?? null); },
    show() { root.style.display = "flex"; },
    hide() { root.style.display = "none"; },
  };

  root.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button[data-action]");
    if (!b) return;
    e.preventDefault();
    const i = p.buttons.indexOf(b);
    if (i >= 0) p.setFocus(i, false, "pointer");
    emit("action", b._target);
  });
  // programmatic activation (audit el.click(), native keyboard click):
  // e.detail === 0 means no pointer was involved — real mouse clicks were
  // already handled by pointerdown above
  root.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    const b = e.target.closest("button[data-action]");
    if (b) emit("action", b._target);
  });
  root.addEventListener("pointermove", (e) => {
    const b = e.target.closest("button[data-action]");
    if (!b) { p.clearHover(); return; } // off every interactive element
    const i = p.buttons.indexOf(b);
    if (i < 0) return;
    if (i !== p.focusIndex || p.hoverCleared) p.setFocus(i, true, "pointer");
    else p.focusSource = "pointer"; // hovering the current item claims it for the mouse
  });
  root.addEventListener("pointerleave", () => p.clearHover());

  return p;
}

// ---- PAUSED -----------------------------------------------------------------
let pause = null;
function buildPause() {
  const r = pause.root;
  r.replaceChildren();
  r.appendChild(el("div", "pan-title", "PAUSED"));
  const list = el("div", "pan-list");
  list.append(
    btn("pan-btn", { action: "resume" }, "RESUME"),
    btn("pan-btn", { action: "restart" }, "RESTART LEVEL"),
    btn("pan-btn", { action: "select" }, "LEVEL SELECT"),
    btn("pan-btn", { action: "settings" }, "SETTINGS"),
    btn("pan-btn", { action: "fs" },
      document.fullscreenElement ? "FULLSCREEN: ON" : "FULLSCREEN: OFF"),
    btn("pan-btn", { action: "mute" },
      isMuted() ? "SOUND: OFF (M)" : "SOUND: ON (M)"),
  );
  r.appendChild(list);
  r.appendChild(el("div", "pan-hint", "ESC/⌫ resumes"));
  pause.collect();
}

// ---- RESULTS (single level) -------------------------------------------------
let results = null;
function buildResults() {
  const st = state;
  const r = results.root;
  r.replaceChildren();

  if (st.practiceRun)
    r.appendChild(el("div", "res-practice",
      "PRACTICE RUN — nothing saved · replay for a real attempt"));
  r.appendChild(el("div", "res-title", st.altExit ? "SECRET CLEAR" : "LEVEL CLEAR"));
  r.appendChild(el("div", "res-time", fmtTime(st.runTime)));
  if (st.newBest) r.appendChild(el("div", "res-newbest", "★ NEW BEST ★"));
  else if (st.bests[st.levelIndex])
    r.appendChild(el("div", "res-prevbest", `best ${fmtTime(st.bests[st.levelIndex])}`));
  const chain = st.style.best >= 2 ? ` · best chain ×${st.style.best}` : "";
  const coins = st.coins.length ? ` · ◆ ${st.coinCount}/${st.coins.length}` : "";
  r.appendChild(el("div", "res-stats", `falls ${st.deaths} · kills ${st.kills}${chain}${coins}`));
  if (st.altExit) r.appendChild(el("div", "res-alt", "— SECRET EXIT ROUTE —"));

  // rank panel: both axes with their published thresholds + the seal
  const par = effPar(LEVELS[st.levelIndex]);
  const sg = speedGrade(st.runTime, par), cg = cleanGrade(st.hits);
  const rank = st.rank || finalRank(st.runTime, par, st.hits);
  const rankRow = el("div", "res-rankrow");
  const axis = (title, grade, lines, note) => {
    const a = el("div", "res-axis");
    a.appendChild(el("div", "res-axis-title", title));
    const g = el("div", "res-axis-grade", grade);
    g.style.color = GRADE_COLOR[grade];
    a.appendChild(g);
    for (const line of lines) {
      const ln = el("div", "res-axis-line", line);
      if (line[0] === grade) { ln.classList.add("on"); ln.style.color = GRADE_COLOR[grade]; }
      a.appendChild(ln);
    }
    a.appendChild(el("div", "res-axis-note", note));
    return a;
  };
  rankRow.appendChild(axis("SPEED", sg, speedThresholds(par), `your time ${fmtTime(st.runTime)}`));
  const seal = el("div", "res-seal");
  const sealG = el("div", "res-seal-grade", rank);
  sealG.style.color = GRADE_COLOR[rank];
  sealG.style.setProperty("--seal-glow", GRADE_COLOR[rank]);
  seal.append(sealG, el("div", "res-seal-note", "worse axis wins"));
  rankRow.appendChild(seal);
  rankRow.appendChild(axis("CLEAN", cg, CLEAN_THRESHOLDS, `${st.hits} hit${st.hits === 1 ? "" : "s"} taken`));
  r.appendChild(rankRow);

  // splits table (levels with split gates): segment · cum · Δ vs PB · gold
  if (st.finalSegs && st.finalSegs.cums.length > 1) {
    const F = st.finalSegs;
    const tbl = el("div", "res-splits");
    tbl.appendChild(el("div", "res-splits-title", "SPLITS  vs PB"));
    const rows = Math.min(F.cums.length, 9);
    for (let i = 0; i < rows; i++) {
      const row = el("div", "res-split");
      row.appendChild(el("span", "rs-name", i === F.cums.length - 1 ? "FIN" : `S${i + 1}`));
      row.appendChild(el("span", "rs-cum", fmtTime(F.cums[i])));
      if (F.pb?.[i] != null) {
        const d = F.cums[i] - F.pb[i];
        row.appendChild(el("span", d < 0 ? "rs-delta ahead" : "rs-delta behind",
          `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}`));
      } else row.appendChild(el("span", "rs-delta none", "—"));
      if (F.golds?.[i] != null && F.segs[i] < F.golds[i])
        row.appendChild(el("span", "rs-gold", "★"));
      tbl.appendChild(row);
    }
    r.appendChild(tbl);
  }

  // buttons: NEXT (same world only) · REPLAY · SELECT
  const wid = LEVELS[st.levelIndex]?.worldId || 1;
  let next = -1;
  for (let j = st.levelIndex + 1; j < LEVELS.length; j++)
    if (!LEVELS[j].bside && (LEVELS[j].worldId || 1) === wid) { next = j; break; }
  const list = el("div", "pan-list res-list");
  if (next >= 0) list.appendChild(btn("pan-btn res-btn", { action: "next", arg: next }, "NEXT →"));
  list.appendChild(btn("pan-btn res-btn", { action: "restart" }, "REPLAY"));
  list.appendChild(btn("pan-btn res-btn", { action: "select" }, "SELECT"));
  r.appendChild(list);
  results.collect();
}

// ---- THE LINE results -------------------------------------------------------
let lineres = null;
function buildLineResults() {
  const st = state;
  const d = st.lineDone;
  const r = lineres.root;
  r.replaceChildren();
  if (!d) return;

  r.appendChild(el("div", "lr-title", "THE LINE — COMPLETE"));
  r.appendChild(el("div", "lr-sub",
    `${WORLD_NAME[d.world] || `WORLD ${d.world}`} · ${d.splits.length} levels · one clock`));
  const clock = el("div", d.newBest ? "lr-clock best" : "lr-clock", fmtTime(d.total));
  r.appendChild(clock);
  if (d.newBest) r.appendChild(el("div", "lr-newbest", "★ NEW BEST LINE"));
  r.appendChild(el("div", "lr-deaths", `${d.deaths} fall${d.deaths === 1 ? "" : "s"} along the way`));

  const tbl = el("div", "lr-splits");
  let cum = 0;
  d.splits.forEach((s, i) => {
    cum += s.t;
    const row = el("div", "lr-split");
    row.appendChild(el("span", "lr-name", `${i + 1}· ${s.name}`));
    row.appendChild(el("span", s.deaths ? "lr-dead" : "lr-clean", s.deaths ? `${s.deaths}×✝` : "clean"));
    row.appendChild(el("span", "lr-t", fmtTime(s.t)));
    row.appendChild(el("span", "lr-cum", fmtTime(cum)));
    tbl.appendChild(row);
  });
  r.appendChild(tbl);

  const list = el("div", "pan-list lr-list");
  list.append(
    btn("pan-btn lr-btn", { action: "line", arg: d.world }, "RUN IT AGAIN"),
    btn("pan-btn lr-btn", { action: "select" }, "LEVEL SELECT"),
  );
  r.appendChild(list);
  lineres.collect();
}

// ---- SKINS ------------------------------------------------------------------
// cosmetic palette rows: unlocked rows equip (action "skin"), locked rows are
// inert and show their condition + LIVE progress numbers
let skins = null;

// the swatch IS the player: the same drawWanderer() the game renders every
// frame, posed dash-ready at rest — one draw function, so the swatch and the
// in-game look can never drift apart again
function skinSwatch(p, open) {
  const cv = document.createElement("canvas");
  cv.width = 44; cv.height = 44; // 22×32 wanderer + room for the glow/halo
  cv.className = "sk-swatch-cv";
  const g = cv.getContext("2d");
  // a soft accent backdrop — the dark cloak reads on the dark panel, and each
  // skin shows a hint of its own color even before you equip it
  if (open) {
    const acc = p.ready || p.body;
    const bg = g.createRadialGradient(22, 21, 1, 22, 21, 22);
    bg.addColorStop(0, acc + "3a"); // ~0.23 alpha (8-digit hex)
    bg.addColorStop(1, acc + "00");
    g.fillStyle = bg;
    g.beginPath(); g.arc(22, 21, 22, 0, Math.PI * 2); g.fill();
  }
  g.save();
  if (!open) g.globalAlpha = 0.3;
  g.translate(22, 25);
  drawWanderer(g, {
    w: 22, h: 32, facing: 1,
    aimX: 40, aimY: -8, // gazes gently forward-up
    vx: 0, vy: 0,
    accent: p.ready || p.body, dashColor: p.dash, special: p.special,
    crystal: open ? "ready" : "charging",
    t: 0.8, // a fixed waft pose — the swatch doesn't animate
  });
  g.restore();
  return cv;
}
function buildSkins() {
  const st = state;
  const r = skins.root;
  r.replaceChildren();
  const get = saveReader(LEVELS);
  const un = unlockedPalettes(get);

  r.appendChild(el("div", "pan-title sk-title", "SKINS"));
  r.appendChild(el("div", "sk-sub", "cosmetic player tints — unlocked by playing"));

  // live progress for the two counting conditions (B-sides excluded)
  const ids = get("ids") || [], worlds = get("worlds") || [], bs = get("bsides") || [];
  let coinTotal = 0, w1S = 0, w1N = 0, dwN = 0, dwC = 0;
  for (let i = 0; i < ids.length; i++) {
    if (bs[i]) continue;
    coinTotal += get("coins." + ids[i]) || 0;
    if ((worlds[i] || 1) === 1) { w1N++; if (get("rank." + ids[i]) === "S") w1S++; }
    if ((worlds[i] || 1) === 3) { dwN++; if (get("best." + ids[i])) dwC++; }
  }
  const progress = { coin50: `${Math.min(coinTotal, 50)}/50 coins`,
    sworld1: `${w1S}/${w1N} S-ranks`, death: `${dwC}/${dwN} cleared` };

  const grid = el("div", PALETTES.length > 7 ? "sk-grid two" : "sk-grid");
  PALETTES.forEach((p, i) => {
    const open = un.has(p.id);
    const row = open
      ? btn("sk-row", { action: "skin", arg: i })
      : el("div", "sk-row locked");
    const sw = skinSwatch(p, open);
    if (open) row.dataset.gi = String(i); // grid index — drives 2D arrow nav
    const text = el("span", "sk-text");
    text.appendChild(el("span", "sk-name", p.name));
    text.appendChild(el("span", open ? "sk-need open" : "sk-need",
      open ? (p.need ? `unlocked — ${p.need}` : "always unlocked")
        : `🔒 ${p.need}${progress[p.id] ? `   (${progress[p.id]})` : ""}`));
    row.append(sw, text);
    if (st.paletteIndex === i) row.appendChild(el("span", "sk-equipped", "EQUIPPED ✓"));
    grid.appendChild(row);
  });
  r.appendChild(grid);

  const back = btn("pan-btn pan-back", { action: "select" }, "BACK (Esc/⌫)");
  const backWrap = el("div", "pan-list sk-back");
  backWrap.appendChild(back);
  r.appendChild(backWrap);
  skins.collect();
}

// ---- SECRETS ----------------------------------------------------------------
// gated B-sides: condition + live progress always visible; only unlocked rows
// are playable (action "secretplay")
let secrets = null;
function buildSecrets() {
  const r = secrets.root;
  r.replaceChildren();
  const get = saveReader(LEVELS);
  const bsides = LEVELS.map((l, i) => [l, i]).filter(([l]) => l.bside);

  r.appendChild(el("div", "pan-title sc-title", "SECRETS"));
  r.appendChild(el("div", "sk-sub", "hidden B-sides — earn the condition to unlock the level"));

  const list = el("div", "sc-list");
  if (!bsides.length) list.appendChild(el("div", "sc-empty", "no B-sides in this build"));
  for (const [l, idx] of bsides) {
    const u = bsideUnlock(l, get);
    const row = u.open
      ? btn("sc-row", { action: "secretplay", arg: idx })
      : el("div", "sc-row locked");
    const glyph = el("span", u.open ? "sc-diamond" : "sc-diamond locked");
    glyph.style.setProperty("--tint", l.tint || "#ff4fa0");
    const text = el("span", "sc-text");
    text.appendChild(el("span", "sc-name", u.open ? l.name : "? ? ?"));
    text.appendChild(el("span", u.open ? "sc-cond open" : "sc-cond",
      u.open ? `UNLOCKED — ${l.tag}` : `🔒 ${u.label}`));
    const right = el("span", "sc-right");
    right.appendChild(el("span", "sc-progress", u.progress));
    if (u.open) {
      const best = Number(lsGet("tether.best." + l.id)) || 0;
      right.appendChild(el("span", "sc-play", best ? `★ ${fmtTime(best)}  PLAY` : "PLAY"));
    }
    row.append(glyph, text, right);
    list.appendChild(row);
  }
  r.appendChild(list);

  const backWrap = el("div", "pan-list sc-back");
  backWrap.appendChild(btn("pan-btn pan-back", { action: "select" }, "BACK (Esc/⌫)"));
  r.appendChild(backWrap);
  secrets.collect();
}

// ---- SETTINGS ---------------------------------------------------------------
// two visual columns, ONE flat focus order (sliders → autofs → reset →
// pads → rebinds → keyreset → back — the canvas nav order). game.js routes
// ←/→ on slider/toggle rows to adjust-in-place; the rebind CAPTURE state
// lives in st.rebind/st.rebindMsg and the keydown capture block, unchanged.
let settingsP = null;
function buildSettings() {
  const st = state;
  const r = settingsP.root;
  r.replaceChildren();

  r.appendChild(el("div", "pan-title set-title", "SETTINGS"));
  r.appendChild(el("div", "sk-sub",
    "everything saves instantly — sliders: ←/→ or click · keys: ENTER, then press the new key"));

  // ---------------- left column
  const left = el("div", "set-col set-left");
  left.appendChild(el("div", "set-head", "AUDIO & FEEL"));
  for (const [key, label] of SET.SLIDERS) {
    const v = SET.SETTINGS[key];
    const row = btn("set-row set-slider", { action: "slider", arg: key });
    row.appendChild(el("span", "set-label", label));
    const bar = el("span", "set-bar");
    const fill = el("i", "set-fill");
    fill.style.width = v > 0 ? Math.max(4, Math.round(v * 100)) + "%" : "0";
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el("span", "set-val", `${Math.round(v * 100)}%`));
    left.appendChild(row);
  }
  { // launch-fullscreen toggle (applies on the session's FIRST input)
    const on = SET.SETTINGS.autofs >= 0.5;
    const row = btn("set-row set-toggle", { action: "toggle", arg: "autofs" });
    row.appendChild(el("span", "set-label", "LAUNCH FULLSCREEN"));
    row.appendChild(el("span", on ? "set-state on" : "set-state off",
      on ? "ON — first input" : "OFF"));
    left.appendChild(row);
  }
  left.appendChild(btn("set-row set-reset", { action: "setreset" }, "RESET AUDIO & FEEL"));

  { // gamepad: every detected device; headphones/remotes enumerate too —
    // auto-pick skips them, this shows why
    const devs = padList();
    left.appendChild(el("div", "set-head set-padhead",
      `GAMEPAD${devs.length ? ` (${devs.length} device${devs.length > 1 ? "s" : ""})` : ""}`));
    if (!devs.length)
      left.appendChild(el("div", "set-padnote",
        "none detected — PRESS ANY BUTTON on the controller to wake it"));
    for (const d of devs.slice(0, 3)) {
      if (d.usable) {
        const row = btn("set-row set-pad" + (d.active ? " active" : ""), { action: "padpick", arg: d.id });
        row.appendChild(el("span", "set-padname",
          `${d.active ? "▶ USING " : ""}${d.id.slice(0, d.active ? 30 : 38)}`));
        row.appendChild(el("span", "set-padinfo", `${d.buttons}btn/${d.axes}ax${d.chosen ? " ★" : ""}`));
        left.appendChild(row);
      } else {
        const row = el("div", "set-pad dead");
        row.appendChild(el("span", "set-padname", `✕ ${d.id.slice(0, 30)}`));
        row.appendChild(el("span", "set-padinfo", `${d.buttons}btn/${d.axes}ax — not a controller`));
        left.appendChild(row);
      }
    }
    if (padChoice()) {
      const auto = btn("set-row set-autopick", { action: "padpick", arg: null }, "back to AUTO pick");
      left.appendChild(auto);
    }
    left.appendChild(el("div", "set-padhint",
      "Ⓐ/LB jump · Ⓑ/LT dash · Ⓧ/RB attack · Ⓨ/RT grapple · R-stick aim"));
    left.appendChild(el("div", "set-padhint",
      "shoulders = thumbs stay on sticks · START pause · BACK restart"));
  }
  r.appendChild(left);

  // ---------------- right column: key bindings
  const right = el("div", "set-col set-right");
  const head = el("div", "set-head");
  head.append(el("span", null, "CONTROLS"),
    el("span", "set-headnote", "mouse stays: LMB attack · RMB grapple"));
  right.appendChild(head);
  for (const [action, label] of SET.REBINDABLE) {
    const waiting = st.rebind === action;
    const row = btn("set-row set-key" + (waiting ? " waiting" : ""), { action: "rebind", arg: action });
    row.appendChild(el("span", "set-label", label));
    row.appendChild(el("span", waiting ? "set-bind waiting" : "set-bind",
      waiting ? "PRESS A KEY… (ESC cancels)" : SET.bindingLabel(action)));
    right.appendChild(row);
  }
  right.appendChild(btn("set-row set-reset", { action: "keyreset" }, "RESET ALL KEYS"));
  if (st.rebindMsg) right.appendChild(el("div", "set-rebindmsg", st.rebindMsg));
  r.appendChild(right);

  const backWrap = el("div", "pan-list set-back");
  backWrap.appendChild(btn("pan-btn pan-back", { action: "setback" }, "BACK (Esc/⌫)"));
  r.appendChild(backWrap);
  settingsP.collect();
}

// update ONE slider row in place (fill + % readout) — slider changes must
// NOT rebuild the panel: a rebuild detaches the bar mid-drag (its rect reads
// as zeros → every move computed fraction 1 → the "snaps to 100%" bug)
function updateSliderRow(key) {
  if (!settingsP) return;
  const row = settingsP.root.querySelector(`button[data-action="slider"][data-arg="${key}"]`);
  if (!row) return;
  const v = SET.SETTINGS[key];
  const fill = row.querySelector(".set-fill");
  if (fill) fill.style.width = v > 0 ? Math.max(4, Math.round(v * 100)) + "%" : "0";
  const val = row.querySelector(".set-val");
  if (val) val.textContent = `${Math.round(v * 100)}%`;
}

// pointer-set on a slider bar: clicking/dragging inside the bar sets the
// value by fraction (replaces the canvas half-click ±5%). Snaps to 5%.
function wireSliderPointer(root) {
  // CAPTURE phase + stopPropagation: a hit on the bar must not ALSO trigger
  // the generic button activation (which Enter-cycles the slider +5%)
  root.addEventListener("pointerdown", (e) => {
    const bar = e.target.closest(".set-bar");
    if (!bar) return;
    const row = bar.closest("button[data-action=\"slider\"]");
    if (!row) return;
    e.stopPropagation();
    e.preventDefault();
    // the rect is captured ONCE: plain numbers survive any DOM churn, and
    // the bar's on-screen position is static for the drag's whole life
    const rect = bar.getBoundingClientRect();
    const key = row.dataset.arg;
    const set = (ev) => {
      const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      emit("action", { action: "sliderset", arg: { key, value: Math.round(f * 20) / 20 } });
    };
    // pointer capture pins events AND the cursor (ew-resize) to the live bar
    // for the whole drag — wander off the bar and nothing changes
    try { bar.setPointerCapture(e.pointerId); } catch {}
    set(e);
    const move = (ev) => set(ev);
    const up = (ev) => {
      try { bar.releasePointerCapture(ev.pointerId); } catch {}
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  }, true); // capture — beat the generic activation listener on the same root
}

// ---- controller (game.js delegates here on paused/results) ------------------
function activePanel() {
  const st = state;
  if (st.screen === "paused") return pause;
  if (st.screen === "results") return st.lineDone ? lineres : results;
  if (st.screen === "skins") return skins;
  if (st.screen === "secrets") return secrets;
  if (st.screen === "settings") return settingsP;
  return null;
}

// SKINS is a 2-column GRID (above 7 palettes): Up/Down move within the
// COLUMN (skipping locked rows; clamping into a partial bottom row like the
// select grid), Left/Right cross columns within the row, the bottom exits to
// BACK. Locked rows are inert, so movement scans for the next unlocked one.
function skinsNavGrid(dx, dy) {
  const p = skins;
  if (!p.buttons.length) return;
  if (p.hoverCleared) { p.setFocus(p.focusIndex, false, "key"); return; }
  const cols = PALETTES.length > 7 ? 2 : 1;
  if (cols === 1) { p.nav(dy || dx); return; } // single column = linear
  const byGi = (gi) => p.buttons.findIndex((b) => b.dataset.gi === String(gi));
  const backIdx = p.buttons.findIndex((b) => b.dataset.gi == null); // BACK row
  const cur = p.buttons[p.focusIndex];
  if (cur.dataset.gi == null) { // on BACK: Up returns to the LAST skin row
    if (dy < 0) {
      for (let gi = PALETTES.length - 1; gi >= 0; gi--)
        if (byGi(gi) >= 0) { p.setFocus(byGi(gi)); return; }
    }
    return;
  }
  const gi = Number(cur.dataset.gi);
  if (dx) { // cross the row: col 0 ↔ 1 (stay if the neighbor is locked)
    const target = gi + dx;
    if ((target >> 1) === (gi >> 1) && byGi(target) >= 0) p.setFocus(byGi(target));
    return;
  }
  if (dy > 0) { // down the column, skipping locked; clamp into a partial tail
    for (let g = gi + cols; g < PALETTES.length; g += cols)
      if (byGi(g) >= 0) { p.setFocus(byGi(g)); return; }
    let lastGi = -1; // any unlocked row BELOW (the other column's tail)?
    for (const b of p.buttons) if (b.dataset.gi != null) lastGi = Math.max(lastGi, Number(b.dataset.gi));
    if (lastGi >= 0 && (lastGi >> 1) > (gi >> 1)) { p.setFocus(byGi(lastGi)); return; }
    if (backIdx >= 0) p.setFocus(backIdx); // bottom row exits to BACK
    return;
  }
  if (dy < 0) { // up the column, skipping locked
    for (let g = gi - cols; g >= 0; g -= cols)
      if (byGi(g) >= 0) { p.setFocus(byGi(g)); return; }
  }
}

export const panelsUI = {
  nav(d) { activePanel()?.nav(d); },
  navGrid(dx, dy) { // skins-only 2D nav; other panels stay linear
    if (activePanel() === skins) skinsNavGrid(dx, dy);
    else activePanel()?.nav(dy || dx);
  },
  activateFocused() { activePanel()?.activateFocused(); },
  focusedTarget() { return activePanel()?.focusedTarget() ?? null; },
  refresh() { // live labels (fs/mute), equip marker, or payload changed
    const st = state;
    if (st.screen === "paused") buildPause();
    else if (st.screen === "results") st.lineDone ? buildLineResults() : buildResults();
    else if (st.screen === "skins") buildSkins();
    else if (st.screen === "secrets") buildSecrets();
    else if (st.screen === "settings") buildSettings();
  },
  updateSlider(key) { updateSliderRow(key); }, // in-place — never a rebuild
};

export function initPanelScreens(deps) {
  if (pause) return panelsUI;
  state = deps.state;
  pause = makePanel("screen-paused");
  results = makePanel("screen-results");
  lineres = makePanel("screen-lineresults");
  skins = makePanel("screen-skins");
  secrets = makePanel("screen-secrets");
  settingsP = makePanel("screen-settings");
  wireSliderPointer(settingsP.root);

  onScreen((screen) => {
    pause.hide(); results.hide(); lineres.hide(); skins.hide(); secrets.hide();
    settingsP.hide();
    if (screen === "paused") { pause.focusIndex = 0; buildPause(); pause.show(); }
    else if (screen === "results") {
      if (state.lineDone) { lineres.focusIndex = 0; buildLineResults(); lineres.show(); }
      else { results.focusIndex = 0; buildResults(); results.show(); }
    }
    else if (screen === "skins") { skins.focusIndex = 0; buildSkins(); skins.show(); }
    else if (screen === "secrets") { secrets.focusIndex = 0; buildSecrets(); secrets.show(); }
    else if (screen === "settings") { settingsP.focusIndex = 0; buildSettings(); settingsP.show(); }
  });
  // the settings GAMEPAD list is live: devices wake/sleep while the screen is up
  window.addEventListener("gamepadconnected", () => { if (settingsP.visible()) panelsUI.refresh(); });
  window.addEventListener("gamepaddisconnected", () => { if (settingsP.visible()) panelsUI.refresh(); });
  // the pause FULLSCREEN label tracks reality (F key, hold-Esc exit, chip)
  document.addEventListener("fullscreenchange", () => {
    if (pause.visible()) { const i = pause.focusIndex; buildPause(); pause.setFocus(i, true); }
  });

  if (typeof window !== "undefined") window.__panels = panelsUI; // audit handle
  return panelsUI;
}
