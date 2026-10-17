import { CONFIG as C } from "./config.js";
import { fmtTime, displayName } from "./util.js";
import { icon } from "./icons.js";
import { LEVELS } from "./levels.js";
import { sRankTimeOf } from "./rank.js";
import { onScreen } from "./uiBus.js";
import { ensureUiRoot } from "./uiRoot.js";

/* DOM HUD chrome (Phase 5). Steady-state readouts only: hearts, level name,
 * TIME + S-target, FALLS/KILLS/coins, the DASH gauge, THE LINE strip and the
 * PRACTICE/PLAYTEST tags — at the exact canvas coordinates (ROADMAP lanes).
 *
 * Everything juice-animated or frame-synced STAYS canvas (locked decision):
 * style meter, boss/reaper bars, toast, split flash, SHATTERED, FPS/MUTED.
 *
 * Update model: game.js calls hud.sync() once per rendered frame — the
 * sanctioned exception to "events only". Every write is MUTATION-GATED
 * (nothing touches the DOM unless the displayed value changed); the gauge
 * fill animates via transform:scaleX (compositor-only); the READY pulse is
 * a CSS animation. pointer-events:none throughout — gameplay owns the mouse. */

let state = null;
let palFn = null;
let root = null;
let visible = false;
const els = {};
const last = {}; // per-key mutation gates

const mixHex = (a, b, k) => { // lerp two #rrggbb colors (same as the canvas gauge)
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) * (1 - k) + ((pb >> sh) & 255) * k);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
};

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

function build() {
  root = el("div", "hud");
  root.id = "screen-hud";
  root.style.display = "none";

  els.hearts = [];
  const hearts = el("div", "hud-hearts");
  for (let i = 0; i < C.PLAYER_HP; i++) {
    const h = el("span", "hud-heart");
    h.appendChild(icon("heart", { fill: true }));
    els.hearts.push(h);
    hearts.appendChild(h);
  }
  root.appendChild(hearts);

  const name = el("div", "hud-name");
  name.append(els.num = el("span", "hud-num"), els.name = el("span", "hud-name-t"));
  root.appendChild(name);
  const timeRow = el("div", "hud-timerow");
  const time = el("span", "hud-time");
  time.append(el("span", "hud-label", "Time"), els.time = el("span", "hud-time-v"));
  timeRow.appendChild(time);
  timeRow.appendChild(els.starget = el("span", "hud-starget"));
  root.appendChild(timeRow);
  // falls / kills / coins as an icon cluster, read at a glance
  els.stats = el("div", "hud-stats");
  const stat = (name, cls, fill) => {
    const s = el("span", "hud-stat " + cls);
    s.append(icon(name, { fill }), els[cls] = el("span", "hud-stat-v"));
    els.stats.appendChild(s);
    return s;
  };
  stat("fall", "falls");
  stat("swords", "kills");
  els.coinStat = stat("diamond", "coins", true);
  root.appendChild(els.stats);

  const dash = el("div", "hud-dash");
  dash.appendChild(el("span", "hud-dash-label", "Dash"));
  const bar = el("span", "hud-dash-bar");
  bar.appendChild(els.dashFill = el("i", "hud-dash-fill"));
  dash.appendChild(bar);
  dash.appendChild(els.dashReady = el("span", "hud-dash-ready", "Ready"));
  root.appendChild(dash);

  root.appendChild(els.line = el("div", "hud-line"));
  root.appendChild(els.practice = el("div", "hud-practice"));
  els.practice.append(icon("flag"), "Practice, unranked");
  root.appendChild(els.playtest = el("div", "hud-playtest", "Playtest. Esc returns to the editor."));

  ensureUiRoot().appendChild(root);
}

// gate helper: apply(value) runs only when the value changed
function gate(key, value, apply) {
  if (last[key] === value) return;
  last[key] = value;
  apply(value);
}

function sync() {
  if (!visible) return;
  const st = state, p = st.player;

  gate("hp", p.hp, (hp) => {
    els.hearts.forEach((h, i) => h.classList.toggle("empty", i >= hp));
  });
  gate("name", st.levelIndex, (i) => {
    els.num.textContent = String(i + 1);
    els.name.textContent = displayName(LEVELS[i]?.name ?? "");
  });
  gate("time", fmtTime(st.runTime), (v) => { els.time.textContent = v; });

  const meta = st.playtestData || LEVELS[st.levelIndex];
  const sT = sRankTimeOf(meta);
  gate("starget", `S ≤ ${fmtTime(sT)}`, (v) => { els.starget.textContent = v; });
  gate("son", st.runTime <= sT, (on) => { els.starget.classList.toggle("off", !on); });

  gate("falls", st.deaths, (v) => { els.falls.textContent = String(v); });
  gate("kills", st.kills, (v) => { els.kills.textContent = String(v); });
  gate("coins", st.coins.length ? `${st.coinCount}/${st.coins.length}` : "", (v) => {
    els.coins.textContent = v;
    els.coinStat.style.display = v ? "" : "none";
  });

  // dash gauge — the skin's colors; fill is compositor-only (scaleX)
  const pal = palFn();
  gate("pal", pal, () => {
    root.style.setProperty("--hud-ready", pal.ready);
    root.style.setProperty("--hud-dim", mixHex(pal.ready, "#1a211f", 0.6));
  });
  const dashReady = p.dashCd <= 0 && !p.dashing;
  const frac = dashReady ? 1 : 1 - Math.max(0, Math.min(1, p.dashCd / C.DASH_COOLDOWN));
  gate("dashReady", dashReady, (on) => root.classList.toggle("dash-ready", on));
  gate("infernal", !!st.infernal, (on) => { // E1: the unlock reads on the gauge
    els.dashReady.textContent = on ? "Infernal" : "Ready";
  });
  gate("dashFrac", Math.round(Math.max(0.1, frac) * 200), (q) => {
    els.dashFill.style.transform = `scaleX(${q / 200})`;
  });

  gate("line", st.line
    ? `The line ${st.line.at + 1}/${st.line.queue.length} · ${fmtTime(st.line.total + st.runTime)}`
    : "", (v) => {
    els.line.textContent = v;
    els.line.style.display = v ? "" : "none";
  });
  gate("practice", !!st.practiceRun, (on) => { els.practice.style.display = on ? "" : "none"; });
  gate("playtest", !!st.playtestData, (on) => { els.playtest.style.display = on ? "" : "none"; });
}

export function initHud(deps) {
  if (root) return { sync };
  state = deps.state;
  palFn = deps.pal;
  build();
  // the HUD lives under pause/results scrims exactly like the canvas drew it
  onScreen((screen) => {
    visible = screen === "playing" || screen === "paused" || screen === "results";
    root.style.display = visible ? "" : "none";
    if (visible) { for (const k in last) delete last[k]; sync(); } // fresh gates per entry
  });
  return { sync };
}
