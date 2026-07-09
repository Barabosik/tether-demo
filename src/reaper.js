import { CONFIG as C } from "./config.js";
import { clamp, len2 } from "./util.js";
import { addParticle, burst, ringFx, impact } from "./fx.js";
import { sfx, music } from "./audio.js";
import { damagePlayer, mkWisp } from "./enemies.js";
import { bossIntro, bossPhaseBeat, bossKillBeat } from "./bossfx.js";

/* THE REAPER — DEATH WORLD's finale. The Keeper tested every verb; the
 * Reaper attacks the verb that DEFINES you — the tether itself:
 *
 *  SCYTHE  — a thrown, boomeranging blade. Its edge hurts YOU on contact and
 *            SEVERS YOUR ROPE where it crosses it (no damage — you keep your
 *            velocity, you lose your anchor). Dodge with your body AND route
 *            your rope out of its line: rope discipline as a dodge.
 *  SPIN    — he dives to the player and whirls the blade in a melee wall
 *            (the ring radius burns). When it winds down he EXHAUSTS —
 *            slumped, core bared: the punish window. Slash, pogo, anything.
 *  HARVEST — phase 2+: he rises high (out of slash reach), summons WISPS
 *            (terrain-ignoring chasers — keep moving) and fires a radial
 *            bolt volley. He is EXPOSED while casting — but he is UP THERE:
 *            the intended answers are a DEFLECTED bolt or a composite-pogo
 *            launch off a flank node. The deflect gets its boss moment.
 *
 * Damage lands ONLY while exposed (exhaust/harvest): slash 1 (heavy 2),
 * pogo 2, returned bolt 1. Any other time is a clink — but the pogo BOUNCE
 * is always free mobility. Phases at 16/8 hp tighten telegraphs, double the
 * scythes, and raise the wisp cap. Death opens the "boss"-linked gate. */

export const mkReaper = (x, y) => ({
  kind: "reaper", x, y, px: x, py: y, home: { x, y: y - 60 },
  vx: 0, vy: 0, r: C.REAPER_R, hp: C.REAPER_HP, maxHp: C.REAPER_HP,
  phase: Math.random() * Math.PI * 2,
  hurtT: 0, lastHit: 0, dead: false, deathT: 0, alertT: 0,
  state: "sleep", t: 0, seq: 0,
  scythes: [], spinA: 0, cutToast: false, volleyN: 0, wispT: 0,
});

const PATTERNS = {
  1: ["scythe", "spin"],
  2: ["scythe", "harvest", "spin", "scythe"],
  3: ["scythe", "scythe", "harvest", "spin"],
};
// is an OVERLAY on this exact brain (WORLDS.md: "the very first boss again,
// mutated"): faster windows, an extra chaotic-AoE RUPTURE that DEMANDS the
// Infernal Dash, and an arena that DESTROYS itself as he dives — never a
// new moveset. Its patterns weave the rupture in and lean on the spin
// (the dive that shatters the floor).
const CORRUPT_PATTERNS = {
  1: ["scythe", "spin", "rupture"],
  2: ["spin", "rupture", "scythe", "harvest"],
  3: ["rupture", "spin", "scythe", "spin", "rupture"],
};
const bossPhase = (e) => (e.hp > 16 ? 1 : e.hp > 8 ? 2 : 3);
const teleScale = (e) =>
  (e.corrupted ? [1, 0.78, 0.62, 0.5] : [1, 1, 0.82, 0.68])[bossPhase(e)];
export const reaperExposed = (e) => e.state === "exhaust" || e.state === "harvest";
export const RUPTURE_BAND = 46; // the safe-to-phase thickness of the shock ring

// point→segment distance (rope-cut test), returns the closest point too
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / L2, 0, 1);
  const cx = x1 + dx * t, cy = y1 + dy * t;
  return { d: len2(px - cx, py - cy), x: cx, y: cy };
}

function throwScythe(st, e) {
  const p = st.player;
  const tx = p.x + p.w / 2 + p.vx * 0.22, ty = p.y + p.h / 2 + p.vy * 0.1;
  const d = len2(tx - e.x, ty - e.y) || 1;
  e.scythes.push({
    x: e.x, y: e.y, px: e.x, py: e.y,
    vx: ((tx - e.x) / d) * C.SCYTHE_SPEED, vy: ((ty - e.y) / d) * C.SCYTHE_SPEED,
    ret: false, spin: 0,
  });
  sfx.dartLunge();
  ringFx(st, e.x, e.y, "rgba(255,77,109,0.8)", 60, 0.2);
}

