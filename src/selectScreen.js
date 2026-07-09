import { fmtTime } from "./util.js";
import { WORLD_NAME } from "./worlds.js";
import { LEVELS, isDeletable } from "./levels.js";
import { makeThumbs } from "./ui.js";
import { GRADE_COLOR, PALETTES, unlockedPalettes, saveReader, bsideUnlock } from "./rank.js";
import { emit, on as busOn } from "./uiBus.js";
import { sfx } from "./audio.js";

/* DOM level-select (Phase 1 of the Canvas→DOM UI conversion). Owns the
 * #screen-select subtree of #ui-root: header (title + world nav + LINE),
 * the card grid, the footer, hint lines, and the delete-confirm modal.
 *
 * Interop is the plan's contract, not a rewrite of game logic:
 *   - game.js is the single keyboard entry point (gamepad sends synthetic
 *     window key events; audits press real keys) and DELEGATES to this
 *     controller: nav(dx,dy) / activateFocused() / focusedTarget(). We never
 *     add a competing window listener.
 *   - activations leave here as uiBus "action" events {action,arg}, matching
 *     the canvas UI's button shape, so game.js's uiAction reducer runs them
 *     unchanged (load/world/bflip/line/skins/secrets/settings/…).
 *   - st.confirm stays the delete-confirm state; we render it as DOM and
 *     game.js's existing DEL/Esc/delyes plumbing drives it.
 *
 * Selection lives as a `focusIndex` into an ordered focusables list, shown by
 * a `.focused` class (the canvas glow's replacement) + real DOM focus. Nav is
 * a vertical chain: header row ↔ card grid ↔ footer row, arrows within each
 * band. The corner chips (✕ delete, B▸ flip) are mouse-clickable and reached
 * by keyboard through the DEL / B hotkeys — never the arrow sequence (the
 * old hitbox-dance bug lived in arrowing onto chips). */


let state = null;      // live game state (st) — read-only here
let worldLevelsFn = null;
let worldIdsFn = null;

let rootEl = null;     // #screen-select
let headerEl, gridEl, footerEl, hintsEl, confirmEl, subtitleEl;

// ordered focusable descriptors for arrow nav: { el, band, target }
// band: "header" | "card" | "footer" — arrows move within a band, up/down
// bridge bands. target = the {action,arg} emitted on activate.
let focusables = [];
let focusIndex = 0;
let focusSource = "key";    // "key" | "pointer" — only pointer-set focus clears on hover-out
let hoverCleared = false;   // highlight dropped because the mouse wandered off
let focusedLevelId = null;  // id of the focused card's level — survives rebuilds
let confirmWasOpen = false;
let preConfirmFocus = null; // {index, levelId} stashed while the confirm is up

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }

// ---- element helpers -------------------------------------------------------
function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function btn(cls, target, aria) {
  const b = el("button", cls);
  b.type = "button";
  b.tabIndex = -1; // roving focus is managed, not tabbed
  b._target = target; // {action,arg}
  b.dataset.actionable = "1"; // the delegated pointerdown activates these
  if (aria) b.setAttribute("aria-label", aria);
  return b;
}

