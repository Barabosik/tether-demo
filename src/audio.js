import { CONFIG as C } from "./config.js";
import { clamp } from "./util.js";
import { SFX_B64 } from "./sfxData.js";

/* TETHER audio — WebAudio. Music is 100% procedural; the core gameplay one-
 * shots (footsteps / land / dash / slash / hit / kill) are short SAMPLES
 * synthesised offline by tools/build-sfx.mjs and inlined as base64 in
 * sfxData.js (so the single-file standalone stays self-contained + offline).
 * They decode at unlock() and play through the same sfxBus (M / duck / muffle
 * all apply); if decode ever fails, every one-shot falls back to its old synth.
 *
 * Graph:  sfx ─────────────┐
 *         music ─ filter ─ gain ─┤─ master ─ compressor ─ out
 *
 * - The AudioContext is created lazily on the first user gesture (unlock()),
 *   per browser autoplay policy. Every call before that is a silent no-op.
 * - SFX are tiny synth recipes (osc sweeps + filtered noise + a sub thump).
 *   Impact sounds pair a bright transient with a low sine "body" so the
 *   hit-stop freeze lands as a THUMP, not just visuals.
 * - Music is generated per level from a THEME (root, scale, bpm, colour):
 *   pad chords stacked in scale-thirds, a bass pulse, sparse melody plucks
 *   through a feedback delay, optional hats. Deterministic per bar (seeded)
 *   so a level always "sounds like itself".
 * - duckMusic() sidechains the score under every impact; setMuffle() drops
 *   the filter for pause/results (the underwater menu feel). */

let AC = null;
let out = null;          // { master, comp, sfxBus, musGain, musFilter, delay }
let noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem("tether.mute") === "1"; } catch {}
let pending = null;      // { i, theme, track } requested before the context existed

// live bus levels — CONFIG is only the factory default; the settings menu
// owns these at runtime (setVolumes applies before OR after unlock())
const vol = { master: C.AUDIO_MASTER, music: C.AUDIO_MUSIC, sfx: C.AUDIO_SFX };
export function setVolumes(v) {
  for (const k of Object.keys(vol))
    if (typeof v[k] === "number") vol[k] = Math.min(1, Math.max(0, v[k]));
  applyElGain(); // raw-element fallback tracks the sliders too
  if (!AC) return;
  if (!muted) out.master.gain.setTargetAtTime(vol.master, now(), 0.02);
  out.musGain.gain.setTargetAtTime(vol.music, now(), 0.02);
  out.sfxBus.gain.setTargetAtTime(vol.sfx, now(), 0.02);
}
// audit hook: the actual gain values on the live buses
export const busLevels = () =>
  out ? { master: out.master.gain.value, music: out.musGain.gain.value,
          sfx: out.sfxBus.gain.value } : null;

const now = () => AC.currentTime;

// ---- sample one-shots (tools/build-sfx.mjs) ------------------------------
const sampleBufs = {};
function decodeSamples() {
  for (const [name, b64] of Object.entries(SFX_B64)) {
    try {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // decodeAudioData resamples our 32 kHz WAVs to the context rate for us
      AC.decodeAudioData(bytes.buffer, (buf) => { sampleBufs[name] = buf; }, () => {});
    } catch {}
  }
}
// audit hooks: how many sample one-shots have decoded, and their names
export const sfxDecoded = () => Object.keys(sampleBufs).length;
export const sfxNames = () => Object.keys(SFX_B64);
// play a decoded one-shot; returns false if it isn't ready (caller falls back)
function playBuf(name, { vol = 1, rate = 1, bus = null } = {}) {
  const b = sampleBufs[name];
  if (!AC || muted || !b) return false;
  const src = AC.createBufferSource();
  src.buffer = b;
  src.playbackRate.value = rate;
  const g = AC.createGain();
  g.gain.value = vol;
  src.connect(g); g.connect(bus || out.sfxBus);
  src.start();
  return true;
}

