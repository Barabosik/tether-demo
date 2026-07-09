/* Tiny UI event bus — the interop seam between the game loop and DOM chrome.
 * game.js emits; DOM widgets subscribe. Replaces the old pattern of every
 * widget running its own requestAnimationFrame loop diffing
 * window.__tether.screen (three loops, three copies of the same logic).
 *
 * Events:
 *   "screen"  payload: screen name — emitted by game.js on every transition
 *             (select / playing / paused / results / skins / secrets /
 *             settings / editor). Emitted only on CHANGE.
 *   "action"  payload: { action, arg } — DOM chrome asking the game to do
 *             something. game.js is the only subscriber (single reducer,
 *             same verb table as the canvas UI's uiAction).
 */

const listeners = new Map(); // event name → Set of handlers

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const fn of [...set]) fn(payload);
}

/* Modal containment — the top-layer contract (Phase 1's confirm modal and
 * nav controller reuse this): while ANY app modal (z60) is open, the screen
 * underneath must be inert. The DOM scrim already captures pointer events;
 * what it CANNOT contain are game.js's window-level listeners (mousemove
 * hover tracking, keydown menu nav — including the gamepad's synthetic
 * window KeyboardEvents). game.js gates those on modalOpen().
 *
 * Modals call setModalOpen(id, open) from their toggle; "modal" emits only
 * on the any-open edge. game.js emits "modal-close" when Esc is pressed
 * while a modal owns input; each modal subscribes and closes itself. */
const openModals = new Set();

export function setModalOpen(id, open) {
  const was = openModals.size > 0;
  if (open) openModals.add(id);
  else openModals.delete(id);
  const is = openModals.size > 0;
  if (was !== is) emit("modal", is);
}

export const modalOpen = () => openModals.size > 0;

let screen = null; // last emitted screen (null until the game boots)

export function emitScreen(name) {
  if (name === screen) return;
  screen = name;
  emit("screen", name);
}

export const currentScreen = () => screen;

// subscribe + replay: widgets that initialize after startGame() (main.js
// inits the modals last) still see the boot screen without polling
export function onScreen(fn) {
  const off = on("screen", fn);
  if (screen !== null) fn(screen);
  return off;
}
