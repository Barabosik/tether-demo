import { supabase } from "./supabaseClient.js";
import { fetchLeaderboard } from "./leaderboard.js";
import { fetchAchievements } from "./achievements.js";
import { onScreen, on as busOn, setModalOpen } from "./uiBus.js";
import { ensureUiRoot } from "./uiRoot.js";
import { WORLD_NAME } from "./worlds.js";

/* Trophy button + modal, independent of the canvas/game loop. Screen
 * visibility arrives via the uiBus; level/PB data still reads
 * window.__levels + localStorage on open (a snapshot per open, never per
 * frame). The button lives on the #ui-root artboard at artboard px —
 * no more per-widget canvas-rect math. */

let btnEl = null;
let overlayEl = null;
let bodyEl = null;
let paginationEl = null;
let pageLabelEl = null;
let prevBtnEl = null;
let nextBtnEl = null;
let tab = "bests"; // "bests" | "scores" | "achievements"
let pageIndex = 0;  // index into window.__levels — one page per level

function fmtMs(ms) {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${rest}`;
}

// local personal best (seconds, stored by the game) → m:ss.cs
function fmtSec(sec) {
  const m = Math.floor(sec / 60);
  const rest = (sec - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${rest}`;
}
function localBest(id) {
  try { const v = Number(localStorage.getItem("tether.best." + id)); return v > 0 ? v : null; }
  catch { return null; }
}
function localRank(id) {
  try { return localStorage.getItem("tether.rank." + id); } catch { return null; }
}

function updatePaginationUI() {
  const LEVELS = window.__levels || [];
  const total = LEVELS.length;
  paginationEl.style.display = tab === "scores" && total ? "flex" : "none";
  if (!total) return;
  pageIndex = Math.max(0, Math.min(total - 1, pageIndex));
  pageLabelEl.textContent = `${LEVELS[pageIndex]?.name || "Level"} · ${pageIndex + 1}/${total}`;
  prevBtnEl.disabled = pageIndex === 0;
  nextBtnEl.disabled = pageIndex === total - 1;
}

// dynamic rows are BUILT (createElement/textContent), never innerHTML — no
// string ever crosses an HTML-parsing sink, so nothing here needs escaping
function span(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}
function emptyEl(text) {
  const d = document.createElement("div");
  d.className = "lb-empty";
  d.textContent = text;
  return d;
}

// "Best Times" — every level across every world (+ customs), your local PB and
// rank, grouped by world. Works offline (reads localStorage), so it's the
// default view; the online per-level board is a separate tab.
function renderBests() {
  updatePaginationUI();
  const LEVELS = window.__levels || [];
  bodyEl.replaceChildren();
  if (!LEVELS.length) { bodyEl.replaceChildren(emptyEl("no levels loaded")); return; }
  const campaign = LEVELS.filter((l) => !l.bside);
  const worlds = [...new Set(campaign.map((l) => l.worldId || 1))].sort((a, b) => a - b);
  let cleared = 0;
  const rowFor = (l) => {
    const best = localBest(l.id), rk = localRank(l.id);
    if (best) cleared++;
    const row = document.createElement("div");
    row.className = "lb-row";
    row.append(
      span(rk ? `lb-grade lb-grade-${rk}` : "lb-grade lb-grade-none", rk || "·"),
      span("lb-name", l.name),
      span(best ? "lb-time" : "lb-time lb-time-none", best ? fmtSec(best) : "—"),
    );
    return row;
  };
  for (const w of worlds) {
    const title = document.createElement("div");
    title.className = "lb-section-title";
    title.textContent = WORLD_NAME[w] || `WORLD ${w}`;
    bodyEl.appendChild(title);
    for (const l of campaign.filter((l) => (l.worldId || 1) === w)) bodyEl.appendChild(rowFor(l));
  }
  // SECRETS section: only B-sides you've already cleared (an unlocked-and-run
  // record) show a time; the rest stay hidden behind the SECRETS tab
  const clearedBsides = LEVELS.filter((l) => l.bside && localBest(l.id));
  if (clearedBsides.length) {
    const title = document.createElement("div");
    title.className = "lb-section-title";
    title.textContent = "SECRETS";
    bodyEl.appendChild(title);
    for (const l of clearedBsides) bodyEl.appendChild(rowFor(l));
  }
  const foot = document.createElement("div");
  foot.className = "lb-foot";
  foot.textContent = `${cleared}/${campaign.length} levels cleared`;
  bodyEl.appendChild(foot);
}

function gotoPage(delta) {
  const LEVELS = window.__levels;
  if (!LEVELS || !LEVELS.length) return;
  pageIndex = Math.max(0, Math.min(LEVELS.length - 1, pageIndex + delta));
  renderScores();
}

