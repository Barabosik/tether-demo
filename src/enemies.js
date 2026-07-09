import { CONFIG as C } from "./config.js";
import { clamp, lerp, len2, circleRect, segRectT, rand, drawStarPath } from "./util.js";
import { addParticle, burst, ringFx, impact } from "./fx.js";
import { sfx } from "./audio.js";
import { mkKeeper, updateKeeper, drawKeeper, keeperContact } from "./boss.js";
import { mkBaphomet, updateBaphomet, drawBaphomet, baphometContact, updateInfernalDrop } from "./baphomet.js";
import { mkLeviathan, updateLeviathan, drawLeviathan, leviathanContact } from "./leviathan.js";
import { mkUriel, updateUriel, drawUriel, urielContact } from "./uriel.js";
import { mkArchitect, updateArchitect, drawArchitect } from "./architect.js";
import { mkShadow, updateShadow, drawShadow } from "./shadow.js";
import { mkReaper, updateReaper, drawReaper, reaperContact, boltReaper } from "./reaper.js";

export { mkKeeper, mkBaphomet, mkLeviathan, mkUriel, mkArchitect, mkShadow };
export { mkReaper };

/* Enemy archetypes. Design rule (the Hollow Knight contract): every attack is
 * telegraphed by silhouette + colour + sound BEFORE it can hurt you, and every
 * attack leaves a punish window after. Each archetype forces a different
 * decision against the movement kit — none of them is a stationary target:
 *
 *  DRONE — the passive baseline: bobbing body, contact damage, pogo platform.
 *          The "training dummy" of the pack (and the bounce stone in lakes).
 *  DART  — the charger. Sees you -> shakes + aim line -> line locks (freeze) ->
 *          LUNGES through your lane -> dizzy (harmless, take your hit).
 *          Decision: dash THROUGH it (i-frames), sidestep the locked line, or
 *          stomp it mid-flight (pogo interrupts straight into dizzy).
 *  WARD  — the mounted turret. Tracks with a brightening aim line, fires slow
 *          bolts. Bolts die on terrain, can be SLASHED apart, and dash
 *          i-frames eat them. Decision: keep tempo through its lane, or close
 *          the gap and cut it down in the post-shot cooldown.
 *  BLOOM — the regrowing mine. Linger inside its radius and it fuses:
 *          accelerating blink + a preview ring of the exact blast. Pop it from
 *          range (slash), pogo it (bounce away as it blows), or dash through
 *          on i-frames. The blast also hurts OTHER enemies — chain reactions
 *          are encouraged. It reblooms, so it shapes routes forever.
 */

// ------------------------------------------------------------------ builders
const base = (kind, x, y, r, hp) => ({
  kind, x, y, px: x, py: y, home: { x, y },
  vx: 0, vy: 0, r, hp,
  phase: Math.random() * Math.PI * 2,
  hurtT: 0, lastHit: 0, dead: false, deathT: 0, alertT: 0,
});
export const mkDrone = (x, y) => base("drone", x, y, C.DRONE_R, C.DRONE_HP);
export const mkDart = (x, y) =>
  ({ ...base("dart", x, y, C.DART_R, C.DART_HP), state: "patrol", t: 0, lockX: 1, lockY: 0 });
export const mkWard = (x, y) =>
  ({ ...base("ward", x, y, C.WARD_R, C.WARD_HP), state: "idle", t: 0, aimX: 1, aimY: 0 });
export const mkBloom = (x, y) =>
  ({ ...base("bloom", x, y, C.BLOOM_R, 1), state: "idle", t: 0, blink: 0 });
export const mkWisp = (x, y) =>
  ({ ...base("wisp", x, y, C.WISP_R, C.WISP_HP), trailT: 0 });

const los = (st, x0, y0, x1, y1) => {
  for (const s of st.solids)
    if (!s.gone && s.kind !== "oneway" && s.kind !== "valve" &&
        segRectT(x0, y0, x1, y1, s) <= 1) return false;
  return true;
};

// --------------------------------------------------------- shared damage I/O
// brain but CANNOT touch you: "they don't attack physically" (WORLDS.md). The
// one shared damage path — every contact, bolt, blast, AoE — honors it.
let phantomActive = false;
// the ONE enemy->player damage path (contact, bolts, blasts): knockback style,
// gated by dash i-frames AND the shared mercy window — never two hearts at once
export function damagePlayer(st, fromX, fromY, kb = C.CONTACT_KNOCKBACK) {
  const p = st.player;
  if (phantomActive) return false; // a regret lashes out, but it's only an echo
  if (p.iT > 0 || p.hurtInvuln > 0 || st.deathT > 0 || st.won) return false;
  p.hp--;
  st.hits = (st.hits || 0) + 1;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const dx = pcx - fromX, dy = pcy - fromY;
  const l = len2(dx, dy) || 1;
  p.vx = (dx / l) * kb;
  p.vy = (dy / l) * kb - 220;
  p.grapple = null; // the hit knocks the rope out of your hand
  p.dashing = false;
  p.hurtInvuln = C.DAMAGE_INVULN;
  p.blinkT = C.DAMAGE_INVULN;
  sfx.hurt();
  impact(st, C.HITSTOP_HURT, C.SHAKE_HURT, { r: 255, g: 70, b: 70, a: 0.35 });
  burst(st, pcx, pcy, 14, 320, "#ff6b6b", 400, true);
  return true;
}

