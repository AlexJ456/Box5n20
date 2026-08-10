/**
 * Sound. Three modes:
 *
 *   off      silence
 *   chime    the 528Hz phase tone and the 880 / 1174.66Hz completion bell,
 *            carried over unchanged from the previous build
 *   ambient  a continuous, very quiet two-oscillator drone whose pitch falls
 *            a fifth on the exhale — far less jarring in a dark room
 *
 * The AudioContext is created lazily on the first user gesture. Creating it at
 * load (as the previous build did) means Safari hands back a suspended context
 * that never starts.
 */

let ctx = null;
let mode = 'off';
let drone = null;
let lastParamUpdate = 0;

function context() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch (e) {
      console.warn('Audio unavailable', e);
      return null;
    }
  }
  return ctx;
}

/** Call from a user gesture handler before anything else needs to make noise. */
export function unlock() {
  const c = context();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function setMode(next) {
  mode = next;
  if (mode !== 'ambient') stopDrone();
}

export function getMode() {
  return mode;
}

/* -------------------------------------------------------------------------
   Chime
   ------------------------------------------------------------------------- */

function phaseChime() {
  const c = context();
  if (!c) return;
  const t = c.currentTime;
  const gain = c.createGain();
  gain.connect(c.destination);

  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(528, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.5, t + 0.01);
  gain.gain.linearRampToValueAtTime(0, t + 0.3);
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.3);
}

function completionBell() {
  const c = context();
  if (!c) return;
  const t = c.currentTime;
  const gain = c.createGain();
  gain.connect(c.destination);

  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.45, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);

  [880, 1174.66].forEach((frequency, i) => {
    const osc = c.createOscillator();
    osc.type = i === 0 ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(frequency, t);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 1.2);
  });
}

/* -------------------------------------------------------------------------
   Ambient drone
   ------------------------------------------------------------------------- */

/**
 * The drone has to be usable with your eyes shut, which means every phase
 * needs its own audible signature:
 *
 *   in    pitch climbs a full octave, gain swells      — rising
 *   hold  parked at the top with a slow shimmer        — suspended, not still rising
 *   out   pitch falls back, gain fades                 — falling
 *   wait  effectively silent                           — unmistakably the bottom
 *
 * plus a soft filter swell at every boundary. The earlier version took only
 * `breath`, which the engine holds at a constant 1 through the whole hold and
 * 0 through the whole wait — so those phases were frozen and there was no
 * event at any boundary to locate yourself by.
 */

const DRONE_LOW = 130.81;   // C3, bottom of the exhale
const DRONE_TOP = 2;        // a full octave up (C4) at the top of the inhale

const SHIMMER_HZ = 4.5;
const SHIMMER_DEPTH = 0.02;

const GAIN_FLOOR = 0.0008;  // wait: below the noise floor of any real speaker
const GAIN_LOW = 0.014;
const GAIN_HIGH = 0.075;

const FILTER_LOW = 520;
const FILTER_HIGH = 1120;
const SWELL_LIFT = 900;
const SWELL_MS = 450;

let swellUntil = 0;

function startDrone() {
  const c = context();
  if (!c || drone) return;
  const t = c.currentTime;

  const gain = c.createGain();
  gain.gain.setValueAtTime(GAIN_FLOOR, t);

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(FILTER_LOW, t);
  filter.Q.setValueAtTime(0.6, t);

  const a = c.createOscillator();
  const b = c.createOscillator();
  a.type = 'sine';
  b.type = 'sine';
  a.frequency.setValueAtTime(DRONE_LOW, t);
  b.frequency.setValueAtTime(DRONE_LOW * 1.004, t); // gentle beating

  // The shimmer rides into the master gain's AudioParam. Web Audio sums a
  // param's scheduled value with whatever is connected to it, so this layers
  // on top of the setTargetAtTime writes below instead of fighting them.
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.setValueAtTime(SHIMMER_HZ, t);
  const lfoDepth = c.createGain();
  lfoDepth.gain.setValueAtTime(0, t);
  lfo.connect(lfoDepth);
  lfoDepth.connect(gain.gain);

  a.connect(filter);
  b.connect(filter);
  filter.connect(gain);
  gain.connect(c.destination);
  a.start();
  b.start();
  lfo.start();

  drone = { gain, filter, a, b, lfo, lfoDepth };
}

