import { CONFIG as C } from "./config.js";
import { clamp, len2, angDiff, circleRect, drawDiamondPath, rr, rand } from "./util.js";
import { addParticle, burst, ringFx, impact, bumpStyle } from "./fx.js";
import { sfx } from "./audio.js";
import { updateEnemies, killEnemy, triggerBloom, interruptDart } from "./enemies.js";
import { pogoKeeper, slashKeeper } from "./boss.js";
import { pogoBaphomet, slashBaphomet } from "./baphomet.js";
import { pogoLeviathan, slashLeviathan } from "./leviathan.js";
import { pogoUriel, slashUriel } from "./uriel.js";
import { pogoArchitect, slashArchitect } from "./architect.js";
import { pogoShadow, slashShadow } from "./shadow.js";
import { pogoReaper, slashReaper } from "./reaper.js";

/* Player-side combat. Every meaningful hit routes through impact() — hit-stop
 * tier + trauma shake + flash — plus a particle payload. Speed decides weight:
 * above HEAVY_SPEED a hit does double damage and knockback scales with
 * velocity, so swinging INTO an enemy with attack held is the power move.
 * Strike-nodes are the swing-combat pogo: hitting one rewrites your velocity
 * toward your aim (speed conserved + bonus) and refreshes the dash.
 * Enemy brains/contact/bolts live in enemies.js — this file is what YOUR
 * button presses do to the world. */

export function updateCombat(st, dt, wantPogo) {
  tryStartAttack(st, wantPogo);
  resolveAttack(st, dt);
  resolvePogo(st, dt);
  updateEnemies(st, dt);
}

function tryStartAttack(st, wantPogo) {
  const p = st.player, inp = st.input;
  if (p.attackCd > 0 || p.attack || p.pogo) return;
  if (!(inp.attackHeld || inp.attackBuf > 0)) return;
  inp.attackBuf = 0;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  if (wantPogo) {
    // aim-down midair attack: downward pogo hitbox instead of the aimed slash.
    // Faster re-arm than the slash so a held-button stomp re-fires before the
    // fall can slip an enemy through the gap between boxes.
    p.attackCd = C.POGO_CD;
    p.pogo = { t: C.POGO_ACTIVE };
    for (let i = 0; i < 6; i++)
      addParticle(st, { x: pcx + rand(-8, 8), y: p.y + p.h, vx: rand(-60, 60),
        vy: rand(40, 130), life: 0.2, max: 0.2, grav: 200, size: rand(1.5, 3),
        color: "#8CF2FF" });
    return;
  }
  p.attackCd = C.ATTACK_CD;
  const ang = Math.atan2(st.aim.y - pcy, st.aim.x - pcx);
  sfx.slash();
  p.attack = { t: C.ATTACK_ACTIVE, ang, id: ++st.attackSeq };
  p.slash = { t: 0.12, max: 0.12, ang };
  // stardust off the arc edge (PR10) — embers flung along the swing, tinted by
  // the equipped skin, that fade drifting down (the crescent "breaking apart")
  const col = st.skinDash || "#ffffff";
  for (let i = 0; i < 12; i++) {
    const th = ang + (Math.random() - 0.5) * (C.ATTACK_ARC_DEG * Math.PI / 180) * 0.9;
    const r = C.ATTACK_REACH * (0.72 + Math.random() * 0.5); // out to / past the tip
    const sp = 90 + Math.random() * 220;
    addParticle(st, {
      x: pcx + Math.cos(th) * r, y: pcy + Math.sin(th) * r,
      vx: Math.cos(th) * sp * 0.5, vy: Math.sin(th) * sp * 0.5 + 30,
      life: rand(0.22, 0.5), max: 0.5, grav: 340, size: rand(1.2, 2.6),
      color: Math.random() < 0.5 ? col : "#ffffff", glow: true,
    });
  }
}

// untargetable: dead, or a bloom that's down to its regrowing seed
const targetable = (e) => !e.dead && !(e.kind === "bloom" && e.state === "seed");