export function initSelectScreen(deps) {
  if (rootEl) return controller;
  state = deps.state;
  worldLevelsFn = deps.worldLevels;
  worldIdsFn = deps.worldIds;

  rootEl = el("div", "screen screen-select");
  rootEl.id = "screen-select";

  const title = el("div", "sel-title", "TETHER");
  subtitleEl = el("div", "sel-subtitle");
  headerEl = el("div", "sel-worldnav");
  const head = el("div", "sel-head");
  head.append(title, subtitleEl, headerEl);

  gridEl = el("div", "sel-grid");
  footerEl = el("div", "sel-footer");
  hintsEl = el("div", "sel-hints");
  confirmEl = el("div", "sel-confirm");
  confirmEl.style.display = "none";

  rootEl.append(head, gridEl, footerEl, hintsEl, confirmEl);
  (document.getElementById("ui-root") || document.body).appendChild(rootEl);

  // pointerdown activation (locked decision: match the canvas mousedown
  // snappiness — DOM click fires on release). The scrim swallows pointer
  // when confirm is open, so background cards can't be reached.
  rootEl.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button[data-actionable]");
    if (!b || !rootEl.contains(b)) return;
    e.preventDefault(); // no native focus flash / text-select
    const fi = focusables.findIndex((f) => f.el === b);
    if (fi >= 0) setFocus(fi, false, "pointer");
    activate(b._target);
  });
  // hover-select: silent (the canvas didn't sfx on hover), focus-only.
  // Both pointer listeners live on the SCREEN element (not window), so an
  // open z60 modal's scrim contains them natively — no extra gating needed
  // for the mouse; the keyboard gate lives in game.js.
  rootEl.addEventListener("pointermove", (e) => {
    const b = e.target.closest("button[data-actionable]");
    if (!b) { clearHover(); return; } // off every interactive element
    const fi = focusables.findIndex((f) => f.el === b);
    // a corner chip (✕ / B▸) is interactive but not arrow-focusable: hovering
    // it keeps the card's highlight (you're still "on" the card)
    if (fi < 0) return;
    if (fi !== focusIndex || hoverCleared) setFocus(fi, true, "pointer");
    else focusSource = "pointer"; // hovering the current item claims it for the mouse
  });
  rootEl.addEventListener("pointerleave", () => clearHover());

  // modal-containment (the Phase-0 contract): while a z60 modal is open the
  // screen underneath goes visually dormant — the focused card drops its
  // glow, and gets it back when the modal closes
  busOn("modal", (open) => {
    const f = focusables[focusIndex];
    if (f && !hoverCleared) f.el.classList.toggle("focused", !open);
  });

  hide();
  // audit/debug handle (house pattern, like __tether): the harness reads the
  // focused target + drives refresh instead of the old __tether.ui.buttons
  if (typeof window !== "undefined") window.__select = controller;
  return controller;
}

// ---- build / refresh -------------------------------------------------------
function refresh() {
  if (!rootEl) return;
  const st = state;
  const worldSel = st.worldSel || 1;
  const worlds = worldIdsFn();
  const wl = worldLevelsFn();           // LEVELS indices in this world
  const n = wl.length;

  const wname = WORLD_NAME[worldSel]; // named worlds wear their name up top
  // compact "W1 ·" prefix — long names (THE SUNKEN SHALLOWS) must clear the
  // world-nav chips; .long steps the font down as the second stage
  subtitleEl.textContent = wname
    ? `— W${worldSel} · ${wname} —`
    : `— WORLD ${worldSel} —`;
  subtitleEl.classList.toggle("long", subtitleEl.textContent.length > 22);

  buildWorldNav(worlds, worldSel, n);
  buildGrid(wl, n);
  buildFooter();
  buildHints();
  buildConfirm();

  // recompute the focusable list; preserve focus by LEVEL ID first (so
  // selection follows a reordered card and survives flips), index second.
  // A hover-cleared highlight stays cleared across rebuilds.
  const keepSrc = focusSource, keepCleared = hoverCleared;
  const opening = st.confirm != null && !confirmWasOpen;
  const closing = st.confirm == null && confirmWasOpen;
  confirmWasOpen = st.confirm != null;
  if (opening) preConfirmFocus = { index: focusIndex, levelId: focusedLevelId };
  collectFocusables();
  if (st.confirm != null) {
    // KEEP preselected (parity with the canvas confirm); focus it on open
    const keep = focusables.findIndex((f) => f.target?.action === "delno");
    setFocus(Math.max(0, keep), true);
  } else {
    const want = closing && preConfirmFocus ? preConfirmFocus
      : { index: focusIndex, levelId: focusedLevelId };
    if (closing) preConfirmFocus = null;
    const byId = want.levelId == null ? -1 : focusables.findIndex((f) =>
      f.band === "card" && f.target?.action === "load" && LEVELS[f.target.arg]?.id === want.levelId);
    setFocus(byId >= 0 ? byId : Math.min(want.index, Math.max(0, focusables.length - 1)), true, keepSrc);
    if (keepCleared && keepSrc === "pointer") {
      hoverCleared = true;
      for (const f of focusables) f.el.classList.remove("focused");
    }
  }
}

