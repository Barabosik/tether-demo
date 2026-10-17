import { alignSpikes } from "./levels.js";

/* Level thumbnails — the one canvas helper the DOM UI still uses: the select
 * screen blits these cached minimaps into its cards. Every menu SCREEN now
 * lives in selectScreen.js / panelScreens.js (DOM). */
// pre-render one minimap thumbnail per level. Cached BY ID: reorders and
// world switches reuse canvases instead of rebuilding ~24 offscreen levels
// (the old full rebuild made the slot arrows feel broken-laggy). Geometry
// edits invalidate explicitly (editor save / online reload).
const thumbCache = new Map();
export function invalidateThumbs(id) {
  if (id == null) thumbCache.clear();
  else thumbCache.delete(id);
}
// thumbnails render at 2× the card slot (184×104 css px) so they stay crisp
export const THUMB_W = 368, THUMB_H = 208;

const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a, b, k) => {
  const A = hex(a), B = hex(b);
  return `rgb(${A.map((v, i) => Math.round(v * (1 - k) + B[i] * k)).join(",")})`;
};

// each world's own ground and stone (worldbg.js) — the card reads as a small
// window onto that world, not a schematic
const THUMB_WORLD = {
  1: { base: "#0c1722", rock: "#2a3542", lip: "#5d7186" },
  2: { base: "#13151a", rock: "#3a352e", lip: "#7a6a54" },
  3: { base: "#1a0e10", rock: "#3a2222", lip: "#7a4636" },
};

