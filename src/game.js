import { CONFIG as C, KEYMAP } from "./config.js";
import {
  clamp, lerp, approach, rand, len2, aabb, fmtTime, rr,
  drawStarPath, segRectT, segObbT, circleRect,
} from "./util.js";
import { moveAndCollide, depenetrate } from "./physics.js";
import { LEVELS, PROTECTED_IDS, makeDust, alignSpikes, isDeletable, deleteLevel, moveLevelInWorld, setOnlineLevels } from "./levels.js";
import { WORLD_BG, initWorldBg, updateWorldBg, drawWorldBg } from "./worldbg.js";
import { loadCustomLevels, normalizeLevelData } from "./customLevels.js";
import { addParticle, burst, ringFx, impact, updateParticles, drawParticles, bumpStyle } from "./fx.js";
import {
  tryFireGrapple, releaseGrapple, applySwingForces, ropeConstraint,
  updateAnchors, drawRope, drawLockUI,
} from "./grapple.js";
import { updateCombat, drawNodes, drawSlash, drawPogo, launchPlayer } from "./combat.js";
import { updatePlatforms, checkGrip, drawSolids, drawSpikes, drawZones, updateProps, drawProps } from "./platforms.js";
import { updateHazards, hazardHit, drawHazards, pulseActive } from "./hazards.js";
import { instantiateLevel } from "./levelload.js";
import { drawDecorLayer, updateDecor } from "./decor.js";
import {
  editorInit, editorOpen, editorActive, editorDraw, editorKeyDown,
  editorMouseDown, editorMouseMove, editorMouseUp, editorWheel, editorResume,
} from "./editor.js";
import { drawEnemies, drawShots } from "./enemies.js";
import { drawKeeperHud } from "./boss.js";
import { drawBaphometHud, drawInfernalDrop } from "./baphomet.js";
import { drawLeviathanHud } from "./leviathan.js";
import { drawUrielHud } from "./uriel.js";
import { drawArchitectHud } from "./architect.js";
import { drawShadowHud } from "./shadow.js";
import { startFinale, updateFinale, finaleAdvance, drawFinale } from "./finale.js";
import { startCredits, updateCredits, drawCredits, drawWaking, WAKE_DUR } from "./credits.js";
import { startIntro, updateIntro, drawIntro } from "./intro.js";
import { updateBossFx, drawBossIntro } from "./bossfx.js";
import { tryReadFragment, advanceReading, updateReading, drawFragment, drawFragPrompt, drawLorePanel, fragCollected, fragmentProgress } from "./fragments.js";
import { nearestNpc, tryTalkNpc, updateNpcs, drawNpcs, drawNpcPrompt } from "./npc.js";
import { drawWanderer, vesselPhase, VESSEL_CORE } from "./wanderer.js";
import { drawReaperHud } from "./reaper.js";
import * as RANK from "./rank.js";
const { finalRank, effPar, sRankTimeOf, PALETTES, unlockedPalettes } = RANK;
import { makeThumbs, invalidateThumbs } from "./ui.js";
import { initSelectScreen } from "./selectScreen.js";
import { initHud } from "./hud.js";
import { initPanelScreens } from "./panelScreens.js";
import { unlock, sfx, music, setMuffle, toggleMute, isMuted, busLevels, trackState, sfxDecoded, sfxNames } from "./audio.js";
import * as OPT from "./settings.js";
import { pollGamepad, padStatus, padList, choosePad } from "./gamepad.js";
import { submitScore } from "./leaderboard.js";
import { saveAchievement } from "./achievements.js";
import { emitScreen, on as busOn, emit as busEmit, modalOpen } from "./uiBus.js";
import { ensureUiRoot } from "./uiRoot.js";

/* TETHER — fixed-timestep sim (C.PHYSICS_HZ) + interpolated render.
 * Screen machine: select -> playing <-> paused -> results.
 * Sim steps only while playing; menus are pure render. */

// on level completion: submitScore resolves the logged-in username itself
// and upserts a personal best (skips guests); log the completion achievement
function reportLevelCompletion(levelId, timeMs) {
  submitScore(levelId, timeMs);
  saveAchievement(`Completed level ${levelId}`);
}

function getBest(i) {
  try { return Number(localStorage.getItem("tether.best." + LEVELS[i].id)) || 0; }
  catch { return 0; }
}
function saveBestIfBetter(i, t) {
  try {
    const b = getBest(i);
    if (!b || t < b) { localStorage.setItem("tether.best." + LEVELS[i].id, String(t)); return true; }
  } catch {}
  return false;
}

function createState() {
  const L = LEVELS[0];
  const d = L.build();
  alignSpikes(d.solids, d.spikes, L.world.h, d.nodes);
  return {
    ...d,
    world: { w: L.world.w, h: L.world.h },
    hints: d.hints || [],
    player: {
      x: d.spawn.x, y: d.spawn.y, px: d.spawn.x, py: d.spawn.y,
      w: C.PLAYER_W, h: C.PLAYER_H,
      vx: 0, vy: 0, facing: 1, rot: 0, onGround: false, coyote: 0,
      isJumping: false, squash: 0, hp: C.PLAYER_HP, iT: 0, blinkT: 0, hurtInvuln: 0,
      dashing: false, dashT: 0, dashCd: 0, dashDX: 1, dashDY: 0,
      grapple: null, attack: null, attackCd: 0, slash: null, pogo: null,
      colX: false, colY: false,
      wallCoyote: 0, gripDir: 0, sliding: false, steerLock: 0,
    },
    input: {
      pressed: new Set(), mouse: { sx: C.VIEW_W / 2, sy: C.VIEW_H / 2 },
      attackHeld: false, attackBuf: 0,
      grappleQ: false, spaceQ: false, dashQ: false, jumpBuffer: 0,
      padAiming: false, // gamepad owns the crosshair until the mouse moves
    },
    ui: { sel: 0, buttons: [], mouseMoved: false, clickX: null },
    // real players open on the TETHER title (intro.js); automation (audits,
    // navigator.webdriver) and ?level deep-links skip straight to the menu
    screen: (typeof navigator !== "undefined" && navigator.webdriver) ? "select" : "intro",
    intro: null,
    credits: null, creditsQueued: false, waking: 0,
    idleT: 0,
    lowHp: false, _lowHpMuffle: false, // 1-HP last-stand mode (muffle + heartbeat + vignette)
    levelIndex: 0,
    bests: LEVELS.map((_, i) => getBest(i)),
    newBest: false, winDelay: 0,
    aim: { x: 0, y: 0 }, lock: null,
    cam: { x: 0, y: 0 },
    particles: [], dust: makeDust(L.world),
    worldbg: null, // parametric per-world background (worldbg.js); null = legacy grad+grid+dust
    trauma: 0, flash: { r: 255, g: 255, b: 255, a: 0 }, hitStop: 0, slowmo: 0, bossIntro: null,
    deathT: 0,
    style: { count: 0, timer: 0, flash: 0, best: 0 },
    tint: L.tint,
    rtime: 0, simTime: 0, runTime: 0, fps: 60,
    deaths: 0, kills: 0, won: false,
    attackSeq: 0,
    shots: [],
    coins: [], triggers: [], decor: [], props: [], hazards: [],
    coinCount: 0, altExit: false, toast: null, bossDown: false,
    splits: [], splitFlash: null, pbSplits: null, goldSegs: null, finalSegs: null,
    playtestData: null,
    ghost: null, ghostRec: [], ghostTick: 0, ghostHidden: false,
    hits: 0, rank: null, paletteIndex: 0,
    worldSel: 1, // which world the select screen shows (levels carry worldId)
    pogoChain: 0, pogoChainBest: 0, // consecutive pogos w/o ground (SECRETS)
    gravityDir: 1, // +1 normal, -1 inside a gravity-flip zone (see step())
    confirm: null, // level index pending delete confirmation (select screen)
    settingsFrom: "select", // screen to return to when SETTINGS closes
    rebind: null, rebindMsg: null, // key-capture state on the settings screen
    lastShake: { x: 0, y: 0 }, lastFlashA: 0, // audit hooks: applied juice
    bflip: new Set(), // parent ids whose select card shows its B-side face
    line: null, // THE LINE marathon: { world, queue, at, total, deaths, splits }
    lineDone: null, // finished-run summary for the results screen
    practice: null, // {x,y} checkpoint — death/void return HERE (see hurt)
    practiceRun: false, // touched practice this attempt: nothing banks
  };
}

