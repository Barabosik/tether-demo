/* Shared look for canvas-drawn chrome — the same tokens style.css uses, so
 * canvas text and DOM screens read as one surface. Green-black and bone, one
 * jade accent; Big Shoulders for display words and numbers, Public Sans for
 * everything else. Game art keeps its own per-world colors. */

export const FONT_UI = "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";
export const FONT_DISPLAY = "'Big Shoulders', 'Arial Narrow', sans-serif";

export const INK = "#e4e1d3";      // bone
export const MUTED = "#9aa29b";
export const ACCENT = "#9fc7b8";   // jade
export const BG = "#121715";
export const PANEL = "#1a211f";
export const PANEL2 = "#232c29";

// canvas text only picks up a web font once it has loaded — ask for both
// faces at boot so the first frames after load already use them
export function loadFonts() {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  for (const f of ["700 16px 'Public Sans'", "400 16px 'Public Sans'", "800 16px 'Big Shoulders'"])
    document.fonts.load(f).catch(() => {});
}