export function unlock() {
  if (AC) {
    if (AC.state === "suspended") AC.resume().catch(() => {});
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  AC = new Ctx();

  const master = AC.createGain();
  master.gain.value = muted ? 0 : vol.master;
  const comp = AC.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 22;
  comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.22;
  master.connect(comp); comp.connect(AC.destination);

  const sfxBus = AC.createGain();
  sfxBus.gain.value = vol.sfx;
  sfxBus.connect(master);

  const musFilter = AC.createBiquadFilter();
  musFilter.type = "lowpass"; musFilter.frequency.value = 15000;
  const musGain = AC.createGain();
  musGain.gain.value = vol.music;
  musFilter.connect(musGain); musGain.connect(master);

  // melody echo — feedback delay inside the music chain
  const delay = AC.createDelay(1.0); delay.delayTime.value = 0.29;
  const fb = AC.createGain(); fb.gain.value = 0.34;
  const wet = AC.createGain(); wet.gain.value = 0.5;
  delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(musFilter);

  noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  decodeSamples(); // async — one-shots use the synth fallback until buffers land

  out = { master, comp, sfxBus, musGain, musFilter, delay };
  setInterval(scheduleMusic, 45);
  if (pending !== null) music.play(pending.i, pending.theme, pending.track);
  if (trk.el) trk.el.play().catch(() => {}); // autoplay refused pre-gesture
}

export const isMuted = () => muted;
export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem("tether.mute", muted ? "1" : "0"); } catch {}
  if (AC) out.master.gain.setTargetAtTime(muted ? 0 : vol.master, now(), 0.015);
  applyElGain(); // the real track obeys M even outside the graph
  return muted;
}

// ------------------------------------------------------------- primitives
const EPS = 0.0001;

function tone({ t, f0, f1, dur, type = "sine", vol = 0.2, attack = 0.003,
                bus = null, bend = "exp" }) {
  if (!AC || muted) return;
  t = t ?? now();
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(20, f0), t);
  if (f1 && f1 !== f0) {
    if (bend === "exp") o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    else o.frequency.linearRampToValueAtTime(Math.max(20, f1), t + dur);
  }
  g.gain.setValueAtTime(EPS, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  o.connect(g); g.connect(bus || out.sfxBus);
  o.start(t); o.stop(t + dur + 0.05);
}

