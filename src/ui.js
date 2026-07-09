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
export function makeThumbs(LEVELS) {
  return LEVELS.map((L) => {
    const hit = thumbCache.get(L.id);
    if (hit) return hit;
    const cv = document.createElement("canvas");
    cv.width = 184;
    cv.height = 104;
    const g = cv.getContext("2d");
    const d = L.build();
    alignSpikes(d.solids, d.spikes, L.world.h, d.nodes);
    g.fillStyle = "#120d1a";
    g.fillRect(0, 0, 184, 104);
    const s = Math.min(184 / L.world.w, 104 / L.world.h);
    const ox = (184 - L.world.w * s) / 2, oy = (104 - L.world.h * s) / 2;
    g.save();
    g.translate(ox, oy);
    g.scale(s, s);
    const SK = { crumble: "#7c5a3e", mover: "#5b78a8", grip: "#4a7a52" };
    const SURF = { ice: "#4a6f8a", bouncy: "#4f7a44", sticky: "#3d2b55", conveyor: "#6b5a35" };
    for (const r of d.solids) {
      g.fillStyle = SK[r.kind] || SURF[r.surface] || "#3a2f4a";
      g.fillRect(r.x, r.y, r.w, r.h);
    }
    g.fillStyle = "#c23a50";
    for (const r of d.spikes) {
      if (r.rot) {
        g.save();
        g.translate(r.x + r.w / 2, r.y + r.h / 2);
        g.rotate((r.rot * Math.PI) / 180);
        g.fillRect(-r.w / 2, -r.h / 2, r.w, Math.max(r.h, 20 / s));
        g.restore();
      } else g.fillRect(r.x, r.y, r.w, Math.max(r.h, 20 / s));
    }
    g.fillStyle = "#ffd166";
    for (const a of d.anchors) { g.beginPath(); g.arc(a.x, a.y, 13 / s, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = "#ff4fa0";
    for (const n of d.nodes) { g.beginPath(); g.arc(n.x, n.y, 13 / s, 0, Math.PI * 2); g.fill(); }
    const EK = { drone: "#ff5d5d", dart: "#ffb14a", ward: "#b08cff", bloom: "#cdf26e",
                 wisp: "#9fe8ff", reaper: "#ff4d6d" };
    for (const en of d.enemies) {
      g.fillStyle = EK[en.kind] || "#ff5d5d";
      g.beginPath(); g.arc(en.x, en.y, 11 / s, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = "#fff3c4";
    g.fillRect(d.goal.x, d.goal.y, d.goal.w, d.goal.h);
    g.restore();
    thumbCache.set(L.id, cv);
    return cv;
  });
}