function buildWorldNav(worlds, worldSel, n) {
  headerEl.replaceChildren();
  // chips FLANK the centered subtitle at the canvas row (y64): offsets from
  // the artboard center are the exact drawSelect numbers
  const multi = worlds.length > 1 || worldSel !== worlds[0];
  const place = (b, dx, w) => {
    b.style.left = `calc(50% + ${dx}px)`;
    b.style.width = w + "px";
    headerEl.appendChild(b);
  };
  const prev = btn("sel-chip sel-arrow", { action: "world", arg: -1 }, "previous world");
  prev.textContent = "‹";
  place(prev, multi ? -160 : -138, 44);

  if (multi) {
    const next = btn("sel-chip sel-arrow", { action: "world", arg: 1 }, "next world");
    next.textContent = "›";
    place(next, 116, 44);
  }
  const add = btn("sel-chip sel-worldnew", { action: "worldnew" }, "new world");
  add.textContent = "+";
  place(add, 170, 30);

  if (n >= 2) { // THE LINE — the whole-world marathon
    const line = btn("sel-chip sel-line", { action: "line", arg: worldSel }, "run THE LINE");
    const lb = (() => { try { return JSON.parse(lsGet("tether.line." + worldSel) || "null"); } catch { return null; } })();
    line.textContent = "LINE";
    line.title = `all ${n} levels, one clock${lb ? ` · best ${fmtTime(lb.total)}` : ""}`;
    place(line, 214, 62);
  }
}

