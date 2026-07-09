import { CONFIG as C } from "./config.js";
import { clamp, len2 } from "./util.js";
import { addParticle, burst, ringFx, impact } from "./fx.js";
import { sfx, music } from "./audio.js";
import { damagePlayer } from "./enemies.js";
import { launchPlayer } from "./combat.js";
import { bossIntro, bossPhaseBeat, bossKillBeat } from "./bossfx.js";

/* LEVIATHAN OF ASH — World 3's boss: the rising-flood chase (the accepted
 * arena system). The cavern floods with magma while you CLIMB; the serpent
 * lives in the flood and hunts the shaft. Damage happens on the move:
 *
 *  THE FLOOD — the magma line rises the whole fight (faster each phase).
 *            Touching it costs a heart and EJECTS you upward (a mercy
 *            launch, not a pit death) — the chase never soft-kills.
 *  STRIKE  — he locks a height and lunges ACROSS the shaft from a wall.
 *            Telegraphed lane; dodge by CLIMBING or DROPPING. No phasing.
 *  THE CROWN — after every second strike his head SURFACES at the magma
 *            line and lingers: descend TOWARD the fire and POGO it
 *            (3 dmg; slash 1). Armored at all other times. The flood
 *            HOLDS its breath during the window — punishing is a choice,
 *            not a suicide.
 *  SURGE   — phase 2+: the whole shaft ignites in a rising wave. It
 *            outruns any climb: the INFERNAL DASH THROUGH it as it passes
 *            is the answer (W3+ bosses may demand the window — WORLDS.md).
 *
 * Death drains the flood and opens every "boss" gate: the way up is clear. */

export const mkLeviathan = (x, y) => ({
  kind: "leviathan", x, y, px: x, py: y, home: { x, y },
  vx: 0, vy: 0, r: 52, hp: 15, maxHp: 15,
  phase: Math.random() * Math.PI * 2,
  hurtT: 0, lastHit: 0, dead: false, deathT: 0, alertT: 0,
  state: "sleep", t: 0, seq: 0, strikes: 0,
  floodY: 0, floodOn: false, drainY: 0,
  laneY: 0, laneDir: 1, headX: 0,
  surgeY: 0, surgeOn: false,
});

const bossPhase = (e) => (e.hp > 9 ? 1 : e.hp > 4 ? 2 : 3);
const teleScale = (e) => [1, 1, 0.85, 0.7][bossPhase(e)];
const FLOOD_RATE = [0, 26, 34, 44]; // px/s by phase — the chase tightens
export const SURGE_SPEED = 760;     // no climb outruns it; the dash phases it