export function makeThumbs(LEVELS) {
  return LEVELS.map((L) => {
    const hit = thumbCache.get(L.id);
    if (hit) return hit;
    const cv = document.createElement("canvas");
    cv.width = THUMB_W;
    cv.height = THUMB_H;
    const g = cv.getContext("2d");
    const d = L.build();
    alignSpikes(d.solids, d.spikes, L.world.h, d.nodes);
    const P = THUMB_WORLD[L.worldId] || THUMB_WORLD[1];
    const W = THUMB_W, H = THUMB_H;

    // ground: the world's base, a little lighter toward the floor
    g.fillStyle = P.base;
    g.fillRect(0, 0, W, H);
    const wash = g.createLinearGradient(0, 0, 0, H);
    wash.addColorStop(0, "rgba(0,0,0,0)");
    wash.addColorStop(1, mix(P.base, P.lip, 0.18));
    g.fillStyle = wash;
    g.fillRect(0, 0, W, H);

    // framing: fit the whole level when its shape is close to the card's;
    // very wide or tall levels zoom in (capped) around the spawn→goal route
    const ww = L.world.w, wh = L.world.h;
    const sFit = Math.min(W / ww, H / wh), sFill = Math.max(W / ww, H / wh);
    const sp = d.spawn || { x: ww / 2, y: wh / 2 };
    const gc = d.goal ? { x: d.goal.x + d.goal.w / 2, y: d.goal.y + d.goal.h / 2 } : sp;
    // …but never so far that the spawn or the goal leaves the frame
    const sRoute = Math.min(W / (Math.abs(gc.x - sp.x) + 360), H / (Math.abs(gc.y - sp.y) + 360));
    const s = Math.max(sFit, Math.min(sFill, sFit * 1.45, sRoute));
    const clampC = (c, span, view) => (span * s <= view ? span / 2 : Math.max(view / s / 2, Math.min(span - view / s / 2, c)));
    const cx = clampC((sp.x + gc.x) / 2, ww, W), cy = clampC((sp.y + gc.y) / 2, wh, H);
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(s, s);
    g.translate(-cx, -cy);
    const px = 1 / s; // one thumbnail pixel, in world units

    // rock: a body in the world's stone with a lit top lip, like the game
    const KIND = { crumble: "#6e5a44", mover: "#4f6670", grip: "#4d6b57", scorch: "#5a2a24" };
    for (const r of d.solids) {
      const body = KIND[r.kind] || (r.surface === "ice" ? "#557079" : r.surface === "bouncy" ? "#5b7550" : P.rock);
      g.fillStyle = body;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.fillStyle = KIND[r.kind] ? mix(KIND[r.kind], "#e4e1d3", 0.35) : P.lip;
      g.fillRect(r.x, r.y, r.w, Math.min(r.h, 3 * px));
    }

    // spikes: a row of teeth (deep pits keep a dark body under them)
    const tooth = 8 * px;
    g.fillStyle = "#d9654f";
    for (const r of d.spikes) {
      g.save();
      g.translate(r.x + r.w / 2, r.y + r.h / 2);
      if (r.rot) g.rotate((r.rot * Math.PI) / 180);
      const w = r.w, top = -r.h / 2;
      if (r.deep && r.h > tooth) { g.fillStyle = "#3a1a18"; g.fillRect(-w / 2, top + tooth * 0.8, w, r.h - tooth * 0.8); g.fillStyle = "#d9654f"; }
      const n = Math.max(1, Math.round(w / tooth));
      const tw = w / n;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x0 = -w / 2 + i * tw;
        g.moveTo(x0, top + tooth);
        g.lineTo(x0 + tw / 2, top);
        g.lineTo(x0 + tw, top + tooth);
      }
      g.fill();
      g.restore();
    }

    // hazards: saws/pendulum bobs as discs, crushers/lasers as bars
    for (const h of d.hazards) {
      if (h.kind === "laser") { g.fillStyle = "rgba(229,115,95,0.75)"; g.fillRect(h.x + h.w / 2 - px, h.y, 2 * px, h.h); }
      else if (h.w && h.h) { g.fillStyle = "#8a4a3a"; g.fillRect(h.x, h.y, h.w, h.h); }
      else {
        const hx = h.kind === "pendulum" ? h.hx ?? h.x : h.x, hy = h.kind === "pendulum" ? h.hy ?? h.y : h.y;
        g.fillStyle = "#c7614c";
        g.beginPath(); g.arc(hx, hy, Math.max(h.r || 20, 3.5 * px), 0, Math.PI * 2); g.fill();
      }
    }

    // grapple rings: gold outlines, the game's own read for "swing here"
    g.strokeStyle = "#e3cf5c";
    g.lineWidth = 2.4 * px;
    for (const a of d.anchors) { g.beginPath(); g.arc(a.x, a.y, 6 * px, 0, Math.PI * 2); g.stroke(); }
    // pogo nodes + coins: small bone and gold diamonds
    const diamond = (x, y, r) => { g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.fill(); };
    g.fillStyle = "#c9c8bc";
    for (const n of d.nodes) diamond(n.x, n.y, 5.5 * px);
    g.fillStyle = "#e3cf5c";
    for (const c of d.coins) diamond(c.x, c.y, 4.5 * px);
    // foes: warm dots; bosses read bigger
    g.fillStyle = "#e5735f";
    for (const en of d.enemies) {
      const boss = ["reaper", "baphomet", "leviathan", "keeper"].includes(en.kind);
      g.beginPath(); g.arc(en.x, en.y, (boss ? 13 : 5) * px, 0, Math.PI * 2); g.fill();
    }

    // goal: a gold frame; spawn: the player, a bone sliver
    if (d.goal) {
      g.fillStyle = "rgba(227,207,92,0.22)";
      g.fillRect(d.goal.x, d.goal.y, d.goal.w, d.goal.h);
      g.strokeStyle = "#e3cf5c";
      g.lineWidth = 2 * px;
      g.strokeRect(d.goal.x, d.goal.y, d.goal.w, d.goal.h);
    }
    if (d.spawn) {
      g.fillStyle = "#e4e1d3";
      g.fillRect(d.spawn.x - 3.5 * px, d.spawn.y - 12 * px, 7 * px, 12 * px);
    }
    g.restore();
    thumbCache.set(L.id, cv);
    return cv;
  });
}