function buildGrid(wl, n) {
  gridEl.replaceChildren();
  if (n === 0) {
    const empty = el("div", "sel-empty", "this world is empty — press N to create its first level");
    gridEl.appendChild(empty);
    gridEl.style.setProperty("--cw", "196px");
    gridEl.style.maxWidth = "";
    return;
  }
  const st = state;
  const getP = saveReader(LEVELS);
  const thumbs = makeThumbs(LEVELS);

  // card scale k: 1–2 rows sit at native size; 3+ rows shrink to stay above
  // the footer, mirroring drawSelect's grid-fit math
  const cols = Math.min(4, Math.max(1, n));
  const rowsN = Math.max(1, Math.ceil(n / cols));
  let k = 1;
  if (n > cols) {
    const availH = 496 - 118, needH = rowsN * 190 - 18;
    if (needH > availH) k = (availH + 18) / (rowsN * 190);
  }
  const cw = Math.floor(196 * k), ch = Math.floor(172 * k);
  gridEl.style.setProperty("--cw", cw + "px");
  gridEl.style.setProperty("--ch", ch + "px");
  gridEl.style.setProperty("--k", String(Math.max(k, 0.72)));
  gridEl.classList.toggle("sel-grid-top", n > cols); // 3+ rows anchor higher
  // the grid is ALWAYS 4-wide (the keyboard geometry): cap the row width so
  // flex-wrap can't pack shrunken cards 5+ across; gaps scale like the canvas
  const colGap = Math.max(8, Math.floor(18 * k));
  gridEl.style.columnGap = colGap + "px";
  gridEl.style.rowGap = Math.max(10, Math.floor(18 * k)) + "px";
  gridEl.style.maxWidth = cols * cw + (cols - 1) * colGap + "px";

  // B-side that rides on a card BACK, keyed by the parent level id
  const bsideByParent = new Map();
  for (let bi = 0; bi < LEVELS.length; bi++)
    if (LEVELS[bi].bside && LEVELS[bi].parent) bsideByParent.set(LEVELS[bi].parent, bi);

  for (let j = 0; j < n; j++) {
    const i = wl[j];
    const L = LEVELS[i];
    const bi = bsideByParent.get(L.id);
    const flipped = bi != null && st.bflip.has(L.id);
    const bu = flipped ? bsideUnlock(LEVELS[bi], getP) : null;
    const di = flipped ? bi : i;            // level this face DISPLAYS
    const D = LEVELS[di];
    const lockedB = flipped && !bu.open;

    const card = btn("sel-card", lockedB ? { action: "bflip", arg: L.id } : { action: "load", arg: di });
    card.classList.toggle("flipped", !!flipped);
    card.classList.toggle("locked", !!lockedB);
    card.style.setProperty("--tint", D.tint || "#ffb454");
    // the BODY lifts on focus; the card box (hit geometry) and the corner
    // chips stay pinned — the canvas fixed the "hitbox dance" exactly this
    // way (lifted drawing, lift-independent chip coords)
    const body = el("div", "sel-cardbody");
    card.appendChild(body);

    // thumbnail — blit the cached offscreen canvas into the card's own
    // <canvas> (a cached node can't be re-parented; drawImage copies pixels)
    const thumbWrap = el("div", "sel-thumb");
    const cv = document.createElement("canvas");
    cv.width = 184; cv.height = 104;
    const g = cv.getContext("2d");
    if (thumbs[di]) g.drawImage(thumbs[di], 0, 0, 184, 104);
    if (lockedB) { g.fillStyle = "rgba(10,7,16,0.55)"; g.fillRect(0, 0, 184, 104); }
    thumbWrap.appendChild(cv);
    if (lockedB) thumbWrap.appendChild(el("div", "sel-lockface", "🔒"));
    body.appendChild(thumbWrap);

    // rank badge
    const rk = lsGet("tether.rank." + D.id);
    if (rk && !lockedB) {
      const badge = el("div", "sel-rank", rk);
      badge.style.color = GRADE_COLOR[rk] || "#c9b8d8";
      badge.style.setProperty("--rank-glow", GRADE_COLOR[rk] || "#c9b8d8");
      body.appendChild(badge);
    }

    const name = el("div", "sel-name", `${flipped ? "B·" : `${j + 1}·`} ${D.name}`);
    body.appendChild(name);
    const tag = el("div", "sel-tag", lockedB ? bu.label : D.tag);
    body.appendChild(tag);

    const foot = el("div", "sel-cardfoot");
    if (lockedB) {
      foot.appendChild(el("span", "sel-lockprog", `🔒 ${bu.progress}`));
    } else {
      const best = st.bests[di];
      const bestEl = el("span", best ? "sel-best" : "sel-best none", best ? `★ ${fmtTime(best)}` : "not cleared");
      foot.appendChild(bestEl);
      const ct = D.data.coins?.length || 0;
      if (ct) {
        let got = 0, alt = false;
        got = Number(lsGet("tether.coins." + D.id)) || 0;
        alt = !!lsGet("tether.alt." + D.id);
        const coinEl = el("span", got >= ct ? "sel-coins full" : "sel-coins", `◆${got}/${ct}${alt ? " ✦" : ""}`);
        foot.appendChild(coinEl);
      }
    }
    body.appendChild(foot);

    // corner chips — mouse/keyboard-hotkey only, NOT in the arrow sequence
    if (isDeletable(L.id)) {
      const del = btn("sel-x", { action: "delcustom", arg: i }, `delete ${L.name}`);
      del.textContent = "✕";
      del.dataset.chip = "1";
      card.appendChild(del);
    }
    if (bi != null) {
      const flip = btn("sel-bchip" + (flipped ? " back" : ""), { action: "bflip", arg: L.id },
        flipped ? "back to A-side" : "flip to B-side");
      flip.textContent = flipped ? "◂ A" : "B ▸";
      flip.dataset.chip = "1";
      card.appendChild(flip);
    }
    gridEl.appendChild(card);
  }
}

