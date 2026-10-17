/* The UI's icon set: small stroked SVGs (24-unit grid, one stroke weight),
 * built as DOM nodes so they inherit currentColor from the control they sit
 * in. Replaces the old unicode glyphs and emoji. */

const NS = "http://www.w3.org/2000/svg";

export const ICON_PATHS = {
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13z",
  trophy: "M8 4h8v6a4 4 0 0 1-8 0zM8 6H4.5v1.5A3.5 3.5 0 0 0 8 11M16 6h3.5v1.5A3.5 3.5 0 0 1 16 11M12 14v4M8.5 20h7",
  gear: "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6",
  sparkle: "M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  flag: "M6 21V4M6 4.5h11l-2.5 4 2.5 4H6",
  play: "M8 5.5v13l10.5-6.5z",
  diamond: "M12 3.5l6.5 8.5-6.5 8.5L5.5 12z",
  heart: "M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z",
  unlock: "M7 11V8a5 5 0 0 1 9.6-2M5.5 11h13v9.5h-13z",
  fall: "M12 4v11M7 10.5l5 5 5-5M5.5 20h13",
  swords: "M5 4.5l9.5 9.5M19 4.5L9.5 14M7.5 13.5l-3 3 3 3 3-3M16.5 13.5l3 3-3 3-3-3",
  rotate: "M9 3h6a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 15 21H9a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 9 3zM11 18h2M19.5 8a6 6 0 0 1 0 8M21 14l-1.5 2-2-1",
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  eyeOff: "M4 4l16 16M9.9 5.8A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.3 7.6A15 15 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 3.7-.8",
};
const PATHS = ICON_PATHS;

// icon(name, {fill}) → <svg class="ic ic-name"> — filled icons (heart,
// diamond, play) take the fill from currentColor instead of a stroke
export function icon(name, opts = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `ic ic-${name}${opts.fill ? " ic-fill" : ""}`);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", PATHS[name] || "");
  svg.appendChild(p);
  return svg;
}

// a keyboard key, for hint lines: <kbd>Esc</kbd>
export function kbd(label) {
  const k = document.createElement("kbd");
  k.textContent = label;
  return k;
}

// parse a hint string where [Key] marks a key cap: "[Esc] pause · [R] restart"
// → a fragment of text nodes and <kbd> elements (built, never innerHTML)
export function hintLine(src) {
  const frag = document.createDocumentFragment();
  const re = /\[([^\]]+)\]/g;
  let at = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > at) frag.appendChild(document.createTextNode(src.slice(at, m.index)));
    frag.appendChild(kbd(m[1]));
    at = m.index + m[0].length;
  }
  if (at < src.length) frag.appendChild(document.createTextNode(src.slice(at)));
  return frag;
}
