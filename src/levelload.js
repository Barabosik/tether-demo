import { mkDrone, mkDart, mkWard, mkBloom, mkKeeper, mkWisp, mkReaper, mkBaphomet, mkLeviathan, mkUriel, mkArchitect, mkShadow } from "./enemies.js";
import { mkCrumble, mkMover, mkMoverPath, mkGrip } from "./platforms.js";
import { instantiateHazards } from "./hazards.js";

/* Level data <-> runtime. Levels live as plain JSON (src/levels/*.json —
 * the SAME structures the editor manipulates, no parallel format);
 * instantiateLevel() deep-clones a data object into live runtime state
 * (hydrating enemy/terrain builders and zeroing runtime timers). The data
 * object itself is never mutated by play. */

const MK_ENEMY = { drone: mkDrone, dart: mkDart, ward: mkWard, bloom: mkBloom, keeper: mkKeeper,
                   wisp: mkWisp, reaper: mkReaper, baphomet: mkBaphomet, leviathan: mkLeviathan, uriel: mkUriel, architect: mkArchitect, shadow: mkShadow };

export function instantiateLevel(data) {
  return {
    solids: data.solids.map((s) => {
      if (s.kind === "crumble") return mkCrumble(s.x, s.y, s.w, s.h);
      if (s.kind === "mover") // waypoint paths and legacy x2/y2 rails both load
        return s.path ? mkMoverPath(s) : mkMover(s.x, s.y, s.w, s.h, s.x2, s.y2, s.speed);
      if (s.kind === "grip") return mkGrip(s.x, s.y, s.w, s.h);
      if (s.kind === "gate")
        return { kind: "gate", x: s.x, y: s.y, w: s.w, h: s.h, baseH: s.h, link: s.link || "g1", openT: 0 };
      if (s.kind === "oneway" || s.kind === "valve") return { ...s };
      return { ...s }; // plain terrain — surface/conveyorSpeed/layer ride along
    }),
    spikes: data.spikes.map((s) => ({ ...s })),
    anchors: data.anchors.map((a) => {
      if (a.kind === "zip") // slides its rail while latched (home x0/y0 → end x2/y2)
        return { kind: "zip", x: a.x, y: a.y, x0: a.x, y0: a.y,
                 x2: a.x2 ?? a.x + 240, y2: a.y2 ?? a.y, speed: a.speed || 230, zt: 0 };
      if (a.kind === "sling") return { kind: "sling", x: a.x, y: a.y }; // rubber-band launch
      return { x: a.x, y: a.y };
    }),
    nodes: data.nodes.map((n) => ({ x: n.x, y: n.y, pulse: 0 })),
    enemies: data.enemies.map((e) => {
      const m = (MK_ENEMY[e.kind] || mkDrone)(e.x, e.y);
      if (e.frenzy) m.frenzy = e.frenzy;      // E3 — the frenzy overlay scalar
      if (e.halo) m.halo = true;              // W6 — angelic reskin (palette only)
      if (e.phantom) m.phantom = true;
      if (e.corrupted) m.corrupted = true;
      return m;
    }),
    hints: (data.hints || []).map((h) => ({ ...h })),
    coins: (data.coins || []).map((c) => ({ x: c.x, y: c.y, taken: false })),
    fragments: (data.fragments || []).map((f) => ({ ...f })),
    npcs: (data.npcs || []).map((n) => ({ ...n })),
    triggers: (data.triggers || []).map((t) => ({ ...t, hit: false })),
    decor: (data.decor || []).map((d) => ({ ...d })),
    props: (data.props || []).map((pr) => ({ ...pr, broken: false, pressed: false, latched: false })),
    hazards: instantiateHazards(data.hazards),
    goal: { ...data.goal },
    spawn: { ...data.spawn },
  };
}

/* SPIKE-FLUSH (unchanged behavior, moved here with the loader): base flush on
 * the world floor, tips raised to a lip below the lower neighbouring STATIC
 * rim; `deep` spikes keep their authored tip height (swing headroom); pogo
 * nodes force clearance. Runs on the INSTANTIATED clone at load. */
export function alignSpikes(solids, spikes, worldH, nodes = []) {
  const LIP = 46, EPS = 2, NODE_CLEAR = 70;
  for (const sp of spikes) {
    if (sp.rot || sp.pin) continue; // rotated/pinned spikes keep their rect exactly
    if (sp.deep) { sp.h = worldH - sp.y; continue; }
    let rim = -Infinity;
    for (const s of solids) {
      if (s.kind) continue; // movers roam and crumbles vanish — no lip authority
      const touchesX = s.x <= sp.x + sp.w + EPS && s.x + s.w >= sp.x - EPS;
      if (touchesX && s.y < worldH) rim = Math.max(rim, s.y);
    }
    let top = rim > -Infinity ? rim + LIP : sp.y;
    for (const n of nodes) {
      if (n.x >= sp.x - EPS && n.x <= sp.x + sp.w + EPS)
        top = Math.max(top, n.y + NODE_CLEAR);
    }
    top = Math.min(sp.y, top);
    sp.y = top;
    sp.h = worldH - top;
  }
  return spikes;
}