function resolveAttack(st, dt) {
  const p = st.player, atk = p.attack;
  if (!atk) return;
  atk.t -= dt;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const arc = ((C.ATTACK_ARC_DEG * Math.PI) / 180) / 2;

  for (const e of st.enemies) {
    if (!targetable(e) || e.lastHit === atk.id) continue;
    const dx = e.x - pcx, dy = e.y - pcy;
    const dist = len2(dx, dy);
    if (dist > C.ATTACK_REACH + e.r) continue;
    if (angDiff(Math.atan2(dy, dx), atk.ang) > arc) continue;
    e.lastHit = atk.id;
    hitEnemy(st, e, dx / (dist || 1), dy / (dist || 1));
  }
  for (const n of st.nodes) {
    if (n.lastHit === atk.id) continue;
    const dx = n.x - pcx, dy = n.y - pcy;
    const dist = len2(dx, dy);
    if (dist > C.ATTACK_REACH + C.NODE_R) continue;
    if (angDiff(Math.atan2(dy, dx), atk.ang) > arc) continue;
    n.lastHit = atk.id;
    nodeStrike(st, n);
  }
  // DEFLECT — a slashed bolt is RETURNED along your aim, 1.6× and friendly:
  // it kills the small, pops blooms, and wounds THE REAPER while exposed.
  // (Upgraded from the old cut-to-nothing: same read, bigger reward.)
  for (const q of st.shots) {
    if (q.friendly || q.lastHit === atk.id) continue;
    const dx = q.x - pcx, dy = q.y - pcy;
    if (len2(dx, dy) > C.ATTACK_REACH + q.r + 6) continue;
    if (angDiff(Math.atan2(dy, dx), atk.ang) > arc) continue;
    q.lastHit = atk.id;
    q.friendly = true;
    const sp = len2(q.vx, q.vy) * C.DEFLECT_SPEED;
    q.vx = Math.cos(atk.ang) * sp;
    q.vy = Math.sin(atk.ang) * sp;
    q.life = Math.max(q.life, 2.2);
    sfx.deflect();
    bumpStyle(st, 2); // a deflect is a statement
    impact(st, C.HITSTOP_LIGHT, 0.16, null);
    burst(st, q.x, q.y, 12, 280, "#ffe2a8", 220, true);
    ringFx(st, q.x, q.y, "rgba(255,209,102,0.9)", 40, 0.22);
  }
  if (atk.t <= 0) p.attack = null;
}

function hitEnemy(st, e, ux, uy) {
  const p = st.player;
  if (e.kind === "keeper") { slashKeeper(st, e); return; } // steel — pogo the crown window
  if (e.kind === "baphomet") { slashBaphomet(st, e); return; } // hide — bite only in the stun window
  if (e.kind === "leviathan") { slashLeviathan(st, e); return; } // scale — bite only at the bared crown
  if (e.kind === "uriel") { slashUriel(st, e); return; } // radiance — bite only in the exposed grid
  if (e.kind === "architect") { slashArchitect(st, e); return; } // law — bite only in the re-ink
  if (e.kind === "shadow") { slashShadow(st, e); return; }
  if (e.kind === "reaper") { slashReaper(st, e); return; } // answers only while exposed
  if (e.kind === "bloom") { // you don't wound a mine — you set it off
    triggerBloom(st, e, true);
    bumpStyle(st, 1);
    sfx.hit(false);
    impact(st, C.HITSTOP_LIGHT, C.SHAKE_LIGHT, null);
    burst(st, e.x, e.y, 8, 220, "#cdf26e", 250, true);
    return;
  }
  const speed = len2(p.vx, p.vy);
  const heavy = speed > C.HEAVY_SPEED * (st.power?.heavy || 1);
  e.hp -= heavy ? 2 : 1;
  e.hurtT = 0.3;
  if (heavy) interruptDart(st, e); // a heavy hit knocks a charging dart silly
  if (e.kind !== "ward") { // wards are mounted — they take the hit, not the ride
    // knockback rides the player's velocity — you plow THROUGH them
    let kx = ux, ky = uy;
    if (speed > 60) { kx = p.vx / speed; ky = p.vy / speed; }
    const kb = (C.KB_BASE + C.KB_VEL * speed) * (e.kind === "dart" ? 0.6 : 1) * (st.power?.kb || 1);
    e.vx += kx * kb;
    e.vy += ky * kb - 90;
  }
  const hx = e.x - ux * e.r, hy = e.y - uy * e.r;
  bumpStyle(st, heavy ? 2 : 1); // landing hits mid-flight keeps the chain alive
  if (e.hp <= 0) {
    killEnemy(st, e);
  } else {
    sfx.hit(heavy);
    impact(st, heavy ? C.HITSTOP_HEAVY : C.HITSTOP_LIGHT,
      heavy ? C.SHAKE_HEAVY : C.SHAKE_LIGHT,
      heavy ? { r: 255, g: 235, b: 210, a: 0.18 } : null);
    burst(st, hx, hy, heavy ? 16 : 9, heavy ? 360 : 240, "#ffd9a0", 300, true);
    if (heavy) ringFx(st, hx, hy, "rgba(255,217,160,0.8)", 60, 0.25);
  }
}

