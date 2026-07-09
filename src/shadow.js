/* Boss stub. The public demo ships Worlds 1-3 only; this enemy never spawns
 * here. The export surface is preserved as no-ops so the shared combat/enemies
 * dispatch keeps resolving its imports. */
export const mkShadow = (x, y) => ({ kind: "shadow", x, y, dead: true, hp: 0 });
export function updateShadow() {}
export function pogoShadow() {}
export function slashShadow() {}
export function shadowContact() {}
export function drawShadow() {}
export function drawShadowHud() {}