export function updateLeviathan(st, e, dt) {
  const p = st.player;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const active = st.deathT <= 0 && !st.won;
  e.t -= dt;

  if (!e.floodOn) e.floodY = st.world.h + 200; // asleep: the magma waits below

  switch (e.state) {
    case "sleep":
      e.x = e.home.x; e.y = e.home.y + Math.sin(st.simTime * 0.5) * 6;
      if (active && Math.abs(pcy - e.y) < 700) {
        e.state = "rise"; e.t = 1.6; e.alertT = 0.7;
        e.floodOn = true; e.floodY = st.world.h - 140;
        sfx.keeperRoar();
        impact(st, 0.08, 0.6, { r: 255, g: 90, b: 40, a: 0.3 });
        bossIntro(st, "LEVIATHAN OF ASH", "the rising flood", "#ff8a5a");
      }
      break;
    case "rise":
      e.y += (e.floodY - 40 - e.y) * 2.5 * dt;
      if (e.t <= 0) { e.state = "lurk"; e.t = 1.2; }
      break;
    case "lurk": { // swims the flood line, choosing the next horror
      e.y += (e.floodY - 30 - e.y) * 3 * dt;
      e.x += (st.world.w / 2 + Math.sin(st.simTime * 0.8 + e.phase) * (st.world.w * 0.3) - e.x) * 1.6 * dt;
      if (e.t <= 0 && active) {
        const wantSurge = bossPhase(e) >= 2 && e.seq % 3 === 2;
        if (wantSurge) { e.state = "surgeTele"; e.t = 1.0 * teleScale(e); sfx.waveCharge(); }
        else if (e.strikes >= 2) { e.state = "headTele"; e.t = 0.7; e.strikes = 0; sfx.sweepWarn(); }
        else { e.state = "strikeTele"; e.t = 0.8 * teleScale(e); e.laneY = pcy; e.laneDir = pcx < st.world.w / 2 ? -1 : 1; sfx.waveCharge(); }
        e.seq++;
      }
      break;
    }
    case "strikeTele": // the lane glows at the locked height — move OFF it
      e.y += (e.laneY - e.y) * 4 * dt;
      e.x += ((e.laneDir < 0 ? st.world.w - 60 : 60) - e.x) * 4 * dt;
      if (e.t <= 0) {
        e.state = "strike"; e.t = (st.world.w + 300) / 1500;
        e.headX = e.x; e.strikes++;
        sfx.dartThud();
      }
      break;
    case "strike": {
      e.headX += -e.laneDir * 1500 * dt; // across the shaft
      e.x = e.headX; e.y = e.laneY;
      if (active && Math.abs(pcy - e.laneY) < e.r + 4 && Math.abs(pcx - e.headX) < e.r + 12)
        damagePlayer(st, e.headX, e.laneY, 620);
      if (e.t <= 0) { e.state = "lurk"; e.t = 0.9 * teleScale(e); }
      break;
    }
    case "headTele": // he coils under the surface — the crown is coming
      e.y += (e.floodY + 30 - e.y) * 5 * dt;
      e.x += (pcx - e.x) * 1.8 * dt;
      if (e.t <= 0) { e.state = "head"; e.t = 2.2 * teleScale(e); sfx.sweepFire(); }
      break;
    case "head": // THE WINDOW — the crown bared at the fire line; the flood
      e.y = e.floodY - 26;   // holds its breath while you dive to punish
      e.x += Math.sin(st.simTime * 3) * 0.4;
      if (e.t <= 0) { e.state = "lurk"; e.t = 1.0 * teleScale(e); }
      break;
    case "surgeTele": // the whole flood glows — the shaft is about to burn
      e.y += (e.floodY + 40 - e.y) * 5 * dt;
      if (e.t <= 0) {
        e.state = "surge"; e.surgeOn = true; e.surgeY = e.floodY - 10;
        e.t = (e.floodY / SURGE_SPEED) + 0.4;
        sfx.waveBoom();
        impact(st, 0.06, 0.7, { r: 255, g: 110, b: 40, a: 0.35 });
      }
      break;
    case "surge": {
      e.surgeY -= SURGE_SPEED * dt; // the wave races UP the shaft
      if (active && pcy > e.surgeY - 27 && pcy < e.surgeY + 27 &&
          p.iT <= 0 && p.hurtInvuln <= 0)
        damagePlayer(st, pcx, e.surgeY + 60, 520);
      if (e.surgeY < -80 || e.t <= 0) { e.surgeOn = false; e.state = "lurk"; e.t = 1.1 * teleScale(e); }
      break;
    }
    case "dying":
      e.y += 40 * dt; // sinks into its own fire
      e.x += Math.sin(st.simTime * 26) * 2;
      if (Math.random() < 0.35)
        burst(st, e.x + (Math.random() - 0.5) * 120, e.y + (Math.random() - 0.5) * 60, 8, 340, "#ff8a4d", 320, true);
      if (e.t <= 0) {
        e.state = "gone"; e.deathT = 0.4; // not dead YET — the drain must run
        st.bossDown = true; // the way up opens
        st.kills++;
        st.toast = { text: "THE SERPENT SINKS — CLIMB", t: 3 };
        sfx.keeperDie();
        impact(st, 0.14, 0.9, { r: 255, g: 120, b: 50, a: 0.5 });
        for (let i = 0; i < 3; i++)
          ringFx(st, e.x, e.y, "rgba(255,130,60,0.9)", 170 + i * 90, 0.5 + i * 0.15);
      }
      break;
    case "gone": // the serpent is under — the magma follows him down
      e.floodY = Math.min(st.world.h + 200, e.floodY + 260 * dt);
      if (e.floodY >= st.world.h + 150) e.dead = true;
      break;
  }

  // ---- the FLOOD itself (this boss IS the arena system) ------------------
  if (e.floodOn && !e.dead && e.state !== "gone") {
    if (e.state === "dying") {
      e.floodY = Math.min(st.world.h + 200, e.floodY + 220 * dt); // drains fast
    } else if (e.state !== "head" && e.state !== "headTele") {
      e.floodY -= FLOOD_RATE[bossPhase(e)] * dt; // the chase never stops
      e.floodY = Math.max(560, e.floodY);        // …but the summit stays winnable
    }
    if (active && p.y + p.h > e.floodY + 6 && p.hurtInvuln <= 0 && st.deathT <= 0) {
      damagePlayer(st, pcx, e.floodY + 120, 300);
      launchPlayer(st, 0, -1, 1050, 0); // the mercy eject — burned, not buried
    }
    if (Math.random() < 0.4) // the surface seethes
      addParticle(st, { x: Math.random() * st.world.w, y: e.floodY - 4,
        vx: (Math.random() - 0.5) * 30, vy: -60 - Math.random() * 90,
        life: 0.5, max: 0.5, grav: -60, size: 1.5 + Math.random() * 2.5,
        color: "#ff8a5a", glow: true });
  }
}