// ---- pogo strike: the downward hitbox below the feet -------------------------
function resolvePogo(st, dt) {
  const p = st.player, pg = p.pogo;
  if (!pg) return;
  pg.t -= dt;
  const g = st.gravityDir || 1; // the stomp box extends TOWARD gravity
  const hx = p.x - C.POGO_PAD, hy = g > 0 ? p.y + p.h : p.y - C.POGO_REACH;
  const hw = p.w + C.POGO_PAD * 2, hh = C.POGO_REACH;
  let target = null, isNode = false;
  for (const e of st.enemies) {
    if (!targetable(e)) continue;
    if (circleRect(e.x, e.y, e.r, hx, hy, hw, hh)) { target = e; break; }
  }
  if (!target)
    for (const n of st.nodes)
      if (circleRect(n.x, n.y, C.NODE_R + 4, hx, hy, hw, hh)) { target = n; isNode = true; break; }
  if (target) pogoConnect(st, target, isNode);
  else if (pg.t <= 0) p.pogo = null;
}

function pogoConnect(st, target, isNode) {
  const p = st.player;
  const g = st.gravityDir || 1;
  p.pogo = null;
  // MOMENTUM-COMPOSITE bounce: pogo is a REDIRECT, not a reset. Each axis
  // scales with what you brought in —
  //   vertical: reflect the incoming fall (POGO_REFLECT of it) with the
  //     classic bounce as the floor, so a fast-fall→pogo launches HIGHER
  //     and a gentle tap gives the familiar hop; anti-gravity vy still
  //     carries (mid-swing pogo lifts the arc, the pendulum catches it).
  //   horizontal: kept and slightly amplified (POGO_VX_BOOST) — a swing- or
  //     dash-pogo continues along that trajectory, up-and-forward.
  // All in gravity-space, so flip zones pogo correctly.
  if (C.POGO_COMPOSITE === false) {
    // classic fixed-upward pogo (the A/B baseline): straight up, momentum RESET
    p.vx = 0;
    p.vy = -C.POGO_BOUNCE * (st.power?.pogo || 1) * g;
  } else {
    const carry = p.vy * g < 0 ? p.vy * C.POGO_CARRY : 0;
    const fall = Math.max(0, p.vy * g); // speed INTO the target
    p.vx *= 1 + C.POGO_VX_BOOST;
    p.vy = -Math.max(C.POGO_BOUNCE * (st.power?.pogo || 1), fall * C.POGO_REFLECT) * g + carry;
  }
  p.dashing = false;
  p.dashCd = 0;                    // pogo refreshes the dash, same as node strikes
  p.isJumping = false;
  p.iT = Math.max(p.iT, 0.15);     // brief bounce grace vs the thing you just hit
  sfx.pogo(isNode);
  bumpStyle(st, 2);                // pogo is a signature chain move
  // POGO CHAIN (SECRETS unlock): count consecutive pogos without touching
  // ground; game.js resets st.pogoChain on land/respawn. Persist the best.
  st.pogoChain = (st.pogoChain || 0) + 1;
  if (st.pogoChain > (st.pogoChainBest || 0)) {
    st.pogoChainBest = st.pogoChain;
    try {
      if (st.pogoChain > (Number(localStorage.getItem("tether.pogochain")) || 0))
        localStorage.setItem("tether.pogochain", String(st.pogoChain));
    } catch {}
  }
  if (isNode) {
    target.pulse = 1;
    impact(st, C.HITSTOP_POGO, C.SHAKE_POGO, { r: 150, g: 245, b: 255, a: 0.3 });
    burst(st, target.x, target.y, 16, 340, "#8CF2FF", 300, true);
    ringFx(st, target.x, target.y, "rgba(140,242,255,0.9)", 80, 0.3);
  } else if (target.kind === "baphomet") {
    pogoBaphomet(st, target); // wounds ONLY while the brand is bared (stun)
  } else if (target.kind === "leviathan") {
    pogoLeviathan(st, target); // wounds ONLY at the bared crown (head window)
  } else if (target.kind === "uriel") {
    pogoUriel(st, target); // wounds ONLY while the radiance is committed to the grid
  } else if (target.kind === "architect") {
    pogoArchitect(st, target); // wounds ONLY in the re-ink window
  } else if (target.kind === "shadow") {
    pogoShadow(st, target); // wounds ONLY the post-dash stumble
  } else if (target.kind === "keeper") {
    pogoKeeper(st, target); // wounds ONLY inside the golden crown window
  } else if (target.kind === "reaper") {
    pogoReaper(st, target); // the bounce is free; the wound needs him exposed
  } else if (target.kind === "bloom") {
    // stomp the mine: it lights, the bounce carries you clear of the blast
    triggerBloom(st, target, true);
    impact(st, C.HITSTOP_POGO, C.SHAKE_POGO, { r: 205, g: 242, b: 110, a: 0.25 });
    burst(st, target.x, target.y - target.r * 0.4, 10, 280, "#cdf26e", 350, true);
  } else {
    target.hurtT = 0.3;
    target.hp -= 1;
    target.vx += p.vx * 0.35;      // stomped enemies get slammed away
    target.vy += 260;
    interruptDart(st, target);     // crowning a mid-lunge dart cancels the threat
    if (target.hp <= 0) {
      killEnemy(st, target);
    } else {
      impact(st, C.HITSTOP_POGO, C.SHAKE_POGO, { r: 150, g: 245, b: 255, a: 0.3 });
      burst(st, target.x, target.y - target.r * 0.4, 12, 300, "#8CF2FF", 350, true);
    }
  }
  for (let i = 0; i < 8; i++)
    addParticle(st, { x: p.x + p.w / 2, y: p.y + p.h, vx: rand(-140, 140),
      vy: rand(-40, 80), life: 0.3, max: 0.3, grav: 200, size: rand(2, 3),
      color: "#ffffff" });
}

