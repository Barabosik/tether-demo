import { CONFIG as C } from "./config.js";
import { clamp, len2 } from "./util.js";
import { addParticle, burst, ringFx, impact } from "./fx.js";
import { sfx, music } from "./audio.js";
import { damagePlayer } from "./enemies.js";
import { bossIntro, bossPhaseBeat, bossKillBeat } from "./bossfx.js";

/* BAPHOMET — the guardian of Hell (World 2's boss). The gate between the
 * mortal descent and Hell proper: the fight tests everything W1–W2 taught
 * (grapple reposition, dash timing, pogo on a window) — but it is winnable
 * on the BASE dash, with NO i-frames, because beating Baphomet is how the
 * player EARNS the Infernal Dash going into W3. So every attack is dodged by
 * MOVEMENT — height, position, timing — never by phasing through it:
 *
 *  CLEAVE  — hellfire floods the floor for 1.4s (a jump lasts 0.8s: you
 *            can't hop it). SWING, cling a grip wall, or stand on a raised
 *            slab above the fire line. Dodged by VERTICALITY, not i-frames.
 *  CHARGE  — he locks onto your height and gores across the arena. JUMP over
 *            it or DROP below his lane. He smashes the far wall and is STUNNED
 *            — the brand on his chest bared. This is the damage window.
 *  BRIMSTONE (phase 2+) — a slow fan of embers aimed at you. Slow enough to
 *            side-step or SLASH; never requires a dash to survive.
 *
 * Damage lands ONLY while STUNNED (the bared brand): POGO 3, SLASH 1 — the
 * crown-window grammar. Phases at 13/6 hp tighten telegraphs and add the
 * fan. Death opens every gate linked "boss": the way to Hell is open. */

export const mkBaphomet = (x, y) => ({
  kind: "baphomet", x, y, px: x, py: y, home: { x, y: y - 60 },
  vx: 0, vy: 0, r: 48, hp: 20, maxHp: 20,
  phase: Math.random() * Math.PI * 2,
  hurtT: 0, lastHit: 0, dead: false, deathT: 0, alertT: 0,
  state: "sleep", t: 0, seq: 0,
  chargeDir: 1, chargeY: 0, brandHits: 0, lockX: 0, lockY: 0,
  slamT: 0, slamX: 0, slamY: 0, campT: 0, campCd: 0,
});

const PATTERNS = {
  1: ["cleave", "charge"],
  2: ["charge", "cleave", "brimstone"],
  3: ["charge", "brimstone", "cleave", "charge"],
};
const bossPhase = (e) => (e.hp > 13 ? 1 : e.hp > 6 ? 2 : 3);
const teleScale = (e) => [1, 1, 0.82, 0.66][bossPhase(e)];

export const CLEAVE_Y = 880; // feet below this line burn during a cleave

