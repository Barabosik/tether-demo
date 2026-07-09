/* NPC stub. The public demo ships without NPCs; levels place none. The export
 * surface is preserved as no-ops so callers (game, editor) keep resolving. */
export const newNpcId = () => "n-" + Math.random().toString(36).slice(2, 6);
export const NPC_R = 46;
export function nearestNpc() { return null; }
export function tryTalkNpc() { return false; }
export function updateNpcs() {}
export function drawNpcs() {}
export function drawNpcPrompt() {}