// THE velocity-redirect primitive: speed conserved (with a floor) + bonus,
// re-aimed along (ux,uy); the kick owns the trajectory (drops rope + dash)
// and refreshes the dash. Node strikes and angled bounce pads share it.
export function launchPlayer(st, ux, uy, minSpeed = C.NODE_MIN_SPEED, bonus = C.NODE_KICK_BONUS) {
  const p = st.player;
  const speed = len2(p.vx, p.vy);
  const kick = Math.max(speed, minSpeed) + bonus;
  p.vx = ux * kick;
  p.vy = uy * kick;
  p.grapple = null;   // the kick owns the trajectory now
  p.dashing = false;
  p.dashCd = 0;       // refreshes the dash — chain onward
  p.iT = Math.max(p.iT, 0.25);
  p.isJumping = false;
  return kick;
}

// the combat pogo's aimed sibling: velocity re-aimed at the cursor, speed conserved + bonus
function nodeStrike(st, n) {
  const p = st.player;
  const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
  const ax = st.aim.x - pcx, ay = st.aim.y - pcy;
  const l = len2(ax, ay) || 1;
  launchPlayer(st, ax / l, ay / l);
  bumpStyle(st, 2); // strike-node redirect — a stylish momentum swap
  sfx.node(st.style.count); // the chain LADDERS — each strike rings a step higher
  n.pulse = 1;
  impact(st, C.HITSTOP_NODE, C.SHAKE_NODE, { r: 255, g: 120, b: 190, a: 0.25 });
  burst(st, n.x, n.y, 20, 380, "#ff4fa0", 200, true);
  ringFx(st, n.x, n.y, "rgba(255,79,160,0.9)", 110, 0.35);
}

// ------------------------------------------------------------------ render