async function renderScores() {
  const LEVELS = window.__levels;
  if (!LEVELS || !LEVELS.length) { bodyEl.replaceChildren(emptyEl("no levels loaded")); return; }
  pageIndex = Math.max(0, Math.min(LEVELS.length - 1, pageIndex));
  const level = LEVELS[pageIndex];
  updatePaginationUI();

  bodyEl.replaceChildren(emptyEl("loading…"));
  const rows = await fetchLeaderboard(level.id);
  bodyEl.replaceChildren();
  const title = document.createElement("div");
  title.className = "lb-section-title";
  title.textContent = level.name;
  bodyEl.appendChild(title);
  if (!rows.length) {
    bodyEl.appendChild(emptyEl(`no scores yet for ${level.name}`));
    return;
  }
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    row.append(
      span("lb-rank", String(i + 1)),
      span("lb-name", r.player_name), // textContent — online strings never hit an HTML parser
      span("lb-time", fmtMs(r.time_ms)),
    );
    bodyEl.appendChild(row);
  });
}

async function renderAchievements() {
  updatePaginationUI();
  bodyEl.replaceChildren(emptyEl("loading…"));
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { bodyEl.replaceChildren(emptyEl("log in to see your achievements")); return; }
  const rows = await fetchAchievements();
  if (!rows.length) { bodyEl.replaceChildren(emptyEl("no achievements yet")); return; }
  bodyEl.replaceChildren();
  rows.forEach((r) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    row.append(
      span("lb-name", r.achievement_name),
      span("lb-time", new Date(r.created_at).toLocaleDateString()),
    );
    bodyEl.appendChild(row);
  });
}

function refresh() {
  if (tab === "bests") renderBests();
  else if (tab === "scores") renderScores();
  else renderAchievements();
}

let tabButtons = [];
function setTab(next) {
  tab = next;
  for (const b of tabButtons) b.el.classList.toggle("active", b.tab === tab);
  refresh();
}

function buildModal() {
  const overlay = document.createElement("div");
  overlay.id = "lb-modal-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) toggleModal(false); });

  const modal = document.createElement("div");
  modal.id = "lb-modal";

  const header = document.createElement("div");
  header.className = "lb-header";
  const tabs = document.createElement("div");
  tabs.className = "lb-tabs";
  tabButtons = [
    { tab: "bests", label: "Best Times" },
    { tab: "scores", label: "Online" },
    { tab: "achievements", label: "Achievements" },
  ].map((t) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = t.label;
    el.classList.toggle("active", t.tab === tab);
    el.addEventListener("click", () => setTab(t.tab));
    return { ...t, el };
  });
  tabs.append(...tabButtons.map((b) => b.el));

  const close = document.createElement("button");
  close.type = "button";
  close.className = "lb-close";
  close.textContent = "✕";
  close.addEventListener("click", () => toggleModal(false));

  header.append(tabs, close);

  const body = document.createElement("div");
  body.className = "lb-body";

  const pagination = document.createElement("div");
  pagination.className = "lb-pagination";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "lb-page-btn";
  prevBtn.textContent = "‹";
  prevBtn.addEventListener("click", () => gotoPage(-1));
  const pageLabel = document.createElement("span");
  pageLabel.className = "lb-page-label";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "lb-page-btn";
  nextBtn.textContent = "›";
  nextBtn.addEventListener("click", () => gotoPage(1));
  pagination.append(prevBtn, pageLabel, nextBtn);

  modal.append(header, body, pagination);
  overlay.append(modal);
  (document.getElementById("wrap") || document.body).appendChild(overlay);

  overlayEl = overlay;
  bodyEl = body;
  paginationEl = pagination;
  pageLabelEl = pageLabel;
  prevBtnEl = prevBtn;
  nextBtnEl = nextBtn;
}

function toggleModal(show) {
  const next = show ?? overlayEl.style.display !== "flex";
  overlayEl.style.display = next ? "flex" : "none";
  setModalOpen("leaderboard", next); // gates the menu underneath (uiBus contract)
  if (next) {
    const st = window.__tether, LEVELS = window.__levels;
    if (st && LEVELS && LEVELS.length) pageIndex = Math.max(0, Math.min(LEVELS.length - 1, st.levelIndex));
    refresh();
  }
}

function buildButton() {
  const btn = document.createElement("button");
  btn.id = "lb-open-btn";
  btn.type = "button";
  btn.title = "Leaderboard & Achievements";
  btn.textContent = "🏆";
  btn.addEventListener("click", () => toggleModal());
  ensureUiRoot().appendChild(btn);
  btnEl = btn;
}

export function initLeaderboardModal() {
  if (btnEl) return;
  buildButton();
  buildModal();
  // visible only on the level-select screen — hidden the instant a level
  // starts, shown again on return to the menu (uiBus event, no rAF poll)
  onScreen((screen) => {
    const onSelect = screen === "select";
    btnEl.style.display = onSelect ? "" : "none";
    if (!onSelect && overlayEl.style.display === "flex") toggleModal(false);
  });
  // Esc (or gamepad Ⓑ) while this modal owns input — game.js emits, we close
  busOn("modal-close", () => {
    if (overlayEl.style.display === "flex") toggleModal(false);
  });
}