// per-kind death: how long the body's death animation plays (drawn in
// drawEnemies during deathT) + the shock-ring's colour. Each enemy dies in
// ITS OWN way — the husk cracks, the dart shatters, the shroud collapses, the
// shade unravels — instead of the one generic ring everything used to pop into.
const DEATH = {
  drone: { dur: 0.42, ring: "rgba(255,93,93,0.85)" },
  dart:  { dur: 0.34, ring: "rgba(255,177,74,0.85)" },
  ward:  { dur: 0.46, ring: "rgba(176,140,255,0.85)" },
  wisp:  { dur: 0.52, ring: "rgba(159,232,255,0.7)" },
};
// the debris each death throws (particles that outlive the body)
function deathDebris(st, e) {
  const spark = (x, y, vx, vy, life, size, color, grav) =>
    addParticle(st, { x, y, vx, vy, life, max: life, grav, size, color, glow: true });
  if (e.kind === "drone") { // husk chunks + red sparks blow apart
    for (let i = 0; i < 11; i++) { const a = Math.random() * Math.PI * 2, s = rand(140, 440);
      spark(e.x, e.y, Math.cos(a) * s, Math.sin(a) * s - 40, rand(0.3, 0.58), rand(2, 4.2), i % 2 ? "#3a1420" : "#ff5d5d", 520); }
  } else if (e.kind === "dart") { // slivers shear off along its heading
    for (let i = 0; i < 9; i++) { const a = e.deathAng + rand(-0.7, 0.7), s = rand(220, 580);
      spark(e.x, e.y, Math.cos(a) * s, Math.sin(a) * s, rand(0.22, 0.46), rand(2, 3.6), i % 2 ? "#241a0c" : "#ffb14a", 240); }
  } else if (e.kind === "ward") { // embers rain off the collapsing shroud
    for (let i = 0; i < 11; i++) { const a = rand(-2.7, -0.4), s = rand(70, 270);
      spark(e.x, e.y - e.r * 0.3, Math.cos(a) * s, Math.sin(a) * s, rand(0.4, 0.85), rand(2, 3.6), "#b08cff", 640); }
  } else if (e.kind === "wisp") { // motes rise and fade (floaty — negative grav)
    for (let i = 0; i < 13; i++) { const a = Math.random() * Math.PI * 2, s = rand(24, 110);
      spark(e.x, e.y, Math.cos(a) * s * 0.6, Math.sin(a) * s * 0.6 - rand(30, 95), rand(0.5, 1.05), rand(1.5, 3), i % 3 ? "#9fe8ff" : "#dff6ff", -20); }
  } else {
    burst(st, e.x, e.y, 26, 420, TINT[e.kind] || "#ff8a5d", 420, true);
  }
}

export function killEnemy(st, e) {
  e.dead = true;
  const D = DEATH[e.kind];
  e.deathT = D ? D.dur : 0.28;
  e.deathMax = e.deathT;
  e.deathAng = Math.atan2(e.vy || 0, e.vx || 0.001); // heading for directional shatters
  st.kills++;
  sfx.kill();
  // the kill-POP: the punch, a white core-flash over the kind's shock-ring,
  // then the kind's debris. Flash swells a touch with the live style combo, so
  // a chained kill reads BIGGER (the W6 power-fantasy).
  const combo = Math.min(1, (st.style?.count || 0) / 8);
  impact(st, C.HITSTOP_KILL, C.SHAKE_KILL, { r: 255, g: 222, b: 184, a: 0.26 + combo * 0.14 });
  ringFx(st, e.x, e.y, "rgba(255,255,255,0.92)", e.r * 2.1, 0.15);
  ringFx(st, e.x, e.y, (D && D.ring) || "rgba(255,160,120,0.9)", e.r * 3.4, 0.34);
  deathDebris(st, e);
}

// generic damage (explosions, environment) — melee has its own path in combat
export function damageEnemy(st, e, dmg) {
  if (e.dead) return;
  if (e.kind === "keeper") return; // the shield answers to pogo-in-window only
  if (e.kind === "baphomet") return; // the brand answers to the stun window only
  if (e.kind === "leviathan") return; // the crown answers to the head window only
  if (e.kind === "uriel") return; // the radiance answers only to a phase-through
  if (e.kind === "architect") return; // the law answers only in the re-ink window
  if (e.kind === "shadow") return;
  if (e.kind === "reaper") return; // the exposed gate owns every damage path
  if (e.kind === "bloom") { triggerBloom(st, e, true); return; }
  e.hp -= dmg;
  e.hurtT = 0.3;
  if (e.hp <= 0) killEnemy(st, e);
}

// ------------------------------------------------------------------- blooms
export function triggerBloom(st, e, short) {
  if (e.dead || e.state === "seed") return;
  if (e.state !== "fuse") {
    e.state = "fuse";
    e.t = (short ? C.BLOOM_FUSE_SHORT : C.BLOOM_FUSE) / (e.frenzy || 1);
    e.blink = 0;
    e.alertT = 0.4;
  } else if (short && e.t > C.BLOOM_FUSE_SHORT) {
    e.t = C.BLOOM_FUSE_SHORT; // popping an already-lit bloom hurries it
  }
}

function explodeBloom(st, e) {
  const p = st.player;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const prox = clamp(1 - len2(e.x - pcx, e.y - pcy) / 500, 0, 1);
  sfx.boom();
  impact(st, prox > 0.6 ? C.HITSTOP_HEAVY : 0, 0.3 + prox * 0.4,
    { r: 220, g: 255, b: 140, a: 0.10 + prox * 0.15 });
  ringFx(st, e.x, e.y, "rgba(205,242,110,0.95)", C.BLOOM_BLAST, 0.35);
  ringFx(st, e.x, e.y, "rgba(255,255,255,0.7)", C.BLOOM_BLAST * 0.55, 0.22);
  burst(st, e.x, e.y, 30, 480, "#cdf26e", 380, true);
  burst(st, e.x, e.y, 12, 220, "#ffffff", 200, true);
  // a drifting spore cloud lingers after the crack — floaty, near-weightless,
  // hangs in the air where the pod burst (the pod IS a spore mine)
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2, s = rand(30, 150);
    addParticle(st, { x: e.x, y: e.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - rand(10, 70),
      life: rand(0.6, 1.35), max: 1.35, grav: rand(-24, 26), size: rand(1.5, 3.6),
      color: Math.random() < 0.5 ? "#cdf26e" : "#e8ffb0", glow: true });
  }
  // the blast is a real AoE: player AND enemies (chain reactions welcome)
  if (len2(e.x - pcx, e.y - pcy) < C.BLOOM_BLAST + 8)
    damagePlayer(st, e.x, e.y, C.CONTACT_KNOCKBACK * 1.25);
  for (const o of st.enemies) {
    if (o === e || o.dead) continue;
    if (len2(o.x - e.x, o.y - e.y) > C.BLOOM_BLAST * 1.05 + o.r) continue;
    if (o.kind === "bloom") { // sympathetic detonation, staggered for readability
      if (o.state === "idle") { triggerBloom(st, o, true); o.t = 0.14; }
    } else damageEnemy(st, o, 2);
  }
  e.state = "seed";
  e.t = C.BLOOM_REGROW;
}