function stopDrone() {
  if (!drone || !ctx) return;
  const { gain, a, b, lfo, lfoDepth } = drone;
  const t = ctx.currentTime;
  drone = null;
  swellUntil = 0;
  try {
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0.0001, t, 0.25);
    lfoDepth.gain.setTargetAtTime(0, t, 0.2);
    a.stop(t + 1.2);
    b.stop(t + 1.2);
    lfo.stop(t + 1.2);
  } catch (e) {
    /* already stopped */
  }
}

/** Where the drone should sit right now, given the breath and the phase. */
function targets(breath, kind) {
  if (kind === 'hold') {
    return { freq: DRONE_LOW * DRONE_TOP, gain: GAIN_HIGH, filter: FILTER_HIGH, shimmer: SHIMMER_DEPTH };
  }
  if (kind === 'wait') {
    return { freq: DRONE_LOW, gain: GAIN_FLOOR, filter: FILTER_LOW, shimmer: 0 };
  }
  // in / out — both read straight off the breath, one rising, one falling.
  return {
    freq: DRONE_LOW * (1 + (DRONE_TOP - 1) * breath),
    gain: GAIN_LOW + (GAIN_HIGH - GAIN_LOW) * breath,
    filter: FILTER_LOW + (FILTER_HIGH - FILTER_LOW) * breath,
    shimmer: 0
  };
}

/**
 * Called every frame during a session. Parameter writes are throttled to
 * ~25Hz because `setTargetAtTime` smooths between them anyway.
 */
export function follow(breath, kind) {
  if (mode !== 'ambient') return;
  if (!drone) startDrone();
  if (!drone || !ctx) return;

  const now = ctx.currentTime;
  if (now - lastParamUpdate < 0.04) return;
  lastParamUpdate = now;

  const t = targets(breath, kind);
  drone.a.frequency.setTargetAtTime(t.freq, now, 0.12);
  drone.b.frequency.setTargetAtTime(t.freq * 1.004, now, 0.12);
  drone.gain.gain.setTargetAtTime(t.gain, now, 0.1);
  drone.lfoDepth.gain.setTargetAtTime(t.shimmer, now, 0.15);

  // Leave the filter alone while a boundary swell is still ringing out,
  // otherwise these writes cancel it 40ms after it starts.
  if (now >= swellUntil) {
    drone.filter.frequency.setTargetAtTime(t.filter, now, 0.12);
  }
}

/** A soft "wush" marking a phase boundary — textural, never percussive. */
function swell() {
  if (!drone || !ctx) return;
  const now = ctx.currentTime;
  const from = drone.filter.frequency.value;

  drone.filter.frequency.cancelScheduledValues(now);
  drone.filter.frequency.setValueAtTime(from, now);
  drone.filter.frequency.linearRampToValueAtTime(from + SWELL_LIFT, now + 0.09);
  drone.filter.frequency.setTargetAtTime(FILTER_LOW, now + 0.09, 0.22);
  swellUntil = now + SWELL_MS / 1000;
}

/* -------------------------------------------------------------------------
   Public cues
   ------------------------------------------------------------------------- */

export function phaseCue() {
  if (mode === 'chime') phaseChime();
  else if (mode === 'ambient') swell();
}

export function completeCue() {
  if (mode === 'off') return;
  if (mode === 'ambient') stopDrone();
  completionBell();
}

export function stop() {
  stopDrone();
}

/** Free the hardware when the app is backgrounded; resume on return. */
export function suspend() {
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
}

export function resume() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