export function updateBaphomet(st, e, dt) {
  const p = st.player;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const dist = len2(pcx - e.x, pcy - e.y);
  const active = st.deathT <= 0 && !st.won;
  e.t -= dt;

  const hover = (targetY, k = 3) => {
    e.vy += (targetY - e.y) * k * dt - e.vy * 2.5 * dt;
    e.vx += (e.home.x + Math.sin(st.simTime * 0.7 + e.phase) * 30 - e.x) * 2.5 * dt - e.vx * 2 * dt;
    e.x += e.vx * dt; e.y += e.vy * dt;
  };

  // CAMP-BREAKER — a wall is refuge, not residence. The counter runs while
  // the player hangs clinging; the answer (an ember flick) comes only when
  // he is FREE — never during cleave, where clinging above the fire is the
  // taught dodge. Wait-at-the-wall stops being a strategy.
  e.campCd -= dt;
  if (active && p.sliding) e.campT += dt;
  else e.campT = Math.max(0, e.campT - dt * 2);
  if ((e.state === "idle" || e.state === "rise") && active &&
      e.campT > 1.6 && e.campCd <= 0) {
    e.campCd = 2.2; e.campT = 0.9; // partial reset: keep camping, keep eating flicks
    for (let i = -1; i <= 1; i++) {
      const a = Math.atan2(pcy - e.y, pcx - e.x) + i * 0.14;
      st.shots.push({ x: e.x + Math.cos(a) * (e.r + 8), y: e.y + Math.sin(a) * (e.r + 8),
        px: e.x, py: e.y, vx: Math.cos(a) * C.SHOT_SPEED, vy: Math.sin(a) * C.SHOT_SPEED,
        r: C.SHOT_R, life: C.SHOT_LIFE, phantom: e.phantom }); // a regret's bolt is only an echo
    }
    sfx.wardShot();
  }

  switch (e.state) {
    case "sleep":
      e.y = e.home.y + 60 + Math.sin(st.simTime * 0.6) * 4;
      if (active && dist < 660) {
        e.state = "rise"; e.t = 1.4; e.alertT = 0.6;
        sfx.keeperRoar();
        impact(st, 0.06, 0.5, { r: 255, g: 120, b: 60, a: 0.28 });
        bossIntro(st, "BAPHOMET", "guardian of the mines", "#ff8a4d");
      }
      break;
    case "rise":
      hover(e.home.y, 4);
      if (e.t <= 0) { e.state = "idle"; e.t = 1.1; }
      break;
    case "idle": {
      hover(e.home.y);
      if (e.t <= 0 && active) {
        const pat = PATTERNS[bossPhase(e)];
        const attack = pat[e.seq++ % pat.length];
        if (attack === "cleave") { e.state = "cleaveTele"; e.t = 0.9 * teleScale(e); sfx.sweepWarn(); }
        else if (attack === "charge") { e.state = "chargeTele"; e.t = 0.6 * teleScale(e); sfx.waveCharge(); }
        else if (attack === "brimstone") { e.state = "brimstone"; e.t = 0.6; e.brimN = 5; }
      }
      break;
    }
    case "cleaveTele":
      hover(e.home.y - 30);
      if (e.t <= 0) { e.state = "cleave"; e.t = 1.4; sfx.sweepFire(); impact(st, 0, 0.3, null); }
      break;
    case "cleave": {
      hover(e.home.y - 30);
      if (Math.random() < 0.75)
        addParticle(st, { x: Math.random() * st.world.w, y: 1000, vx: 0, vy: -240 - Math.random() * 180,
          life: 0.55, max: 0.55, grav: -70, size: 2 + Math.random() * 3, color: "#ff7a3d", glow: true });
      if (active && p.y + p.h > CLEAVE_Y) damagePlayer(st, pcx, 1100, 480);
      if (e.t <= 0) { e.state = "idle"; e.t = 1.3 * teleScale(e); }
      break;
    }
    case "chargeTele": {
      // lock onto the player's height — the lunge lane is telegraphed as a
      // bright line at lockY; JUMP over it or DROP below to dodge
      if (e.t > 0.15) { e.lockX = pcx; e.lockY = pcy; }
      e.vx += ((e.home.x) - e.x) * 2 * dt - e.vx * 2 * dt; e.x += e.vx * dt;
      e.vy += (e.lockY - e.y) * 5 * dt - e.vy * 3 * dt; e.y += e.vy * dt;
      if (e.t <= 0) {
        e.state = "charge"; e.t = 0.85;
        e.chargeDir = e.lockX >= e.x ? 1 : -1; e.chargeY = e.y;
        e.vx = e.chargeDir * 1350; e.vy = 0;
        sfx.dartThud();
      }
      break;
    }
    case "charge": {
      e.x += e.vx * dt; e.y += (e.chargeY - e.y) * 8 * dt;
      // the horn wall — contact hurts (dodge by leaving the lane), and the
      // wall stops the charge into a STUN
      if (active && Math.abs(pcy - e.chargeY) < e.r + 6 && len2(pcx - e.x, 0) < e.r + 14)
        damagePlayer(st, e.x, e.chargeY, 640);
      // he stops where the ARENA stops him: the first wall face across his
      // lane — a shut gate IS a wall (an open one has h=0), so the stun can
      // never land inside the sealed goal alcove the player can't reach
      let hitWall = e.x < e.r + 34 || e.x > st.world.w - e.r - 34 || e.t <= 0;
      for (const s of st.solids) {
        if (s.kind === "oneway" || s.kind === "valve" || s.h <= 0) continue;
        if (e.chargeY < s.y - e.r * 0.6 || e.chargeY > s.y + s.h + e.r * 0.6) continue;
        if (e.chargeDir > 0 ? e.x <= s.x && e.x + e.r > s.x
                            : e.x >= s.x + s.w && e.x - e.r < s.x + s.w) {
          e.x = e.chargeDir > 0 ? s.x - e.r : s.x + s.w + e.r;
          hitWall = true; break;
        }
      }
      if (hitWall) {
        e.x = clamp(e.x, e.r + 34, st.world.w - e.r - 34);
        e.state = "stun"; e.t = 1.7 * teleScale(e); e.brandHits = 0; e.vx = 0;
        e.slamT = 0.38; e.slamX = e.x; e.slamY = e.chargeY; // the impact BURSTS
        sfx.waveBoom();
        impact(st, 0.06, 0.6, { r: 255, g: 120, b: 60, a: 0.32 });
        ringFx(st, e.x, e.y, "rgba(255,140,70,0.7)", 100, 0.3);
        ringFx(st, e.x, e.chargeY, "rgba(255,110,40,0.55)", 210, 0.38);
        burst(st, e.x, e.chargeY, 26, 480, "#ff8a4d", 300, true);
      }
      break;
    }
    case "stun": // THE window — the brand is bared; POGO or SLASH it
      e.y += (e.chargeY - e.y) * 3 * dt;
      e.x += Math.sin(st.simTime * 22) * 0.6; // groggy sway
      // the SLAM SHOCK — an expanding burst at the impact point, so hugging
      // the wall he hits (the camp spot) is exactly where you can't stand;
      // dodge by DISTANCE, then dive in to punish the bared brand
      if (e.slamT > 0) {
        e.slamT -= dt;
        const rr = 210 * (1 - Math.max(0, e.slamT) / 0.38);
        if (active && len2(pcx - e.slamX, pcy - e.slamY) < rr)
          damagePlayer(st, e.slamX, e.slamY);
      }
      if (e.t <= 0 || e.brandHits >= 3) { e.state = "idle"; e.t = 1.1 * teleScale(e); }
      break;
    case "brimstone": {
      hover(e.home.y - 10);
      if (e.t <= 0.4 && e.brimN > 0 && active) {
        e.brimN--;
        const a = Math.atan2(pcy - e.y, pcx - e.x) + (e.brimN - 2) * 0.26;
        st.shots.push({ x: e.x + Math.cos(a) * (e.r + 8), y: e.y + Math.sin(a) * (e.r + 8),
          px: e.x, py: e.y, vx: Math.cos(a) * C.SHOT_SPEED, vy: Math.sin(a) * C.SHOT_SPEED,
          r: C.SHOT_R, life: C.SHOT_LIFE, phantom: e.phantom }); // a regret's bolt is only an echo
        sfx.wardShot();
        e.t = 0.5;
      }
      if (e.brimN <= 0) { e.state = "idle"; e.t = 1.1 * teleScale(e); }
      break;
    }
    case "dying":
      e.x += Math.sin(st.simTime * 28) * 2;
      if (Math.random() < 0.3)
        burst(st, e.x + (Math.random() - 0.5) * 90, e.y + (Math.random() - 0.5) * 90, 8, 320, "#ff8a4d", 320, true);
      if (e.t <= 0) {
        e.dead = true; e.deathT = 0.4;
        st.kills++;
        // the seal does NOT break yet — the INFERNAL DASH falls from the sky
        // into the arena's heart, and CLAIMING it is what opens the way (the
        // reward can't be skipped on the way out; nikita's design)
        st.infernalDrop = { x: st.world.w / 2, y: -90, vy: 0, landed: false, taken: false };
        st.toast = { text: "THE GUARDIAN FALLS", t: 2.5 };
        sfx.keeperDie();
        impact(st, 0.14, 0.9, { r: 255, g: 140, b: 60, a: 0.5 });
        for (let i = 0; i < 3; i++)
          ringFx(st, e.x, e.y, "rgba(255,140,70,0.9)", 160 + i * 90, 0.5 + i * 0.15);
        burst(st, e.x, e.y, 60, 660, "#ff8a4d", 400, true);
      }
      break;
  }
}