// --------------------------------------------------------------- per-kind AI
export function updateEnemies(st, dt) {
  const p = st.player;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const active = st.deathT <= 0 && !st.won;

  for (const e of st.enemies) {
    if (e.dead) { if (e.deathT > 0) e.deathT -= dt; continue; }
    phantomActive = !!e.phantom;
    if (e.hurtT > 0) e.hurtT -= dt;
    if (e.alertT > 0) e.alertT -= dt;
    // E3 — FRENZY (W4's corruption): the same brain, hotter numbers. A
    // frenzied archetype telegraphs tighter, moves faster, rests less —
    // tuning scalars only, never a new AI system (WORLDS.md accepted list).
    const fz = e.frenzy || 1;

    if (e.kind === "keeper") {
      updateKeeper(st, e, dt);
      keeperContact(st, e);
      continue;
    }
    if (e.kind === "baphomet") {
      updateBaphomet(st, e, dt);
      baphometContact(st, e);
      continue;
    }
    if (e.kind === "leviathan") {
      updateLeviathan(st, e, dt);
      leviathanContact(st, e);
      continue;
    }
    if (e.kind === "uriel") {
      updateUriel(st, e, dt);
      urielContact(st, e);
      continue;
    }
    if (e.kind === "architect") {
      updateArchitect(st, e, dt);
      continue;
    }
    if (e.kind === "shadow") {
      updateShadow(st, e, dt);
      continue;
    }
    if (e.kind === "reaper") {
      updateReaper(st, e, dt);
      reaperContact(st, e);
      continue;
    }
    if (e.kind === "drone") {
      // damped spring to a bobbing home point — knockback decays into a return
      const tx = e.home.x + Math.sin(st.simTime * 1.3 + e.phase) * 14;
      const ty = e.home.y + Math.sin(st.simTime * 2.1 + e.phase) * 10;
      e.vx += (tx - e.x) * 6 * dt - e.vx * 3 * dt;
      e.vy += (ty - e.y) * 6 * dt - e.vy * 3 * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;

    } else if (e.kind === "dart") {
      e.t -= dt;
      if (e.state === "patrol" || e.state === "cool") {
        const tx = e.home.x + Math.sin(st.simTime * 0.9 + e.phase) * 60;
        const ty = e.home.y + Math.sin(st.simTime * 1.7 + e.phase) * 12;
        e.vx += (tx - e.x) * 5 * dt - e.vx * 2.6 * dt;
        e.vy += (ty - e.y) * 5 * dt - e.vy * 2.6 * dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if (e.state === "cool" && e.t <= 0) e.state = "patrol";
        if (active && e.state === "patrol" &&
            len2(pcx - e.x, pcy - e.y) < C.DART_AGGRO && los(st, e.x, e.y, pcx, pcy)) {
          e.state = "tele"; e.t = C.DART_TELE / fz; e.alertT = 0.45;
          sfx.dartWind();
        }
      } else if (e.state === "tele") {
        e.vx *= Math.exp(-8 * dt); e.vy *= Math.exp(-8 * dt);
        e.x += e.vx * dt; e.y += e.vy * dt;
        if (e.t > C.DART_LOCK) { // track until the LOCK freeze — then the line is a promise
          const d = len2(pcx - e.x, pcy - e.y) || 1;
          e.lockX = (pcx - e.x) / d; e.lockY = (pcy - e.y) / d;
        }
        if (e.t <= 0) {
          e.state = "lunge"; e.t = C.DART_LUNGE_T;
          e.vx = e.lockX * C.DART_LUNGE_SPEED * fz;
          e.vy = e.lockY * C.DART_LUNGE_SPEED * fz;
          sfx.dartLunge();
        }
      } else if (e.state === "lunge") {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if ((st.rtime * 60 | 0) % 2 === 0)
          addParticle(st, { x: e.x, y: e.y, vx: -e.vx * 0.05, vy: -e.vy * 0.05,
            life: 0.2, max: 0.2, grav: 0, size: 3, color: "#ffb14a", glow: true });
        let wall = e.x < e.r || e.x > st.world.w - e.r;
        for (const s of st.solids)
          if (!s.gone && s.kind !== "oneway" && s.kind !== "valve" &&
              circleRect(e.x, e.y, e.r, s.x, s.y, s.w, s.h)) { wall = true; break; }
        if (wall || e.t <= 0) {
          if (wall) {
            sfx.dartThud();
            impact(st, 0, 0.15, null);
            burst(st, e.x, e.y, 10, 260, "#ffb14a", 300, true);
            e.x -= e.vx * dt * 1.5; e.y -= e.vy * dt * 1.5; // back out of the face
          }
          dizzyDart(st, e);
        }
      } else if (e.state === "dizzy") {
        e.vx *= Math.exp(-3 * dt); e.vy *= Math.exp(-3 * dt);
        e.y += Math.sin(st.simTime * 9 + e.phase) * 8 * dt;
        e.x += e.vx * dt; e.y += e.vy * dt;
        if (e.t <= 0) { e.state = "cool"; e.t = C.DART_COOL; }
      }

    } else if (e.kind === "ward") {
      const d = len2(pcx - e.x, pcy - e.y) || 1;
      if (e.state !== "charge" || e.t > 0.22) { // aim hardens just before the shot
        e.aimX = (pcx - e.x) / d; e.aimY = (pcy - e.y) / d;
      }
      if (e.state === "idle") {
        if (active && d < C.WARD_RANGE && los(st, e.x, e.y, pcx, pcy)) {
          e.state = "charge"; e.t = C.WARD_CHARGE / fz; e.alertT = 0.45;
          sfx.wardCharge();
        }
      } else if (e.state === "charge") {
        e.t -= dt;
        if (d > C.WARD_RANGE * 1.2 || !los(st, e.x, e.y, pcx, pcy)) {
          e.state = "idle"; // lost you — stand down
        } else if (e.t <= 0) {
          st.shots.push({ x: e.x + e.aimX * (e.r + 6), y: e.y + e.aimY * (e.r + 6),
            px: e.x, py: e.y,
            vx: e.aimX * C.SHOT_SPEED, vy: e.aimY * C.SHOT_SPEED,
            r: C.SHOT_R, life: C.SHOT_LIFE });
          sfx.wardShot();
          ringFx(st, e.x, e.y, "rgba(176,140,255,0.8)", 34, 0.18);
          e.state = "cool"; e.t = C.WARD_COOL / fz;
        }
      } else if (e.state === "cool") {
        e.t -= dt;
        if (e.t <= 0) e.state = "idle";
      }

    } else if (e.kind === "wisp") {
      // the harvest spirit: seeks THROUGH terrain — no LOS, no collision.
      // Never fast enough to catch clean movement; lethal to a camper.
      if (active) {
        const d = len2(pcx - e.x, pcy - e.y) || 1;
        e.vx += ((pcx - e.x) / d) * C.WISP_ACCEL * dt;
        e.vy += ((pcy - e.y) / d) * C.WISP_ACCEL * dt;
        const sp = len2(e.vx, e.vy);
        if (sp > C.WISP_SPEED * fz) { e.vx *= C.WISP_SPEED * fz / sp; e.vy *= C.WISP_SPEED * fz / sp; }
      } else {
        e.vx *= Math.exp(-2 * dt);
        e.vy *= Math.exp(-2 * dt);
      }
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.trailT -= dt;
      if (e.trailT <= 0) {
        e.trailT = 0.07;
        addParticle(st, { x: e.x, y: e.y, vx: -e.vx * 0.15, vy: -e.vy * 0.15,
          life: 0.35, max: 0.35, grav: -30, size: rand(2, 3.5), color: "#9fe8ff", glow: true });
      }

    } else if (e.kind === "bloom") {
      if (e.state === "seed") {
        e.t -= dt;
        if (e.t <= 0) { e.state = "idle"; sfx.regrow(); }
      } else {
        e.y = e.home.y + Math.sin(st.simTime * 1.1 + e.phase) * 14;
        e.x = e.home.x + Math.sin(st.simTime * 0.7 + e.phase) * 8;
        if (e.state === "idle") {
          if (active && len2(pcx - e.x, pcy - e.y) < C.BLOOM_TRIGGER)
            triggerBloom(st, e, false);
        } else if (e.state === "fuse") {
          e.t -= dt;
          const k = 1 - e.t / C.BLOOM_FUSE;
          const prevBlink = e.blink | 0;
          e.blink += dt * (5 + k * 13);
          if ((e.blink | 0) > prevBlink) sfx.bloomTick(k);
          if (e.t <= 0) explodeBloom(st, e);
        }
      }
    }
  }

  phantomActive = false; // never leak past the enemy loop — spikes/darts still bite
  updateShots(st, dt, active);
  updateInfernalDrop(st, dt); // Baphomet's reward — no-op unless spawned
  contactDamage(st);
}

