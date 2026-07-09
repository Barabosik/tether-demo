import { CONFIG as C, KEYMAP } from "./config.js";

/* Gamepad → the existing input pipeline (standard mapping, polled per frame).
 * Buttons and the move stick synthesize the SAME KeyboardEvents the keyboard
 * path consumes (edge → keydown, release → keyup), fired at each action's
 * CURRENT binding — so buffers, menus, the editor guard and key remaps all
 * keep working with zero special cases downstream. The right stick IS the
 * aim: while the pad is the active device it drives st.input.mouse, orbiting
 * the crosshair around the player at PAD_AIM_RADIUS (grapple.js widens the
 * assist cone by PAD_ASSIST_EXTRA_DEG while st.input.padAiming).
 *
 * Layout (fixed in v1, shown on the SETTINGS screen):
 *   Ⓐ/LB jump · Ⓑ/LT dash · Ⓧ/RB attack · Ⓨ/RT grapple — every verb on a
 *   shoulder too, so both thumbs can stay on the sticks mid-combat
 *   L-stick/dpad move · R-stick aim · START pause · BACK restart
 * In menus: dpad/L-stick navigate, Ⓐ confirm, Ⓑ back. */

const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
              BACK: 8, START: 9, DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15 };

// gameplay buttons → KEYMAP actions (edge-held, like a real key).
// Face buttons AND a full shoulder set: aiming lives on the right stick, so
// jump/attack must be reachable WITHOUT lifting either thumb — LB jump,
// LT dash (left index/middle), RB attack, RT grapple (right index/middle).
const PLAY_MAP = [
  [BTN.A, "jump"], [BTN.LB, "jump"],
  [BTN.B, "dash"], [BTN.LT, "dash"],
  [BTN.X, "attack"], [BTN.RB, "attack"],
  [BTN.Y, "grapple"], [BTN.RT, "grapple"],
  [BTN.BACK, "reset"],
];
// menu buttons → literal menu keys (tapped on the press edge)
const MENU_MAP = [
  [BTN.A, "Enter"], [BTN.B, "Escape"], [BTN.BACK, "Escape"],
  [BTN.DUP, "ArrowUp"], [BTN.DDOWN, "ArrowDown"],
  [BTN.DLEFT, "ArrowLeft"], [BTN.DRIGHT, "ArrowRight"],
];
const DPAD_DIR = { left: BTN.DLEFT, right: BTN.DRIGHT, up: BTN.DUP, down: BTN.DDOWN };

let pad = null;                // the pad currently driving input (for padStatus)
let prev = [];                 // previous pressed[] snapshot
const heldCodes = new Set();   // synthetic codes currently held down
const moveHeld = { left: false, right: false, up: false, down: false };
const menuStick = { x: 0, y: 0 }; // -1/0/1 detents for menu navigation taps
const aim = { x: 1, y: -0.35 };   // unit aim dir (last stick, or facing default)
let everAimed = false;
let lastScreen = "";
let lastPadId = null;          // release everything when the device switches

/* Device pick. Bluetooth headphones/mice/remotes also enumerate as
 * "gamepads" (buttons: 0–4, mapping: "", no sticks) and used to shadow the
 * real controller by grabbing slot 0. Auto-pick now scores every device —
 * explicit user choice (SETTINGS → GAMEPAD, persisted) beats standard
 * mapping beats control richness — and anything without enough controls to
 * actually play (6 buttons + 2 axes) is never auto-picked. */
let chosenId = null;
try { chosenId = localStorage.getItem("tether.pad") || null; } catch {}

function listPads() {
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return [...pads].filter((p) => p && p.connected);
  } catch { return []; }
}
const usable = (p) => p.buttons.length >= 6 && p.axes.length >= 2;
function score(p) {
  let s = 0;
  if (chosenId && p.id === chosenId) s += 1000;
  if (p.mapping === "standard") s += 100;
  return s + Math.min(p.buttons.length, 20) + Math.min(p.axes.length, 8);
}
function pickPad() {
  const cands = listPads().filter(usable);
  if (!cands.length) return null;
  cands.sort((a, b) => score(b) - score(a));
  return cands[0];
}

// SETTINGS screen: every detected device, with why it is/isn't the one
export function padList() {
  return listPads().map((p) => ({
    id: p.id || "unnamed device", mapping: p.mapping,
    buttons: p.buttons.length, axes: p.axes.length,
    usable: usable(p),
    active: !!pad && p.id === pad.id,
    chosen: !!chosenId && p.id === chosenId,
  }));
}
export function choosePad(id) { // null = back to auto
  chosenId = id || null;
  try {
    if (id) localStorage.setItem("tether.pad", id);
    else localStorage.removeItem("tether.pad");
  } catch {}
}
export const padChoice = () => chosenId;

const send = (type, code) =>
  window.dispatchEvent(new KeyboardEvent(type, { code }));