export function startGame(canvas) {
  const ctx = canvas.getContext("2d");
  // Resolution independence: the backing store tracks the real display size,
  // the game keeps rendering in VIEW coordinates through a uniform scale +
  // letterbox transform. Nothing downstream knows about pixels.
  const view = { scale: 1 };
  const uiRoot = ensureUiRoot(); // DOM overlay artboard — scaled in fitCanvas
  // profiling aid: ?rs=N pins the internal supersample (bypasses the policy)
  const RS_OVERRIDE = (() => {
    try { return Number(new URLSearchParams(location.search).get("rs")) || 0; }
    catch { return 0; }
  })();
  function fitCanvas() {
    // BACKING-STORE POLICY (profiled 2026-07-03, tools/_prof.mjs: 4× pixels
    // cost 3.7× frame time; sim is noise — render fill dominates):
    //  • windowed — native device pixels (VIEW × dpr, capped): 1:1 pixel-exact
    //    AND the cheapest possible store. This restores the pre-supersample
    //    frame rate on dpr-1 monitors.
    //  • fullscreen — exactly the DISPLAYED device pixels (CSS fit × dpr),
    //    capped at RENDER_SCALE_MAX: a 1080p fullscreen renders 1920×1080
    //    (1:1 crisp, CHEAPER than the old 2240×1260 supersample); beyond the
    //    cap (4K+) it renders 2× and downscales — sharp, bounded fill cost.
    //  Never a blurry upscale, never speculative overdraw. Reallocation is
    //  guarded so resizes don't clear/realloc the bitmap every event.
    const dpr = window.devicePixelRatio || 1;
    const fs = !!document.fullscreenElement;
    // the canvas FILLS the browser window in BOTH modes (aspect-correct,
    // letterboxed by the flex centering) — the old windowed path capped at
    // native VIEW size and left a small box floating in the page
    const availW = window.innerWidth;
    const availH = window.innerHeight;
    const s = Math.min(availW / C.VIEW_W, availH / C.VIEW_H);

    const RS = RS_OVERRIDE ||
      Math.max(1, Math.min(s * dpr, C.RENDER_SCALE_MAX));
    const bw = Math.round(C.VIEW_W * RS), bh = Math.round(C.VIEW_H * RS);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    view.scale = RS;
    const cssW = Math.round(C.VIEW_W * s);
    canvas.style.width = cssW + "px";
    canvas.style.height = Math.round(C.VIEW_H * s) + "px";
    // the DOM artboard tracks the same rounded CSS width as the canvas box,
    // so artboard px and canvas VIEW px stay the same numbers on screen
    uiRoot?.style.setProperty("--ui-scale", String(cssW / C.VIEW_W));
  }
  fitCanvas();

  OPT.loadSettings(); // volumes/juice/keymap overrides, before any input lands
  const st = createState();
  // single write-point for screen transitions: DOM chrome subscribes on the
  // uiBus instead of polling window.__tether.screen every frame
  function setScreen(name) {
    st.screen = name;
    emitScreen(name);
  }
  emitScreen(st.screen); // boot screen for widgets that subscribed pre-init
  makeThumbs(LEVELS); // prime the shared thumbnail cache (selectScreen reads it)
  try { st.paletteIndex = Number(localStorage.getItem("tether.palette")) || 0; } catch {}
  try {
    const w = Number(localStorage.getItem("tether.world")) || 1;
    if (LEVELS.some((l) => (l.worldId || 1) === w)) st.worldSel = w;
  } catch {}
  // recomputed on demand — the editor can add levels/worlds at runtime.
  // B-sides are excluded: they never appear in a world grid, only the SECRETS tab.
  const worldIds = () => [...new Set(LEVELS.filter((l) => !l.bside).map((l) => l.worldId || 1))].sort((a, b) => a - b);
  const worldLevels = () => LEVELS.map((_, i) => i).filter((i) => !LEVELS[i].bside && (LEVELS[i].worldId || 1) === st.worldSel);

  // DOM level-select (Phase 1): game.js stays the input entry point and
  // delegates; the controller owns its DOM and emits uiBus actions back
  const selectUI = initSelectScreen({ state: st, worldLevels, worldIds });
  // HUD before the panels: earlier sibling → renders UNDER their scrims
  const hud = initHud({ state: st, pal: () => PALETTES[st.paletteIndex] || PALETTES[0] });
  const panelsUI = initPanelScreens({ state: st }); // pause / results / skins / secrets / settings
  busOn("screen", (s) => {
    if (s === "select") selectUI.show(st.levelIndex);
    else selectUI.hide();
  });
  // boot-show DEFERRED one frame: a ?level=N boot (audits, deep links) loads
  // straight into "playing" below — building the full select DOM (thumbnail
  // blits included) just to hide it again taxed every harness goto
  requestAnimationFrame(() => { if (st.screen === "select") selectUI.show(st.levelIndex); });
  if (st.screen === "intro") startIntro(st); // the boot title (real players only)

  const bgGrad = ctx.createLinearGradient(0, 0, 0, C.VIEW_H);
  bgGrad.addColorStop(0, "#16101f");
  bgGrad.addColorStop(0.55, "#191322");
  bgGrad.addColorStop(1, "#0d0a13");
  const vignette = ctx.createRadialGradient(
    C.VIEW_W / 2, C.VIEW_H / 2, C.VIEW_H * 0.35,
    C.VIEW_W / 2, C.VIEW_H / 2, C.VIEW_H * 0.85
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.55)");

  // ------------------------------------------------------------ level flow
  function applyLevel(d, meta) {
    alignSpikes(d.solids, d.spikes, meta.world.h, d.nodes);
    st.solids = d.solids; st.spikes = d.spikes; st.anchors = d.anchors;
    st.nodes = d.nodes; st.enemies = d.enemies; st.goal = d.goal; st.spawn = d.spawn;
    st.shots = [];
    st.hints = d.hints || [];
    st.coins = d.coins || []; st.triggers = d.triggers || []; st.decor = d.decor || [];
    st.fragments = d.fragments || []; st.reading = null;
    st.npcs = d.npcs || [];
    st.trueEnding = false;
    st.props = d.props || [];
    st.hazards = d.hazards || [];
    st.coinCount = 0; st.altExit = false; st.toast = null; st.bossDown = false;
    st.bossIntro = null; st.slowmo = 0; // the boss-presentation layer clears per level
    st.voidY = meta.voidY ?? meta.data?.voidY ?? null;
    st.infernalDrop = null; // Baphomet's reward resets with his arena
    st.hits = 0; st.rank = null;
    st.splits = []; st.splitFlash = null; st.finalSegs = null;
    st.world = { w: meta.world.w, h: meta.world.h };
    st.tint = meta.tint || "#ffb454";
    // E1 — the INFERNAL DASH (WORLDS.md): dash i-frames are an UNLOCK, not a
    // base property. Earned by felling Baphomet and claiming his shard —
    // and by NOTHING else (nikita's ruling): a fresh save that jumps into
    // W3 via the select has no window, and the verb gates stand shut. The
    // campaign is sequential in spirit; the unlock IS the reward.
    st.infernal = (() => {
      try { return !!localStorage.getItem("tether.best.m07-baphomet"); } catch { return false; }
    })();
    // W6 POWER-STATE (WORLDS.md: "the buffed kit = CONFIG-scaled variant") —
    // the power trip is the SAME verbs with hotter numbers, applied per-world:
    // faster run, higher pogo, wider velocity-melee window (lower heavy
    // threshold), shorter dash cooldown, harder hit feedback. NOT a moveset.
    st.power = (meta.worldId || meta.data?.worldId) === 6
      ? { move: 1.16, pogo: 1.15, heavy: 0.72, dashCd: 0.55, kb: 1.35 }
      : { move: 1, pogo: 1, heavy: 1, dashCd: 1, kb: 1 };
    st.revealT = 0;
    // the equipped skin's colors, snapshot for combat VFX (the crescent slash +
    // its embers tint by skin — PR10); skin only changes in the menu, so a
    // per-level snapshot is always current by the time you swing
    { const sp = PALETTES[st.paletteIndex] || PALETTES[0]; st.skinDash = sp.dash; st.skinReady = sp.ready; }
    // THE VESSEL burn state for this world (Character Bible) — the player
    st.vesselPhase = vesselPhase((meta.worldId || meta.data?.worldId) || 1);
    st.dust = makeDust(st.world);
    st.worldbg = initWorldBg(meta, st.world); // null for worlds without a config
    st.style.count = 0; st.style.timer = 0; st.style.flash = 0; st.style.best = 0;
    st.deaths = 0; st.kills = 0; st.runTime = 0;
    st.won = false; st.winDelay = 0; st.newBest = false; st.winHandled = false;
    st.deathT = 0; st.trauma = 0; st.hitStop = 0; st.flash.a = 0;
    st.waking = 0;
    st.idleT = 0; // a fresh level starts alert, not slumped (PR5)
    st.lowHp = false; st._lowHpMuffle = false; // fresh level = full HP, no last stand
    st.practice = null; st.practiceRun = false; // fresh attempt = honest attempt
    st.particles.length = 0;
    st.lock = null;
    respawn();
    st.cam.x = clamp(st.player.x + st.player.w / 2 - C.VIEW_W / 2, 0, Math.max(0, st.world.w - C.VIEW_W));
    st.cam.y = clamp(st.player.y + st.player.h / 2 - C.VIEW_H / 2, 0, Math.max(0, st.world.h - C.VIEW_H));
    setScreen("playing");
    st.ui.sel = 0;
  }
  function loadLevel(i) {
    st.levelIndex = i;
    st.playtestData = null;
    st.lineDone = null; // any level start clears a finished-LINE summary
    applyLevel(LEVELS[i].build(), LEVELS[i]);
    try { // speedrun pace data: the PB run's cumulative splits + gold segments
      st.pbSplits = JSON.parse(localStorage.getItem("tether.pbsplits." + LEVELS[i].id) || "null");
      st.goldSegs = JSON.parse(localStorage.getItem("tether.goldsegs." + LEVELS[i].id) || "null");
    } catch { st.pbSplits = null; st.goldSegs = null; }
    // the best run haunts the level — recorded at 20Hz, kept with the best time
    st.ghostRec = []; st.ghostTick = 0; st.ghost = null;
    try {
      const g = JSON.parse(localStorage.getItem("tether.ghost." + LEVELS[i].id) || "null");
      if (g && g.f && g.f.length) st.ghost = g;
      st.ghostHidden = localStorage.getItem("tether.ghostoff") === "1";
    } catch {}
    music.play(i, LEVELS[i].data?.music, LEVELS[i].data?.track); // authored theme + real track
    setMuffle(false);
  }
  // editor playtest: hot-load a working copy, no reload cycle, Esc returns
  function playtestLevel(data) {
    st.playtestData = data;
    applyLevel(instantiateLevel(data), data);
    music.play(Math.max(0, st.levelIndex ?? 0), data.music, data.track);
    setMuffle(false);
  }
  function restartLevel() {
    if (st.playtestData) playtestLevel(st.playtestData);
    else loadLevel(st.levelIndex); // in THE LINE this restarts the SEGMENT only
  }

  // PRACTICE FLAG (P): plant a checkpoint where you stand — death and the
  // void return you THERE instead of the level start, so a brutal room can
  // be drilled in isolation (DEATH WORLD, boss phases). The moment a flag
  // exists the attempt is a PRACTICE RUN: it finishes, but banks nothing
  // (no best/rank/ghost/splits/coins/leaderboard). R = honest restart.
  function setPractice() {
    if (st.deathT > 0 || st.won) return;
    const p = st.player;
    if (st.practice && len2(p.x - st.practice.x, p.y - st.practice.y) < 48) {
      st.practice = null; // planting on top of the flag picks it back up
      st.toast = { text: "FLAG CLEARED — still a practice run (R for a real one)", t: 2.2 };
      return;
    }
    st.practice = { x: p.x, y: p.y };
    st.practiceRun = true;
    sfx.confirm();
    ringFx(st, p.x + p.w / 2, p.y + p.h, "rgba(140,242,255,0.9)", 60, 0.35);
    st.toast = { text: "PRACTICE FLAG — death returns here · run unranked", t: 2.4 };
  }

  // ------------------------------------------------ THE LINE (marathon)
  // one unbroken run through a whole world: no results between levels, one
  // cumulative clock. Deaths cost time; R resets only the current segment;
  // leaving to the select screen abandons the run. IL bests/ghosts still
  // bank normally — a great LINE is made of great segments.
  function startLine(worldId) {
    const queue = LEVELS.map((_, i) => i)
      .filter((i) => !LEVELS[i].bside && (LEVELS[i].worldId || 1) === worldId);
    if (!queue.length) return;
    st.line = { world: worldId, queue, at: 0, total: 0, deaths: 0, splits: [] };
    loadLevel(queue[0]);
    st.toast = { text: `THE LINE — ${queue.length} LEVELS · ONE CLOCK`, t: 2.6 };
  }
  function lineAdvance() {
    const L = st.line;
    L.splits.push({ id: LEVELS[st.levelIndex].id, name: LEVELS[st.levelIndex].name,
      t: st.runTime, deaths: st.deaths });
    L.total += st.runTime;
    L.deaths += st.deaths;
    L.at++;
    if (L.at < L.queue.length) {
      loadLevel(L.queue[L.at]);
      st.line = L; // loadLevel clears stale line-results state, not the run
      st.toast = { text: `${L.at + 1}/${L.queue.length} — ${LEVELS[L.queue[L.at]].name}`, t: 2.2 };
      return;
    }
    st.line = null;
    st.lineDone = { world: L.world, total: L.total, deaths: L.deaths, splits: L.splits, newBest: false };
    try {
      const k = "tether.line." + L.world;
      const prev = JSON.parse(localStorage.getItem(k) || "null");
      if (!prev || L.total < prev.total) {
        st.lineDone.newBest = true;
        localStorage.setItem(k, JSON.stringify({ total: L.total, deaths: L.deaths, splits: L.splits }));
      }
    } catch {}
    submitScore("line-w" + L.world, Math.round(L.total * 1000));
    saveAchievement(`THE LINE — world ${L.world} in ${fmtTime(L.total)}`);
    setScreen("results");
    st.ui.sel = 0;
    setMuffle(true);
  }
  function gotoSelect(world) {
    st.line = null; // walking out mid-run abandons THE LINE
    st.lineDone = null;
    st.bests = LEVELS.map((_, i) => getBest(i));
    st.worldSel = world || LEVELS[st.levelIndex]?.worldId || st.worldSel || 1;
    setScreen("select"); // AFTER worldSel — the DOM select builds on this emit
    music.play(-1, null, "music/main-theme.mp3");
    setMuffle(false);
  }
  // The public demo has no campaign finale: clearing the last shipped level
  // returns to the select screen like any other level.
  function isCampaignFinale() {
    return false;
  }
  // the boot title dismissed — into the level select (the menu theme is
  // already queued; the gesture that got us here unlocked its audio). Plain
  // setScreen, NOT gotoSelect: keep the worldSel loaded from tether.world at
  // boot (a returning player opens on the world they left)
  function beginFromIntro() {
    st.intro = null;
    sfx.confirm();
    setScreen("select");
    setMuffle(false);
  }
  // (public demo: no finale path reaches this)
  function endFinale() {
    st.finale = null;
    gotoSelect(1);
  }
  // (public demo: no credits path reaches this)
  function endCredits() {
    st.credits = null; st._creditsData = null;
    loadLevel(Math.min(st.levelIndex + 1, LEVELS.length - 1));
  }
  // returning to play: the score is muffled ONLY if you're back in the 1-HP
  // last stand — otherwise it opens back up (keeps the low-HP guard in sync)
  function resumeMuffle() {
    const low = st.player.hp === 1 && !st.won && st.deathT <= 0;
    st._lowHpMuffle = low;
    setMuffle(low);
  }
  function uiAction(b) {
    if (!b) return;
    // an armed rebind capture is cancelled by activating anything else
    // (the canvas cleared it on any click — same semantics)
    if (st.rebind && b.action !== "rebind") { st.rebind = null; st.rebindMsg = null; }
    if (b.action !== "sliderset") // drags emit many; its tick is change-gated below
      (b.action === "slider" || b.action === "bflip" ? sfx.tick : sfx.confirm)();
    if (b.action === "load") loadLevel(b.arg);
    else if (b.action === "resume") { setScreen("playing"); resumeMuffle(); }
    else if (b.action === "restart") restartLevel();
    else if (b.action === "select") gotoSelect();
    else if (b.action === "next")
      loadLevel(b.arg != null ? b.arg : Math.min(st.levelIndex + 1, LEVELS.length - 1));
    else if (b.action === "fs") toggleFullscreen();
    else if (b.action === "mute") toggleMute();
    else if (b.action === "world") {
      // include the current (possibly still-empty) world in the cycle
      const ids = [...new Set([...worldIds(), st.worldSel])].sort((a, b) => a - b);
      const at = Math.max(0, ids.indexOf(st.worldSel));
      st.worldSel = ids[(at + b.arg + ids.length) % ids.length];
      try { localStorage.setItem("tether.world", String(st.worldSel)); } catch {}
      st.ui.sel = 0;
    }
    else if (b.action === "worldnew") {
      // a fresh empty world — it becomes real when its first level is saved
      st.worldSel = Math.max(...worldIds(), 0) + 1;
      st.ui.sel = 0;
    }
    else if (b.action === "slotL" || b.action === "slotR") {
      const id = LEVELS[b.arg]?.id;
      if (id && moveLevelInWorld(id, b.action === "slotR" ? 1 : -1)) {
        makeThumbs(LEVELS); // keep the shared thumb cache warm
        st.bests = LEVELS.map((_, j) => getBest(j));
        // the DOM select re-finds the moved card by level id on refresh —
        // selection follows the level without index bookkeeping
      }
    }
    else if (b.action === "skins") { setScreen("skins"); st.ui.sel = 0; }
    else if (b.action === "secrets") { setScreen("secrets"); st.ui.sel = 0; }
    else if (b.action === "secretplay") loadLevel(b.arg); // only pushed for unlocked B-sides
    else if (b.action === "skin") {
      st.paletteIndex = b.arg;
      try { localStorage.setItem("tether.palette", String(st.paletteIndex)); } catch {}
    }
    else if (b.action === "delcustom") { st.confirm = b.arg; st.ui.sel = 1; } // KEEP preselected
    else if (b.action === "delno") { st.confirm = null; st.ui.sel = 0; }
    else if (b.action === "delyes") doDeleteLevel(b.arg);
    else if (b.action === "settings") {
      st.settingsFrom = st.screen === "paused" ? "paused" : "select";
      setScreen("settings"); st.ui.sel = 0;
      st.rebind = null; st.rebindMsg = null;
    }
    else if (b.action === "setback") {
      setScreen(st.settingsFrom || "select"); st.ui.sel = 0;
      st.rebind = null; st.rebindMsg = null;
    }
    else if (b.action === "slider") // ENTER/click on the row: cycle up, wrap past 100%
      OPT.setSetting(b.arg, OPT.SETTINGS[b.arg] >= 1 ? 0 : OPT.SETTINGS[b.arg] + 0.05);
    else if (b.action === "sliderset") { // pointer on the BAR: set by fraction
      if (OPT.SETTINGS[b.arg.key] !== b.arg.value) {
        OPT.setSetting(b.arg.key, b.arg.value);
        sfx.tick();
        panelsUI.updateSlider(b.arg.key); // in-place — a rebuild would detach
      }                                   // the bar mid-drag (cursor + snap bugs)
    }
    else if (b.action === "rebind") { st.rebind = b.arg; st.rebindMsg = null; }
    else if (b.action === "setreset") OPT.resetSliders();
    else if (b.action === "keyreset") { OPT.resetKeys(); st.rebindMsg = null; }
    else if (b.action === "padpick") choosePad(b.arg); // null = back to auto
    else if (b.action === "toggle")
      OPT.setSetting(b.arg, OPT.SETTINGS[b.arg] >= 0.5 ? 0 : 1);
    else if (b.action === "bflip") {
      if (st.bflip.has(b.arg)) st.bflip.delete(b.arg);
      else st.bflip.add(b.arg);
    }
    else if (b.action === "line") startLine(b.arg);
    // any action that leaves us on a DOM screen re-renders it (world cycled,
    // card flipped, confirm opened/closed, pause fs/mute label, skin equip,
    // rebind armed…). sliderset is EXEMPT: it updates its row in place —
    // rebuilding mid-drag detaches the bar under the pointer.
    if (b.action === "sliderset") return;
    if (st.screen === "select") selectUI.refresh();
    else if (st.screen === "paused" || st.screen === "results" ||
             st.screen === "skins" || st.screen === "secrets" ||
             st.screen === "settings") panelsUI.refresh();
  }
  async function doDeleteLevel(i) {
    const id = LEVELS[i]?.id;
    st.confirm = null;
    st.ui.sel = 0;
    if (!id || !isDeletable(id)) return;
    await deleteLevel(id); // scrubs overlays + records, refreshes the registry
    makeThumbs(LEVELS);
    st.bests = LEVELS.map((_, j) => getBest(j));
    if (!LEVELS.some((l) => (l.worldId || 1) === st.worldSel)) st.worldSel = 1;
    if (st.levelIndex >= LEVELS.length) st.levelIndex = 0;
    if (st.screen === "select") selectUI.refresh(); // async tail — card list changed
  }
  function toggleFullscreen() {
    const el = canvas.parentElement || canvas;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  }
  // LAUNCH FULLSCREEN (settings): browsers refuse fullscreen without a user
  // gesture, so "by default" means "on the session's FIRST input". One shot —
  // exiting manually afterwards is respected.
  let autoFsDone = false;
  function maybeAutoFullscreen() {
    if (autoFsDone) return;
    autoFsDone = true;
    if (navigator.webdriver) return; // audits drive real inputs — a surprise
                                     // fullscreen would shift every mouse map
    if (OPT.SETTINGS.autofs >= 0.5 && !document.fullscreenElement) toggleFullscreen();
  }

  // ---------------------------------------------------------------- input
  // live lookup, not a snapshot — the settings screen rebinds KEYMAP at runtime
  const isGameKey = (c) => Object.values(KEYMAP).some((l) => l.includes(c));
  const menuKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"]);
  const held = (action) => KEYMAP[action].some((c) => st.input.pressed.has(c));

  function onKeyDown(e) {
    // typing into a DOM field (the editor's inline text input) is never gameplay
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    unlock(); // audio wants a user gesture — every keypress qualifies
    if (e.isTrusted) maybeAutoFullscreen(); // synthetic (gamepad) keys can't grant it
    if (editorActive()) {
      if (editorKeyDown(e)) { e.preventDefault(); return; }
    }
    const c = e.code;
    if (isGameKey(c) || menuKeys.has(c)) e.preventDefault();

    // an open DOM modal (z60: leaderboard/admin) owns the keyboard — the
    // menu underneath is inert. Esc closes the modal, the chrome toggles
    // (fullscreen/mute) stay live, everything else is swallowed. Gamepad
    // menu taps arrive as synthetic window KeyboardEvents and hit this same
    // gate, so Ⓑ closes the modal too.
    if (modalOpen()) {
      if (e.repeat) return;
      if (c === "Escape" || c === "Backspace") busEmit("modal-close"); // ⌫ = the fullscreen-safe Esc
      else if (KEYMAP.fullscreen.includes(c)) toggleFullscreen();
      else if (KEYMAP.mute.includes(c)) toggleMute();
      return;
    }

    // THE TITLE (boot) — anything begins the game (this keypress is also the
    // audio-unlock gesture, handled by unlock() above)
    if (st.screen === "intro") {
      e.preventDefault();
      if (!e.repeat) beginFromIntro();
      return;
    }

    // settled; before that it plays on, unskippable
    if (st.screen === "ending") {
      e.preventDefault();
      if (!e.repeat && finaleAdvance(st)) endFinale();
      return;
    }
    // the point, and it's short). Keys are swallowed so nothing leaks into the
    // frozen game; the set-piece hands off on its own clock.
    if (st.screen === "credits") {
      e.preventDefault();
      return;
    }

    // settings-screen key capture — swallows EVERYTHING until resolved
    if (st.screen === "settings" && st.rebind) {
      e.preventDefault();
      if (e.repeat) return;
      if (c === "Escape") { st.rebind = null; st.rebindMsg = null; panelsUI.refresh(); return; }
      const r = OPT.rebindKey(st.rebind, c);
      if (r.ok) { st.rebind = null; st.rebindMsg = null; sfx.confirm(); }
      else { st.rebindMsg = r.why; sfx.tick(); }
      panelsUI.refresh(); // the row shows the new binding / the error line
      return;
    }

    if (KEYMAP.fullscreen.includes(c)) {
      if (!e.repeat) toggleFullscreen();
      return;
    }
    if (KEYMAP.mute.includes(c)) {
      if (!e.repeat) {
        toggleMute();
        if (st.screen === "paused") panelsUI.refresh(); // SOUND label tracks M
      }
      return;
    }
    if (c === "F2") { // frame-time profiler overlay
      if (!e.repeat) st.prof.on = !st.prof.on;
      return;
    }
    if (c === "KeyG" && st.screen === "playing") {
      if (!e.repeat) {
        st.ghostHidden = !st.ghostHidden;
        try { localStorage.setItem("tether.ghostoff", st.ghostHidden ? "1" : "0"); } catch {}
        st.toast = { text: st.ghostHidden ? "GHOST OFF" : "GHOST ON", t: 1.2 };
      }
      return;
    }
    // ⌫ Backspace = Escape everywhere EXCEPT the select screen (there it
    // stays delete-custom). Native fullscreen reserves real Esc (the UA
    // exits fullscreen; preventDefault can't stop it, Firefox doesn't even
    // deliver the keydown) — Backspace is the in-fullscreen pause/back key
    // on every browser, matching gamepad Ⓑ (synthetic Esc, which the UA
    // ignores for the exit gesture).
    if (c === "Escape" || (c === "Backspace" && st.screen !== "select")) {
      if (e.repeat) return;
      e.preventDefault();
      if (st.screen === "playing" && st.playtestData) { setScreen("editor"); editorResume(); return; }
      if (st.screen === "playing") { setScreen("paused"); st.ui.sel = 0; setMuffle(true); }
      else if (st.screen === "paused") { setScreen("playing"); resumeMuffle(); }
      else if (st.screen === "results") gotoSelect();
      else if (st.screen === "skins") { setScreen("select"); st.ui.sel = 0; }
      else if (st.screen === "secrets") { setScreen("select"); st.ui.sel = 0; }
      else if (st.screen === "settings") uiAction({ action: "setback" });
      else if (st.screen === "select" && st.confirm != null) { st.confirm = null; selectUI.refresh(); }
      return;
    }

    if (st.screen === "playing") {
      if (!e.repeat) {
        if (KEYMAP.jump.includes(c)) st.input.spaceQ = true;
        if (KEYMAP.dash.includes(c)) st.input.dashQ = true;
        if (KEYMAP.grapple.includes(c)) { // E: advance an open panel, else read a fragment / talk, else grapple
          if (st.reading) advanceReading(st);
          else if (!tryReadFragment(st) && !tryTalkNpc(st)) st.input.grappleQ = true;
        }
        if (KEYMAP.attack.includes(c)) {
          st.input.attackHeld = true;
          st.input.attackBuf = C.ATTACK_BUFFER;
        }
        if (KEYMAP.reset.includes(c)) restartLevel();
        if (KEYMAP.practice.includes(c)) setPractice();
      }
      st.input.pressed.add(c);
      return;
    }

    // menu navigation
    if (e.repeat) return;
    if (st.screen === "select" && (c === "Delete" || c === "Backspace")) {
      e.preventDefault();
      if (st.confirm == null) {
        const b = selectUI.focusedTarget();
        if (b?.action === "load" && isDeletable(LEVELS[b.arg]?.id))
          { st.confirm = b.arg; selectUI.refresh(); } // refresh opens confirm, KEEP preselected
      }
      return;
    }
    if (st.screen === "select" && c === "Tab") { // cycle worlds
      if (st.confirm != null) return; // the modal owns input
      uiAction({ action: "world", arg: e.shiftKey ? -1 : 1 });
      return;
    }
    if (st.screen === "select" && /^Digit[1-9]$/.test(c)) {
      const wl = worldLevels();
      const i = Number(c.slice(5)) - 1;
      if (i < wl.length) { sfx.confirm(); loadLevel(wl[i]); }
      return;
    }
    if (st.screen === "select" && c === "KeyE") {
      sfx.confirm();
      const b = selectUI.focusedTarget();
      let ei = b && b.action === "load" ? b.arg : null;
      if (ei == null && b?.action === "bflip") // locked B-face: edit the B-side itself
        ei = LEVELS.findIndex((l) => l.bside && l.parent === b.arg);
      editorOpen(ei != null && ei >= 0 ? ei : (worldLevels()[0] ?? 0));
      setScreen("editor");
      return;
    }
    if (st.screen === "select" && c === "KeyN") {
      sfx.confirm();
      editorOpen(null, { worldId: st.worldSel }); // new levels land in THIS world
      setScreen("editor");
      return;
    }
    if (st.screen === "select" && c === "KeyO" && st.confirm == null) {
      uiAction({ action: "settings" });
      return;
    }
    if (st.screen === "select" && c === "KeyB" && st.confirm == null) {
      // flip the selected card to/from its B-side face
      const b = selectUI.focusedTarget();
      let pid = null;
      if (b?.action === "bflip") pid = b.arg;
      else if (b?.action === "load") {
        const L = LEVELS[b.arg];
        if (L?.parent) pid = L.parent; // B-face showing → flip back
        else if (L && LEVELS.some((x) => x.parent === L.id)) pid = L.id;
      }
      if (pid) uiAction({ action: "bflip", arg: pid });
      return;
    }
    if (st.screen === "settings") {
      // DOM panel with one special rule: ←/→ on a slider row adjusts it in
      // place (5% steps), on the toggle row it flips — on other rows they
      // navigate (canvas parity)
      const t = panelsUI.focusedTarget();
      if (c === "ArrowLeft" || c === "ArrowRight" || c === "KeyA" || c === "KeyD") {
        const dir = c === "ArrowRight" || c === "KeyD" ? 1 : -1;
        if (t?.action === "slider") { OPT.adjustSetting(t.arg, dir); sfx.tick(); panelsUI.updateSlider(t.arg); }
        else if (t?.action === "toggle") { OPT.setSetting(t.arg, OPT.SETTINGS[t.arg] >= 0.5 ? 0 : 1); sfx.tick(); panelsUI.refresh(); }
        else panelsUI.nav(dir);
        return;
      }
      if (c === "ArrowUp" || c === "KeyW") { panelsUI.nav(-1); return; }
      if (c === "ArrowDown" || c === "KeyS") { panelsUI.nav(1); return; }
      if (c === "Enter" || c === "Space") panelsUI.activateFocused();
      return;
    }
    if (st.screen === "select" && (c === "Comma" || c === "Period")) {
      if (st.confirm != null) return;
      const b = selectUI.focusedTarget();
      if (b?.action === "load") uiAction({ action: c === "Period" ? "slotR" : "slotL", arg: b.arg });
      return;
    }
    if (st.screen === "select" && (c === "BracketRight" || c === "BracketLeft")) {
      const un = unlockedPalettes(RANK.saveReader(LEVELS));
      const avail = PALETTES.map((p, i) => [p, i]).filter(([p]) => un.has(p.id));
      let at = avail.findIndex(([, i]) => i === st.paletteIndex);
      at = (at + (c === "BracketRight" ? 1 : avail.length - 1)) % avail.length;
      st.paletteIndex = avail[at][1];
      try { localStorage.setItem("tether.palette", String(st.paletteIndex)); } catch {}
      sfx.tick();
      return;
    }
    if (st.screen === "select") {
      // DOM select: the controller owns grid geometry + focus; it ticks on
      // focus change itself, and activations come back as uiBus actions
      if (c === "ArrowLeft" || c === "KeyA") selectUI.nav(-1, 0);
      else if (c === "ArrowRight" || c === "KeyD") selectUI.nav(1, 0);
      else if (c === "ArrowUp" || c === "KeyW") selectUI.nav(0, -1);
      else if (c === "ArrowDown" || c === "KeyS") selectUI.nav(0, 1);
      else if (c === "Enter" || c === "Space") selectUI.activateFocused();
      return;
    }
    if (st.screen === "skins") {
      // 2-column grid: Up/Down move the column, Left/Right cross it
      if (c === "ArrowLeft" || c === "KeyA") panelsUI.navGrid(-1, 0);
      else if (c === "ArrowRight" || c === "KeyD") panelsUI.navGrid(1, 0);
      else if (c === "ArrowUp" || c === "KeyW") panelsUI.navGrid(0, -1);
      else if (c === "ArrowDown" || c === "KeyS") panelsUI.navGrid(0, 1);
      else if (c === "Enter" || c === "Space") panelsUI.activateFocused();
      return;
    }
    if (st.screen === "paused" || st.screen === "results" || st.screen === "secrets") {
      // DOM panels: linear list — any arrow moves ±1 (canvas parity)
      if (c === "ArrowUp" || c === "KeyW" || c === "ArrowLeft" || c === "KeyA") panelsUI.nav(-1);
      else if (c === "ArrowDown" || c === "KeyS" || c === "ArrowRight" || c === "KeyD") panelsUI.nav(1);
      else if (c === "Enter" || c === "Space") panelsUI.activateFocused();
      else if (KEYMAP.reset.includes(c) && st.screen !== "secrets") restartLevel();
      return;
    }
    // (no canvas menu screens remain — the editor handled itself above)
  }
  function onKeyUp(e) {
    if (KEYMAP.attack.includes(e.code)) st.input.attackHeld = false;
    st.input.pressed.delete(e.code);
  }
  function onBlur() {
    st.input.pressed.clear();
    st.input.attackHeld = false;
  }
  function onMouseMove(e) {
    // window-level listener: DOM stacking can't contain it, so an open modal
    // gates it here — menu hover/selection must not track under the scrim
    if (modalOpen()) return;
    // canvas element is exactly the VIEW area (aspect-correct), so client →
    // VIEW is a direct proportional map; CSS letterbox lives outside the rect.
    const r = canvas.getBoundingClientRect();
    st.input.mouse.sx = clamp((e.clientX - r.left) / r.width * C.VIEW_W, 0, C.VIEW_W);
    st.input.mouse.sy = clamp((e.clientY - r.top) / r.height * C.VIEW_H, 0, C.VIEW_H);
    st.ui.mouseMoved = true;
    st.input.padAiming = false; // the mouse reclaims the crosshair
    if (editorActive()) editorMouseMove(st.input.mouse.sx, st.input.mouse.sy);
  }
  function onMouseDown(e) {
    unlock();
    if (e.isTrusted) maybeAutoFullscreen();
    e.preventDefault();
    // the modal scrim already captures clicks (this canvas listener can't
    // fire through it) — the guard documents the contract and covers any
    // synthetic dispatch straight at the canvas
    if (modalOpen()) return;
    if (st.screen === "intro") { beginFromIntro(); return; } // click also begins
    if (editorActive()) {
      editorMouseDown(st.input.mouse.sx, st.input.mouse.sy, e.button, e.shiftKey);
      return;
    }
    // every menu is DOM now — canvas mousedown only means gameplay input
    if (st.screen !== "playing") return;
    if (e.button === 0) {
      st.input.attackHeld = true;
      st.input.attackBuf = C.ATTACK_BUFFER;
    } else if (e.button === 2) {
      st.input.grappleQ = true;
    }
  }
  function onMouseUp(e) {
    if (editorActive()) { editorMouseUp(); return; }
    if (e.button === 0) st.input.attackHeld = false;
  }
  function onCtxMenu(e) { e.preventDefault(); }

  const aimWorld = () => ({
    x: st.cam.x + st.input.mouse.sx,
    y: st.cam.y + st.input.mouse.sy,
  });

  // the equipped skin drives every dash visual (color + particle flourish)
  const dashPal = () => PALETTES[st.paletteIndex] || PALETTES[0];
  const mixHex = (a, b, k) => { // lerp two #rrggbb colors
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = (sh) => Math.round(((pa >> sh) & 255) * (1 - k) + ((pb >> sh) & 255) * k);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  };
  const dimCache = { idx: -1, body: "", glow: "" }; // spent-dash ghost tints
  // spawn a skin-shaped dash burst — count/sparkle scale with the skin tier
  function dashBurst(x, y, n, spd) {
    const pal = dashPal(), fx = pal.fx || {};
    const tier = fx.tier || 1;
    const cnt = Math.round(n * (0.8 + tier * 0.35));
    for (let i = 0; i < cnt; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(spd * 0.35, spd);
      addParticle(st, {
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rand(0.25, 0.6), max: 0.6, grav: fx.shape === "smoke" ? -40 : 0,
        size: rand(2, 4), color: i % 3 === 0 ? pal.dash : pal.body,
        glow: true, shape: fx.shape, spin: rand(0, Math.PI * 2),
      });
    }
    if (tier >= 3) // top skins get a bright sparkle ring on top of the burst
      ringFx(st, x, y, pal.dash, 60, 0.28);
  }

  // -------------------------------------------------------------- actions
  function startDash(dx, dy, aim) {
    const p = st.player;
    let ux = dx, uy = dy;
    if (!ux && !uy) {
      const ax = aim.x - (p.x + p.w / 2), ay = aim.y - (p.y + p.h / 2);
      const l = len2(ax, ay) || 1;
      ux = ax / l; uy = ay / l;
    } else {
      const l = len2(ux, uy);
      ux /= l; uy /= l;
    }
    p.grapple = null;
    p.dashing = true; p.dashT = C.DASH_DURATION;
    p.dashDX = ux; p.dashDY = uy;
    // the INFERNAL DASH is the i-frame layer (E1) — the base dash is pure
    // movement, exactly as the W1–W2 curriculum teaches it
    if (st.infernal) p.iT = Math.max(p.iT, C.DASH_IFRAMES);
    p.isJumping = false;
    bumpStyle(st, 1); // airborne dash extends the chain
    st.revealT = 0.6;
    sfx.dash();
    impact(st, 0, C.SHAKE_LIGHT, st.infernal
      ? { r: 255, g: 110, b: 50, a: 0.14 } : { r: 255, g: 255, b: 255, a: 0.1 });
    dashBurst(p.x + p.w / 2, p.y + p.h / 2, 10, 240);
    if (st.infernal) { // the window IGNITES — hellfire ring + ember spray
      ringFx(st, p.x + p.w / 2, p.y + p.h / 2, "rgba(255,110,50,0.6)", 74, 0.26);
      burst(st, p.x + p.w / 2, p.y + p.h / 2, 12, 320, "#ff6a3d", 280, true);
    }
  }
  function endDash() {
    const p = st.player;
    if (!p.dashing) return;
    p.dashing = false;
    p.dashCd = C.DASH_COOLDOWN * st.power.dashCd;
    p.vx = p.dashDX * C.DASH_SPEED * C.DASH_END_KEEP;
    p.vy = p.dashDY * C.DASH_SPEED * C.DASH_END_KEEP * 0.5;
  }
  function doJump() {
    const p = st.player;
    const g = st.gravityDir || 1;
    sfx.jump();
    p.vy = -C.JUMP_FORCE * g;
    p.onGround = false; p.coyote = 0; st.input.jumpBuffer = 0; p.isJumping = true;
    for (let i = 0; i < 8; i++)
      addParticle(st, { x: p.x + p.w / 2, y: g > 0 ? p.y + p.h : p.y, vx: rand(-90, 90),
        vy: rand(-20, 70) * g, life: rand(0.2, 0.4), max: 0.4, grav: 300 * g,
        size: rand(2, 3), color: "#d8c4e8" });
  }
  function doWallJump() {
    const p = st.player;
    const g = st.gravityDir || 1;
    if (p.gripDir === 0) {
      // hanging from an anti-gravity face: SPACE is a drop-jump — release with
      // a push off the surface plus a steerable horizontal kick
      const dirX = (held("right") ? 1 : 0) - (held("left") ? 1 : 0);
      p.vx = (dirX || p.facing) * C.WALLJUMP_VX * 0.85;
      p.vy = 150 * g;
      p.onGround = false; p.coyote = 0; p.wallCoyote = 0;
      st.input.jumpBuffer = 0; p.isJumping = false;
      sfx.wallJump();
      for (let i = 0; i < 6; i++)
        addParticle(st, { x: p.x + rand(0, p.w), y: g > 0 ? p.y : p.y + p.h,
          vx: rand(-40, 40), vy: 40 * g, life: 0.3, max: 0.3, grav: 300 * g,
          size: rand(1.5, 2.5), color: "#9fd8a8" });
      return;
    }
    p.vx = -p.gripDir * C.WALLJUMP_VX; // away from the wall...
    p.vy = -C.WALLJUMP_VY * g;         // ...and up; JUMP_CUT variable height applies
    p.onGround = false; p.coyote = 0; p.wallCoyote = 0;
    p.steerLock = C.WALLJUMP_STEER_LOCK;
    st.input.jumpBuffer = 0; p.isJumping = true;
    sfx.wallJump();
    const fx2 = p.gripDir > 0 ? p.x + p.w : p.x;
    for (let i = 0; i < 8; i++)
      addParticle(st, { x: fx2, y: p.y + rand(4, p.h - 4), vx: -p.gripDir * rand(60, 160),
        vy: rand(-60, 60), life: rand(0.2, 0.35), max: 0.35, grav: 300,
        size: rand(1.5, 3), color: "#9fd8a8" });
  }
  function onLand(fallSpeed) {
    const p = st.player;
    p.dashCd = 0;
    p.isJumping = false;
    p.pogo = null;
    st.pogoChain = 0; // touching ground ends the pogo chain (SECRETS unlock)
    if (st.style.count >= 4) { // bank a good chain with a little flourish
      impact(st, 0, 0.18, null);
      ringFx(st, p.x + p.w / 2, p.y + p.h / 2, "rgba(255,209,102,0.7)", 70, 0.3);
    }
    st.style.count = 0; st.style.timer = 0; // touching ground ends the chain
    const hard = clamp(fallSpeed / 950, 0, 1);
    sfx.land(hard);
    p.squash = 0.12 + hard * 0.38;
    if (fallSpeed > 500) impact(st, 0, C.SHAKE_LAND * hard, null);
    const n = Math.floor(4 + hard * 9);
    for (let i = 0; i < n; i++)
      addParticle(st, { x: p.x + p.w / 2 + rand(-p.w / 2, p.w / 2), y: p.y + p.h,
        vx: rand(-150, 150), vy: rand(-60, -10), life: rand(0.2, 0.4), max: 0.4,
        grav: 500, size: rand(2, 3), color: "#d8c4e8" });
  }
  function clearQueues() {
    const inp = st.input;
    inp.jumpBuffer = 0; inp.attackBuf = 0;
    inp.dashQ = false; inp.grappleQ = false; inp.spaceQ = false;
  }
  // no checkpoints — death and hazards always return to the level's start
  function teleportToStart() {
    const p = st.player;
    const home = st.practice || st.spawn; // a practice flag overrides the start
    p.x = home.x; p.y = home.y;
    p.px = p.x; p.py = p.y; // no interpolation smear across the teleport
    p.vx = 0; p.vy = 0; p.rot = 0;
    p.dashing = false; p.dashCd = 0; p.grapple = null; p.attack = null; p.pogo = null;
    p.isJumping = false; p.coyote = 0; p.squash = 0;
    p.wallCoyote = 0; p.sliding = false;
    st.pogoChain = 0; // a reset to start also breaks the pogo chain
    clearQueues();
  }
  function respawn() {
    teleportToStart();
    const p = st.player;
    p.hp = C.PLAYER_HP;
    p.iT = 1.0; p.blinkT = 1.0; p.hurtInvuln = 1.0;
  }
  // THE single damage entry point. One shared mercy window (p.hurtInvuln) means
  // a spike + a drone (or two substeps) touching in the same instant can only
  // cost ONE heart. fromVoid always rescues you even mid-window (can't sit in
  // the void). Enemy contact lives in combat.js but sets the SAME window.
  function hurt(fromVoid) {
    const p = st.player;
    if (p.hurtInvuln > 0 || st.deathT > 0 || st.won) {
      if (fromVoid) teleportToStart(); // rescue without an extra heart
      return;
    }
    p.hp -= 1;
    st.hits++;
    p.hurtInvuln = C.DAMAGE_INVULN;
    p.blinkT = C.DAMAGE_INVULN;
    sfx.hurt();
    impact(st, C.HITSTOP_HURT, C.SHAKE_HURT, { r: 255, g: 70, b: 70, a: 0.4 });
    burst(st, p.x + p.w / 2, p.y + p.h / 2, 18, 360, "#ff6b6b", 450, true);
    if (p.hp <= 0) { startDeath(); return; }
    st.deaths++;
    teleportToStart();
  }
  // the death beat: control lock + big fx, THEN full-HP respawn
  function startDeath() {
    const p = st.player;
    st.deaths++;
    st.deathT = C.DEATH_TIME;
    sfx.death();
    p.vx = 0; p.vy = 0;
    p.grapple = null; p.dashing = false; p.attack = null; p.pogo = null; p.slash = null;
    impact(st, 0.1, C.SHAKE_DEATH, { r: 255, g: 60, b: 60, a: 0.5 });
    burst(st, p.x + p.w / 2, p.y + p.h / 2, 34, 460, "#ff6b6b", 420, true);
    ringFx(st, p.x + p.w / 2, p.y + p.h / 2, "rgba(255,107,107,0.9)", 120, 0.4);
  }
  function win() {
    if (st.won) return;
    st.won = true;
    st.winDelay = 1.15;
    const bank = !st.playtestData && !st.practiceRun; // practice banks NOTHING
    // RESET instead of a results table — a real run only, and only once the
    // boss is down (the goal gate already guarantees it)
    st.finaleQueued = bank && !st.line && st.bossDown && isCampaignFinale(st.levelIndex);
    // instead of a results table.
    st.creditsQueued = bank && !st.line && st.bossDown &&
      !isCampaignFinale(st.levelIndex) && !!LEVELS[st.levelIndex].data?.credits;
    st.newBest = bank ? saveBestIfBetter(st.levelIndex, st.runTime) : false;
    if (bank) reportLevelCompletion(LEVELS[st.levelIndex].id, Math.round(st.runTime * 1000));
    // close the lap: the run's segments (splits + the finish leg) feed the
    // results table; golds update on ANY finished run, PB splits follow a PB
    if (st.splits.length) {
      const cums = [...st.splits.map((s) => s.t), st.runTime];
      const segs = [...st.splits.map((s) => s.seg), st.runTime - st.splits[st.splits.length - 1].t];
      st.finalSegs = { cums, segs, pb: st.pbSplits, golds: st.goldSegs };
      if (bank) {
        try {
          const id = LEVELS[st.levelIndex].id;
          const golds = st.goldSegs ? [...st.goldSegs] : [];
          segs.forEach((s, i) => { if (golds[i] == null || s < golds[i]) golds[i] = s; });
          localStorage.setItem("tether.goldsegs." + id, JSON.stringify(golds));
          if (st.newBest) localStorage.setItem("tether.pbsplits." + id, JSON.stringify(cums));
        } catch {}
      }
    }
    if (bank) {
      try { // persist best coins + secret-exit discovery
        const id = LEVELS[st.levelIndex].id;
        if (st.newBest && st.ghostRec.length > 5)
          localStorage.setItem("tether.ghost." + id,
            JSON.stringify({ dt: 0.05, f: st.ghostRec }));
        const ck = "tether.coins." + id;
        if (st.coinCount > (Number(localStorage.getItem(ck)) || 0))
          localStorage.setItem(ck, String(st.coinCount));
        if (st.altExit) localStorage.setItem("tether.alt." + id, "1");
        // rank: keep the BEST (lowest grade index) ever earned on this level
        const rk = finalRank(st.runTime, effPar(LEVELS[st.levelIndex]), st.hits);
        st.rank = rk;
        const order = { S: 0, A: 1, B: 2, C: 3 };
        const prev = localStorage.getItem("tether.rank." + id);
        if (!prev || order[rk] < order[prev]) localStorage.setItem("tether.rank." + id, rk);
        const cm = LEVELS[st.levelIndex].data.coins?.length || 0;
        if (cm) localStorage.setItem("tether.coinmax." + id, String(cm));
      } catch {}
    }
    st.bests = LEVELS.map((_, i) => getBest(i));
    sfx.win();
    impact(st, 0, 0.3, { r: 255, g: 220, b: 130, a: 0.45 });
    const g = st.goal;
    const cols = ["#ffd166", "#ffb454", "#ff4fa0", "#a0ffa0", "#ffffff"];
    for (let i = 0; i < 150; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(80, 450);
      addParticle(st, { x: g.x + g.w / 2, y: g.y + g.h / 2, vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 130, life: rand(0.6, 1.4), max: 1.4, grav: 520,
        size: rand(2, 5), color: cols[i % cols.length], glow: true });
    }
  }

  // --------------------------------------------- physics step (FIXED dt)
  function step(dt) {
    const p = st.player, inp = st.input;
    p.px = p.x; p.py = p.y;
    for (const e of st.enemies) { e.px = e.x; e.py = e.y; }

    // death beat: the world holds its breath — then the RUN ENDS. A shatter
    // restarts the whole level (timer, enemies, boss hp, coins): three hearts
    // are three hits within ONE attempt, not three attempts against a
    // worn-down world. PRACTICE runs keep the soft flag-respawn instead —
    // preserving world state is exactly what makes drilling work.
    if (st.deathT > 0) {
      st.deathT -= dt;
      st.simTime += dt;
      if (st.deathT <= 0) {
        if (st.practiceRun) respawn();
        else restartLevel();
      }
      return;
    }

    st.simTime += dt;
    if (st.revealT > 0) st.revealT -= dt;
    if (!st.won) st.runTime += dt;
    // FOOTSTEPS (PR11): a stride cadence scaled to run speed — silent when
    // airborne, dashing, dead/won, or standing still. The counter rises so the
    // four footstep clips rotate instead of machine-gunning one.
    {
      const fs = Math.abs(p.vx);
      if (p.onGround && !p.dashing && !st.won && st.deathT <= 0 && fs > 45) {
        p.strideAcc = (p.strideAcc || 0) + fs * dt;
        if (p.strideAcc >= 70) { p.strideAcc = 0; sfx.step(st.strideN = (st.strideN || 0) + 1); }
      } else p.strideAcc = 0;
    }
    if (!st.won && !st.playtestData && ++st.ghostTick >= 6 && st.ghostRec.length < 6000) {
      st.ghostTick = 0; // 120Hz sim / 6 = 20Hz samples
      st.ghostRec.push([Math.round(p.x), Math.round(p.y), p.facing]);
    }
    if (st.won) {
      st.winDelay -= dt;
      // fire the post-win transition ONCE — a frame can run several fixed steps
      // and setScreen() doesn't break that loop, so without this guard step N+1
      // re-enters and (finaleQueued already spent) falls through to results
      if (st.winDelay <= 0 && !st.winHandled) {
        st.winHandled = true;
        if (st.playtestData) { setScreen("editor"); editorResume(); }
        else if (st.line) lineAdvance(); // THE LINE rolls straight on
        else { setScreen("results"); st.ui.sel = 0; setMuffle(true); }
      }
    }
    // 1-HP LAST STAND: one hit from death, the world narrows — the score goes
    // muffled ("behind glass"), a lub-dub heartbeat rises under it, and a red
    // vignette pulses in (render). Muffle only toggles on the state CHANGE so it
    // doesn't spam the filter automation.
    st.lowHp = p.hp === 1 && !st.won && st.deathT <= 0;
    music.setPulse(st.lowHp);
    if (st.lowHp !== st._lowHpMuffle) { st._lowHpMuffle = st.lowHp; setMuffle(st.lowHp); }
    updatePlatforms(st, dt); // movers carry riders BEFORE the player integrates
    updateAnchors(st, dt);   // zip anchors slide their rail; the taut rope rides along
    updateProps(st, dt);     // plates press, gates slide, clutter breaks
    updateHazards(st, dt);   // saws roll, pendulums swing, crushers cycle
    updateNpcs(st, dt);
    if (p.dashCd > 0) p.dashCd -= dt;
    if (p.coyote > 0) p.coyote -= dt;
    if (p.wallCoyote > 0) p.wallCoyote -= dt;
    if (p.steerLock > 0) p.steerLock -= dt;
    if (inp.jumpBuffer > 0) inp.jumpBuffer -= dt;
    if (p.iT > 0) p.iT -= dt;
    if (p.hurtInvuln > 0) p.hurtInvuln -= dt;
    if (p.attackCd > 0) p.attackCd -= dt;
    if (inp.attackBuf > 0) inp.attackBuf -= dt;

    const aim = aimWorld();
    st.aim = aim;
    p.facing = aim.x >= p.x + p.w / 2 ? 1 : -1;

    const dirX = (held("right") ? 1 : 0) - (held("left") ? 1 : 0);
    const dirY = (held("down") ? 1 : 0) - (held("up") ? 1 : 0);
    const wasGround = p.onGround;

    // ---- volumes: gravity-flip + wind act on the player's CENTER.
    // Momentum contract: velocity is NEVER touched on entry/exit — only the
    // forces change while inside (gravity sign; wind = constant acceleration).
    {
      const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
      let g = 1;
      for (const tr of st.triggers) {
        if (tr.kind !== "gravity") continue;
        if (pcx >= tr.x && pcx <= tr.x + tr.w && pcy >= tr.y && pcy <= tr.y + tr.h) { g = -1; break; }
      }
      st.gravityDir = g;
      if (!p.dashing) { // a dash is a commitment — wind waits
        for (const tr of st.triggers) {
          if (tr.kind !== "wind") continue;
          if (pcx < tr.x || pcx > tr.x + tr.w || pcy < tr.y || pcy > tr.y + tr.h) continue;
          const a = ((tr.angle || 0) * Math.PI) / 180; // 0° = up, clockwise
          const f = tr.force || C.WIND_FORCE;
          p.vx += Math.sin(a) * f * dt;
          p.vy += -Math.cos(a) * f * dt; // applies mid-swing too — new arcs
        }
      }
    }
    const grav = st.gravityDir;

    if (inp.dashQ) {
      inp.dashQ = false;
      if (!p.dashing && p.dashCd <= 0) startDash(dirX, dirY, aim);
    }

    // grapple fire / chain (blocked mid-dash; a dash is a commitment)
    if (inp.grappleQ) {
      inp.grappleQ = false;
      if (!p.dashing) tryFireGrapple(st);
    }

    // Space is context-sensitive: release the rope, else jump
    if (inp.spaceQ) {
      inp.spaceQ = false;
      if (p.grapple) releaseGrapple(st);
      else inp.jumpBuffer = C.JUMP_BUFFER;
    }

    if (p.dashing) {
      p.vx = p.dashDX * C.DASH_SPEED;
      p.vy = p.dashDY * C.DASH_SPEED;
      p.dashT -= dt;
      if (p.dashT <= 0) endDash();
      if (st.infernal) { // the INFERNAL trail — hellfire, cinders, falling ash
        for (let i = 0; i < 2; i++)
          addParticle(st, { x: p.x + p.w / 2 + rand(-8, 8), y: p.y + p.h / 2 + rand(-10, 10),
            vx: -p.dashDX * rand(60, 190) + rand(-40, 40),
            vy: -p.dashDY * rand(60, 190) - rand(10, 90),
            life: rand(0.3, 0.55), max: 0.55, grav: -130,
            size: rand(2, 4), color: Math.random() < 0.62 ? "#ff6a3d" : "#ffb454", glow: true });
        if (Math.random() < 0.75) // grey ash flecks sift down behind the burn
          addParticle(st, { x: p.x + p.w / 2 + rand(-10, 10), y: p.y + p.h / 2 + rand(-12, 12),
            vx: rand(-30, 30), vy: rand(20, 80),
            life: rand(0.5, 0.9), max: 0.9, grav: 150,
            size: rand(1, 2.2), color: "#8a7570", glow: false });
      }
      const pal = dashPal(), fx = pal.fx || {};
      addParticle(st, { kind: "trail", life: 0.18, max: 0.18,
        color: pal.dash, tstyle: fx.trail || "box", glow: (fx.tier || 1) >= 3,
        trail: { x: p.x, y: p.y, w: p.w, h: p.h } });
      if ((fx.tier || 1) >= 2 && Math.random() < 0.6) // extra shaped motes off the body
        addParticle(st, { x: p.x + rand(0, p.w), y: p.y + rand(0, p.h),
          vx: -p.dashDX * rand(40, 120), vy: -p.dashDY * rand(40, 120),
          life: rand(0.2, 0.4), max: 0.4, grav: fx.shape === "smoke" ? -30 : 0,
          size: rand(1.5, 3), color: pal.body, glow: true, shape: fx.shape });
    } else if (p.grapple) {
      applySwingForces(st, dt, dirX, dirY);
    } else {
      const steerX = p.steerLock > 0 ? 0 : dirX; // wall-jump pop wins briefly
      const target = steerX * C.RUN_SPEED * st.power.move;
      // fast-fall: holding TOWARD gravity while airborne (down normally, up
      // inside a flip zone) steepens the drop — Celeste-style commitment
      const fastFall = !p.onGround && dirY * grav > 0;
      // ice: barely any grip — you drift long after letting go of the keys
      const onIce = p.onGround && p.groundSolid?.surface === "ice";
      const rate = steerX !== 0
        ? (p.onGround ? (onIce ? C.SURF_ICE_ACCEL : C.GROUND_ACCEL)
                      : C.AIR_ACCEL * (fastFall ? C.FASTFALL_STEER : 1))
        : (p.onGround ? (onIce ? C.SURF_ICE_DECEL : C.GROUND_DECEL) : C.AIR_DECEL);
      p.vx = approach(p.vx, target, rate * dt);
      // asymmetric free-fall: the moment vy points WITH gravity the stronger
      // descent constant takes over — rises stay floaty (swing arcs, jump
      // apexes), falls commit. The rope branch above keeps symmetric GRAVITY.
      const gBase = p.vy * grav >= 0 ? C.GRAVITY_DESC : C.GRAVITY;
      p.vy += gBase * dt * grav * (fastFall ? C.FASTFALL_ACCEL : 1);
      const fallCap = C.MAX_FALL * (fastFall ? C.FASTFALL_MULT : 1);
      if (p.vy * grav > fallCap) p.vy = fallCap * grav;
      if (p.isJumping && !held("jump") && p.vy * grav < 0) { p.vy *= C.JUMP_CUT; p.isJumping = false; }
      if (p.vy * grav >= 0) p.isJumping = false;
    }

    if (inp.jumpBuffer > 0 && !p.dashing && !p.grapple) {
      if (p.onGround || p.coyote > 0) doJump();
      else if (p.wallCoyote > 0) doWallJump();
    }

    // integrate + resolve — substepped continuous collision (see physics.js)
    const fall = p.vy;
    moveAndCollide(st, dt);
    if (p.scorched) { // an INFERNAL dash just punched through scorched stone
      const s = p.scorched; p.scorched = null;
      sfx.crumbleBreak();
      impact(st, 0.03, 0.5, { r: 255, g: 110, b: 50, a: 0.25 });
      burst(st, s.x + s.w / 2, s.y + s.h / 2, 22, 420, "#ff8a4d", 320, true);
      ringFx(st, s.x + s.w / 2, s.y + s.h / 2, "rgba(255,140,70,0.6)", 90, 0.3);
      bumpStyle(st, 1); // shattering through is style, same as a node strike
    }
    if (p.dashing && (p.colX || p.colY)) endDash();
    p.x = clamp(p.x, 0, st.world.w - p.w);

    // angled bounce pad: contact hands the trajectory to the shared
    // velocity-redirect (same primitive as node strikes — dash refresh included)
    if (p.padLaunch) {
      const pad = p.padLaunch;
      p.padLaunch = null;
      pad.padCd = C.PAD_COOLDOWN;
      pad.contactT = 0.22;
      const a = ((pad.angle || 0) * Math.PI) / 180; // 0° = up
      launchPlayer(st, Math.sin(a), -Math.cos(a), C.NODE_MIN_SPEED, C.NODE_KICK_BONUS * 0.5);
      bumpStyle(st, 1);
      sfx.pogo(true);
      impact(st, 0.05, C.SHAKE_POGO * 0.7, { r: 255, g: 209, b: 102, a: 0.18 });
      burst(st, p.x + p.w / 2, p.y + p.h / 2, 14, 320, "#ffd166", 250, true);
      ringFx(st, pad.x + pad.w / 2, pad.y + pad.h / 2, "rgba(255,180,84,0.85)", 70, 0.3);
    }
    // bouncy pad reflected the landing inside the collision pass — sell it
    if (p.bounced) {
      const hard = clamp(p.bounced / 950, 0.25, 1);
      sfx.jump();
      p.isJumping = false; p.pogo = null;
      p.squash = 0.25 + hard * 0.3;
      impact(st, 0, C.SHAKE_LAND * hard * 0.6, null);
      for (let i = 0; i < Math.floor(5 + hard * 7); i++)
        addParticle(st, { x: p.x + p.w / 2 + rand(-p.w / 2, p.w / 2), y: p.y + p.h,
          vx: rand(-140, 140), vy: rand(-80, -20), life: rand(0.2, 0.4), max: 0.4,
          grav: 500, size: rand(2, 3), color: "#a8ff7a", glow: true });
      p.bounced = 0;
    }
    // conveyor: the belt carries whoever stands on it (position shift, like a
    // mover's carry — running composes on top instead of fighting the accel)
    if (p.onGround && p.groundSolid?.surface === "conveyor") {
      p.x += (p.groundSolid.conveyorSpeed ?? C.CONVEYOR_SPEED) * dt;
      p.x = clamp(p.x, 0, st.world.w - p.w);
    }

    ropeConstraint(st); // taut rope: project + strip outward radial velocity
    depenetrate(st);    // the constraint may re-embed us in a wall — settle NOW
    checkGrip(st, dt, held("left"), held("right")); // cling + wall-coyote

    const sp = len2(p.vx, p.vy);
    if (sp > C.MAX_SPEED) { const k = C.MAX_SPEED / sp; p.vx *= k; p.vy *= k; }

    if (wasGround && !p.onGround && !p.isJumping && !p.dashing) p.coyote = C.COYOTE_TIME;
    if (!wasGround && p.onGround) onLand(fall * grav); // landing speed in gravity-space

    // pogo intent: a midair attack while AIMING into the downward cone — one
    // input, aim-driven like every other verb (grapple/slash/dash all follow
    // the cursor). Holding Down still forces it as a keyboard fallback.
    let aimDown = false; // "down" = toward gravity, so flip zones pogo upward
    {
      const ax = aim.x - (p.x + p.w / 2), ay = aim.y - (p.y + p.h / 2);
      const l = len2(ax, ay);
      aimDown = l > 12 && (ay * grav) / l > C.POGO_AIM_CONE;
    }
    updateCombat(st, dt, !p.onGround && (aimDown || held("down")));
    if (p.hp <= 0 && st.deathT <= 0) startDeath();

    // hazards & goal — SWEPT: segment of step start/end centers vs spike rects
    // inflated by the player's half extents; no speed skips it. Gated only by
    // the shared mercy window (NOT dash i-frames — spikes always bite a dash).
    if (!st.won && p.hurtInvuln <= 0 && st.deathT <= 0) {
      const hw2 = p.w / 2 - 5, hh2 = p.h / 2 - 5;
      const c0x = p.px + p.w / 2, c0y = p.py + p.h / 2;
      const c1x = p.x + p.w / 2, c1y = p.y + p.h / 2;
      for (const s of st.spikes) {
        if (s.pulse && !pulseActive(s, st.simTime)) continue; // phased out = safe
        if (s.rot) { // rotated spike: capsule sweep vs the oriented box
          if (segObbT(c0x, c0y, c1x, c1y, s.x + s.w / 2, s.y + s.h / 2,
              s.w / 2, s.h / 2, (s.rot * Math.PI) / 180, 11) <= 1) { hurt(false); break; }
        } else {
          const infl = { x: s.x - hw2, y: s.y - hh2, w: s.w + hw2 * 2, h: s.h + hh2 * 2 };
          if (segRectT(c0x, c0y, c1x, c1y, infl) <= 1) { hurt(false); break; }
        }
      }
      // moving hazards share the same mercy window as spikes
      if (p.hurtInvuln <= 0 && st.deathT <= 0 && hazardHit(st)) hurt(false);
    }
    if (p.y > st.world.h + 150) { if (st.won) respawn(); else hurt(true); }
    // symmetric top void — a gravity flip can launch you above the world
    if (p.y + p.h < -220) { if (st.won) respawn(); else hurt(true); }
    if (!st.won && st.deathT <= 0 &&
        aabb(p.x, p.y, p.w, p.h, st.goal.x, st.goal.y, st.goal.w, st.goal.h)) win();
    // the void plunge: once the boss is down and the floor is gone, falling
    // past the void line completes the level (the drop into the dark = the win)
    if (!st.won && st.deathT <= 0 && st.voidY != null && st.bossDown && p.y > st.voidY) win();

    // coins + triggers (secrets, alternate exits)
    if (!st.won && st.deathT <= 0) {
      for (const c2 of st.coins) {
        if (c2.taken || !circleRect(c2.x, c2.y, 14, p.x, p.y, p.w, p.h)) continue;
        c2.taken = true;
        st.coinCount++;
        sfx.coin();
        burst(st, c2.x, c2.y, 12, 260, "#ffd166", 220, true);
        ringFx(st, c2.x, c2.y, "rgba(255,209,102,0.8)", 40, 0.25);
      }
      for (const tr of st.triggers) {
        if (tr.hit || !aabb(p.x, p.y, p.w, p.h, tr.x, tr.y, tr.w, tr.h)) continue;
        tr.hit = true;
        if (tr.kind === "secret") {
          sfx.secret();
          st.toast = { text: "SECRET FOUND", t: 2.5 };
          impact(st, 0, 0.15, null);
        } else if (tr.kind === "exit") {
          st.altExit = true;
          sfx.secret();
          win();
        } else if (tr.kind === "split") {
          // IL split gate: k-th crossed = k-th segment, lap-timer style.
          // Deaths don't reset the clock, so splits survive them too.
          const k = st.splits.length;
          const cum = st.runTime;
          const seg = cum - (k > 0 ? st.splits[k - 1].t : 0);
          const gold = st.goldSegs?.[k] != null && seg < st.goldSegs[k];
          const delta = st.pbSplits?.[k] != null ? cum - st.pbSplits[k] : null;
          st.splits.push({ t: cum, seg });
          st.splitFlash = { k, delta, gold, t: 2.8 };
          tr.flashT = 0.5;
          sfx.tick();
        }
      }
    }

    // speed streaks at high velocity
    if (sp > 1000)
      addParticle(st, { x: p.x + p.w / 2 + rand(-6, 6), y: p.y + p.h / 2 + rand(-6, 6),
        vx: -p.vx * 0.12, vy: -p.vy * 0.12, life: 0.16, max: 0.16, grav: 0,
        size: rand(1.5, 2.5), color: "rgba(255,220,170,0.8)", glow: true });
  }

  // ------------------------------- per-frame FX (real dt, fps-independent)
  function updateFX(dt, alpha) {
    const p = st.player;
    if (st.finale && updateFinale(st, dt)) endFinale();
    if (st.credits && updateCredits(st, dt)) endCredits();
    if (st.waking > 0) st.waking = Math.max(0, st.waking - dt);
    if (st.intro) updateIntro(st, dt); // the boot title drifts on the same clock
    updateBossFx(st, dt); // boss intro-card timeline (real dt, fps-independent)
    updateReading(st, dt);
    if (st.trauma > 0) st.trauma = Math.max(0, st.trauma - C.TRAUMA_DECAY * dt);
    if (st.flash.a > 0) st.flash.a = Math.max(0, st.flash.a - dt * 2.2);
    if (st.style.flash > 0) st.style.flash = Math.max(0, st.style.flash - dt * 3);
    if (st.toast && (st.toast.t -= dt) <= 0) st.toast = null;
    if (st.splitFlash && (st.splitFlash.t -= dt) <= 0) st.splitFlash = null;
    if (st.style.timer > 0) {
      st.style.timer -= dt;
      if (st.style.timer <= 0) st.style.count = 0; // combo timed out mid-air
    }
    if (p.squash > 0) p.squash = Math.max(0, p.squash - dt * 3.5);
    if (p.blinkT > 0) p.blinkT -= dt;
    if (p.grapple && p.grapple.visT < 1)
      p.grapple.visT = Math.min(1, p.grapple.visT + dt / C.ROPE_VISUAL_T);
    for (const n of st.nodes) if (n.pulse > 0) n.pulse = Math.max(0, n.pulse - dt * 3);

    // particles + dust crawl during hit-stop (sells the freeze)
    const pdt = st.hitStop > 0 ? dt * C.HITSTOP_SCALE : dt;
    if (p.slash && (p.slash.t -= pdt) <= 0) p.slash = null;
    updateParticles(st, pdt);
    if (st.worldbg) updateWorldBg(st.worldbg, st.world, pdt, st.cam);
    else for (const m of st.dust) {
      m.y -= m.z * 9 * pdt;
      if (m.y < -10) { m.y += st.world.h + 20; m.x = Math.random() * st.world.w; }
    }

    updateDecor(st.decor, dt, p.x + p.w / 2, p.y + p.h / 2, p.vx);
    // body tilt into velocity while airborne (or a lean INTO the grip wall)
    const targetRot = p.sliding ? p.gripDir * 0.12
      : p.onGround ? 0 : clamp(p.vx * 0.00045, -0.5, 0.5);
    p.rot += (targetRot - p.rot) * (1 - Math.pow(0.001, dt));

    // camera: chase interpolated player + velocity lookahead
    const icx = lerp(p.px, p.x, alpha) + p.w / 2;
    const icy = lerp(p.py, p.y, alpha) + p.h / 2;
    const lax = clamp(p.vx * C.CAM_LOOKAHEAD, -C.CAM_LOOK_MAX, C.CAM_LOOK_MAX);
    const lay = clamp(p.vy * C.CAM_LOOKAHEAD * 0.6, -C.CAM_LOOK_MAX, C.CAM_LOOK_MAX);
    const tx = clamp(icx + lax - C.VIEW_W / 2, 0, Math.max(0, st.world.w - C.VIEW_W));
    const ty = clamp(icy + lay - C.VIEW_H / 2, 0, Math.max(0, st.world.h - C.VIEW_H));
    const k = 1 - Math.pow(C.CAM_SMOOTH, dt);
    st.cam.x += (tx - st.cam.x) * k;
    st.cam.y += (ty - st.cam.y) * k;
  }

  // ------------------------------------------------------------- render
  function render(alpha) {
    const p = st.player;
    const W = C.VIEW_W, H = C.VIEW_H, t = st.rtime;
    const ix = lerp(p.px, p.x, alpha), iy = lerp(p.py, p.y, alpha);
    const pcx = ix + p.w / 2, pcy = iy + p.h / 2;

    // Backing store == VIEW × view.scale exactly, so one uniform scale maps
    // VIEW coords → pixels. No in-canvas letterbox needed (CSS centers the
    // aspect-correct canvas element; the page paints the bars).
    ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
    // a configured world (worldbg.js) owns the whole ambient layer on the
    // world screens; menus and the editor keep the legacy gradient+dust
    const wbgLive = st.worldbg && st.screen !== "editor" && st.screen !== "select" &&
      st.screen !== "skins" && st.screen !== "secrets" && st.screen !== "settings" &&
      st.screen !== "intro" && st.screen !== "credits";
    if (wbgLive) {
      drawWorldBg(ctx, st, W, H, t);
    } else {
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);
      // parallax dust motes (all screens — the menus float in the same space)
      for (const m of st.dust) {
        const sx = m.x - st.cam.x * m.z, sy = m.y - st.cam.y * m.z;
        if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) continue;
        ctx.globalAlpha = 0.22 + 0.2 * Math.sin(t * 1.6 + m.t);
        ctx.fillStyle = "#b89ccc";
        ctx.fillRect(sx, sy, m.s, m.s);
      }
      ctx.globalAlpha = 1;
    }

    if (st.screen === "editor") {
      st.ui.buttons.length = 0;
      editorDraw(ctx, t, 0.016);
    } else if (st.screen === "select") {
      // DOM screen (selectScreen.js) — the canvas keeps the ambient
      // background (gradient + dust above) and nothing else
      st.ui.buttons.length = 0;
    } else if (st.screen === "skins" || st.screen === "secrets" || st.screen === "settings") {
      // DOM panels (panelScreens.js) over the ambient background
      st.ui.buttons.length = 0;
    } else if (st.screen === "intro") {
      // the boot title — over the ambient background, no world, no DOM
      st.ui.buttons.length = 0;
      drawIntro(ctx, st);
    } else if (st.screen === "credits") {
      // no world, no DOM — just the ambient bg under the cinematic
      st.ui.buttons.length = 0;
    } else {
      // playing / paused / results — the world renders live; the pause and
      // results screens are DOM panels (panelScreens.js) over it
      renderWorld(alpha, ix, iy, pcx, pcy, W, H, t);
      st.ui.buttons.length = 0;
    }

    // — the credits screen skips renderWorld, so these live in render() proper
    if (st.credits) drawCredits(ctx, st);
    if (st.waking > 0) drawWaking(ctx, st);

    // fps meter — verify your display Hz here (hidden in the editor, whose
    // owns the whole frame)
    if (st.screen !== "editor" && st.screen !== "ending" && st.screen !== "intro" && st.screen !== "credits") {
      // on select the DOM account chip owns the top-right corner — duck under it
      const fy = st.screen === "select" ? 56 : 24;
      ctx.textAlign = "right";
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.fillStyle = "rgba(200,170,220,0.7)";
      ctx.fillText(`${Math.round(st.fps)} FPS · sim ${C.PHYSICS_HZ} Hz`, W - 14, fy);
      if (isMuted()) {
        ctx.fillStyle = "rgba(255,180,84,0.6)";
        ctx.fillText("MUTED · M", W - 14, fy + 16);
      }
    }

    // custom crosshair / menu pointer (system cursor is hidden over the
    // canvas). DOM screens show a REAL cursor instead — draw only where the
    // canvas still owns the pointer (gameplay + editor).
    if (st.screen === "playing" || st.screen === "editor") {
      const mx = st.input.mouse.sx, my = st.input.mouse.sy;
      const locked = st.screen === "playing" && !!st.lock;
      ctx.strokeStyle = locked ? "rgba(255,180,84,1)" : "rgba(255,230,200,0.9)";
      ctx.lineWidth = locked ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(mx - 9, my); ctx.lineTo(mx - 3, my);
      ctx.moveTo(mx + 3, my); ctx.lineTo(mx + 9, my);
      ctx.moveTo(mx, my - 9); ctx.lineTo(mx, my - 3);
      ctx.moveTo(mx, my + 3); ctx.lineTo(mx, my + 9);
      ctx.stroke();
      ctx.fillStyle = locked ? "rgba(255,180,84,1)" : "rgba(255,230,200,0.9)";
      ctx.fillRect(mx - 1, my - 1, 2, 2);
    }
  }

  function renderWorld(alpha, ix, iy, pcx, pcy, W, H, t) {
    const p = st.player;

    // camera + trauma shake (sub-pixel translate = smooth at high fps);
    // the settings SCREEN SHAKE slider scales the whole effect
    const shake = C.MAX_SHAKE * st.trauma * st.trauma * OPT.SETTINGS.shake;
    const shx = (Math.random() * 2 - 1) * shake, shy = (Math.random() * 2 - 1) * shake;
    st.lastShake.x = shx; st.lastShake.y = shy;
    ctx.save();
    ctx.translate(-st.cam.x + shx, -st.cam.y + shy);

    // faint grid — legacy worlds only; a configured background is a PLACE,
    // its silhouette planes already carry the depth the grid faked
    if (!st.worldbg) {
      ctx.strokeStyle = "rgba(255,255,255,0.025)";
      ctx.lineWidth = 1;
      const gs = 64;
      for (let x = Math.floor(st.cam.x / gs) * gs; x < st.cam.x + W + gs; x += gs) {
        ctx.beginPath(); ctx.moveTo(x, st.cam.y); ctx.lineTo(x, st.cam.y + H); ctx.stroke();
      }
      for (let y = Math.floor(st.cam.y / gs) * gs; y < st.cam.y + H + gs; y += gs) {
        ctx.beginPath(); ctx.moveTo(st.cam.x, y); ctx.lineTo(st.cam.x + W, y); ctx.stroke();
      }
    }

    drawDecorLayer(ctx, st.decor, 0, t, st.tint, pcx, pcy); // background dressing
    drawZones(ctx, st.triggers, t); // gravity/wind volumes are visible space
    drawProps(ctx, st, t);

    // anchors — gold rings (swing), cyan rings on a rail (zip-line), magenta
    // elastic rings (slingshot); all brighter when in grapple range
    for (const a of st.anchors) {
      const d = len2(a.x - pcx, a.y - pcy);
      const inRange = d <= C.GRAPPLE_RANGE;
      const pulse = 1 + 0.12 * Math.sin(t * 3 + a.x * 0.01);
      const hue = a.kind === "zip" ? "140,242,255" : a.kind === "sling" ? "255,92,160" : "255,209,102";
      if (a.kind === "zip") { // the rail the ring travels; a faint dashed guide
        ctx.strokeStyle = `rgba(140,242,255,${inRange ? 0.3 : 0.14})`;
        ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
        ctx.beginPath(); ctx.moveTo(a.x0, a.y0); ctx.lineTo(a.x2, a.y2); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = `rgba(${hue},${inRange ? 0.95 : 0.35})`;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = `rgb(${hue})`;
      ctx.shadowBlur = inRange ? 14 : 4;
      ctx.beginPath();
      ctx.arc(a.x, a.y, C.ANCHOR_R * pulse, 0, Math.PI * 2);
      ctx.stroke();
      if (a.kind === "sling") { // a second, looser ring = the rubber band
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.arc(a.x, a.y, C.ANCHOR_R * pulse + 3.5, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(${hue},${inRange ? 1 : 0.4})`;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (st.practice) { // the planted flag — a small cyan pennant
      const fx3 = st.practice.x + C.PLAYER_W / 2, fy3 = st.practice.y + C.PLAYER_H;
      ctx.strokeStyle = "rgba(140,242,255,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(fx3, fy3); ctx.lineTo(fx3, fy3 - 26); ctx.stroke();
      ctx.fillStyle = `rgba(140,242,255,${0.65 + 0.3 * Math.sin(t * 5)})`;
      ctx.beginPath();
      ctx.moveTo(fx3, fy3 - 26); ctx.lineTo(fx3 + 14, fy3 - 21); ctx.lineTo(fx3, fy3 - 16);
      ctx.closePath(); ctx.fill();
    }
    if (st.deathT <= 0 && st.screen === "playing") drawLockUI(ctx, st, pcx, pcy, t);

    // goal
    {
      const g = st.goal;
      const gp = 0.5 + 0.5 * Math.sin(t * 3);
      ctx.save();
      ctx.shadowColor = "#ffd166"; ctx.shadowBlur = 20 + gp * 22;
      ctx.fillStyle = `rgba(255,209,102,${0.13 + gp * 0.13})`;
      rr(ctx, g.x, g.y, g.w, g.h, 12); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,209,102,0.85)"; ctx.lineWidth = 2;
      rr(ctx, g.x, g.y, g.w, g.h, 12); ctx.stroke();
      ctx.translate(g.x + g.w / 2, g.y + g.h / 2);
      ctx.rotate(t * 0.8);
      ctx.fillStyle = "#ffd166";
      drawStarPath(ctx, 0, 0, 5, 17, 8);
      ctx.fill();
      ctx.restore();
      ctx.font = "bold 12px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,209,102,0.8)";
      ctx.fillText("GOAL", g.x + g.w / 2, g.y - 10);
    }

    // platforms (kind-aware: static / crumble / mover / grip)
    drawSolids(ctx, st, t);

    // spikes — shared painter (platforms.js); rotated + pulsing handled
    drawSpikes(ctx, st.spikes, st.simTime);
    drawHazards(ctx, st, t); // saws, pendulums, crushers, lasers

    // tutorial hints — emphasis 1 = a teaching prompt (pill-backed, bright,
    // placed where the player can STAND STILL and read before the verb is
    // ever required); 0 = ambient flavor text.
    // OVERFLOW RULE: hints are world-anchored, so a wide pill straddling the
    // screen edge would clip mid-word when read from a distance. While ANY
    // part of a hint is on-screen, it slides horizontally to sit fully inside
    // the viewport (sticky-note behavior); fully off-screen hints stay put.
    ctx.textAlign = "center";
    for (const h of st.hints) {
      const { x: hax, y: hy, text: txt, big } = h;
      ctx.font = big ? "bold 14px ui-monospace, Menlo, monospace"
                     : "13px ui-monospace, Menlo, monospace";
      const half = ctx.measureText(txt).width / 2 + (big ? 12 : 4);
      let hx = hax;
      const visible = hax + half > st.cam.x && hax - half < st.cam.x + W;
      if (visible)
        hx = clamp(hax, st.cam.x + half + 6, st.cam.x + W - half - 6);
      if (big) {
        const bob = Math.sin(t * 2 + hax * 0.01) * 2;
        ctx.fillStyle = "rgba(12,8,18,0.62)";
        rr(ctx, hx - half, hy + bob - 16, half * 2, 24, 7);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,209,102,0.35)";
        ctx.lineWidth = 1;
        rr(ctx, hx - half, hy + bob - 16, half * 2, 24, 7);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,233,201,0.92)";
        ctx.fillText(txt, hx, hy + bob);
      } else {
        // soft shadow separates faint text from bright platform-edge pixels
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 4;
        ctx.fillStyle = "rgba(216,196,232,0.44)";
        ctx.fillText(txt, hx, hy);
        ctx.shadowBlur = 0;
      }
    }


    drawNodes(ctx, st, t);
    for (const c2 of st.coins) {
      if (c2.taken) continue;
      ctx.save();
      ctx.translate(c2.x, c2.y + Math.sin(t * 2 + c2.x * 0.02) * 3);
      ctx.rotate(t * 1.6);
      ctx.shadowColor = "#ffd166"; ctx.shadowBlur = 12;
      ctx.fillStyle = "#ffd166";
      ctx.strokeStyle = "#fff3c4"; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(7, 0); ctx.lineTo(0, 9); ctx.lineTo(-7, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
    }
    drawNpcs(ctx, st, t);
    for (const f of st.fragments) drawFragment(ctx, f, t, fragCollected(f));
    if (st.deathT <= 0 && !st.reading) { drawFragPrompt(ctx, st, t); drawNpcPrompt(ctx, st, t); } // "E ·" prompts
    drawEnemies(ctx, st, alpha, pcx, pcy);
    drawInfernalDrop(ctx, st, t); // Baphomet's reward, once it has fallen
    drawShots(ctx, st, alpha);

    if (st.deathT <= 0) drawRope(ctx, st, pcx, pcy);

    drawParticles(ctx, st, "under"); // dash afterimages

    // the ghost of your best run (G toggles)
    if (st.ghost && !st.ghostHidden && st.deathT <= 0 && st.screen === "playing") {
      const g = st.ghost;
      const ft = st.runTime / g.dt;
      const i0 = Math.min(g.f.length - 1, Math.floor(ft));
      const i1 = Math.min(g.f.length - 1, i0 + 1);
      const fr = ft - i0;
      const gx = lerp(g.f[i0][0], g.f[i1][0], fr);
      const gy = lerp(g.f[i0][1], g.f[i1][1], fr);
      ctx.save();
      ctx.globalAlpha = 0.26;
      ctx.fillStyle = "#8CF2FF";
      rr(ctx, gx, gy, p.w, p.h, 7);
      ctx.fill();
      ctx.fillStyle = "#0b2b30";
      const fdir = g.f[i0][2] || 1;
      ctx.beginPath(); ctx.arc(gx + p.w / 2 + fdir * 4.5 - 4.5, gy + p.h * 0.32, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(gx + p.w / 2 + fdir * 4.5 + 4.5, gy + p.h * 0.32, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // player — squash/stretch + airborne tilt; hidden during the death beat
    if (st.deathT <= 0) {
      const dashReady = p.dashCd <= 0 && !p.dashing;
      const pal = PALETTES[st.paletteIndex] || PALETTES[0];
      // the spent-dash "ghost" body dims the SKIN's color (was hardcoded
      // #7c6650 yellow — FROST stayed yellow mid-i-frames). Cached per skin.
      if (dimCache.idx !== st.paletteIndex) {
        dimCache.idx = st.paletteIndex;
        dimCache.body = mixHex(pal.body, "#241a22", 0.52);
        dimCache.glow = mixHex(pal.body, "#0f0b12", 0.75);
      }
      const bodyC = p.dashing ? pal.dash : dashReady ? pal.ready : dimCache.body;
      const glowC = p.dashing ? pal.dash : dashReady ? pal.body : dimCache.glow;
      const vst = clamp(len2(p.vx, p.vy) / 2400, 0, 0.28);
      const sclX = (1 - vst * 0.7) * (1 + p.squash * 0.9);
      const sclY = (1 + vst) * (1 - p.squash * 0.8);
      if (dashReady && st.screen === "playing") {
        const ap = 1 + 0.07 * Math.sin(t * 8);
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = pal.ready; // the ready halo wears the skin's color
        ctx.shadowColor = pal.ready; ctx.shadowBlur = (pal.fx?.tier || 1) >= 2 ? 8 : 0;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pcx, pcy, p.w * 0.95 * ap, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      if (p.blinkT > 0) ctx.globalAlpha = Math.floor(p.blinkT * 20) % 2 === 0 ? 0.35 : 1;
      ctx.translate(pcx, pcy);
      ctx.rotate(p.rot);
      ctx.scale(sclX, sclY * (st.gravityDir || 1)); // flipped gravity flips the body
      // the hooded wanderer (wanderer.js): dark silhouette + reactive cape;
      // the skin's accent lives in the eyes + chest crystal, and the crystal
      // carries the dash-ready read the body color used to. THE VESSEL (PR16):
      // the burn-state structure rides along per world — but specials
      // EMBER vessel takes the phase's core hue (earned skins keep their color).
      const special = pal.special;
      const phase = special ? null : st.vesselPhase;
      const coreTint = (phase && st.paletteIndex === 0) ? VESSEL_CORE[phase.id] : null;
      drawWanderer(ctx, {
        w: p.w, h: p.h, facing: p.facing,
        aimX: st.aim.x - pcx, aimY: st.aim.y - pcy,
        vx: p.vx, vy: p.vy,
        accent: coreTint ? coreTint.core : pal.ready,
        dashColor: coreTint ? coreTint.dash : pal.dash,
        special, phase,
        crystal: p.dashing ? "dashing" : dashReady ? "ready" : "charging",
        t, idle: st.idleT,
      });
      ctx.restore();

      // i-frame shimmer — invulnerability reads in the SKIN's dash color
      if (p.iT > 0) {
        ctx.save();
        ctx.globalAlpha = 0.3 + 0.25 * Math.sin(t * 28);
        ctx.strokeStyle = pal.dash;
        ctx.shadowColor = pal.dash;
        ctx.shadowBlur = 8;
        ctx.lineWidth = 2;
        rr(ctx, ix - 3, iy - 3, p.w + 6, p.h + 6, 9);
        ctx.stroke();
        ctx.restore();
      }

      // dash cooldown pie above the head (below it when gravity is flipped)
      if (!dashReady && !p.dashing) {
        const pieY = (st.gravityDir || 1) > 0 ? iy - 14 : iy + p.h + 14;
        const f = 1 - clamp(p.dashCd / (C.DASH_COOLDOWN * st.power.dashCd), 0, 1);
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = pal.ready;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(pcx, pieY, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(pcx, pieY, 7, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (st.deathT <= 0) {
      drawSlash(ctx, st, pcx, pcy);
      drawPogo(ctx, st, ix, iy);
    }
    drawDecorLayer(ctx, st.decor, 1, t, st.tint, pcx, pcy); // foreground dressing

    drawParticles(ctx, st, "over"); // sparks + rings

    ctx.restore(); // end camera space

    // impact flash — scaled by the settings IMPACT FLASH slider
    st.lastFlashA = st.flash.a * OPT.SETTINGS.flash;
    if (st.lastFlashA > 0) {
      ctx.fillStyle = `rgba(${st.flash.r},${st.flash.g},${st.flash.b},${st.lastFlashA})`;
      ctx.fillRect(0, 0, W, H);
    }
    // 1-HP LAST STAND vignette — the world closes in, a red edge-glow pulsing
    // like a heartbeat (lub-dub Gaussian). Only while genuinely one hit away.
    if (st.lowHp && st.deathT <= 0) {
      if (!st.vigGrad || st.vigGrad.w !== W || st.vigGrad.h !== H) {
        const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.30, W / 2, H / 2, H * 0.82);
        g.addColorStop(0, "rgba(160,14,26,0)");
        g.addColorStop(0.6, "rgba(160,14,26,0.55)");
        g.addColorStop(1, "rgba(160,14,26,1)");
        st.vigGrad = { grad: g, w: W, h: H };
      }
      const ph = t % 0.92;                                    // ~65 bpm
      const g1 = (ph - 0.02) / 0.07, g2 = (ph - 0.26) / 0.08; // lub-dub Gaussians
      const beat = Math.max(Math.exp(-g1 * g1), 0.8 * Math.exp(-g2 * g2));
      ctx.globalAlpha = 0.36 + 0.40 * beat;
      ctx.fillStyle = st.vigGrad.grad;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    // per-level ambient identity: a faint top glow in the level's signature hue
    const wash = ctx.createLinearGradient(0, 0, 0, H * 0.5);
    wash.addColorStop(0, st.tint);
    wash.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H * 0.5);
    ctx.restore();
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);

    // -------------------------------------------------------------- HUD
    // steady-state chrome (hearts/name/time/stats/dash/line/tags) is DOM now
    // (hud.js, synced per frame from frame()). The canvas keeps the juice:
    // split flash, boss/reaper bars, toast, style meter, death overlay.
    ctx.textAlign = "left";
    ctx.font = "bold 13px ui-monospace, Menlo, monospace";
    // live split delta — lap-timer green/red vs the PB run's pace
    if (st.splitFlash) {
      const f = st.splitFlash;
      const a = Math.min(1, f.t);
      let text, col;
      if (f.delta == null) { text = `SPLIT ${f.k + 1}  —`; col = `rgba(200,180,220,${a})`; }
      else {
        const sign = f.delta >= 0 ? "+" : "−";
        text = `SPLIT ${f.k + 1}  ${sign}${Math.abs(f.delta).toFixed(2)}`;
        col = f.delta < 0 ? `rgba(125,255,200,${a})` : `rgba(255,107,107,${a})`;
      }
      ctx.save();
      ctx.font = "bold 14px ui-monospace, Menlo, monospace";
      ctx.fillStyle = col;
      if (f.gold) { ctx.shadowColor = "#ffd166"; ctx.shadowBlur = 10; }
      ctx.fillText(text + (f.gold ? " ★" : ""), 240, 78);
      ctx.restore();
    }
    drawKeeperHud(ctx, st);
    drawBaphometHud(ctx, st);
    drawLeviathanHud(ctx, st);
    drawUrielHud(ctx, st);
    drawArchitectHud(ctx, st);
    drawShadowHud(ctx, st);
    drawReaperHud(ctx, st);
    if (st.toast) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.font = "bold 20px ui-monospace, Menlo, monospace";
      ctx.fillStyle = `rgba(140,242,255,${Math.min(1, st.toast.t)})`;
      ctx.shadowColor = "#8CF2FF"; ctx.shadowBlur = 14;
      ctx.fillText(st.toast.text, C.VIEW_W / 2, 130);
      ctx.restore();
    }
    if (st.bossIntro) drawBossIntro(ctx, st); // the boss title-card, over the world
    if (st.reading) drawLorePanel(ctx, st); // the quiet memory scrap, over the world
    if (st.finale) drawFinale(ctx, st);

    // style meter — rewards an unbroken airborne chain (swing→pogo→dash→strike)
    if (st.style.count >= 2 && st.deathT <= 0) {
      let rank = C.STYLE_RANKS[0];
      for (const r of C.STYLE_RANKS) if (st.style.count >= r[0]) rank = r;
      const [, label, col] = rank;
      const pop = 1 + st.style.flash * 0.22;
      const rx = W - 30;
      ctx.save();
      ctx.textAlign = "right";
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 14;
      ctx.font = `bold ${Math.round(26 * pop)}px ui-monospace, Menlo, monospace`;
      ctx.fillText(label, rx, 108);
      ctx.shadowBlur = 0;
      ctx.font = `bold ${Math.round(46 * pop)}px ui-monospace, Menlo, monospace`;
      ctx.fillText(`×${st.style.count}`, rx, 156);
      const frac = clamp(st.style.timer / C.STYLE_WINDOW, 0, 1);
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      rr(ctx, rx - 150, 172, 150, 6, 3); ctx.fill();
      ctx.fillStyle = col;
      rr(ctx, rx - 150, 172, Math.max(2, 150 * frac), 6, 3); ctx.fill();
      ctx.restore();
    }

    // death overlay
    if (st.deathT > 0) {
      const a = clamp(st.deathT / C.DEATH_TIME, 0, 1);
      ctx.fillStyle = `rgba(20,4,8,${0.35 * (1 - a * 0.4)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.fillStyle = `rgba(255,100,100,${Math.min(1, (1 - a) * 3)})`;
      ctx.shadowColor = "#ff5050";
      ctx.shadowBlur = 24;
      ctx.font = "bold 44px ui-monospace, Menlo, monospace";
      ctx.fillText("SHATTERED", W / 2, H / 2 - 8);
      ctx.shadowBlur = 0;
    }
  }

  // ------- fixed-step sim + interpolated render (identical at any display Hz)
  const FIXED = 1 / C.PHYSICS_HZ;
  let last = performance.now();
  let acc = 0;

  // frame-time profiler (F2 or ?perf=1): EMA ms per phase + GC-spike proxy.
  // Exposed as __tether.prof so headless runs can read real numbers.
  const prof = {
    on: false, sim: 0, fx: 0, render: 0, frame: 0,
    frames: 0, spikes: 0, heap0: 0, heapRate: 0,
  };
  st.prof = prof;
  const pnow = () => performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    let fdt = (now - last) / 1000;
    last = now;
    if (fdt > 0 && fdt < 1) st.fps = st.fps * 0.95 + (1 / fdt) * 0.05;
    if (fdt > 0.1) fdt = 0.1; // tab-switch clamp
    st.rtime += fdt;
    // reconcile: setScreen() is the write-point, but audits and console
    // debugging write st.screen directly — the tick re-emits on change
    // (emitScreen self-guards), so DOM screens/chrome never desync
    emitScreen(st.screen);
    pollGamepad(st); // pad edges land as synthetic keys before the sim steps
    const t0 = pnow();

    let alpha = 1;
    if (st.screen === "playing") {
      // hit-stop = near-zero timescale; interpolation renders smooth slow-mo
      let simDt = fdt;
      if (st.hitStop > 0) {
        st.hitStop -= fdt;
        simDt = fdt * C.HITSTOP_SCALE;
      } else if (st.slowmo > 0) { // a boss-kill slow-mo eases in after the freeze
        st.slowmo -= fdt;
        simDt = fdt * C.SLOWMO_SCALE;
      }
      acc += simDt;
      let steps = 0;
      while (acc >= FIXED && steps < C.MAX_STEPS) {
        step(FIXED);
        acc -= FIXED;
        steps++;
        if (st.hitStop > 0 && simDt === fdt) {
          acc = Math.min(acc, FIXED * 0.5); // freeze on the exact impact step
          break;
        }
      }
      if (steps === C.MAX_STEPS) acc = acc % FIXED;
      alpha = clamp(acc / FIXED, 0, 1);
    } else {
      acc = 0;
    }
    const t1 = pnow();

    updateFX(fdt, alpha);
    const t2 = pnow();
    render(alpha);
    hud.sync(); // DOM HUD readouts — mutation-gated, no-op off-gameplay
    const t3 = pnow();

    { // EMA the phase costs; count long frames (GC/jank proxy)
      const a = 0.05;
      prof.sim = prof.sim + (t1 - t0 - prof.sim) * a;
      prof.fx = prof.fx + (t2 - t1 - prof.fx) * a;
      prof.render = prof.render + (t3 - t2 - prof.render) * a;
      prof.frame = prof.frame + (t3 - t0 - prof.frame) * a;
      prof.frames++;
      if (t3 - t0 > 12) prof.spikes++;
      const mem = performance.memory;
      if (mem) {
        if (!prof.heap0) prof.heap0 = mem.usedJSHeapSize;
        prof.heapRate = prof.heapRate * 0.98 +
          ((mem.usedJSHeapSize - prof.heap0) / 1048576) * 0.02;
        prof.heap0 = mem.usedJSHeapSize;
      }
      if (prof.on) drawProf();
    }
    st.ui.mouseMoved = false;
  }

  function drawProf() {
    const lines = [
      `frame ${prof.frame.toFixed(2)}ms  (${Math.round(st.fps)} fps)`,
      `render ${prof.render.toFixed(2)}  sim ${prof.sim.toFixed(2)}  fx ${prof.fx.toFixed(2)}`,
      `store ${canvas.width}×${canvas.height} @dpr ${(window.devicePixelRatio || 1).toFixed(2)}`,
      `particles ${st.particles.length} · solids ${st.solids.length} · spikes>12ms ${prof.spikes}`,
      `heapΔ ${prof.heapRate >= 0 ? "+" : ""}${(prof.heapRate * 60).toFixed(2)} MB/s`,
    ];
    ctx.save();
    ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
    ctx.fillStyle = "rgba(8,5,14,0.85)";
    ctx.fillRect(C.VIEW_W - 300, 48, 288, 14 * lines.length + 14);
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = "#a0ffa0";
    lines.forEach((l, i) => ctx.fillText(l, C.VIEW_W - 290, 64 + i * 14));
    ctx.restore();
  }

  function onVis() {
    if (!document.hidden) { last = performance.now(); acc = 0; }
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", onMouseDown);
  // audio can only start on a user gesture, and every menu is DOM now — a
  // first click on a select-screen BUTTON never reaches the canvas listener,
  // which left the menu theme queued-but-silent until gameplay input. Catch
  // the first gesture anywhere; unlock() is idempotent and replays pending.
  window.addEventListener("pointerdown", () => unlock(), { capture: true });
  window.addEventListener("keydown", () => unlock(), { capture: true });
  window.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("contextmenu", onCtxMenu);
  canvas.addEventListener("wheel", (e) => editorActive() && editorWheel(e), { passive: false });
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("resize", fitCanvas);
  document.addEventListener("fullscreenchange", fitCanvas);
  // Keyboard Lock (Chrome-only, feature-detected): while fullscreen, lock
  // Escape so a TAP reaches the game (pause/menu-back — the ladder works
  // exactly as windowed) and the UA moves its exit gesture to press-AND-HOLD
  // Esc. Firefox/Safari have no equivalent: there tap-Esc always exits
  // fullscreen (UA-reserved) and Backspace / gamepad Ⓑ are the back keys.
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) navigator.keyboard?.lock?.(["Escape"])?.catch?.(() => {});
    else navigator.keyboard?.unlock?.();
  });
  requestAnimationFrame(frame);

  // online levels (Supabase `custom_levels`, admin-uploaded) — fetched once
  // at boot and again after the admin panel uploads a new one
  async function reloadCustomLevels() {
    await loadCustomLevels();
    invalidateThumbs(null); // online uploads can replace content under an id
    makeThumbs(LEVELS);
    if (st.screen === "select") selectUI.refresh(); // new online levels appear live
  }

  // read-only debug handle (inspect `__tether.player.hp` etc. in the console)
  // __config lets the audit bots A/B tunables through the real loop
  if (typeof window !== "undefined") {
    window.__tether = st; window.__rank = RANK; window.__levels = LEVELS; window.__config = C;
    // DETERMINISTIC STEP (audits): advance the sim by N fixed steps synchronously,
    // exactly as the rAF loop would — but on the caller's clock, not wall-time.
    // Fps/load-sensitive fixtures (breach r04/r06) drive THIS instead of polling
    // through setInterval, so their outcome is frame-exact and reproducible.
    window.__tick = (n) => { for (let i = 0; i < (n || 1); i++) step(FIXED); };
    window.__worldbg = { WORLD_BG, initWorldBg }; // audits probe the renderer mechanisms
    window.__frag = { fragmentProgress, PROTECTED_IDS }; // memory-collection gate (PR2)
    window.__npc = { nearestNpc, tryTalkNpc, updateNpcs };
    window.__vessel = { vesselPhase, VESSEL_CORE, phase: () => st.vesselPhase }; // burn-state (PR16)
    window.__credits = {
      enter(next) {
        st._creditsData = LEVELS.find((l) => l.id === "hv07-architect")?.data?.credits;
        setScreen("credits");
        startCredits(st, next, PALETTES[st.paletteIndex] || PALETTES[0]);
      },
      state: () => st.credits,
    };
    window.__reloadCustomLevels = reloadCustomLevels;
    window.__admin = { normalizeLevelData, setOnlineLevels }; // PR8 — override-merge audits
    // settings-audit hooks: live option state, keymap, and WebAudio bus gains
    window.__settings = OPT; window.__keymap = KEYMAP;
    window.__audio = { busLevels, trackState, sfxDecoded, sfxNames, sfx }; // + PR11 sample sfx
    window.__pad = { status: padStatus, list: padList, choose: choosePad };
  }

  // while a modal is open the underlying menu also goes visually dormant:
  // no card carries the selection glow under the scrim. Selection is
  // stashed on open and restored on close (keyboard/hover are gated, so
  // nothing can move it in between).
  let selBeforeModal = 0;
  busOn("modal", (open) => {
    if (open) { selBeforeModal = st.ui.sel; st.ui.sel = -1; }
    else st.ui.sel = Math.max(0, selBeforeModal);
  });

  // DOM chrome → game actions (uiBus "action" channel). Single reducer: the
  // DOM side (select screen, admin modal) emits verbs in the same {action,
  // arg} shape as canvas buttons; everything routes through uiAction except
  // "editor-new" (the admin modal's Enter-Map-Editor, mirroring KeyN).
  busOn("action", (a) => {
    if (!a) return;
    if (a.action === "editor-new") {
      if (st.screen !== "select") return; // the gear only shows on select; guard anyway
      sfx.confirm();
      editorOpen(null, { worldId: st.worldSel });
      setScreen("editor");
      return;
    }
    uiAction(a);
  });

  music.play(-1, null, "music/main-theme.mp3"); // menu theme queues now, starts on the first gesture
  editorInit({
    playtest: playtestLevel,
    exitToSelect: gotoSelect,
    refreshThumbs: () => { invalidateThumbs(null); makeThumbs(LEVELS); },
  });
  reloadCustomLevels(); // fire-and-forget: online levels append once fetched

  // dev/verification hook: ?level=N boots straight into a level; ?x=&y=
  // teleports the spawn-placed player (headless screenshot audits use this)
  {
    const qp = new URLSearchParams(location.search);
    if (qp.get("perf")) prof.on = true;
    const ql = Number(qp.get("level"));
    if (ql >= 1 && ql <= LEVELS.length) {
      loadLevel(ql - 1);
      const qx = Number(qp.get("x")), qy = Number(qp.get("y"));
      const p = st.player;
      if (qx) { p.x = qx; p.px = qx; }
      if (qy) { p.y = qy; p.py = qy; }
      st.cam.x = clamp(p.x + p.w / 2 - C.VIEW_W / 2, 0, Math.max(0, st.world.w - C.VIEW_W));
      st.cam.y = clamp(p.y + p.h / 2 - C.VIEW_H / 2, 0, Math.max(0, st.world.h - C.VIEW_H));
    }
  }
}
