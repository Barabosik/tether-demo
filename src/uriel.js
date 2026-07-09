/* Boss stub. The public demo ships Worlds 1-3 only; this enemy never spawns
 * here. The export surface is preserved as no-ops so the shared combat/enemies
 * dispatch keeps resolving its imports. */
export const mkUriel = (x, y) => ({ kind: "uriel", x, y, dead: true, hp: 0 });
export function updateUriel() {}
export function drawUriel() {}
export function urielContact() {}
export function pogoUriel() {}
export function slashUriel() {}
export function drawUrielHud() {}