function hold(code) {
  if (!code || heldCodes.has(code)) return;
  heldCodes.add(code);
  send("keydown", code);
}
function drop(code) {
  if (!heldCodes.delete(code)) return;
  send("keyup", code);
}
const tap = (code) => { send("keydown", code); send("keyup", code); };
function releaseAll() {
  for (const c of [...heldCodes]) drop(c);
  for (const d of Object.keys(moveHeld)) moveHeld[d] = false;
}

export const padStatus = () =>
  pad ? { connected: true, id: pad.id || "gamepad" } : { connected: false, id: "" };

export function pollGamepad(st) {
  const gp = pickPad();
  const had = !!pad;
  pad = gp;
  if (!gp) {
    if (had) { releaseAll(); st.input.padAiming = false; }
    lastPadId = null;
    prev = [];
    return;
  }
  if (gp.id !== lastPadId) { // device switch: drop the old device's holds
    if (lastPadId !== null) releaseAll();
    lastPadId = gp.id;
    prev = [];
  }

  const screen = st.screen;
  if (screen !== lastScreen) releaseAll(); // never carry holds across screens
  lastScreen = screen;
  const down = gp.buttons.map((b) => b.pressed);
  if (screen === "editor") { prev = down; return; } // mouse/keyboard tool

  const rose = (i) => down[i] && !prev[i];
  const fell = (i) => !down[i] && prev[i];
  const lx = gp.axes[0] || 0, ly = gp.axes[1] || 0;
  const rx = gp.axes[2] || 0, ry = gp.axes[3] || 0;

  // releases first, regardless of screen — a button let go while paused must
  // never leave its synthetic key stuck down
  for (const [i, action] of PLAY_MAP) if (fell(i)) drop(KEYMAP[action][0]);

  const anyInput = down.some(Boolean) ||
    Math.hypot(lx, ly) > C.PAD_DEADZONE_AIM || Math.hypot(rx, ry) > C.PAD_DEADZONE_AIM;

  if (screen === "playing") {
    for (const [i, action] of PLAY_MAP) if (rose(i)) hold(KEYMAP[action][0]);
    if (rose(BTN.START)) tap("Escape");

    // left stick (hysteresis) + dpad → held directions
    const want = {
      left: lx < -(moveHeld.left ? C.PAD_MOVE_OFF : C.PAD_MOVE_ON) || down[DPAD_DIR.left],
      right: lx > (moveHeld.right ? C.PAD_MOVE_OFF : C.PAD_MOVE_ON) || down[DPAD_DIR.right],
      up: ly < -(moveHeld.up ? C.PAD_MOVE_OFF : C.PAD_MOVE_ON) || down[DPAD_DIR.up],
      down: ly > (moveHeld.down ? C.PAD_MOVE_OFF : C.PAD_MOVE_ON) || down[DPAD_DIR.down],
    };
    for (const d of Object.keys(want)) {
      if (want[d] && !moveHeld[d]) { moveHeld[d] = true; hold(KEYMAP[d][0]); }
      else if (!want[d] && moveHeld[d]) { moveHeld[d] = false; drop(KEYMAP[d][0]); }
    }

    // right stick → aim; pad input claims the crosshair until the mouse moves
    const mag = Math.hypot(rx, ry);
    if (mag > C.PAD_DEADZONE_AIM) {
      aim.x = rx / mag; aim.y = ry / mag;
      everAimed = true;
    } else if (!everAimed) {
      // silent stick: aim forward-and-up off the facing until it speaks
      const fx = st.player.facing || 1;
      const m = Math.hypot(fx, 0.35);
      aim.x = fx / m; aim.y = -0.35 / m;
    }
    if (anyInput) st.input.padAiming = true;
    if (st.input.padAiming) {
      const px = st.player.x + st.player.w / 2 - st.cam.x;
      const py = st.player.y + st.player.h / 2 - st.cam.y;
      st.input.mouse.sx = Math.max(0, Math.min(C.VIEW_W, px + aim.x * C.PAD_AIM_RADIUS));
      st.input.mouse.sy = Math.max(0, Math.min(C.VIEW_H, py + aim.y * C.PAD_AIM_RADIUS));
    }
  } else {
    // menus: taps only, on press edges
    for (const [i, code] of MENU_MAP) if (rose(i)) tap(code);
    if (rose(BTN.START)) tap(screen === "select" ? "Enter" : "Escape");
    // stick detents navigate like dpad taps (edge-crossing, no auto-repeat)
    const sx = lx > 0.55 ? 1 : lx < -0.55 ? -1 : 0;
    const sy = ly > 0.55 ? 1 : ly < -0.55 ? -1 : 0;
    if (sx !== menuStick.x && sx) tap(sx > 0 ? "ArrowRight" : "ArrowLeft");
    if (sy !== menuStick.y && sy) tap(sy > 0 ? "ArrowDown" : "ArrowUp");
    menuStick.x = sx; menuStick.y = sy;
  }

  prev = down;
}