function noise({ t, dur, vol = 0.3, f0 = 1200, f1 = 0, type = "bandpass",
                 Q = 0.9, bus = null, attack = 0.002 }) {
  if (!AC || muted) return;
  t = t ?? now();
  const src = AC.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  src.playbackRate.value = 0.96 + Math.random() * 0.08;
  const f = AC.createBiquadFilter();
  f.type = type; f.Q.value = Q;
  f.frequency.setValueAtTime(f0, t);
  if (f1) f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  const g = AC.createGain();
  g.gain.setValueAtTime(EPS, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  src.connect(f); f.connect(g); g.connect(bus || out.sfxBus);
  src.start(t); src.stop(t + dur + 0.05);
}

// the low "body" under every meaty impact — this is what makes hit-stop THUMP
function sub(t, f = 56, vol = 0.5, dur = 0.14) {
  tone({ t, f0: f, f1: f * 0.72, dur, type: "sine", vol, attack: 0.004 });
}

const st = (n) => 440 * Math.pow(2, n / 12); // semitone -> Hz (A4 ref)

// ----------------------------------------------------------------- SFX kit
// pentatonic ladder for combo-pitched hits (node strikes climb as you chain)
const LADDER = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export const sfx = {
  jump() { tone({ f0: 240, f1: 400, dur: 0.09, type: "triangle", vol: 0.13 }); },
  harmonica() {
    // him. PLACEHOLDER timbre (detuned reeds); tune to taste / swap for a sample.
    if (!AC || muted) return;
    const t0 = now();
    const notes = [st(-9), st(-5), st(-7), st(-9)]; // a low, wistful fall + rest
    notes.forEach((f, i) => {
      const t = t0 + i * 0.5;
      tone({ t, f0: f, f1: f, dur: 0.6, type: "triangle", vol: 0.045, attack: 0.08 });
      tone({ t, f0: f * 1.007, f1: f * 1.007, dur: 0.6, type: "sawtooth", vol: 0.02, attack: 0.08 });
    });
  },
  ropeCut() { // the scythe severs your tether — a snap, then the line whips away
    noise({ dur: 0.06, vol: 0.5, f0: 3200, f1: 700, type: "bandpass" });
    tone({ f0: 880, f1: 210, dur: 0.13, type: "square", vol: 0.11 });
  },
  deflect() { // returned to sender — bright rising zing over the slash
    tone({ f0: 620, f1: 1750, dur: 0.09, type: "square", vol: 0.15 });
    tone({ f0: 1240, f1: 2600, dur: 0.07, type: "sine", vol: 0.09 });
  },
  // FOOTSTEP (PR11): four siblings rotate with a pitch jitter so a run never
  // machine-guns one clip. n = a monotonically rising stride counter (game.js).
  step(n) {
    if (playBuf("step" + (1 + ((n | 0) & 3)), { vol: 0.34, rate: 0.92 + Math.random() * 0.16 })) return;
    tone({ f0: 118, f1: 82, dur: 0.045, type: "triangle", vol: 0.045 }); // fallback tap
  },
  land(hard) {
    if (playBuf("land", { vol: 0.4 + hard * 0.5, rate: 0.94 + hard * 0.12 })) return;
    noise({ dur: 0.09, vol: 0.10 + hard * 0.18, f0: 500, f1: 140, type: "lowpass" });
    if (hard > 0.45) sub(undefined, 62, 0.22 + hard * 0.2, 0.11);
  },
  dash() {
    if (playBuf("dash", { vol: 0.62, rate: 0.97 + Math.random() * 0.06 })) return;
    noise({ dur: 0.17, vol: 0.30, f0: 1500, f1: 350, Q: 1.4 });
    tone({ f0: 700, f1: 210, dur: 0.13, type: "sawtooth", vol: 0.06 });
  },
  attach(chain) {
    const k = chain ? 1.3 : 1;
    tone({ f0: 500 * k, f1: 900 * k, dur: 0.05, type: "sine", vol: 0.12 }); // zip out
    tone({ f0: 190 * k, f1: 95, dur: 0.08, type: "triangle", vol: 0.22 });  // thunk
    noise({ dur: 0.03, vol: 0.10, f0: 2600, type: "highpass" });
  },
  release() { noise({ dur: 0.12, vol: 0.14, f0: 900, f1: 2600, Q: 1.2 }); },
  fizzle() { tone({ f0: 300, f1: 150, dur: 0.09, type: "square", vol: 0.05 }); },
  slash() {
    if (playBuf("slash", { vol: 0.5, rate: 0.96 + Math.random() * 0.1 })) return;
    noise({ dur: 0.09, vol: 0.20, f0: 2600, f1: 900, Q: 1.1 });
    tone({ f0: 1300, f1: 500, dur: 0.06, type: "sawtooth", vol: 0.05 });
  },
  hit(heavy) {
    if (playBuf(heavy ? "hitHeavy" : "hit", { vol: heavy ? 0.85 : 0.58, rate: 0.95 + Math.random() * 0.09 })) return;
    if (heavy) {
      noise({ dur: 0.12, vol: 0.34, f0: 900, f1: 190, type: "lowpass" });
      tone({ f0: 210, f1: 85, dur: 0.10, type: "square", vol: 0.16 });
      sub(undefined, 60, 0.5, 0.13);
    } else {
      noise({ dur: 0.05, vol: 0.20, f0: 1900, f1: 700 });
      tone({ f0: 330, f1: 170, dur: 0.06, type: "square", vol: 0.11 });
    }
  },
  kill() {
    if (!AC || muted) return;
    if (playBuf("kill", { vol: 0.66, rate: 0.98 + Math.random() * 0.06 })) return;
    sub(undefined, 52, 0.6, 0.2);
    noise({ dur: 0.26, vol: 0.32, f0: 600, f1: 90, type: "lowpass" });
    const t = now();
    tone({ t: t + 0.02, f0: 660, f1: 1350, dur: 0.14, type: "triangle", vol: 0.10 });
    tone({ t: t + 0.05, f0: st(16), dur: 0.18, type: "sine", vol: 0.07 });
  },
  node(combo) {
    if (!AC || muted) return;
    // the musical one: each successive chain strike rings a step higher
    const f = st(LADDER[clamp(combo, 0, LADDER.length - 1)]);
    const t = now();
    tone({ t, f0: f, dur: 0.22, type: "triangle", vol: 0.20, bus: out?.delay });
    tone({ t, f0: f, dur: 0.20, type: "triangle", vol: 0.16 });
    tone({ t, f0: f * 2, dur: 0.11, type: "sine", vol: 0.08 });
    noise({ t, dur: 0.05, vol: 0.12, f0: 3200, type: "highpass" });
    sub(t, 68, 0.3, 0.1);
  },
  pogo(isNode) {
    tone({ f0: 150, f1: 540, dur: 0.13, type: "sine", vol: 0.24, bend: "lin" }); // boing
    noise({ dur: 0.04, vol: 0.12, f0: 2200 });
    if (isNode) tone({ f0: 880, dur: 0.12, type: "sine", vol: 0.08 });
    sub(undefined, 64, 0.25, 0.09);
  },
  hurt() {
    tone({ f0: 150, f1: 68, dur: 0.20, type: "square", vol: 0.20 });
    noise({ dur: 0.12, vol: 0.22, f0: 700, f1: 200 });
    sub(undefined, 55, 0.4, 0.14);
  },
  death() {
    if (!AC || muted) return;
    const t = now();
    sub(t, 48, 0.7, 0.4);
    noise({ t, dur: 0.5, vol: 0.30, f0: 900, f1: 60, type: "lowpass" });
    tone({ t, f0: 300, f1: 92, dur: 0.45, type: "sawtooth", vol: 0.10 });
    tone({ t: t + 0.1, f0: 150, f1: 60, dur: 0.4, type: "triangle", vol: 0.14 });
    if (AC) { // long duck — the world goes quiet for the death beat
      const g = out.musGain.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(C.AUDIO_MUSIC * 0.06, t, 0.02);
      g.setTargetAtTime(C.AUDIO_MUSIC, t + 1.0, 0.6);
    }
  },
  win() {
    // stinger in the CURRENT level's key — resolves the room you just cleared
    if (!AC) return;
    const T = mus.theme || THEMES[0];
    const t = now();
    [0, 2, 4, 7].forEach((deg, i) => {
      const f = degFreq(T, deg, 2);
      tone({ t: t + i * 0.09, f0: f, dur: 0.5, type: "triangle", vol: 0.16, bus: out.delay });
      tone({ t: t + i * 0.09, f0: f * 2, dur: 0.3, type: "sine", vol: 0.06 });
    });
    [0, 2, 4].forEach((deg) => // pad swell under it
      tone({ t, f0: degFreq(T, deg, 1), dur: 1.6, type: "sawtooth", vol: 0.035,
             attack: 0.5, bus: out.musFilter }));
  },
  rank(i) {
    if (!AC || muted) return;
    const t = now();
    tone({ t, f0: st(4 + i * 3), dur: 0.1, type: "sine", vol: 0.09 });
    tone({ t: t + 0.06, f0: st(9 + i * 3), dur: 0.14, type: "sine", vol: 0.11 });
  },
  tick() { tone({ f0: 950, dur: 0.03, type: "sine", vol: 0.07 }); },
  confirm() {
    if (!AC || muted) return;
    const t = now();
    tone({ t, f0: 620, dur: 0.06, type: "triangle", vol: 0.10 });
    tone({ t: t + 0.05, f0: 930, dur: 0.09, type: "triangle", vol: 0.10 });
  },

  // --- enemy telegraphs & payoffs — every attack is AUDIBLE before it exists
  dartWind() { // the charge-up whine: rising the whole telegraph
    tone({ f0: 170, f1: 640, dur: C.DART_TELE, type: "sawtooth", vol: 0.055, bend: "lin" });
    tone({ f0: 340, f1: 1280, dur: C.DART_TELE, type: "sine", vol: 0.04, bend: "lin" });
  },
  dartLunge() {
    noise({ dur: 0.18, vol: 0.26, f0: 500, f1: 2200, Q: 1.3 });
    tone({ f0: 900, f1: 300, dur: 0.12, type: "sawtooth", vol: 0.07 });
  },
  dartThud() {
    noise({ dur: 0.09, vol: 0.22, f0: 420, f1: 120, type: "lowpass" });
    sub(undefined, 70, 0.28, 0.09);
  },
  wardCharge() {
    tone({ f0: 190, f1: 430, dur: C.WARD_CHARGE, type: "sine", vol: 0.06, bend: "lin" });
    noise({ dur: C.WARD_CHARGE, vol: 0.03, f0: 3000, f1: 6000, type: "highpass" });
  },
  wardShot() {
    tone({ f0: 760, f1: 230, dur: 0.13, type: "square", vol: 0.11 });
    noise({ dur: 0.05, vol: 0.10, f0: 2400 });
  },
  shotBreak() { // cutting a bolt out of the air
    tone({ f0: 1500, f1: 2400, dur: 0.05, type: "sine", vol: 0.10 });
    noise({ dur: 0.05, vol: 0.12, f0: 3400, type: "highpass" });
  },
  bloomTick(k) { // fuse blinks — pitch and urgency ride the timer
    tone({ f0: 620 + k * 520, dur: 0.035, type: "square", vol: 0.07 + k * 0.05 });
  },
  boom() {
    if (!AC || muted) return;
    const t = now();
    sub(t, 44, 0.75, 0.32);
    noise({ t, dur: 0.4, vol: 0.38, f0: 380, f1: 70, type: "lowpass" });
    noise({ t, dur: 0.14, vol: 0.16, f0: 2800, f1: 900 }); // crackle top
    tone({ t, f0: 180, f1: 55, dur: 0.3, type: "triangle", vol: 0.14 });
  },
  regrow() { tone({ f0: 290, f1: 470, dur: 0.18, type: "sine", vol: 0.05 }); },

  // --- dynamic terrain
  crumbleWarn() { // gravelly shudder — the floor is deciding
    noise({ dur: C.CRUMBLE_DELAY, vol: 0.10, f0: 700, f1: 250, type: "lowpass" });
    tone({ f0: 90, f1: 60, dur: C.CRUMBLE_DELAY, type: "triangle", vol: 0.05 });
  },
  crumbleBreak() {
    noise({ dur: 0.28, vol: 0.30, f0: 500, f1: 90, type: "lowpass" });
    sub(undefined, 58, 0.4, 0.16);
  },
  crumbleBack() { tone({ f0: 300, f1: 520, dur: 0.12, type: "triangle", vol: 0.07 }); },
  wallJump() {
    tone({ f0: 280, f1: 470, dur: 0.09, type: "triangle", vol: 0.14 });
    noise({ dur: 0.05, vol: 0.10, f0: 1600, f1: 700 });
  },
  gripScuff() { noise({ dur: 0.05, vol: 0.05, f0: 1400, f1: 700 }); },
  keeperRoar() {
    if (!AC || muted) return;
    const t = now();
    tone({ t, f0: 70, f1: 160, dur: 0.9, type: "sawtooth", vol: 0.22, bend: "lin" });
    noise({ t, dur: 0.9, vol: 0.20, f0: 300, f1: 90, type: "lowpass" });
    sub(t, 44, 0.6, 0.5);
  },
  clink() {
    tone({ f0: 2200, f1: 1500, dur: 0.06, type: "triangle", vol: 0.12 });
    noise({ dur: 0.04, vol: 0.10, f0: 4200, type: "highpass" });
  },
  sweepWarn() {
    tone({ f0: 220, f1: 480, dur: 0.8, type: "square", vol: 0.06, bend: "lin" });
    tone({ f0: 221, f1: 484, dur: 0.8, type: "square", vol: 0.06, bend: "lin" });
  },
  sweepFire() {
    noise({ dur: 1.1, vol: 0.24, f0: 500, f1: 1600, Q: 0.6 });
    sub(undefined, 50, 0.4, 0.3);
  },
  crownOpen() {
    if (!AC || muted) return;
    const t = now();
    [0, 4, 9].forEach((n, i) => tone({ t: t + i * 0.07, f0: st(n + 12), dur: 0.3, type: "triangle", vol: 0.12 }));
  },
  waveCharge() { tone({ f0: 400, f1: 60, dur: 0.95, type: "sine", vol: 0.16, bend: "lin" }); },
  waveBoom() {
    if (!AC || muted) return;
    const t = now();
    sub(t, 40, 0.85, 0.4);
    noise({ t, dur: 0.5, vol: 0.4, f0: 300, f1: 60, type: "lowpass" });
  },
  keeperHurt() {
    tone({ f0: 300, f1: 110, dur: 0.25, type: "sawtooth", vol: 0.16 });
    noise({ dur: 0.2, vol: 0.2, f0: 900, f1: 250 });
  },
  keeperDie() {
    if (!AC || muted) return;
    const t = now();
    sub(t, 38, 0.9, 0.7);
    noise({ t, dur: 1.2, vol: 0.35, f0: 800, f1: 50, type: "lowpass" });
    [12, 16, 19, 24].forEach((n, i) =>
      tone({ t: t + 0.5 + i * 0.12, f0: st(n), dur: 0.6, type: "triangle", vol: 0.12, bus: out.delay }));
  },
  plate() { tone({ f0: 420, f1: 300, dur: 0.07, type: "square", vol: 0.09 }); },
  clutter() {
    noise({ dur: 0.12, vol: 0.18, f0: 1600, f1: 400 });
    tone({ f0: 320, f1: 140, dur: 0.08, type: "triangle", vol: 0.08 });
  },
  coin() {
    if (!AC || muted) return;
    const t = now();
    tone({ t, f0: st(16), dur: 0.07, type: "triangle", vol: 0.14 });
    tone({ t: t + 0.06, f0: st(23), dur: 0.16, type: "triangle", vol: 0.13 });
  },
  secret() { // the reveal — a rising, slightly-wrong-then-right arpeggio
    if (!AC || muted) return;
    const t = now();
    [0, 3, 7, 12, 16].forEach((n, i) =>
      tone({ t: t + i * 0.09, f0: st(n + 4), dur: 0.3, type: "triangle", vol: 0.11, bus: out.delay }));
  },
  moverClunk() {
    tone({ f0: 120, f1: 78, dur: 0.08, type: "triangle", vol: 0.10 });
    noise({ dur: 0.04, vol: 0.06, f0: 500, type: "lowpass" });
  },
};

// sidechain: every impact() pushes the score down so the hit owns the mix
export function duckMusic(amt) {
  if (!AC || muted) return;
  const g = out.musGain.gain, t = now();
  g.cancelScheduledValues(t);
  g.setTargetAtTime(vol.music * (1 - clamp(amt, 0, 0.9)), t, 0.006);
  g.setTargetAtTime(vol.music, t + 0.07, 0.33);
}

// pause/results muffle — filter sweep, the "behind glass" menu feel
export function setMuffle(on) {
  if (!AC) return;
  out.musFilter.frequency.setTargetAtTime(on ? 460 : 15000, now(), 0.09);
}

// --------------------------------------------------------------- the score
/* One THEME per level (index -1 = level select). scale = semitones from root,
 * prog = chord-root scale degrees, 2 bars per chord. */
const THEMES = [];
THEMES[-1] = { root: -24, scale: [0, 2, 4, 7, 9], bpm: 64, pad: "triangle",
               prog: [0, 3, 4, 3], density: 0.20, hats: false, drive: false };
THEMES[0] = { root: -24, scale: [0, 2, 4, 7, 9], bpm: 76, pad: "triangle",
              prog: [0, 5, 3, 4], density: 0.30, hats: false, drive: false };
THEMES[1] = { root: -19, scale: [0, 2, 3, 5, 7, 9, 10], bpm: 100, pad: "sawtooth",
              prog: [0, 6, 3, 4], density: 0.30, hats: true, drive: true };
THEMES[2] = { root: -21, scale: [0, 2, 4, 6, 7, 9, 11], bpm: 88, pad: "triangle",
              prog: [0, 1, 4, 5], density: 0.45, hats: false, drive: false };
THEMES[3] = { root: -26, scale: [0, 3, 5, 7, 10], bpm: 92, pad: "triangle",
              prog: [0, 3, 4, 2], density: 0.30, hats: true, drive: false }; // shifting ground — earthy tick
THEMES[4] = { root: -17, scale: [0, 2, 4, 7, 9], bpm: 72, pad: "triangle",
              prog: [0, 4, 5, 3], density: 0.35, hats: false, drive: false }; // the climb — high air
THEMES[5] = { root: -29, scale: [0, 3, 5, 7, 10], bpm: 84, pad: "sawtooth",
              prog: [0, 2, 3, 1], density: 0.26, hats: false, drive: false }; // momentum bank
THEMES[6] = { root: -26, scale: [0, 1, 3, 5, 7, 8, 10], bpm: 108, pad: "sawtooth",
              prog: [0, 1, 0, 3], density: 0.36, hats: true, drive: true };  // gauntlet
THEMES[7] = { root: -26, scale: [0, 1, 3, 5, 7, 8, 10], bpm: 116, pad: "sawtooth",
              prog: [0, 1, 3, 1], density: 0.44, hats: true, drive: true };  // the keeper

function degFreq(T, deg, oct = 0) {
  const n = T.scale.length;
  const o = Math.floor(deg / n) + oct;
  return st(T.root + T.scale[((deg % n) + n) % n] + o * 12);
}

// deterministic per (level, bar) — the level always plays "its" phrases
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const mus = { theme: null, level: null, step: 0, nextT: 0, pulse: false, lastDeg: 4 };

/* ---- real tracks (public/music/*.mp3) -------------------------------------
 * Levels author `track: "music/<file>.mp3"`; the file streams through an
 * HTMLAudioElement into the SAME music chain (musFilter → musGain), so the
 * volume slider, ducking, the pause muffle and mute all keep working. The
 * procedural score is the FALLBACK layer (ROADMAP: keep it as one): it plays
 * when no track is authored, or when the file can't load — which is what
 * keeps the single-file standalone self-contained (drop a music/ folder next
 * to TETHER.html and the real score comes back). */
const trk = { el: null, url: null, fallback: null };
// the element-level mirror of the mix controls. When the element is ROUTED
// (createMediaElementSource succeeded) the WebAudio buses own loudness and
// el.volume stays 1; when it is RAW (no graph — stale copies, tainted
// media, any exotic environment) el.volume carries master×music itself.
// el.muted mirrors the mute either way — M must always kill the music.
function applyElGain() {
  const el = trk.el;
  if (!el) return;
  el.muted = muted;
  el.volume = el.__node ? 1 : Math.min(1, vol.master * vol.music);
}
function stopTrack() {
  if (trk.el) {
    try { trk.el.pause(); } catch {}
    try { trk.el.__node && trk.el.__node.disconnect(); } catch {}
  }
  trk.el = null; trk.url = null;
}
function startProcedural(i, theme) {
  mus.level = i;
  mus.theme = theme || THEMES[i] || THEMES[0];
  mus.step = 0;
  mus.nextT = now() + 0.08;
}
function startTrack(url) {
  if (trk.url === url && trk.el) { // level restart keeps the song rolling
    trk.el.play().catch(() => {});
    return;
  }
  stopTrack();
  // resolution order: the vite build serves public/music/ at music/…; a raw
  // file:// standalone finds the same files beside itself as public/music/
  // (the repo) or music/ (a copied pair). Neither present → the score returns.
  const candidates = [url, "public/" + url];
  const tryLoad = (ci) => {
    const el = new Audio(candidates[ci]);
    el.loop = true; el.preload = "auto";
    trk.el = el; trk.url = url; // identity stays the AUTHORED path
    el.addEventListener("error", () => {
      if (trk.el !== el) return; // superseded — a later play() owns the bus
      stopTrack();
      if (ci + 1 < candidates.length) return tryLoad(ci + 1);
      if (trk.fallback) startProcedural(trk.fallback.i, trk.fallback.theme);
    });
    const arm = () => {
      if (trk.el !== el || !AC) return;
      try {
        if (!el.__node) el.__node = AC.createMediaElementSource(el);
        el.__node.connect(out.musFilter); // slider/duck/muffle/mute all apply
      } catch {} // stays RAW — applyElGain carries the controls instead
      applyElGain();
      el.play().catch(() => {});        // pre-gesture refusal: unlock() retries
    };
    applyElGain(); // pre-arm playback (if any) starts at the right loudness
    if (el.readyState >= 2) arm();
    else el.addEventListener("canplay", arm, { once: true });
    el.load();
  };
  tryLoad(0);
}
// audit hook: which track owns the music bus right now (null = procedural),
// and HOW it is playing — routed through the WebAudio buses (mute/volume
// apply by construction) or raw (element-level gain must cover it)
export const trackState = () => ({
  url: trk.url, live: !!trk.el,
  routed: !!(trk.el && trk.el.__node),
  paused: trk.el ? trk.el.paused : null,
  elVol: trk.el ? Math.round(trk.el.volume * 100) / 100 : null,
  elMuted: trk.el ? trk.el.muted : null,
});

export const music = {
  // theme: an optional level-authored THEME object (root/scale/bpm/pad/prog/
  // density/hats/drive). When present it OVERRIDES THEMES[levelIndex] — so a
  // level's score follows the level, not its shifting registry slot. DEATH
  // WORLD levels each carry their own; World 1/2 fall back to THEMES by index.
  // track: an optional level-authored real-audio file (see the block above) —
  // it SILENCES the procedural score and owns the music bus while it lives.
  play(levelIndex, theme = null, track = null) {
    pending = { i: levelIndex, theme, track };
    if (!AC) return;
    if (track) {
      trk.fallback = { i: levelIndex, theme };
      mus.level = levelIndex;
      mus.theme = null; // the scheduler idles while the track owns the bus
      startTrack(track);
      return;
    }
    stopTrack();
    trk.fallback = null;
    if (mus.level === levelIndex && mus.theme && !theme) return;
    startProcedural(levelIndex, theme);
  },
  setPulse(on) { mus.pulse = on; }, // 1-HP heartbeat
};

function scheduleMusic() {
  if (!AC || !mus.theme) return;
  if (muted) { mus.nextT = Math.max(mus.nextT, now()); return; }
  const T = mus.theme;
  const stepDur = 60 / T.bpm / 2; // 8th notes
  const ahead = now() + 0.20;
  let guard = 0;
  if (mus.nextT < now() - 0.5) mus.nextT = now(); // tab-sleep catch-up clamp
  while (mus.nextT < ahead && guard++ < 64) {
    scheduleStep(T, mus.step, mus.nextT, stepDur);
    mus.nextT += stepDur;
    mus.step++;
  }
}

function scheduleStep(T, i, t, stepDur) {
  const pos = i % 8, bar = (i / 8) | 0;
  const chord = T.prog[((bar / 2) | 0) % T.prog.length];
  const rng = mulberry32(((mus.level + 2) * 7919 + bar * 131 + pos) | 0);

  // pad — a chord of stacked scale-thirds every 2 bars, slow attack
  if (pos === 0 && bar % 2 === 0) {
    const dur = stepDur * 16;
    for (const off of [0, 2, 4]) {
      const f = degFreq(T, chord + off, 1);
      tone({ t, f0: f * 0.998, dur, type: T.pad, vol: 0.028, attack: dur * 0.3, bus: out.musFilter });
      tone({ t, f0: f * 1.004, dur, type: T.pad, vol: 0.028, attack: dur * 0.3, bus: out.musFilter });
    }
  }
  // bass — root on the bar; driving levels pulse 8ths
  if (pos === 0)
    tone({ t, f0: degFreq(T, chord, 0) / 2, dur: stepDur * 3.2, type: "sine", vol: 0.14, attack: 0.02, bus: out.musFilter });
  else if (T.drive && pos % 2 === 0)
    tone({ t, f0: degFreq(T, chord, 0) / 2, dur: stepDur * 1.1, type: "sine", vol: 0.07, attack: 0.01, bus: out.musFilter });

  // melody — sparse seeded walk, plucks through the echo
  if (rng() < T.density && !(pos === 0 && bar % 2 === 0)) {
    mus.lastDeg = clamp(mus.lastDeg + ((rng() * 5) | 0) - 2, chord, chord + 9);
    const f = degFreq(T, mus.lastDeg, 2);
    tone({ t, f0: f, dur: 0.3, type: "triangle", vol: 0.055, bus: out.delay });
  }
  // hats — offbeat air on the driving levels
  if (T.hats && pos % 2 === 1)
    noise({ t, dur: 0.03, vol: 0.038, f0: 7000, type: "highpass", bus: out.musFilter });

  // 1-HP heartbeat — lub-dub under everything
  if (mus.pulse && pos === 0) {
    sub(t, 58, 0.30, 0.13);
    sub(t + stepDur * 0.9, 50, 0.20, 0.11);
  }
}

// headless-audit probe (read-only)
if (typeof window !== "undefined")
  window.__tetherAudio = {
    state: () => (AC ? AC.state : "none"),
    muted: () => muted,
    level: () => mus.level,
    pulse: () => mus.pulse,                                        // 1-HP heartbeat armed
    muffled: () => (out ? out.musFilter.frequency.value < 3000 : false), // filter swept down
  };
