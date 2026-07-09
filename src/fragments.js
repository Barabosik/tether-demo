/* Collectible stub. The public demo ships without the collectible/lore system;
 * levels carry none. The export surface is preserved as no-ops so callers
 * (game, editor) keep resolving their imports and behave as "nothing to find". */
export const FRAG_SKINS = ["butterfly", "spark", "feather"];
export const FRAG_R = 22;
export function fragmentProgress() { return { found: 0, total: 0, complete: false }; }
export const fragKey = (f) => "tether.frag." + (f && f.id);
export function fragCollected() { return false; }
export const newFragId = () => "f-" + Math.random().toString(36).slice(2, 8);
export function nearestFragment() { return null; }
export function openReading() {}
export function advanceReading() {}
export function tryReadFragment() { return false; }
export function updateReading() {}
export function drawFragment() {}
export function drawFragPrompt() {}
export function drawLorePanel() {}
