/* ============================================================================
 * TETHER — every gameplay tunable in one place.
 * Units: px, px/s, px/s², seconds, degrees where noted.
 * ==========================================================================*/

export const CONFIG = {
  // --- Simulation (high-fps support) ---------------------------------------
  PHYSICS_HZ: 120,        // fixed sim rate — identical feel at 60/120/144/240Hz
  MAX_STEPS: 6,           // catch-up cap per frame (spiral-of-death guard)

  // --- View / world ---------------------------------------------------------
  VIEW_W: 1120,
  VIEW_H: 630,
  RENDER_SCALE_MAX: 2, // cap on internal backing-store supersample vs VIEW.
                       // Backing store = VIEW × min(dpr, this), FIXED regardless
                       // of window/fullscreen size — keeps fill cost constant.
  WORLD_W: 4300,
  WORLD_H: 1150,
  CAM_SMOOTH: 0.0012,     // base^dt exponential follow — LOWER = snappier
  CAM_LOOKAHEAD: 0.14,    // camera leads by velocity * this (seconds)
  CAM_LOOK_MAX: 190,      // px cap on the lookahead lead

  // --- Collision / damage model ----------------------------------------------
  COLLIDE_SUBSTEP: 8,     // max px of travel per collision substep (continuous CD)
  DAMAGE_INVULN: 0.9,     // ONE shared post-hit mercy window for ALL damage
                          // sources (spikes, void, drones). Guarantees a single
                          // hit = one heart, even if two sources overlap in a
                          // step. Distinct from dash i-frames (p.iT), which only
                          // dodge enemy contact and never protect from spikes.
  DEATH_TIME: 0.9,        // "shattered" beat before respawning with full HP

  // --- Run / jump -------------------------------------------------------------
  GRAVITY: 1900,          // ASCENT gravity — slightly floaty, swing arcs need air time
  GRAVITY_DESC: 2350,     // DESCENT gravity (free-fall only): rises stay floaty,
                          // falls commit. Applies when vy points WITH gravity and
                          // no rope is attached — the swing pendulum keeps the
                          // symmetric GRAVITY (asymmetry on a taut rope would
                          // pump energy into every cycle: downswing gains more
                          // than the upswing loses, and "release speed = built
                          // speed" stops being true). Pinned by npm run physics.
  MAX_FALL: 1150,
  RUN_SPEED: 330,
  GROUND_ACCEL: 3200,
  GROUND_DECEL: 4400,
  AIR_ACCEL: 2100,
  AIR_DECEL: 700,         // low air drag — momentum is the whole game
  JUMP_FORCE: 760,
  JUMP_CUT: 0.45,         // vy *= this on early release (variable height)
  COYOTE_TIME: 0.12,
  JUMP_BUFFER: 0.12,
  MAX_SPEED: 1700,        // absolute velocity cap (sanity, not feel)
  FASTFALL_MULT: 1.45,    // max-fall multiplier while holding toward gravity
                          // (Celeste-style fast-fall; 1150 → ~1670, under the
                          // MAX_SPEED cap so diagonals stay clean)
  FASTFALL_ACCEL: 1.55,   // gravity multiplier while fast-falling (snappy start;
                          // rides GRAVITY_DESC now — absolute pull ≈ 3640 px/s²,
                          // was 1900·1.7 ≈ 3230)
  FASTFALL_STEER: 0.45,   // air-steer multiplier while fast-falling — the
                          // commitment half of the trade: the drop costs most
                          // of your air control (pinned by npm run physics)

  // --- Grapple -------------------------------------------------------------------
  GRAPPLE_RANGE: 640,     // max rope length / fire distance
  AIM_ASSIST_DEG: 30,     // cone half-angle that snaps to anchor nodes
  ROPE_MIN: 60,           // shortest climbable rope
  CLIMB_SPEED: 260,       // W/S reel speed
  SWING_ACCEL: 950,       // A/D pump/steer while attached
  SWING_PUMP: 2.4,        // steer multiplier while PUMPING: taut rope, rising
                          // against gravity, steering WITH the motion. Active
                          // momentum building — miss the window, get base accel
  SWING_PUMP_MAX: 1350,   // speed ceiling for pump gains (~1.5× a natural swing)
  REEL_ENERGY: 0.8,       // reeling IN while taut converts rope-shortening into
                          // tangential speed (angular momentum × this fraction);
                          // paying out the rope keeps speed but widens the arc
  ROPE_VISUAL_T: 0.07,    // rope extend animation (visual only, attach is instant)
  // ZIP-LINE anchors: the grapple center slides its rail while you're latched
  // (the pendulum pins to a moving point — time your release in motion).
  ZIP_SPEED: 230,         // default rail slide speed (px/s); per-anchor override
  ZIP_RETRACT: 340,       // an idle zip anchor eases back home this fast
  // SLINGSHOT anchors: the rope is a spring, not a rigid rope — stretch away to
  // load it, then release to launch. accel toward the anchor = K × stretch(px).
  SLING_K: 30,            // spring stiffness (v_launch ≈ stretch × √K)
  SLING_MAX: 1.9,         // hard stretch cap (× rest length) — no fling-to-infinity

  // --- Dash --------------------------------------------------------------------------
  DASH_SPEED: 920,
  DASH_DURATION: 0.21,    // fixed distance = SPEED * DURATION ≈ 193px
  DASH_COOLDOWN: 0.9,     // cleared on landing OR on a node strike
  DASH_IFRAMES: 0.27,     // brief invulnerability (> DURATION)
  DASH_END_KEEP: 0.55,    // fraction of dash velocity kept on exit

  // --- Pogo strike (midair attack while aiming down; Down key also forces) ----
  POGO_AIM_CONE: 0.6,     // aim counts as "down" when ay/|aim| exceeds this
                          // (≈53° half-angle from straight down — forgiving,
                          // but lateral swing-slashes stay slashes)
  POGO_ACTIVE: 0.13,      // downward hitbox lifetime
  POGO_REACH: 34,         // how far below the feet it extends
  POGO_PAD: 8,            // horizontal padding of the hitbox
  POGO_CD: 0.18,          // pogo re-arm while attack is held — the gap between
                          // boxes (CD - ACTIVE = 50ms ≈ 30px of fall) stays
                          // smaller than an enemy, so a held-button stomp can't
                          // fall THROUGH the blind window and eat contact damage
  POGO_BOUNCE: 880,       // upward launch on connect (~204px rise) — the FLOOR
  POGO_CARRY: 0.35,       // fraction of existing UPWARD vy kept on top — mid-swing
                          // pogo COMPOSES with swing velocity instead of resetting it
  POGO_REFLECT: 0.75,     // fraction of the incoming fall speed reflected when it
                          // beats the floor — fast-fall→pogo launches HIGHER
  POGO_VX_BOOST: 0.15,    // horizontal kept + amplified: swing/dash pogo carries
                          // its trajectory up-and-forward (redirect, not reset)
  POGO_COMPOSITE: true,   // THE core speedrun mechanic. true = the bounce is
                          // TANGENT to your velocity (horizontal carried +
                          // amplified, rising vy composes) — pogo redirects
                          // momentum. false = the classic FIXED-UPWARD reset
                          // (horizontal zeroed, pure -POGO_BOUNCE). The A/B
                          // baseline for tools/speedrun-audit.mjs; shipping
                          // true is what makes pogo a routing tool.

  // --- Combat ---------------------------------------------------------------------------
  ATTACK_REACH: 80,       // melee radius from player center
  ATTACK_ARC_DEG: 140,    // total arc width around aim direction
  ATTACK_CD: 0.28,
  ATTACK_ACTIVE: 0.09,    // hitbox lifetime (catches swing-throughs)
  ATTACK_BUFFER: 0.15,    // tap-early grace
  HEAVY_SPEED: 620,       // |v| above this = heavy hit (2 dmg, big knockback)
  KB_BASE: 260,           // knockback floor
  KB_VEL: 0.9,            // + this * player speed (moving hits hurl enemies)
  NODE_MIN_SPEED: 820,    // strike-node kick: speed = max(|v|, MIN) + BONUS
  NODE_KICK_BONUS: 240,   //   ...launched toward your aim; refreshes dash
  DRONE_HP: 3,
  DRONE_R: 20,
  NODE_R: 18,
  PLAYER_HP: 3,
  CONTACT_KNOCKBACK: 540, // enemy contact uses the shared DAMAGE_INVULN window

  // --- Enemy archetypes (see src/enemies.js) --------------------------------
  // DART — the charger: telegraph -> locked lunge -> dizzy punish window
  DART_R: 16,
  DART_HP: 3,
  DART_AGGRO: 430,        // sight radius (needs LOS)
  DART_TELE: 0.55,        // wind-up; readable BEFORE the lunge exists
  DART_LOCK: 0.18,        // aim freezes this long before launch (dodge reads)
  DART_LUNGE_SPEED: 1050,
  DART_LUNGE_T: 0.42,
  DART_DIZZY: 1.0,        // post-lunge stun — harmless, doubled as punish invite
  DART_COOL: 1.2,
  // WARD — the mounted turret: charge glow -> slow bolt -> cooldown
  WARD_R: 17,
  WARD_HP: 2,
  WARD_RANGE: 660,
  WARD_CHARGE: 0.75,      // aim-line brightens the whole wind-up
  WARD_COOL: 1.5,
  SHOT_SPEED: 340,        // slow enough to dodge, slash, or i-frame through
  SHOT_R: 8,
  SHOT_LIFE: 3.2,
  // BLOOM — the regrowing mine: proximity fuse -> AoE -> seed -> regrow
  BLOOM_R: 15,
  BLOOM_TRIGGER: 115,     // linger radius that starts the fuse
  BLOOM_FUSE: 0.75,       // accelerating blink + blast-radius preview ring
  BLOOM_FUSE_SHORT: 0.28, // when popped from range (slash/pogo/dash-through)
  BLOOM_BLAST: 135,       // AoE hurts the player AND enemies (chain reactions)
  BLOOM_REGROW: 3.5,
  // WISP — the harvest spirit: drifts THROUGH terrain toward you, one hit
  // kills it, pogo-bounceable. No burst threat — a pure motion tax that
  // punishes camping. The Reaper summons them; the editor places them.
  WISP_R: 13,
  WISP_HP: 1,
  WISP_SPEED: 175,        // homing speed cap
  WISP_ACCEL: 360,        // acceleration toward the player

  // --- Deflect (slash a bolt to RETURN it — see combat.js resolveAttack) -----
  DEFLECT_SPEED: 1.6,     // returned bolt speed multiplier; the bolt turns
                          // friendly: it kills the small, pops blooms, and
                          // wounds THE REAPER only while he is exposed

  // --- THE REAPER — DEATH WORLD's finale (src/reaper.js) ----------------------
  REAPER_R: 42,
  REAPER_HP: 24,
  SCYTHE_SPEED: 720,      // thrown-scythe velocity (boomerangs back)
  SCYTHE_R: 24,           // blade contact radius — also the ROPE-CUT radius
  SCYTHE_RANGE: 880,      // boomerang turnaround distance
  REAPER_SPIN_R: 118,     // whirling-blade sweep radius (the melee wall)
  REAPER_WISP_CAP: 3,     // live wisps he maintains (phase 3: +1)

  // --- Juice (the Hades punch) ------------------------------------------------------------
  HITSTOP_SCALE: 0.05,    // timescale during hit-stop (near-zero, not full freeze)
  SLOWMO_SCALE: 0.32,     // timescale during a boss-kill slow-motion beat
  HITSTOP_LIGHT: 0.055,   // ~4 frames @60
  HITSTOP_HEAVY: 0.095,   // ~6 frames
  HITSTOP_KILL: 0.13,
  HITSTOP_NODE: 0.08,
  HITSTOP_POGO: 0.08,
  HITSTOP_HURT: 0.07,
  SHAKE_LIGHT: 0.18,      // trauma added per event (shake = trauma², decays)
  SHAKE_HEAVY: 0.38,
  SHAKE_KILL: 0.55,
  SHAKE_NODE: 0.45,
  SHAKE_POGO: 0.42,
  SHAKE_LAND: 0.25,
  SHAKE_HURT: 0.6,
  SHAKE_DEATH: 0.85,
  TRAUMA_DECAY: 1.9,
  MAX_SHAKE: 26,          // px at full trauma

  // --- Style meter (rewards airborne chaining) --------------------------------
  STYLE_WINDOW: 2.4,      // seconds a combo survives without a new action
  STYLE_RANKS: [          // [minCount, label, color]
    [2, "NICE", "#cfe3ff"],
    [4, "STYLISH", "#8CF2FF"],
    [7, "WILD", "#ffd166"],
    [10, "SAVAGE", "#ff8a5d"],
    [14, "UNTETHERED", "#ff4fa0"],
  ],

  // --- Dynamic terrain (see src/platforms.js) ---------------------------------
  CRUMBLE_DELAY: 0.55,    // shake time between first touch and collapse
  CRUMBLE_REGROW: 3.0,    // ghost time before the platform re-forms
  MOVER_PAUSE: 0.35,      // dwell at each end of a mover's rail
  GRIP_SLIDE: 70,         // max fall speed while clinging to a grip wall
  WALL_COYOTE: 0.14,      // wall-jump grace after leaving the cling
  WALLJUMP_VX: 430,       // launch away from the wall...
  WALLJUMP_VY: 640,       // ...and up (variable height via JUMP_CUT applies)
  WALLJUMP_STEER_LOCK: 0.1, // steering blackout after launch so the jump POPS
                          // even while still holding toward the wall

  // --- Surface types (solids may carry `surface`; see physics/platforms) -----
  SURF_ICE_ACCEL: 400,    // ground accel/decel while standing on ice
  SURF_ICE_DECEL: 200,    //   (air control untouched — ice is a ground story)
  BOUNCE_RESTITUTION: 0.85, // vy reflected on a bouncy landing
  BOUNCE_MIN_VY: 240,     // gentler landings than this just stand (no bounce)
  STICKY_SLIDE: 40,       // max fall speed while touching a sticky wall (no
                          // input needed — contrast GRIP_SLIDE which wants A/D)
  CONVEYOR_SPEED: 120,    // default belt speed (px/s) when none is authored

  // --- New objects: gravity-flip zones, angled pads, wind volumes ------------
  PAD_COOLDOWN: 0.25,     // per-pad re-trigger lockout (prevents contact loops)
  WIND_FORCE: 1000,       // default wind accel (px/s²) — gravity is 1900 for scale

  // --- Audio (procedural WebAudio — see src/audio.js) -------------------------
  AUDIO_MASTER: 0.85,     // master gain (0 = the M mute toggle)
  AUDIO_MUSIC: 0.5,       // generative score bus
  AUDIO_SFX: 0.9,         // action sounds bus

  // --- Gamepad (standard mapping — see src/gamepad.js) ------------------------
  PAD_MOVE_ON: 0.45,      // left-stick threshold that starts holding a direction
  PAD_MOVE_OFF: 0.30,     //   ...and the release threshold (hysteresis, no jitter)
  PAD_DEADZONE_AIM: 0.30, // right-stick magnitude that counts as aiming
  PAD_AIM_RADIUS: 170,    // crosshair orbit distance from the player (px)
  PAD_ASSIST_EXTRA_DEG: 12, // extra aim-assist cone on top of AIM_ASSIST_DEG
                          // while the pad is the active aim device

  // --- Actors ---------------------------------------------------------------------------------
  PLAYER_W: 26,
  PLAYER_H: 36,
  ANCHOR_R: 9,
};

export const KEYMAP = {
  left:    ["ArrowLeft", "KeyA"],
  right:   ["ArrowRight", "KeyD"],
  up:      ["ArrowUp", "KeyW"],
  down:    ["ArrowDown", "KeyS"],
  jump:    ["Space"],
  dash:    ["ShiftLeft", "ShiftRight"],
  grapple: ["KeyE"],
  attack:  ["KeyJ"],
  reset:   ["KeyR"],
  practice: ["KeyP"],
  fullscreen: ["KeyF"],
  mute:    ["KeyM"],
};
