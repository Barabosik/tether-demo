import { CONFIG as C, KEYMAP } from "./config.js";
import { setVolumes } from "./audio.js";

/* Player options. Everything persists to localStorage and applies LIVE:
 * volumes drive the WebAudio buses, shake/flash scale the juice at their
 * single application sites in game.js, and key overrides mutate KEYMAP
 * in place — every held()/includes() check downstream (including the
 * gamepad synthesizer, which fires the CURRENT binding) picks them up
 * with zero special cases. */

export const SLIDERS = [ // [key, label] — menu order
  ["master", "MASTER VOLUME"],
  ["music", "MUSIC"],
  ["sfx", "SFX"],
  ["shake", "SCREEN SHAKE"],
  ["flash", "IMPACT FLASH"],
];

export const SETTINGS = {
  master: C.AUDIO_MASTER, music: C.AUDIO_MUSIC, sfx: C.AUDIO_SFX,
  shake: 1, flash: 1,
  autofs: 1, // go fullscreen on the first input (browsers demand a gesture)
};
const SLIDER_DEFAULTS = { ...SETTINGS };

// pristine copy taken at import time, before any override is applied
const KEY_DEFAULTS = JSON.parse(JSON.stringify(KEYMAP));

export const REBINDABLE = [ // [action, label] — menu order
  ["jump", "JUMP / RELEASE"],
  ["dash", "DASH"],
  ["grapple", "GRAPPLE"],
  ["attack", "ATTACK / POGO"],
  ["left", "MOVE LEFT"],
  ["right", "MOVE RIGHT"],
  ["up", "UP / REEL IN"],
  ["down", "DOWN / FAST-FALL"],
  ["reset", "RESTART"],
  ["practice", "PRACTICE FLAG"],
  ["fullscreen", "FULLSCREEN"],
  ["mute", "MUTE"],
];

// menus need these to stay themselves; F2 is the profiler
const RESERVED = new Set(["Escape", "Enter", "F2"]);

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("tether.settings") || "{}");
    for (const k of Object.keys(SETTINGS))
      if (typeof s[k] === "number" && s[k] >= 0 && s[k] <= 1) SETTINGS[k] = s[k];
  } catch {}
  try {
    const keys = JSON.parse(localStorage.getItem("tether.keys") || "{}");
    for (const a of Object.keys(KEYMAP))
      if (Array.isArray(keys[a]) && keys[a].length &&
          keys[a].every((c) => typeof c === "string"))
        KEYMAP[a] = keys[a];
  } catch {}
  setVolumes(SETTINGS);
}

function saveSliders() {
  try { localStorage.setItem("tether.settings", JSON.stringify(SETTINGS)); } catch {}
}
function saveKeys() {
  try { localStorage.setItem("tether.keys", JSON.stringify(KEYMAP)); } catch {}
}

export function setSetting(key, v) {
  if (!(key in SETTINGS)) return;
  // snap to 5% steps so the bar and the stored value always agree
  SETTINGS[key] = Math.round(Math.min(1, Math.max(0, v)) * 20) / 20;
  saveSliders();
  setVolumes(SETTINGS);
}
export const adjustSetting = (key, dir) => setSetting(key, SETTINGS[key] + dir * 0.05);

export function resetSliders() {
  for (const k of Object.keys(SLIDER_DEFAULTS)) SETTINGS[k] = SLIDER_DEFAULTS[k];
  saveSliders();
  setVolumes(SETTINGS);
}

/* Rebinding replaces the action's whole list with the captured key (the
 * dual defaults like ArrowLeft+KeyA come back via RESET). A key stolen from
 * another action SWAPS rather than unbinds: the victim inherits the old
 * binding if losing the key would leave it empty. */
export function rebindKey(action, code) {
  if (!(action in KEYMAP)) return { ok: false, why: "unknown action" };
  if (RESERVED.has(code)) return { ok: false, why: `${prettyKey(code)} is reserved` };
  const old = KEYMAP[action];
  for (const a of Object.keys(KEYMAP)) {
    if (a === action || !KEYMAP[a].includes(code)) continue;
    const kept = KEYMAP[a].filter((c) => c !== code);
    KEYMAP[a] = kept.length ? kept : old.filter((c) => c !== code);
  }
  KEYMAP[action] = [code];
  saveKeys();
  return { ok: true };
}

export function resetKeys() {
  for (const a of Object.keys(KEY_DEFAULTS)) KEYMAP[a] = [...KEY_DEFAULTS[a]];
  try { localStorage.removeItem("tether.keys"); } catch {}
}

const KEY_NAMES = {
  Space: "SPACE", Enter: "ENTER", Escape: "ESC", Tab: "TAB",
  ShiftLeft: "L-SHIFT", ShiftRight: "R-SHIFT",
  ControlLeft: "L-CTRL", ControlRight: "R-CTRL",
  AltLeft: "L-ALT", AltRight: "R-ALT",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Backspace: "BKSP", CapsLock: "CAPS", Backquote: "`",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Semicolon: ";", Quote: "'", Backslash: "\\",
  Comma: ",", Period: ".", Slash: "/",
};
export function prettyKey(code) {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return "NUM-" + code.slice(6).toUpperCase();
  return code.toUpperCase();
}
export const bindingLabel = (action) =>
  (KEYMAP[action] || []).map(prettyKey).join(" / ") || "—";