function buildFooter() {
  footerEl.replaceChildren();
  const st = state;
  const get = saveReader(LEVELS);
  const un = unlockedPalettes(get);
  let pi = 0; try { pi = Number(lsGet("tether.palette")) || 0; } catch {}
  const pal = PALETTES[pi] || PALETTES[0];

  const skins = btn("sel-fbtn", { action: "skins" });
  const sw = el("span", "sel-swatch"); sw.style.background = pal.body;
  skins.append(sw, el("span", null, `SKINS (${un.size}/${PALETTES.length})`));

  const bsides = LEVELS.filter((l) => l.bside);
  const openN = bsides.filter((l) => bsideUnlock(l, get).open).length;
  const secrets = btn("sel-fbtn sel-fbtn-pink", { action: "secrets" });
  secrets.textContent = `✦ SECRETS (${openN}/${bsides.length})`;

  const settings = btn("sel-fbtn sel-fbtn-cyan", { action: "settings" });
  settings.textContent = "⚙ SETTINGS (O)";

  footerEl.append(skins, secrets, settings);
}

function buildHints() {
  hintsEl.replaceChildren();
  hintsEl.append(
    el("div", "sel-hint hint-1", "←→↑↓ choose · ENTER or click to play · TAB world · B flip to the B-side"),
    el("div", "sel-hint hint-2", "RMB/E grapple · SPACE release/jump · SHIFT dash · LMB/J attack · aim DOWN+attack = POGO · G ghost"),
    el("div", "sel-hint hint-3", "ESC pause · R restart · F fullscreen · M sound · O settings · E edit · N new level · DEL delete custom"),
  );
}

function buildConfirm() {
  const st = state;
  if (st.confirm == null || !LEVELS[st.confirm]) {
    confirmEl.style.display = "none";
    confirmEl.replaceChildren();
    return;
  }
  const L = LEVELS[st.confirm];
  confirmEl.replaceChildren();
  const box = el("div", "sel-confirm-box");
  box.append(
    el("div", "sel-confirm-title", `DELETE "${L.name}"?`),
    el("div", "sel-confirm-sub", "removes the level AND its times/ranks/ghosts — no undo"),
  );
  const row = el("div", "sel-confirm-row");
  const del = btn("sel-confirm-btn danger", { action: "delyes", arg: st.confirm });
  del.textContent = "DELETE";
  const keep = btn("sel-confirm-btn", { action: "delno" });
  keep.textContent = "KEEP (Esc)";
  row.append(del, keep);
  box.appendChild(row);
  confirmEl.appendChild(box);
  confirmEl.style.display = "flex";
}


// ---- focus model -----------------------------------------------------------
// collect the arrow-navigable buttons (cards + world nav + footer, or the two
// confirm buttons while confirm is open), tagged with their band + geometry
function collectFocusables() {
  const st = state;
  focusables = [];
  if (st.confirm != null) {
    for (const b of confirmEl.querySelectorAll("button[data-actionable]"))
      focusables.push({ el: b, band: "confirm", target: b._target });
    return;
  }
  for (const b of headerEl.querySelectorAll("button[data-actionable]"))
    focusables.push({ el: b, band: "header", target: b._target });
  // cards only (skip the corner chips: dataset.chip) — arrow-reachable
  const cards = [...gridEl.querySelectorAll("button.sel-card[data-actionable]")];
  for (const b of cards) focusables.push({ el: b, band: "card", target: b._target });
  for (const b of footerEl.querySelectorAll("button[data-actionable]"))
    focusables.push({ el: b, band: "footer", target: b._target });
  // remember the card column count for grid nav
  focusables._cols = Math.min(4, Math.max(1, cards.length));
  focusables._cardStart = focusables.findIndex((f) => f.band === "card");
  focusables._cardCount = cards.length;
}

function setFocus(i, silent, source = "key") {
  if (!focusables.length) return;
  focusIndex = Math.max(0, Math.min(focusables.length - 1, i));
  focusSource = source;
  hoverCleared = false;
  for (let j = 0; j < focusables.length; j++)
    focusables[j].el.classList.toggle("focused", j === focusIndex);
  const f = focusables[focusIndex];
  focusedLevelId = f?.target?.action === "load" ? (LEVELS[f.target.arg]?.id ?? null) : null;
  if (f) { try { f.el.focus({ preventScroll: true }); } catch {} }
  if (!silent) sfx.tick();
}

