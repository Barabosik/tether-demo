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
    g.fillStyle = "#121715";
    g.fillRect(0, 0, 184, 104);
    const s = Math.min(184 / L.world.w, 104 / L.world.h);
    const ox = (184 - L.world.w * s) / 2, oy = (104 - L.world.h * s) / 2;
    g.save();
    g.translate(ox, oy);
    g.scale(s, s);
    // a quiet minimap in the UI palette: bone-grey rock, jade anchors, the
    // hazards and the goal the only warm marks
    const SK = { crumble: "#6e5f4c", mover: "#4f6670", grip: "#4d6b57" };
    const SURF = { ice: "#557079", bouncy: "#5b7550", sticky: "#4a4652", conveyor: "#665c45" };
    const dot = (x, y, r) => { g.beginPath(); g.arc(x, y, r / s, 0, Math.PI * 2); g.fill(); };
    for (const r of d.solids) {
      g.fillStyle = SK[r.kind] || SURF[r.surface] || "#3b4743";
      g.fillRect(r.x, r.y, r.w, r.h);
    }
    g.fillStyle = "#b5543f";
    for (const r of d.spikes) {
      if (r.rot) {
        g.save();
        g.translate(r.x + r.w / 2, r.y + r.h / 2);
        g.rotate((r.rot * Math.PI) / 180);
        g.fillRect(-r.w / 2, -r.h / 2, r.w, Math.max(r.h, 3 / s));
        g.restore();
      } else g.fillRect(r.x, r.y, r.w, Math.max(r.h, 3 / s));
    }
    g.fillStyle = "#9fc7b8";
    for (const a of d.anchors) dot(a.x, a.y, 3.2);
    g.fillStyle = "#c9c8bc";
    for (const n of d.nodes) dot(n.x, n.y, 3.2);
    g.fillStyle = "#e5735f";
    for (const en of d.enemies) dot(en.x, en.y, en.kind === "reaper" ? 6 : 3);
    g.fillStyle = "#e3cf5c";
    g.fillRect(d.goal.x, d.goal.y, d.goal.w, d.goal.h);
    g.restore();
    thumbCache.set(L.id, cv);
    return cv;
  });
}