// ---- the INFERNAL DASH drop -------------------------------------------
// Falls from the sky into the arena's heart when the guardian dies. Claiming
// it is the grant: st.infernal flips LIVE (the HUD gauge reads INFERNAL from
// that frame), and only then does the "boss" gate open — the upgrade can't
// be walked past. Persistent unlock stays derived from best.m07-baphomet at
// level load (E1); the drop is the in-arena ceremony of the same grant.
export function updateInfernalDrop(st, dt) {
  const d = st.infernalDrop;
  if (!d || d.taken) return;
  if (!d.landed) {
    d.vy = Math.min(d.vy + 1500 * dt, 980);
    d.y += d.vy * dt;
    if (Math.random() < 0.5) // meteor tail on the way down
      addParticle(st, { x: d.x + (Math.random() - 0.5) * 10, y: d.y - 18, vx: 0, vy: -60,
        life: 0.3, max: 0.3, grav: 0, size: 2 + Math.random() * 2, color: "#ff8a5a", glow: true });
    for (const s of st.solids) { // land on the first solid under the fall line
      if (s.gone || s.kind === "oneway" || s.kind === "valve") continue;
      if (d.x < s.x || d.x > s.x + s.w) continue;
      if (d.y + 14 >= s.y && d.y < s.y + 24) {
        d.y = s.y - 16; d.landed = true;
        impact(st, 0.05, 0.55, { r: 255, g: 150, b: 70, a: 0.32 });
        ringFx(st, d.x, d.y, "rgba(255,160,80,0.75)", 130, 0.35);
        burst(st, d.x, d.y, 26, 460, "#ffb454", 340, true);
        sfx.waveBoom();
        break;
      }
    }
  } else if (Math.random() < 0.25) { // grounded: a patient ember plume
    addParticle(st, { x: d.x + (Math.random() - 0.5) * 22, y: d.y - 6, vx: 0,
      vy: -40 - Math.random() * 60, life: 0.5, max: 0.5, grav: -80,
      size: 1.5 + Math.random() * 2, color: "#ff8a5a", glow: true });
  }
  const p = st.player;
  if (len2(p.x + p.w / 2 - d.x, p.y + p.h / 2 - d.y) < 42) {
    d.taken = true;
    st.infernal = true;   // LIVE — the gauge flips, the window is real NOW
    st.bossDown = true;   // and THIS is what breaks the seal
    st.toast = { text: "THE INFERNAL DASH AWAKENS", t: 3.5 };
    sfx.keeperRoar();
    impact(st, 0.12, 0.85, { r: 255, g: 170, b: 80, a: 0.45 });
    for (let i = 0; i < 3; i++)
      ringFx(st, d.x, d.y, "rgba(255,190,100,0.85)", 140 + i * 80, 0.45 + i * 0.12);
    burst(st, d.x, d.y, 50, 640, "#ffd9a0", 380, true);
  }
}

