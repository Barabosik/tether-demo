import { CONFIG as C } from "./config.js";
import { aabb } from "./util.js";

/* Continuous, penetration-based collision.
 *
 * Root causes this module replaces (the old code had all three):
 *  1. Discrete full-step integration: one big teleport per step, then overlap
 *     checks — fast movers could cross thin geometry between samples.
 *     -> Movement is SUBSTEPPED: travel is subdivided so no single move
 *        exceeds COLLIDE_SUBSTEP px. Above walking speed this is effectively
 *        swept collision; at low speed it costs nothing (1 substep).
 *  2. Resolution picked the push-out side from the VELOCITY SIGN. When the
 *     rope constraint (or any external displacement) shoved the player into
 *     a wall with vx ≈ 0 or pointing away, resolution either did nothing
 *     (stuck inside the wall) or snapped to the wrong side (teleport).
 *     -> Resolution now pushes out along MINIMAL PENETRATION, and only zeroes
 *        the velocity component actually driving into the surface — so walls
 *        depenetrate deterministically and surfaces slide instead of stick.
 *  3. The rope constraint ran after collision and could leave the player
 *     embedded until next frame.
 *     -> depenetrate() runs after the constraint every step.
 */

export function moveAndCollide(st, dt) {
  const p = st.player;
  p.colX = false;
  p.colY = false;
  p.onGround = false;
  p.groundSolid = null; // which solid the feet rest on (surface types read it)
  p.bounced = 0;        // set by a bouncy landing this step (game.js does fx)
  p.padLaunch = null;   // set by touching an armed angled pad (game.js launches)
  const dx = p.vx * dt, dy = p.vy * dt;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / C.COLLIDE_SUBSTEP));
  const sx = dx / n, sy = dy / n;
  for (let i = 0; i < n; i++) {
    p.x += sx;
    resolveAxis(st, p, true);
    p.y += sy;
    resolveAxis(st, p, false);
  }
}

function resolveAxis(st, p, xAxis) {
  const g = st.gravityDir || 1; // "landing" happens on the face opposing gravity
  for (const s of st.solids) {
    if (s.gone) continue; // crumbled platforms are air until they regrow
    if (s.h <= 0 || s.w <= 0) continue; // a fully-open gate is AIR (a zero-height
    // rect still has a top face in the sweep — the W6 lid caught feet at h=0)
    if (!aabb(p.x, p.y, p.w, p.h, s.x, s.y, s.w, s.h)) continue;
    // SCORCHED STONE (E1): a thin burnt pane SHATTERS to an INFERNAL dash —
    // the dash punches through instead of ending on it. Without the unlock
    // (or without dashing) it is plain solid wall. Shattered = gone for the
    // level (a broken door, not a hazard cycle). game.js does the fx.
    if (s.kind === "scorch" && st.infernal && p.dashing) {
      s.gone = true; s.shatterT = 0.35;
      p.scorched = s;
      continue;
    }
    // angled bounce pad: ANY resolved contact launches (game.js consumes)
    if (s.kind === "pad" && !(s.padCd > 0)) p.padLaunch = s;
    if (s.kind === "oneway") { // semi-solid: land from above only, pass otherwise
      if (g < 0) continue;     // gravity-flipped players sail through onewaye
      if (!xAxis && p.vy >= 0 && p.py + p.h <= s.y + 1) {
        p.y -= p.y + p.h - s.y;
        if (p.vy > 0) p.colY = true;
        p.vy = 0;
        p.onGround = true;
        p.groundSolid = s;
      }
      continue;
    }
    if (s.kind === "valve") { // one-way door: pass along dir, block against
      if (xAxis) {
        if (s.dir > 0 && p.px >= s.x + s.w - 0.5 && p.vx < 0) {
          p.x += s.x + s.w - p.x; p.vx = 0; p.colX = true;
        } else if (s.dir < 0 && p.px + p.w <= s.x + 0.5 && p.vx > 0) {
          p.x -= p.x + p.w - s.x; p.vx = 0; p.colX = true;
        }
      }
      continue;
    }
    if (xAxis) {
      const penL = p.x + p.w - s.x;   // push left by this much
      const penR = s.x + s.w - p.x;   // push right
      if (penL <= penR) {
        p.x -= penL;
        if (p.vx > 0) { p.vx = 0; p.colX = true; }
      } else {
        p.x += penR;
        if (p.vx < 0) { p.vx = 0; p.colX = true; }
      }
    } else {
      const penU = p.y + p.h - s.y;
      const penD = s.y + s.h - p.y;
      if (penU <= penD) {
        p.y -= penU;
        if (p.vy >= 0) {
          // bouncy surface: reflect a real landing instead of grounding.
          // Dashes are exempt (a dash is a commitment; it ends on contact).
          if (s.surface === "bouncy" && !p.dashing && p.vy > C.BOUNCE_MIN_VY) {
            p.bounced = p.vy;
            s.contactT = 0.22; // squash-stretch on the pad itself
            p.vy = -p.vy * C.BOUNCE_RESTITUTION;
          } else {
            if (p.vy > 0) p.colY = true;
            p.vy = 0;
            if (g > 0) { p.onGround = true; p.groundSolid = s; }
          }
        }
      } else {
        p.y += penD;
        if (p.vy < 0) {
          // under flipped gravity the UNDERSIDE is the floor — land (and
          // bouncy pads reflect) on the face opposing gravity, symmetrically
          if (g < 0 && s.surface === "bouncy" && !p.dashing && -p.vy > C.BOUNCE_MIN_VY) {
            p.bounced = -p.vy;
            s.contactT = 0.22;
            p.vy = -p.vy * C.BOUNCE_RESTITUTION;
          } else {
            p.vy = 0;
            p.colY = true;
            if (g < 0) { p.onGround = true; p.groundSolid = s; }
          }
        }
      }
    }
  }
}

// After external position edits (the rope constraint), push back out of any
// solid along least penetration. A few iterations settle corner cases.
export function depenetrate(st) {
  const p = st.player;
  const g = st.gravityDir || 1;
  for (let iter = 0; iter < 3; iter++) {
    let hit = false;
    for (const s of st.solids) {
      if (s.gone || s.kind === "oneway" || s.kind === "valve") continue;
      if (s.h <= 0 || s.w <= 0) continue; // open gates are air (see resolveAxis)
      if (!aabb(p.x, p.y, p.w, p.h, s.x, s.y, s.w, s.h)) continue;
      hit = true;
      const penL = p.x + p.w - s.x, penR = s.x + s.w - p.x;
      const penU = p.y + p.h - s.y, penD = s.y + s.h - p.y;
      const mx = Math.min(penL, penR), my = Math.min(penU, penD);
      if (mx <= my) {
        if (penL <= penR) { p.x -= penL; if (p.vx > 0) p.vx = 0; }
        else { p.x += penR; if (p.vx < 0) p.vx = 0; }
      } else {
        if (penU <= penD) {
          p.y -= penU;
          if (p.vy > 0) p.vy = 0;
          if (g > 0) { p.onGround = true; p.groundSolid = s; }
        } else {
          p.y += penD;
          if (p.vy < 0) p.vy = 0;
          if (g < 0) { p.onGround = true; p.groundSolid = s; }
        }
      }
    }
    if (!hit) break;
  }
}