export function drawNodes(ctx, st, t) {
  for (const n of st.nodes) {
    const y = n.y + Math.sin(t * 1.8 + n.x * 0.01) * 4;
    const pr = 1 + n.pulse * 0.6;
    ctx.save();
    ctx.translate(n.x, y);
    ctx.rotate(t * 0.9);
    ctx.shadowColor = "#ff4fa0";
    ctx.shadowBlur = 16;
    ctx.strokeStyle = "rgba(255,79,160,0.85)";
    ctx.lineWidth = 2.5;
    drawDiamondPath(ctx, 0, 0, C.NODE_R * pr);
    ctx.stroke();
    ctx.fillStyle = n.pulse > 0 ? "#ffffff" : "rgba(255,79,160,0.55)";
    drawDiamondPath(ctx, 0, 0, C.NODE_R * 0.55 * pr);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
    ctx.strokeStyle = `rgba(255,79,160,${0.18 + 0.12 * Math.sin(t * 4 + n.x)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(n.x, y, C.NODE_R + 10, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function drawPogo(ctx, st, ix, iy) {
  const p = st.player, pg = p.pogo;
  if (!pg) return;
  const g = st.gravityDir || 1;
  const a = clamp(pg.t / C.POGO_ACTIVE, 0, 1);
  ctx.save();
  ctx.globalAlpha = a * 0.9;
  ctx.shadowColor = "#8CF2FF";
  ctx.shadowBlur = 14;
  ctx.fillStyle = "rgba(140,242,255,0.8)";
  rr(ctx, ix - C.POGO_PAD, g > 0 ? iy + p.h : iy - C.POGO_REACH,
    p.w + C.POGO_PAD * 2, C.POGO_REACH, 5);
  ctx.fill();
  ctx.restore();
}

// The SWEEP: a single crescent blade that SWEEPS through the attack arc — the
// leading tip travels from one edge to the other, a fat mid-body tapering to
// sharp points, a trailing motion-blur and a chromatic refraction fringe. EVERY
// property is a CONTINUOUS function of progress k (no discrete frames), and
// s.t decrements by real per-frame dt (updateFX), so it is butter-smooth at ANY
// fps. Tinted by the equipped skin (st.skinDash) over a white-hot core; the
// embers are spawned at swing time (tryStartAttack).
export function drawSlash(ctx, st, pcx, pcy) {
  const s = st.player.slash;
  if (!s || s.t <= 0) return;
  const k = clamp(1 - s.t / s.max, 0, 1);            // 0 → 1 progress, smooth
  const alpha = Math.min(1, k * 5) * (1 - k * k);    // fast attack, smooth fade
  if (alpha <= 0.003) return;
  const col = st.skinDash || "#ffffff";
  const half = ((C.ATTACK_ARC_DEG * Math.PI) / 180) / 2;
  // reach tracks the HITBOX (C.ATTACK_REACH) so what you see is what you hit —
  // only a slight pop, never overshooting the cone the swing actually connects in
  const R = C.ATTACK_REACH * (0.94 + 0.12 * Math.sin(Math.PI * k));
  const ek = k * (2 - k);                             // ease-out sweep
  const lead = half - ek * 2 * half;                  // the tip travels +half → −half
  const span = half * 1.15;
  const trail = Math.min(half, lead + span);          // trailing edge of the ribbon
  const N = 24, Wmax = 32;

  ctx.save();
  ctx.translate(pcx, pcy);
  ctx.rotate(s.ang);
  ctx.lineCap = "round";

  // trailing motion-blur ghosts (skin color) behind the leading edge
  ctx.lineWidth = 6;
  for (const [gd, aw] of [[0.10, 0.22], [0.28, 0.12]]) {
    if (lead + gd >= trail) continue;
    ctx.globalAlpha = alpha * aw; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(0, 0, R - 14, lead + gd, trail); ctx.stroke();
  }
  // chromatic refraction fringe — the swing slicing the air (Canvas2D has no shader)
  ctx.lineWidth = 5;
  for (const [dy, cc] of [[2, "#78c8ff"], [-2, "#ff789e"]]) {
    if (lead + 0.05 >= trail) break;
    ctx.globalAlpha = alpha * 0.12; ctx.strokeStyle = cc;
    ctx.beginPath(); ctx.arc(0, dy, R - 12, lead + 0.05, trail); ctx.stroke();
  }

  // the crescent ribbon: outer edge lead→trail at R; inner edge tapers so the
  // blade is fat mid-sweep and comes to sharp points at the lead + trail tips
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const p = i / N, th = lead + p * (trail - lead);
    ctx[i ? "lineTo" : "moveTo"](Math.cos(th) * R, Math.sin(th) * R);
  }
  for (let i = N; i >= 0; i--) {
    const p = i / N, th = lead + p * (trail - lead);
    const w = Wmax * Math.sin(Math.PI * Math.pow(p, 0.82)); // 0 at both tips, fat toward the lead
    ctx.lineTo(Math.cos(th) * (R - w), Math.sin(th) * (R - w));
  }
  ctx.closePath();
  const grad = ctx.createRadialGradient(0, 0, R * 0.4, 0, 0, R);
  grad.addColorStop(0, col); grad.addColorStop(0.5, "#ffffff"); grad.addColorStop(1, col);
  ctx.fillStyle = grad;
  ctx.shadowColor = col; ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;

  // the bright blade TIP at the leading edge — catches the light as it sweeps
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(Math.cos(lead) * (R - 5), Math.sin(lead) * (R - 5), 3.4, 0, 6.2832); ctx.fill();

  ctx.restore();
  ctx.lineCap = "butt";
  ctx.globalAlpha = 1;
}
