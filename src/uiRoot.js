import { CONFIG as C } from "./config.js";

/* The DOM overlay artboard: a fixed VIEW_W×VIEW_H surface centered exactly
 * over the canvas and scaled as one unit via --ui-scale (set in fitCanvas,
 * the same place the canvas CSS size comes from — one source of truth).
 * Children are authored in artboard px — the same numbers as canvas VIEW
 * coordinates — never in viewport px, so canvas-drawn and DOM UI share a
 * coordinate space and the old per-widget getBoundingClientRect math
 * (positionBtn and friends) has nothing left to do.
 *
 * Lives INSIDE #wrap: #wrap is what toggleFullscreen() fullscreens, and a
 * fullscreened element renders only its own subtree (the original
 * vanishing-chrome bug). pointer-events:none on the root so gameplay input
 * falls through to the canvas; interactive children opt back in via CSS.
 *
 * Created from JS because the standalone build (tools/build-standalone.mjs)
 * has its own HTML template — a static div in index.html would silently be
 * missing from TETHER.html, which is what the audit harness loads. */

export function ensureUiRoot() {
  if (typeof document === "undefined") return null;
  let el = document.getElementById("ui-root");
  if (el) return el;
  el = document.createElement("div");
  el.id = "ui-root";
  el.style.width = C.VIEW_W + "px";
  el.style.height = C.VIEW_H + "px";
  (document.getElementById("wrap") || document.body).appendChild(el);
  return el;
}