function updateScythes(st, e, dt, active) {
  const p = st.player;
  for (let i = e.scythes.length - 1; i >= 0; i--) {
    const s = e.scythes[i];
    s.px = s.x; s.py = s.y;
    s.spin += dt * 16;
    if (!s.ret) {
      if (len2(s.x - e.x, s.y - e.y) > C.SCYTHE_RANGE) s.ret = true;
    } else { // boomerang home — accelerate back toward the hand
      const d = len2(e.x - s.x, e.y - s.y) || 1;
      s.vx += ((e.x - s.x) / d) * 2600 * dt;
      s.vy += ((e.y - s.y) / d) * 2600 * dt;
      const sp = len2(s.vx, s.vy);
      if (sp > C.SCYTHE_SPEED * 1.15) {
        s.vx *= (C.SCYTHE_SPEED * 1.15) / sp;
        s.vy *= (C.SCYTHE_SPEED * 1.15) / sp;
      }
      if (d < e.r) { e.scythes.splice(i, 1); continue; }
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if ((st.rtime * 60 | 0) % 2 === 0)
      addParticle(st, { x: s.x, y: s.y, vx: -s.vx * 0.04, vy: -s.vy * 0.04,
        life: 0.22, max: 0.22, grav: 0, size: 2.5, color: "#ff4d6d", glow: true });
    if (!active) continue;

    // the blade severs a taut tether where it crosses the rope line
    const g = p.grapple;
    if (g) {
      const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
      const hit = segDist(s.x, s.y, pcx, pcy, g.ax, g.ay);
      if (hit.d < C.SCYTHE_R + 4) {
        p.grapple = null; // velocity kept — the ANCHOR is what you lose
        sfx.ropeCut();
        impact(st, 0, 0.22, { r: 255, g: 255, b: 255, a: 0.12 });
        burst(st, hit.x, hit.y, 14, 300, "#ffffff", 260, true);
        ringFx(st, hit.x, hit.y, "rgba(255,255,255,0.9)", 46, 0.25);
        if (!e.cutToast) { e.cutToast = true; st.toast = { text: "SEVERED — HIS SCYTHE CUTS ROPE", t: 2.6 }; }
      }
    }
    // body contact
    if (len2(s.x - (p.x + p.w / 2), s.y - (p.y + p.h / 2)) < C.SCYTHE_R + 12)
      damagePlayer(st, s.x, s.y, 520);
  }
}

export function updateReaper(st, e, dt) {
  const p = st.player;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const dist = len2(pcx - e.x, pcy - e.y);
  const active = st.deathT <= 0 && !st.won;
  e.t -= dt;

  const hover = (tx, ty, k = 3) => {
    e.vx += (tx - e.x) * k * dt - e.vx * 2.2 * dt;
    e.vy += (ty - e.y) * k * dt - e.vy * 2.2 * dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
  };
  const drift = () => e.home.x + Math.sin(st.simTime * 0.7 + e.phase) * 34;

  updateScythes(st, e, dt, active);

  switch (e.state) {
    case "sleep":
      e.y = e.home.y + 60 + Math.sin(st.simTime * 0.6) * 4;
      if (active && dist < 620) {
        e.state = "rise"; e.t = 1.5; e.alertT = 0.6;
        sfx.keeperRoar();
        impact(st, 0.06, 0.5, { r: 255, g: 90, b: 120, a: 0.25 });
        bossIntro(st, "THE REAPER", "guardian of the shallows", "#ff4d6d");
      }
      break;
    case "rise":
      hover(e.home.x, e.home.y, 4);
      if (e.t <= 0) { e.state = "idle"; e.t = 1.1; }
      break;
    case "idle": {
      hover(drift(), e.home.y + Math.sin(st.simTime * 1.4) * 18);
      if (e.t <= 0 && active) {
        const pat = (e.corrupted ? CORRUPT_PATTERNS : PATTERNS)[bossPhase(e)];
        const attack = pat[e.seq++ % pat.length];
        if (attack === "scythe") { e.state = "scytheTele"; e.t = 0.7 * teleScale(e); sfx.sweepWarn(); }
        else if (attack === "spin") { e.state = "spinTele"; e.t = 0.8 * teleScale(e); sfx.waveCharge(); }
        else if (attack === "harvest") { e.state = "harvestTele"; e.t = 0.6; sfx.crownOpen(); }
        else if (attack === "rupture") { e.state = "ruptureTele"; e.t = 0.9 * teleScale(e); sfx.crownOpen(); }
      }
      break;
    }
    case "scytheTele":
      hover(drift(), e.home.y - 30);
      if (e.t <= 0) { e.state = "scythe"; e.t = 0.5; throwScythe(st, e); }
      break;
    case "scythe": // brief follow-through, then back to the loop
      hover(drift(), e.home.y - 10);
      if (e.t <= 0) { e.state = "idle"; e.t = 1.0 * teleScale(e); }
      break;
    case "spinTele": // marks the dive point — the player's position, promised
      e.diveX = clamp(pcx, 160, st.world.w - 160);
      e.diveY = clamp(pcy - 40, 260, 900);
      hover(e.x, e.home.y - 50, 4);
      if (e.t <= 0) { e.state = "spin"; e.t = 1.25; e.spinA = 0; sfx.waveBoom(); }
      break;
    case "spin": {
      hover(e.diveX, e.diveY, 6.5);
      e.spinA += dt * 13;
      if (Math.random() < 0.5)
        addParticle(st, { x: e.x + Math.cos(e.spinA) * C.REAPER_SPIN_R, y: e.y + Math.sin(e.spinA) * C.REAPER_SPIN_R,
          vx: 0, vy: 0, life: 0.18, max: 0.18, grav: 0, size: 3, color: "#ff4d6d", glow: true });
      // the whirling ring is the hazard — inside the disc is survivable
      if (active && Math.abs(dist - C.REAPER_SPIN_R) < 30) damagePlayer(st, e.x, e.y, 600);
      if (e.t <= 0) {
        // ARENA DESTRUCTION (the accepted destructible-terrain system, built
        // here): the dive SHATTERS the brittle platform it lands on — gone
        if (e.corrupted) shatterBrittleUnder(st, e);
        e.state = "exhaust"; e.t = 1.7; sfx.dartThud();
      }
      break;
    }
    case "ruptureTele": // he flares — a full-arena shock is coming
      hover(drift(), e.home.y - 20, 4);
      if (Math.random() < 0.4)
        addParticle(st, { x: e.x + (Math.random() - 0.5) * 60, y: e.y + (Math.random() - 0.5) * 60,
          vx: 0, vy: 0, life: 0.2, max: 0.2, grav: 0, size: 3, color: "#e0304a", glow: true });
      if (e.t <= 0) {
        e.state = "rupture"; e.t = 1.4; e.ruptR = 20;
        e.ruptX = e.x; e.ruptY = e.y;
        sfx.waveBoom();
        impact(st, 0.05, 0.6, { r: 224, g: 48, b: 74, a: 0.32 });
      }
      break;
    case "rupture": {
      // an expanding ring sweeps the whole arena from his heart. There is no
      // "inside is safe" here (unlike spin) — the wall passes THROUGH every
      // spot; the only answer is to DASH THROUGH the band on the Infernal
      // window as it crosses you. The first boss attack that DEMANDS it.
      e.ruptR += 720 * dt;
      hover(e.ruptX, e.ruptY, 2);
      const pd = len2(pcx - e.ruptX, pcy - e.ruptY);
      if (active && Math.abs(pd - e.ruptR) < RUPTURE_BAND && p.iT <= 0 && p.hurtInvuln <= 0)
        damagePlayer(st, e.ruptX, e.ruptY, 560);
      if (Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2;
        addParticle(st, { x: e.ruptX + Math.cos(a) * e.ruptR, y: e.ruptY + Math.sin(a) * e.ruptR,
          vx: 0, vy: 0, life: 0.18, max: 0.18, grav: 0, size: 3, color: "#ff6a80", glow: true });
      }
      if (e.ruptR > 1400 || e.t <= 0) { e.state = "exhaust"; e.t = 1.5; sfx.dartThud(); }
      break;
    }
    case "exhaust": // slumped, core bared — THE punish window
      e.vx *= Math.exp(-3 * dt); e.vy += (e.home.y + 120 - e.y) * 1.2 * dt - e.vy * 2 * dt;
      e.x += e.vx * dt; e.y += e.vy * dt;
      if (e.t <= 0) { e.state = "idle"; e.t = 1.1 * teleScale(e); }
      break;
    case "harvestTele":
      hover(st.world.w / 2, 300, 5);
      if (e.t <= 0) {
        e.state = "harvest"; e.t = 1.6;
        e.volleyN = bossPhase(e) >= 3 ? 8 : 6;
        e.wispT = 0.1;
      }
      break;
    case "harvest": { // exposed while casting — but he's UP THERE
      hover(st.world.w / 2, 300, 5);
      e.wispT -= dt;
      const cap = C.REAPER_WISP_CAP + (bossPhase(e) >= 3 ? 1 : 0);
      const alive = st.enemies.filter((o) => o.kind === "wisp" && !o.dead).length;
      if (e.wispT <= 0 && alive < cap && active) {
        e.wispT = 0.5;
        const a = Math.random() * Math.PI * 2;
        const w = mkWisp(e.x + Math.cos(a) * 90, e.y + Math.sin(a) * 90);
        w.alertT = 0.5;
        st.enemies.push(w);
        sfx.regrow();
        ringFx(st, w.x, w.y, "rgba(159,232,255,0.8)", 40, 0.25);
      }
      if (e.volleyN > 0 && e.t < 1.2 && active) {
        const k = e.volleyN--;
        const a = (k / (bossPhase(e) >= 3 ? 8 : 6)) * Math.PI * 2 + st.simTime;
        st.shots.push({ x: e.x + Math.cos(a) * (e.r + 8), y: e.y + Math.sin(a) * (e.r + 8),
          px: e.x, py: e.y, vx: Math.cos(a) * C.SHOT_SPEED * 0.9, vy: Math.sin(a) * C.SHOT_SPEED * 0.9,
          r: C.SHOT_R, life: C.SHOT_LIFE, phantom: e.phantom }); // a regret's bolt is only an echo
        if (k % 2) sfx.wardShot();
      }
      if (e.t <= 0) { e.state = "idle"; e.t = 1.0 * teleScale(e); }
      break;
    }
    case "dying":
      e.x += Math.sin(st.simTime * 30) * 2;
      e.scythes.length = 0;
      if (Math.random() < 0.3)
        burst(st, e.x + (Math.random() - 0.5) * 80, e.y + (Math.random() - 0.5) * 80, 8, 300, "#ff4d6d", 300, true);
      if (e.t <= 0) {
        e.dead = true; e.deathT = 0.4;
        st.bossDown = true; // the "boss"-linked gate opens
        st.kills++;
        st.toast = { text: "THE TETHER HOLDS", t: 3 };
        sfx.keeperDie();
        impact(st, 0.14, 0.9, { r: 255, g: 120, b: 150, a: 0.5 });
        for (let i = 0; i < 3; i++)
          ringFx(st, e.x, e.y, "rgba(255,77,109,0.9)", 160 + i * 90, 0.5 + i * 0.15);
        burst(st, e.x, e.y, 60, 640, "#ff4d6d", 380, true);
        for (const o of st.enemies) // the harvest dies with the harvester
          if (o.kind === "wisp" && !o.dead) { o.dead = true; o.deathT = 0.3; }
      }
      break;
  }
}

// ARENA DESTRUCTION — the dive lands; the brittle platform nearest under the
// dive point shatters (reuses the crumble `s.gone` = air-until-regrow path,
// but a shattered arena tile never returns — a broken floor, not a cycle).
function shatterBrittleUnder(st, e) {
  let best = null, bestD = 1e9;
  for (const s of st.solids) {
    if (!s.brittle || s.gone) continue;
    const cx = s.x + s.w / 2;
    if (e.x < s.x - 40 || e.x > s.x + s.w + 40) continue; // roughly overhead
    const d = Math.abs(e.x - cx) + Math.abs(e.y - s.y) * 0.3;
    if (d < bestD) { bestD = d; best = s; }
  }
  if (!best) return;
  best.gone = true; best.shatterT = 0.5;
  sfx.waveBoom();
  impact(st, 0.06, 0.7, { r: 224, g: 48, b: 74, a: 0.34 });
  for (let i = 0; i < 3; i++)
    ringFx(st, best.x + best.w / 2, best.y, "rgba(224,48,74,0.7)", 80 + i * 60, 0.3 + i * 0.1);
  burst(st, best.x + best.w / 2, best.y, 30, 460, "#e0304a", 360, true);
  if (!e.arenaToast) { e.arenaToast = true; st.toast = { text: "THE FLOOR FALLS AWAY", t: 2.6 }; }
}

function wound(st, e, dmg) {
  e.hp -= dmg;
  e.hurtT = 0.3;
  sfx.keeperHurt();
  impact(st, C.HITSTOP_HEAVY, C.SHAKE_HEAVY, { r: 255, g: 200, b: 210, a: 0.3 });
  burst(st, e.x, e.y, 20, 420, "#ff9db1", 320, true);
  if (e.hp <= 0 && e.state !== "dying") {
    e.state = "dying"; e.t = 1.8;
    bossKillBeat(st, e, "#ff4d6d"); // the final blow lands in slow-mo
    music.setPulse(false);
  } else bossPhaseBeat(st, e, bossPhase(e), "#ff4d6d"); // escalation punctuation
}
const clink = (st, e) => {
  sfx.clink();
  burst(st, e.x + (Math.random() - 0.5) * e.r, e.y, 5, 180, "#cfd6ff", 150, false);
};

// damage verdicts — everything answers to the EXPOSED gate
export function slashReaper(st, e) {
  if (!reaperExposed(e)) return clink(st, e);
  const p = st.player;
  wound(st, e, len2(p.vx, p.vy) > C.HEAVY_SPEED ? 2 : 1);
}
export function pogoReaper(st, e) { // the bounce itself is always free
  if (!reaperExposed(e)) return clink(st, e);
  wound(st, e, 2);
}
export function boltReaper(st, e) { // a returned bolt finds the core
  if (!reaperExposed(e)) return clink(st, e);
  wound(st, e, 1);
}

export function reaperContact(st, e) {
  const p = st.player;
  if (p.iT > 0 || p.hurtInvuln > 0 || st.deathT > 0 || st.won) return;
  if (e.state === "sleep" || e.state === "dying" || e.state === "exhaust") return;
  if (e.state === "rupture" || e.state === "ruptureTele") return; // the RING is the hazard, not the body
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  if (len2(pcx - e.x, pcy - e.y) < e.r + 8) damagePlayer(st, e.x, e.y);
}

// ------------------------------------------------------------------ render
export function drawReaper(ctx, st, e, ex, ey, t) {
  const exposed = reaperExposed(e);
  const asleep = e.state === "sleep";
  const flash = e.hurtT > 0.15;
  // the possession recolors the whole read — hellfire-red over the Reaper's
  // rose (WORLDS.md: mutated, possessed)
  const HOT = e.corrupted ? "#e0304a" : "#ff4d6d";
  const HOT_S = e.corrupted ? "224,48,74" : "255,77,109";

  if (e.state === "ruptureTele" || e.state === "rupture") { // the shock ring
    ctx.save();
    if (e.state === "ruptureTele") { // the promise — a bright seed pulse
      ctx.strokeStyle = `rgba(${HOT_S},${0.3 + 0.4 * Math.abs(Math.sin(t * 14))})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ex, ey, 30 + 12 * Math.sin(t * 12), 0, Math.PI * 2); ctx.stroke();
    } else { // the wall — a thick band sweeping out; phase it on the window
      ctx.strokeStyle = `rgba(${HOT_S},0.85)`;
      ctx.lineWidth = RUPTURE_BAND;
      ctx.beginPath(); ctx.arc(e.ruptX, e.ruptY, e.ruptR, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(255,220,200,0.6)";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.ruptX, e.ruptY, e.ruptR, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  // thrown scythes
  for (const s of e.scythes) {
    const sx = s.px + (s.x - s.px), sy = s.py + (s.y - s.py);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(s.spin);
    ctx.shadowColor = "#ff4d6d"; ctx.shadowBlur = 14;
    ctx.strokeStyle = "#ffdfe6";
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(0, 0, C.SCYTHE_R, 0.2, Math.PI * 1.15); ctx.stroke();
    ctx.strokeStyle = "#ff4d6d";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(C.SCYTHE_R * 0.9, 6); ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.translate(ex, ey);
  ctx.globalAlpha = asleep ? 0.45 : 1;

  if (e.state === "spinTele" && e.diveX != null) { // promised dive point
    ctx.save();
    ctx.translate(e.diveX - ex, e.diveY - ey);
    ctx.strokeStyle = `rgba(255,77,109,${0.25 + 0.3 * Math.abs(Math.sin(t * 10))})`;
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, C.REAPER_SPIN_R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  if (e.state === "spin") { // the whirling melee wall
    ctx.strokeStyle = "rgba(255,223,230,0.9)";
    ctx.shadowColor = "#ff4d6d"; ctx.shadowBlur = 16;
    ctx.lineWidth = 6;
    for (let i = 0; i < 3; i++) {
      const a0 = e.spinA + (i * Math.PI * 2) / 3;
      ctx.beginPath(); ctx.arc(0, 0, C.REAPER_SPIN_R, a0, a0 + 0.9); ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  // the cloak — a tattered hooded wedge
  ctx.shadowColor = HOT;
  ctx.shadowBlur = asleep ? 6 : 16;
  ctx.fillStyle = flash ? "#ffffff" : "#170f1d";
  ctx.beginPath();
  ctx.moveTo(0, -e.r - 10);
  ctx.quadraticCurveTo(e.r + 8, -e.r * 0.4, e.r * 0.8, e.r * 0.5);
  for (let i = 3; i >= -3; i--) // ragged hem
    ctx.lineTo(i * (e.r / 3.2), e.r * (i % 2 ? 0.72 : 1.02));
  ctx.quadraticCurveTo(-e.r - 8, -e.r * 0.4, 0, -e.r - 10);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = flash ? "#ffffff" : HOT;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // the core — bared gold while exposed (the crown language: gold = hit me)
  if (!asleep) {
    ctx.shadowColor = exposed ? "#ffd166" : HOT;
    ctx.shadowBlur = exposed ? 22 : 6;
    ctx.fillStyle = exposed
      ? `rgba(255,209,102,${0.75 + 0.25 * Math.sin(t * 9)})`
      : `rgba(${HOT_S},0.35)`;
    ctx.beginPath(); ctx.arc(0, 2, exposed ? 13 : 8, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }
  // the eyes, hunting from the hood
  const p = st.player;
  const dx = p.x + p.w / 2 - ex, dy = p.y + p.h / 2 - ey;
  const dl = len2(dx, dy) || 1;
  ctx.fillStyle = asleep ? "#4a3a5a" : "#ffe6ec";
  const ox = (dx / dl) * 6, oy = (dy / dl) * 4 - e.r * 0.55;
  ctx.beginPath(); ctx.arc(ox - 8, oy, 3.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(ox + 8, oy, 3.4, 0, Math.PI * 2); ctx.fill();

  // the held scythe (visual only) — raised during telegraphs
  if (!asleep && e.state !== "dying") {
    const raise = e.state === "scytheTele" || e.state === "harvestTele" ? -0.9 : -0.25;
    ctx.save();
    ctx.rotate(raise + Math.sin(t * 1.7 + e.phase) * 0.06);
    ctx.strokeStyle = "#c9b8d8";
    ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(e.r * 0.5, e.r * 0.5); ctx.lineTo(e.r + 26, -e.r - 4); ctx.stroke();
    ctx.shadowColor = HOT; ctx.shadowBlur = 12;
    ctx.strokeStyle = "#ffdfe6";
    ctx.lineWidth = 4.5;
    ctx.beginPath(); ctx.arc(e.r + 10, -e.r - 8, 22, Math.PI * 0.9, Math.PI * 1.85); ctx.stroke();
    ctx.restore();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

export function drawReaperHud(ctx, st) {
  const e = st.enemies.find((x) => x.kind === "reaper");
  if (!e || e.dead || e.state === "sleep") return;
  const W = C.VIEW_W, w = 420, x = W / 2 - w / 2, y = 34;
  ctx.fillStyle = "rgba(10,7,16,0.7)";
  ctx.fillRect(x - 4, y - 4, w + 8, 18);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(x, y, w, 10);
  ctx.fillStyle = reaperExposed(e) ? "#ffd166" : (e.corrupted ? "#e0304a" : "#ff4d6d");
  ctx.fillRect(x, y, w * clamp(e.hp / e.maxHp, 0, 1), 10);
  ctx.font = "bold 11px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#f2ccd6";
  ctx.fillText(`THE REAPER — ${["", "I", "II", "III"][bossPhase(e)]}`, W / 2, y + 24);
}