// the crown answers to pogo — ONLY while the head is bared (crown grammar)
export function pogoLeviathan(st, e) {
  if (e.state === "head") {
    e.hp -= 3; e.hurtT = 0.3;
    sfx.keeperHurt();
    impact(st, C.HITSTOP_HEAVY, C.SHAKE_HEAVY, { r: 255, g: 170, b: 90, a: 0.3 });
    burst(st, e.x, e.y, 24, 460, "#ffb454", 330, true);
    if (e.hp <= 0 && e.state !== "dying") { e.state = "dying"; e.t = 2.0; bossKillBeat(st, e, "#ff8a5a"); music.setPulse(false); }
    else bossPhaseBeat(st, e, bossPhase(e), "#ff8a5a");
  } else {
    sfx.clink();
    burst(st, e.x, e.y - e.r, 6, 200, "#e0a890", 200, false);
  }
}
export function slashLeviathan(st, e) {
  if (e.state === "head") {
    e.hp -= 1; e.hurtT = 0.2;
    sfx.keeperHurt();
    impact(st, C.HITSTOP_LIGHT, C.SHAKE_LIGHT, { r: 255, g: 170, b: 90, a: 0.2 });
    burst(st, e.x, e.y, 8, 240, "#ffb454", 200, true);
    if (e.hp <= 0 && e.state !== "dying") { e.state = "dying"; e.t = 2.0; bossKillBeat(st, e, "#ff8a5a"); music.setPulse(false); }
    else bossPhaseBeat(st, e, bossPhase(e), "#ff8a5a");
  } else {
    sfx.clink();
    burst(st, e.x + (Math.random() - 0.5) * e.r, e.y, 5, 180, "#e0a890", 150, false);
  }
}

// body contact — the strike lane owns that damage; the lurker is untouchable
export function leviathanContact(st, e) {
  const p = st.player;
  if (p.iT > 0 || p.hurtInvuln > 0 || st.deathT > 0 || st.won) return;
  if (e.state !== "head" && e.state !== "headTele") return; // in the flood / a lane / gone
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  if (len2(pcx - e.x, pcy - e.y) < e.r + 8) damagePlayer(st, e.x, e.y);
}

