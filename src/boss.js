/* Boss stub. The public demo ships Worlds 1-3 only; this enemy never spawns
 * here. The export surface is preserved as no-ops so the shared combat/enemies
 * dispatch keeps resolving its imports. */
export const mkKeeper = (x, y) => ({ kind: "keeper", x, y, dead: true, hp: 0 });
export function updateKeeper() {}
export function drawKeeper() {}
export function keeperContact() {}
export function pogoKeeper() {}
export function slashKeeper() {}
export function drawKeeperHud() {}