function dizzyDart(st, e) {
  e.state = "dizzy";
  e.t = C.DART_DIZZY / (e.frenzy || 1);
  e.vx *= 0.1; e.vy *= 0.1;
}
export function interruptDart(st, e) { // pogo/heavy mid-flight cancels the threat
  if (e.state === "tele" || e.state === "lunge") dizzyDart(st, e);
}

function updateShots(st, dt, active) {
  const p = st.player;
  for (let i = st.shots.length - 1; i >= 0; i--) {
    const q = st.shots[i];
    q.px = q.x; q.py = q.y;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.life -= dt;
    let die = q.life <= 0;
    if (!die)
      for (const s of st.solids)
        if (!s.gone && s.kind !== "oneway" && s.kind !== "valve" &&
            circleRect(q.x, q.y, q.r, s.x, s.y, s.w, s.h)) { die = true; break; }
    if (!die && q.friendly) {
      // a DEFLECTED bolt is yours: it hunts enemies now (Keeper's shield
      // still laughs; the Reaper answers through his exposed gate)
      for (const e of st.enemies) {
        if (e.dead || e.kind === "keeper" || e.kind === "baphomet" || e.kind === "leviathan" || e.kind === "uriel" || e.kind === "architect" || e.kind === "shadow") continue;
        if (len2(q.x - e.x, q.y - e.y) > e.r + q.r + 2) continue;
        if (e.kind === "reaper") boltReaper(st, e);
        else damageEnemy(st, e, 1);
        die = true;
        break;
      }
    } else if (!die && active && circleRect(q.x, q.y, q.r, p.x, p.y, p.w, p.h)) {
      if (!q.phantom) damagePlayer(st, q.x, q.y, 420); // dash i-frames eat bolts — taught in L2
      die = true;
    }
    if (die) {
      burst(st, q.x, q.y, 6, 170, q.friendly ? "#ffe2a8" : "#b08cff", 150, true);
      const last = st.shots.pop(); // swap-and-pop (drawn order-independent)
      if (i < st.shots.length) st.shots[i] = last;
    }
  }
}

