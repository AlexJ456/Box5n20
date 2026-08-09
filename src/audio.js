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

const DRONE_LOW = 130.81;   // C3, bottom of the exhale
const DRONE_SPAN = 0.5;     // a perfect fifth up at the top of the inhale

function startDrone() {
  const c = context();
  if (!c || drone) return;

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, c.currentTime);

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(760, c.currentTime);
  filter.Q.setValueAtTime(0.6, c.currentTime);

  const a = c.createOscillator();
  const b = c.createOscillator();
  a.type = 'sine';
  b.type = 'sine';
  a.frequency.setValueAtTime(DRONE_LOW, c.currentTime);
  b.frequency.setValueAtTime(DRONE_LOW * 1.004, c.currentTime); // gentle beating

  a.connect(filter);
  b.connect(filter);
  filter.connect(gain);
  gain.connect(c.destination);
  a.start();
  b.start();

  drone = { gain, filter, a, b };
}

function stopDrone() {
  if (!drone || !ctx) return;
  const { gain, a, b } = drone;
  const t = ctx.currentTime;
  drone = null;
  try {
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0.0001, t, 0.25);
    a.stop(t + 1.2);
    b.stop(t + 1.2);
  } catch (e) {
    /* already stopped */
  }
}

/**
 * Follow the breath. Called every frame during a session; parameter writes are
 * throttled to ~25Hz because `setTargetAtTime` smooths between them anyway.
 */
export function follow(breath) {
  if (mode !== 'ambient') return;
  if (!drone) startDrone();
  if (!drone || !ctx) return;

  const now = ctx.currentTime;
  if (now - lastParamUpdate < 0.04) return;
  lastParamUpdate = now;

  const freq = DRONE_LOW * (1 + DRONE_SPAN * breath);
  drone.a.frequency.setTargetAtTime(freq, now, 0.12);
  drone.b.frequency.setTargetAtTime(freq * 1.004, now, 0.12);
  drone.filter.frequency.setTargetAtTime(620 + 420 * breath, now, 0.12);
  drone.gain.gain.setTargetAtTime(0.022 + 0.05 * breath, now, 0.1);
}

/* -------------------------------------------------------------------------
   Public cues
   ------------------------------------------------------------------------- */

export function phaseCue() {
  if (mode === 'chime') phaseChime();
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