// ------------------------------------------------------------------ render
export function drawLeviathan(ctx, st, e, ex, ey, t) {
  const W = st.world.w;
  // the MAGMA — flat fills only (the budget): body, a hot surface line, glow
  if (e.floodOn || e.dead) {
    const fy = e.floodY;
    if (fy < st.world.h + 100) {
      ctx.fillStyle = "rgba(120,28,14,0.86)";
      ctx.fillRect(0, fy, W, st.world.h - fy + 200);
      ctx.fillStyle = "rgba(255,110,40,0.5)";
      ctx.fillRect(0, fy, W, 8);
      ctx.fillStyle = `rgba(255,150,60,${0.16 + 0.08 * Math.sin(t * 3)})`;
      ctx.fillRect(0, fy - 26, W, 26); // the heat shimmer band
    }
  }
  if (e.surgeOn) { // the SURGE — a rising fire band; dash through it
    ctx.fillStyle = "rgba(255,120,45,0.55)";
    ctx.fillRect(0, e.surgeY - 27, W, 54);
    ctx.fillStyle = "rgba(255,220,160,0.5)";
    ctx.fillRect(0, e.surgeY - 3, W, 6);
  }
  if (e.state === "strikeTele") { // the locked lane
    const a = 0.22 + 0.3 * Math.abs(Math.sin(t * 15));
    ctx.strokeStyle = `rgba(255,100,45,${a})`;
    ctx.setLineDash([22, 12]); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, e.laneY); ctx.lineTo(W, e.laneY); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (e.state === "gone") return; // under his own fire — only the magma remains
  if (e.state === "sleep" && !(st.deathT <= 0)) return;

  ctx.save();
  ctx.translate(ex, ey);
  const asleep = e.state === "sleep";
  const window_ = e.state === "head";
  const flash = e.hurtT > 0.15;
  ctx.globalAlpha = asleep ? 0.45 : 1;
  ctx.shadowColor = "#ff6a3d";
  ctx.shadowBlur = window_ ? 24 : 14;
  // the serpent's head — a horned wedge breaking the surface
  ctx.fillStyle = flash ? "#ffffff" : "#301410";
  ctx.beginPath();
  ctx.moveTo(-e.r, e.r * 0.5);
  ctx.lineTo(0, -e.r * 0.9);
  ctx.lineTo(e.r, e.r * 0.5);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = flash ? "#ffffff" : window_ ? "#ffb454" : "#ff6a3d";
  ctx.lineWidth = 3; ctx.stroke();
  // horns swept back
  ctx.strokeStyle = flash ? "#ffffff" : "#e0a890";
  ctx.lineWidth = 5; ctx.lineCap = "round";
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * e.r * 0.45, -e.r * 0.5);
    ctx.quadraticCurveTo(s * e.r * 0.95, -e.r * 1.15, s * e.r * 1.25, -e.r * 0.75);
    ctx.stroke();
  }
  ctx.lineCap = "butt";
  ctx.shadowBlur = 0;
  // the eye — a furnace slit tracking the player
  const p = st.player;
  const dx = p.x + p.w / 2 - ex, dl = Math.abs(dx) || 1;
  ctx.fillStyle = asleep ? "#5a2a1a" : "#ffd06a";
  ctx.beginPath();
  ctx.ellipse((dx / dl) * 10, -e.r * 0.15, 13, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  // the CROWN — bared gold during the window (this is what the pogo hits)
  const glow = window_ ? 1 : 0.15;
  ctx.shadowColor = "#ffb454"; ctx.shadowBlur = window_ ? 22 : 0;
  ctx.strokeStyle = `rgba(255,180,84,${0.3 + glow * 0.7})`;
  ctx.lineWidth = window_ ? 4 : 2;
  ctx.beginPath();
  ctx.moveTo(-e.r * 0.5, -e.r * 0.55);
  ctx.lineTo(-e.r * 0.25, -e.r * 0.8);
  ctx.lineTo(0, -e.r * 0.58);
  ctx.lineTo(e.r * 0.25, -e.r * 0.8);
  ctx.lineTo(e.r * 0.5, -e.r * 0.55);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();
  ctx.globalAlpha = 1;
}

export function drawLeviathanHud(ctx, st) {
  const e = st.enemies.find((x) => x.kind === "leviathan");
  if (!e || e.dead || e.state === "sleep" || e.state === "gone") return;
  const W = C.VIEW_W, w = 420, x = W / 2 - w / 2, y = 34;
  ctx.fillStyle = "rgba(16,8,6,0.7)";
  ctx.fillRect(x - 4, y - 4, w + 8, 18);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(x, y, w, 10);
  ctx.fillStyle = e.state === "head" ? "#ffb454" : "#ff6a3d";
  ctx.fillRect(x, y, w * clamp(e.hp / e.maxHp, 0, 1), 10);
  ctx.font = "bold 11px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#f2d0b8";
  ctx.fillText(`LEVIATHAN OF ASH — ${["", "I", "II", "III"][bossPhase(e)]}`, W / 2, y + 24);
}