function contactDamage(st) {
  const p = st.player;
  if (p.iT > 0 || p.hurtInvuln > 0 || st.deathT > 0 || st.won) return;
  // STOMP PRIORITY: falling onto an enemy with attack intent is a pogo attempt
  // — the pogo box (not body contact) decides that exchange. Without this, the
  // body could clip the enemy a frame before the box connects and a clean
  // stomp still cost a heart (the double-damage-on-hit bug).
  const stompIntent = !p.onGround && p.vy > 60 &&
    (p.pogo || st.input.attackHeld || st.input.attackBuf > 0);
  const pcy = p.y + p.h / 2;
  for (const e of st.enemies) {
    if (e.dead || e.hurtT > 0) continue;
    if (e.kind === "bloom" || e.kind === "keeper" || e.kind === "reaper" || e.kind === "baphomet" || e.kind === "leviathan" || e.kind === "uriel" || e.kind === "architect" || e.kind === "shadow") continue; // own damage paths
    if (e.kind === "dart" && e.state === "dizzy") continue; // dizzy = safe punish window
    if (stompIntent && pcy < e.y - e.r * 0.25) continue;  // from above: the stomp wins
    if (!circleRect(e.x, e.y, e.r, p.x, p.y, p.w, p.h)) continue;
    damagePlayer(st, e.x, e.y,
      e.kind === "dart" && e.state === "lunge" ? C.CONTACT_KNOCKBACK * 1.2 : C.CONTACT_KNOCKBACK);
    break;
  }
  // brushing a bloom while dormant lights it up (dash-through = i-framed escape)
  for (const e of st.enemies)
    if (e.kind === "bloom" && !e.dead && e.state === "idle" &&
        circleRect(e.x, e.y, e.r + 6, p.x, p.y, p.w, p.h))
      triggerBloom(st, e, true);
}

// ------------------------------------------------------------------- render
const TINT = { drone: "#ff5d5d", dart: "#ffb14a", ward: "#b08cff", bloom: "#cdf26e",
               wisp: "#9fe8ff", reaper: "#ff4d6d" };

export function drawEnemies(ctx, st, alpha, pcx, pcy) {
  for (const e of st.enemies) {
    if (e.dead) {
      if (e.deathT > 0) drawDeath(ctx, e, clamp(1 - e.deathT / (e.deathMax || 0.2), 0, 1));
      continue;
    }
    const ex = lerp(e.px, e.x, alpha), ey = lerp(e.py, e.y, alpha);
    if (e.frenzy > 1) { // E3 corruption halo — the frenzy reads at a glance
      // (W6's angelic host wears it GOLD — same tell, holy palette)
      ctx.strokeStyle = e.halo
        ? `rgba(240,208,96,${0.26 + 0.16 * Math.sin(st.rtime * 6 + e.phase)})`
        : `rgba(224,48,74,${0.2 + 0.14 * Math.sin(st.rtime * 6 + e.phase)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ex, ey, e.r + 7, 0, Math.PI * 2); ctx.stroke();
      if (e.halo) { // the ring above the head — an angel at a glance
        ctx.strokeStyle = "rgba(255,244,200,0.75)";
        ctx.beginPath(); ctx.ellipse(ex, ey - e.r - 8, e.r * 0.45, e.r * 0.14, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    const BOSS_DRAW = { keeper: drawKeeper, baphomet: drawBaphomet, leviathan: drawLeviathan,
      uriel: drawUriel, architect: drawArchitect, reaper: drawReaper, shadow: drawShadow };
    if (BOSS_DRAW[e.kind]) {
      // "existing boss brains, void-dressed — tuning + palette, no new
      // systems"): the SAME brain draws at ghost alpha under a memory-blue
      // rim. Nothing else changes.
      if (e.phantom) { ctx.save(); ctx.globalAlpha = 0.6; }
      BOSS_DRAW[e.kind](ctx, st, e, ex, ey, st.rtime);
      if (e.phantom) {
        ctx.restore();
        if (!e.dead && e.state !== "sleep") {
          ctx.strokeStyle = `rgba(106,176,255,${0.3 + 0.16 * Math.sin(st.rtime * 3 + e.phase)})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(ex, ey, e.r + 12, 0, Math.PI * 2); ctx.stroke();
        }
      }
      continue;
    }
    if (e.kind === "drone") drawDrone(ctx, st, e, ex, ey, pcx, pcy);
    else if (e.kind === "dart") drawDart(ctx, st, e, ex, ey, pcx, pcy);
    else if (e.kind === "ward") drawWard(ctx, st, e, ex, ey, pcx, pcy);
    else if (e.kind === "bloom") drawBloom(ctx, st, e, ex, ey);
    else if (e.kind === "wisp") drawWisp(ctx, st, e, ex, ey);

    if (e.alertT > 0) { // the "!" ping — something just noticed you
      const a = clamp(e.alertT / 0.45, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 16px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText("!", ex, ey - e.r - 14 - (1 - a) * 8);
      ctx.globalAlpha = 1;
    }
    if (e.kind !== "bloom" && e.hp < hpMax(e)) // pips once you've drawn blood
      for (let i = 0; i < hpMax(e); i++) {
        ctx.fillStyle = i < e.hp ? TINT[e.kind] : "rgba(255,255,255,0.14)";
        ctx.fillRect(ex - 10 + i * 8, ey - e.r - 12, 5, 4);
      }
  }
}

const hpMax = (e) =>
  e.kind === "dart" ? C.DART_HP : e.kind === "ward" ? C.WARD_HP : C.DRONE_HP;