export function drawInfernalDrop(ctx, st, t) {
  const d = st.infernalDrop;
  if (!d || d.taken) return;
  const y = d.y + (d.landed ? Math.sin(t * 3) * 5 : 0);
  if (d.landed) { // grounded glow pool + beckoning ring
    ctx.fillStyle = "rgba(255,140,70,0.10)";
    ctx.beginPath(); ctx.arc(d.x, d.y + 12, 36 + Math.sin(t * 5) * 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.translate(d.x, y);
  ctx.shadowColor = "#ff8a4d";
  ctx.shadowBlur = d.landed ? 26 : 15;
  ctx.rotate(Math.PI / 4 + (d.landed ? 0 : t * 6)); // tumbles as it falls
  const r = 15 * (d.landed ? 1 + Math.sin(t * 5) * 0.1 : 1);
  ctx.fillStyle = "#ff6a45";
  ctx.fillRect(-r * 0.72, -r * 0.72, r * 1.44, r * 1.44); // the ember shard
  ctx.fillStyle = "#ffd9a0";
  ctx.fillRect(-r * 0.36, -r * 0.36, r * 0.72, r * 0.72); // molten core
  ctx.restore();
}

// the brand answers to pogo — but ONLY while stunned (the crown grammar)
export function pogoBaphomet(st, e) {
  if (e.state === "stun") {
    e.hp -= 3; e.brandHits++; e.hurtT = 0.3;
    sfx.keeperHurt();
    impact(st, C.HITSTOP_HEAVY, C.SHAKE_HEAVY, { r: 255, g: 180, b: 90, a: 0.3 });
    burst(st, e.x, e.y, 22, 440, "#ffb454", 320, true);
    if (e.hp <= 0 && e.state !== "dying") { e.state = "dying"; e.t = 1.8; bossKillBeat(st, e, "#ff8a4d"); music.setPulse(false); }
    else bossPhaseBeat(st, e, bossPhase(e), "#ff8a4d");
  } else {
    sfx.clink(); // his hide shrugs it off outside the window
    burst(st, e.x, e.y - e.r, 6, 200, "#e0b090", 200, false);
  }
}

export function slashBaphomet(st, e) {
  if (e.state === "stun") {
    e.hp -= 1; e.hurtT = 0.2;
    sfx.keeperHurt();
    impact(st, C.HITSTOP_LIGHT, C.SHAKE_LIGHT, { r: 255, g: 180, b: 90, a: 0.2 });
    burst(st, e.x, e.y, 8, 240, "#ffb454", 200, true);
    if (e.hp <= 0 && e.state !== "dying") { e.state = "dying"; e.t = 1.8; bossKillBeat(st, e, "#ff8a4d"); music.setPulse(false); }
    else bossPhaseBeat(st, e, bossPhase(e), "#ff8a4d");
  } else {
    sfx.clink();
    burst(st, e.x + (Math.random() - 0.5) * e.r, e.y, 5, 180, "#e0b090", 150, false);
  }
}

// body contact — the charge lane owns that damage; elsewhere the bulk hurts
export function baphometContact(st, e) {
  const p = st.player;
  if (p.iT > 0 || p.hurtInvuln > 0 || st.deathT > 0 || st.won) return;
  if (e.state === "sleep" || e.state === "dying" || e.state === "stun" || e.state === "charge") return;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  if (len2(pcx - e.x, pcy - e.y) < e.r + 10) damagePlayer(st, e.x, e.y);
}

// ------------------------------------------------------------------ render
export function drawBaphomet(ctx, st, e, ex, ey, t) {
  const stun = e.state === "stun";
  const asleep = e.state === "sleep";
  const flash = e.hurtT > 0.15;
  const ph = bossPhase(e);

  if (e.state === "cleaveTele" || e.state === "cleave") { // the fire line
    const a = e.state === "cleave" ? 0.5 : 0.18 + 0.2 * Math.abs(Math.sin(t * 14));
    const grad = ctx.createLinearGradient(0, CLEAVE_Y, 0, 1000);
    grad.addColorStop(0, "rgba(255,110,40,0)");
    grad.addColorStop(1, `rgba(255,90,30,${a})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, CLEAVE_Y, st.world.w, 1000 - CLEAVE_Y);
    ctx.strokeStyle = `rgba(255,150,70,${a + 0.2})`;
    ctx.setLineDash([14, 10]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, CLEAVE_Y); ctx.lineTo(st.world.w, CLEAVE_Y); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (e.state === "chargeTele") { // the lunge lane — bright line at lockY
    const a = 0.25 + 0.35 * Math.abs(Math.sin(t * 16));
    ctx.strokeStyle = `rgba(255,90,40,${a})`;
    ctx.setLineDash([20, 12]); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, e.lockY); ctx.lineTo(st.world.w, e.lockY); ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.save();
  ctx.translate(ex, ey);
  ctx.globalAlpha = asleep ? 0.5 : 1;
  // the bulk — a horned goat-demon silhouette (procedural)
  ctx.shadowColor = "#ff7a3d";
  ctx.shadowBlur = asleep ? 6 : stun ? 22 : 16;
  ctx.fillStyle = flash ? "#ffffff" : "#2a1410";
  ctx.beginPath(); ctx.arc(0, 0, e.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = flash ? "#ffffff" : stun ? "#ffb454" : "#ff7a3d";
  ctx.lineWidth = 3; ctx.stroke();
  // horns
  ctx.strokeStyle = flash ? "#ffffff" : "#e0b090";
  ctx.lineWidth = 6; ctx.lineCap = "round";
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * e.r * 0.5, -e.r * 0.7);
    ctx.quadraticCurveTo(s * e.r * 1.1, -e.r * 1.2, s * e.r * 1.35, -e.r * 0.5);
    ctx.stroke();
  }
  ctx.lineCap = "butt";
  ctx.shadowBlur = 0;
  // the eyes — track the player
  const p = st.player;
  const dx = p.x + p.w / 2 - ex, dy = p.y + p.h / 2 - ey;
  const dl = len2(dx, dy) || 1;
  ctx.fillStyle = asleep ? "#5a3020" : "#ffcf6a";
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.arc(s * 15 + (dx / dl) * 4, -6 + (dy / dl) * 4, 6, 0, Math.PI * 2); ctx.fill();
  }
  // the BRAND — a sigil on the chest, dark until the stun bares it gold
  const glow = stun ? 1 : 0.12;
  ctx.shadowColor = "#ffb454"; ctx.shadowBlur = stun ? 24 : 0;
  ctx.strokeStyle = `rgba(255,180,84,${0.3 + glow * 0.7})`;
  ctx.lineWidth = stun ? 4 : 2;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) { // a pentacle brand
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    const rx = Math.cos(a) * 14, ry = 14 + Math.sin(a) * 14;
    i ? ctx.lineTo(rx, ry) : ctx.moveTo(rx, ry);
  }
  ctx.closePath(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();
  ctx.globalAlpha = 1;
}

export function drawBaphometHud(ctx, st) {
  const e = st.enemies.find((x) => x.kind === "baphomet");
  if (!e || e.dead || e.state === "sleep") return;
  const W = C.VIEW_W, w = 420, x = W / 2 - w / 2, y = 34;
  ctx.fillStyle = "rgba(16,8,6,0.7)";
  ctx.fillRect(x - 4, y - 4, w + 8, 18);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(x, y, w, 10);
  ctx.fillStyle = e.state === "stun" ? "#ffb454" : "#ff7a3d";
  ctx.fillRect(x, y, w * clamp(e.hp / e.maxHp, 0, 1), 10);
  ctx.font = "bold 11px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#f2d0b8";
  ctx.fillText(`BAPHOMET — ${["", "I", "II", "III"][bossPhase(e)]}`, W / 2, y + 24);
}
