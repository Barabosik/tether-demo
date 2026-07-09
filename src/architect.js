/* Boss stub. The public demo ships Worlds 1-3 only; this enemy never spawns
 * here. The export surface is preserved as no-ops so the shared combat/enemies
 * dispatch keeps resolving its imports. */
export const mkArchitect = (x, y) => ({ kind: "architect", x, y, dead: true, hp: 0 });
export const SWEEP_BAND = 34;
export function updateArchitect() {}
export function pogoArchitect() {}
export function slashArchitect() {}
export function architectContact() {}
export function drawArchitect() {}
export function drawArchitectHud() {}