// A dark hunting wraith — a floating husk with three ragged shadow-barbs
// wheeling around it and one red eye locked on you (was a red disc + rotor
// lines). Silhouette + accent glow, the wanderer's grammar.
function drawDrone(ctx, st, d, dx, dy, pcx, pcy) {
  const flash = d.hurtT > 0.18;
  const A = "#ff5d5d";
  ctx.save();
  ctx.translate(dx, dy);
  // the barbs wheel slowly (was rotor fins) — dark spines with hot tips
  ctx.save();
  ctx.rotate(st.rtime * 1.7 + d.phase);
  for (let i = 0; i < 3; i++) {
    ctx.rotate((Math.PI * 2) / 3);
    ctx.shadowColor = A; ctx.shadowBlur = 5;
    ctx.fillStyle = flash ? "#ffffff" : "#3a1420";
    ctx.beginPath();
    ctx.moveTo(d.r - 2, -3); ctx.lineTo(d.r + 11, 0); ctx.lineTo(d.r - 2, 3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = flash ? "#ffffff" : A;
    ctx.beginPath(); ctx.arc(d.r + 10, 0, 1.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // the dark husk body + accent underglow
  ctx.shadowColor = A; ctx.shadowBlur = flash ? 16 : 11;
  ctx.fillStyle = flash ? "#ffffff" : "#2a1220";
  ctx.beginPath(); ctx.arc(0, 0, d.r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = flash ? "#ffffff" : "rgba(255,93,93,0.7)";
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(0, 0, d.r, 0, Math.PI * 2); ctx.stroke();
  // the single hunting eye tracks you, glowing (cyclops = never the player)
  const ex = pcx - dx, ey = pcy - dy, el = len2(ex, ey) || 1;
  const gx = (ex / el) * d.r * 0.34, gy = (ey / el) * d.r * 0.34;
  ctx.fillStyle = flash ? "#2a1220" : A;
  ctx.shadowColor = A; ctx.shadowBlur = flash ? 0 : 8;
  ctx.beginPath(); ctx.arc(gx, gy, 4.6, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#160a10";
  ctx.beginPath(); ctx.arc(gx + (ex / el) * 1.5, gy + (ey / el) * 1.5, 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawDart(ctx, st, e, ex, ey, pcx, pcy) {
  const flash = e.hurtT > 0.18;
  const tele = e.state === "tele";
  const lunge = e.state === "lunge";
  const dizzy = e.state === "dizzy";
  // telegraph aim line: fades in while tracking, goes SOLID once locked
  if (tele) {
    const locked = e.t <= C.DART_LOCK;
    const a = locked ? 0.85 : 0.35 * (1 - e.t / C.DART_TELE) + 0.1;
    ctx.strokeStyle = `rgba(255,177,74,${a})`;
    ctx.lineWidth = locked ? 2 : 1;
    if (!locked) ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex + e.lockX * C.DART_AGGRO, ey + e.lockY * C.DART_AGGRO);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.save();
  const jit = tele ? (1 - e.t / C.DART_TELE) * 3 : 0;
  ctx.translate(ex + rand(-jit, jit), ey + rand(-jit, jit));
  const ang = lunge || tele
    ? Math.atan2(e.lockY, e.lockX)
    : dizzy ? st.rtime * 4 : Math.atan2(pcy - ey, pcx - ex);
  ctx.rotate(ang);
  const stretch = lunge ? 1.45 : 1;
  ctx.scale(stretch, 1 / Math.sqrt(stretch));
  const A = "#ffb14a";
  const hot = flash || (tele && e.t <= C.DART_LOCK);
  // two dark tail-tatters stream behind the point (comet read)
  ctx.fillStyle = dizzy ? "rgba(138,90,51,0.4)" : "rgba(255,177,74,0.22)";
  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(-e.r * 0.3, 0);
    ctx.lineTo(-e.r * (0.9 + i * 0.55), (i % 2 ? 1 : -1) * e.r * 0.45);
    ctx.lineTo(-e.r * (0.5 + i * 0.4), 0);
    ctx.closePath(); ctx.fill();
  }
  // the dark arrowhead body — reads "fast thing pointing somewhere"
  ctx.shadowColor = A;
  ctx.shadowBlur = lunge ? 18 : 10;
  ctx.fillStyle = hot ? "#ffffff" : dizzy ? "#2a2016" : "#241a0c";
  ctx.beginPath();
  ctx.moveTo(e.r + 6, 0);
  ctx.lineTo(-e.r * 0.7, -e.r * 0.8);
  ctx.lineTo(-e.r * 0.3, 0);
  ctx.lineTo(-e.r * 0.7, e.r * 0.8);
  ctx.closePath();
  ctx.fill();
  // the hot amber barb along the leading edge
  ctx.strokeStyle = hot ? "#ffffff" : dizzy ? "#8a5a33" : A;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(-e.r * 0.3, 0); ctx.lineTo(e.r + 6, 0); ctx.stroke();
  ctx.shadowBlur = 0;
  // the amber eye near the head
  ctx.fillStyle = hot ? "#241a0c" : A;
  ctx.shadowColor = A; ctx.shadowBlur = hot ? 0 : 6;
  ctx.beginPath(); ctx.arc(e.r * 0.1, 0, 2.9, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
  if (dizzy) { // orbiting sparks — "hit me"
    for (let i = 0; i < 3; i++) {
      const a2 = st.rtime * 5 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = "rgba(255,220,160,0.7)";
      ctx.fillRect(ex + Math.cos(a2) * (e.r + 9) - 1.5, ey - e.r * 0.4 + Math.sin(a2) * 5 - 1.5, 3, 3);
    }
  }
}

function drawWard(ctx, st, e, ex, ey, pcx, pcy) {
  const flash = e.hurtT > 0.18;
  const charging = e.state === "charge";
  const k = charging ? 1 - e.t / C.WARD_CHARGE : 0;
  if (charging) { // the promise: this line is where the bolt will fly
    ctx.strokeStyle = `rgba(176,140,255,${0.15 + k * 0.6})`;
    ctx.lineWidth = 1 + k * 1.5;
    ctx.setLineDash([4, 9 - k * 5]);
    ctx.beginPath();
    ctx.moveTo(ex + e.aimX * (e.r + 6), ey + e.aimY * (e.r + 6));
    ctx.lineTo(ex + e.aimX * C.WARD_RANGE * 0.85, ey + e.aimY * C.WARD_RANGE * 0.85);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.save();
  ctx.translate(ex, ey);
  const A = "#b08cff";
  // mount stem down to its platform
  ctx.fillStyle = "#2a2038";
  ctx.fillRect(-5, e.r - 4, 10, e.r);
  ctx.shadowColor = A;
  ctx.shadowBlur = charging ? 10 + k * 14 : 8;
  // a dark shroud — a stationary hooded watcher (was a hex shell)
  ctx.fillStyle = flash ? "#ffffff" : "#1e1430";
  ctx.beginPath();
  ctx.moveTo(-e.r, e.r);
  ctx.quadraticCurveTo(-e.r * 1.05, -e.r * 0.4, 0, -e.r);
  ctx.quadraticCurveTo(e.r * 1.05, -e.r * 0.4, e.r, e.r);
  ctx.lineTo(e.r * 0.5, e.r * 0.72); ctx.lineTo(e.r * 0.16, e.r);
  ctx.lineTo(-e.r * 0.2, e.r * 0.72); ctx.lineTo(-e.r * 0.55, e.r);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = flash ? "#ffffff" : "rgba(176,140,255,0.6)";
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // the hood void the eye glows out of
  ctx.fillStyle = "#0e0818";
  ctx.beginPath(); ctx.ellipse(0, -e.r * 0.34, e.r * 0.6, e.r * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  // the eye tracks you; iris goes white-hot as the shot ripens
  const eyY = -e.r * 0.34;
  ctx.fillStyle = flash ? "#1e1430" : `rgba(${176 + k * 79},${140 + k * 115},255,1)`;
  ctx.shadowColor = A; ctx.shadowBlur = flash ? 0 : 7 + k * 9;
  ctx.beginPath(); ctx.arc(e.aimX * 5, eyY + e.aimY * 4, 5 + k * 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#0a0614";
  ctx.beginPath(); ctx.arc(e.aimX * 6.4, eyY + e.aimY * 5, 2.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawBloom(ctx, st, e, ex, ey) {
  const seed = e.state === "seed";
  const fusing = e.state === "fuse";
  if (seed) {
    const k = 1 - e.t / C.BLOOM_REGROW; // regrow sweep — you can SEE it coming back
    ctx.strokeStyle = "rgba(205,242,110,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ex, ey, e.r * 0.8, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(205,242,110,0.30)";
    ctx.beginPath(); ctx.arc(ex, ey, 3 + k * 4, 0, Math.PI * 2); ctx.fill();
    return;
  }
  if (fusing) { // the exact blast radius, promised in advance
    const k = clamp(1 - e.t / C.BLOOM_FUSE, 0, 1);
    ctx.strokeStyle = `rgba(205,242,110,${0.25 + k * 0.45})`;
    ctx.lineWidth = 1.5 + k;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.arc(ex, ey, C.BLOOM_BLAST * (0.6 + 0.4 * k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const hot = fusing && (e.blink | 0) % 2 === 0;
  const breathe = 1 + Math.sin(st.rtime * 2.2 + e.phase) * 0.06 + (fusing ? 0.15 : 0);
  const A = "#cdf26e";
  ctx.save();
  ctx.translate(ex, ey);
  ctx.rotate(st.rtime * 0.5 + e.phase);
  ctx.shadowColor = A;
  ctx.shadowBlur = fusing ? 16 : 9;
  // a dark barbed seed-pod (filled) with a glowing rim — was a bright flower
  drawStarPath(ctx, 0, 0, 6, e.r * 1.15 * breathe, e.r * 0.55 * breathe);
  ctx.fillStyle = hot ? "#ffffff" : "#16240e";
  ctx.fill();
  ctx.strokeStyle = hot ? "#ffffff" : A;
  ctx.lineWidth = 2;
  ctx.stroke();
  // the glowing heart — the fuse pulses in it
  ctx.fillStyle = hot ? "#ffffff" : A;
  ctx.beginPath(); ctx.arc(0, 0, e.r * 0.34 * breathe, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

export function drawShots(ctx, st, alpha) {
  for (const q of st.shots) {
    const x = lerp(q.px, q.x, alpha), y = lerp(q.py, q.y, alpha);
    ctx.save();
    // deflected bolts wear YOUR colors — gold, and angrier
    ctx.shadowColor = q.friendly ? "#ffd166" : "#b08cff";
    ctx.shadowBlur = q.friendly ? 16 : 12;
    ctx.fillStyle = q.friendly ? "#ffe2a8" : "#cdb3ff";
    ctx.beginPath(); ctx.arc(x, y, q.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(x, y, q.r * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// A drifting shade — a dark spirit core with a luminous cyan tail streaming
// off its motion and two glowing hollow eyes. Still a will-o'-wisp glow, but
// now it has a silhouette (was a pale blob).
function drawWisp(ctx, st, e, ex, ey) {
  const t = st.rtime;
  const A = "#9fe8ff";
  const pulse = 0.78 + 0.22 * Math.sin(t * 5 + e.phase);
  ctx.save();
  // luminous trailing tatters stream away from its motion (behind the core)
  const vl = len2(e.vx, e.vy) || 1;
  const bx = -e.vx / vl, by = -e.vy / vl;
  ctx.shadowColor = A; ctx.shadowBlur = 12 * pulse;
  ctx.fillStyle = "rgba(159,232,255,0.30)";
  for (let i = 1; i <= 3; i++) {
    const wob = Math.sin(t * 7 + e.phase + i) * 4;
    ctx.beginPath();
    ctx.arc(ex + bx * i * 9 - by * wob * 0.3, ey + by * i * 9 + bx * wob * 0.3,
      e.r * (1 - i * 0.26) * pulse, 0, Math.PI * 2);
    ctx.fill();
  }
  // the dark spirit core + strong cyan underglow
  ctx.shadowBlur = 15 * pulse;
  ctx.fillStyle = e.hurtT > 0 ? "#ffffff" : "#12242e";
  ctx.beginPath(); ctx.arc(ex, ey, e.r * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = e.hurtT > 0 ? "#ffffff" : "rgba(159,232,255,0.7)";
  ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(ex, ey, e.r * pulse, 0, Math.PI * 2); ctx.stroke();
  // glowing hollow eyes
  ctx.fillStyle = A; ctx.shadowColor = A; ctx.shadowBlur = 6;
  ctx.beginPath(); ctx.arc(ex - 4, ey - 1, 2.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(ex + 4, ey - 1, 2.1, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

// ---- deaths: each enemy's body finishes in its own way over deathT (k 0→1).
// The debris (deathDebris) is already flying; this animates what's LEFT.
function drawDeath(ctx, e, k) {
  const fade = 1 - k;
  if (e.kind === "drone") deathDrone(ctx, e, k, fade);
  else if (e.kind === "dart") deathDart(ctx, e, k, fade);
  else if (e.kind === "ward") deathWard(ctx, e, k, fade);
  else if (e.kind === "wisp") deathWisp(ctx, e, k, fade);
  else { // fallback — the old expanding ring
    ctx.globalAlpha = fade; ctx.strokeStyle = TINT[e.kind] || "#ff8a5d";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (1 + k), 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
// DRONE — the husk cracks into three wedges that spin apart; the eye flares
// once, then dark.
function deathDrone(ctx, e, k, fade) {
  const A = "#ff5d5d";
  ctx.save(); ctx.translate(e.x, e.y);
  for (let i = 0; i < 3; i++) {
    const a = e.phase + i * (Math.PI * 2 / 3), d = k * e.r * 1.7;
    ctx.save();
    ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
    ctx.rotate(a + k * 2.4);
    ctx.globalAlpha = fade;
    ctx.shadowColor = A; ctx.shadowBlur = 6 * fade;
    ctx.fillStyle = "#2a1220";
    ctx.beginPath();
    ctx.moveTo(0, -e.r * 0.5); ctx.lineTo(e.r * 0.52, e.r * 0.42); ctx.lineTo(-e.r * 0.42, e.r * 0.3);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = A; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }
  if (k < 0.5) { // the eye's last flare
    ctx.globalAlpha = 1 - k * 2;
    ctx.fillStyle = A; ctx.shadowColor = A; ctx.shadowBlur = 16 * (1 - k * 2);
    ctx.beginPath(); ctx.arc(0, 0, 4 + k * 7, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore(); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
// DART — the arrowhead shatters into slivers along its heading.
function deathDart(ctx, e, k, fade) {
  const A = "#ffb14a";
  ctx.save(); ctx.translate(e.x, e.y);
  ctx.globalAlpha = fade;
  for (let i = 0; i < 4; i++) {
    const a = e.deathAng + (i - 1.5) * 0.55, d = k * e.r * 2.1;
    ctx.save();
    ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
    ctx.rotate(a + k * 3.2);
    ctx.shadowColor = A; ctx.shadowBlur = 5 * fade;
    ctx.fillStyle = "#241a0c"; ctx.fillRect(-e.r * 0.5, -1.6, e.r * 0.95, 3.2);
    ctx.fillStyle = A; ctx.fillRect(e.r * 0.18, -1, e.r * 0.26, 2);
    ctx.restore();
  }
  ctx.restore(); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
// WARD — the shroud crumples DOWN into its mount; the eye winks to a point.
function deathWard(ctx, e, k, fade) {
  const A = "#b08cff";
  ctx.save(); ctx.translate(e.x, e.y);
  ctx.globalAlpha = fade;
  ctx.scale(1 + k * 0.16, 1 - k * 0.85); // squash vertically as it collapses
  ctx.shadowColor = A; ctx.shadowBlur = 8 * fade;
  ctx.fillStyle = "#1e1430";
  ctx.beginPath();
  ctx.moveTo(-e.r, e.r);
  ctx.quadraticCurveTo(-e.r * 1.05, -e.r * 0.4, 0, -e.r);
  ctx.quadraticCurveTo(e.r * 1.05, -e.r * 0.4, e.r, e.r);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  if (k < 0.5) { // the eye winks out — a bright dot shrinking to nothing
    const kk = 1 - k / 0.5;
    ctx.globalAlpha = kk;
    ctx.fillStyle = "#ffffff"; ctx.shadowColor = A; ctx.shadowBlur = 12 * kk;
    ctx.beginPath(); ctx.arc(e.x, e.y - e.r * 0.34 * fade, 5 * kk, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
// WISP — the shade unravels: the core swells and fades, the eyes drift up and
// are the last light to go out.
function deathWisp(ctx, e, k, fade) {
  const A = "#9fe8ff";
  ctx.save();
  ctx.globalAlpha = fade * 0.7;
  ctx.shadowColor = A; ctx.shadowBlur = 12 * fade;
  ctx.fillStyle = "#12242e";
  ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (1 + k * 0.7), 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = Math.max(0, 1 - k * 1.3);
  ctx.fillStyle = A; ctx.shadowColor = A; ctx.shadowBlur = 8;
  const sp = 4 + k * 9, ry = e.y - 1 - k * 12;
  ctx.beginPath(); ctx.arc(e.x - sp, ry, 2.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(e.x + sp, ry, 2.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore(); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