// the mouse left every interactive element: a hover-set highlight clears
// (keyboard/gamepad-set focus is never cleared by an idling mouse)
function clearHover() {
  if (focusSource !== "pointer" || hoverCleared) return;
  hoverCleared = true;
  for (const f of focusables) f.el.classList.remove("focused");
}

// ---- controller API (called by game.js) -----------------------------------
const controller = {
  show(focusLevelIndex) {
    rootEl.style.display = "flex";
    refresh();
    // focus the requested level card, else keep current
    if (focusLevelIndex != null) {
      const at = focusables.findIndex((f) => f.band === "card" && f.target?.action === "load" && f.target.arg === focusLevelIndex);
      if (at >= 0) setFocus(at, true);
    }
  },
  hide() { hide(); },
  refresh,
  confirmOpen: () => state.confirm != null,

  // arrow nav — dx/dy in {-1,0,1}. Grid geometry for cards; linear for the
  // header/footer bands; up/down bridge the bands (header ↔ cards ↔ footer)
  nav(dx, dy) {
    if (!focusables.length) return;
    // first key after a hover-clear RE-SUMMONS the highlight in place
    if (hoverCleared) { setFocus(focusIndex, false, "key"); return; }
    const st = state;
    if (st.confirm != null) { // DELETE ↔ KEEP
      if (dx) setFocus(focusIndex + (dx > 0 ? 1 : -1));
      return;
    }
    const f = focusables[focusIndex];
    const cs = focusables._cardStart, cc = focusables._cardCount, cols = focusables._cols || 4;
    if (dx) {
      // left/right: within the current band, clamped
      const band = f.band;
      let i = focusIndex + (dx > 0 ? 1 : -1);
      if (i < 0 || i >= focusables.length || focusables[i].band !== band) return;
      setFocus(i);
      return;
    }
    if (dy > 0) { // down
      if (f.band === "header") { setFocus(cs >= 0 ? cs : firstOf("footer")); return; }
      if (f.band === "card") {
        // rows below get the focus even when the cell directly beneath is
        // missing (incomplete bottom row: n % cols ≠ 0) — clamp into the
        // partial row's last card. Only the BOTTOM row exits to the footer.
        const rel = focusIndex - cs;
        const lastRow = Math.floor((cc - 1) / cols);
        if (Math.floor(rel / cols) < lastRow)
          setFocus(cs + Math.min(rel + cols, cc - 1));
        else setFocus(firstOf("footer"));
        return;
      }
      // footer: clamp
      return;
    }
    if (dy < 0) { // up
      if (f.band === "footer") { setFocus(cc ? cs + cc - 1 : firstOf("header")); return; }
      if (f.band === "card") {
        const rel = focusIndex - cs;
        if (rel - cols >= 0) setFocus(cs + rel - cols);
        else setFocus(firstOf("header"));
        return;
      }
      // header: clamp
      return;
    }
  },

  activateFocused() {
    if (hoverCleared) { setFocus(focusIndex, false, "key"); return; } // never fire an invisible selection
    const f = focusables[focusIndex];
    if (f) activate(f.target);
  },

  // the {action,arg} of the focused item — game.js's E/B/DEL/comma hotkeys
  // read this instead of st.ui.buttons[st.ui.sel]. Null while the highlight
  // is hover-cleared: nothing is visibly selected, so hotkeys don't act.
  focusedTarget() {
    if (hoverCleared) return null;
    const f = focusables[focusIndex];
    return f ? f.target : null;
  },
};

function firstOf(band) {
  const i = focusables.findIndex((f) => f.band === band);
  return i >= 0 ? i : focusIndex;
}

function activate(target) {
  if (target) emit("action", target);
}

function hide() {
  if (rootEl) rootEl.style.display = "none";
}
