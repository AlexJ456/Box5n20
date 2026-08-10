/**
 * Sound. Three modes:
 *
 *   off      silence
 *   chime    the 528Hz phase tone and the 880 / 1174.66Hz completion bell,
 *            carried over unchanged from the previous build
 *   ambient  a soft pad that opens and settles with the breath
 *
 * The AudioContext is created lazily on the first user gesture. Creating it at
 * load (as the previous build did) means Safari hands back a suspended context
 * that never starts.
 *
 * Everything is synthesised — there are no audio files to download, so the app
 * still works offline from the cached shell alone.
 */

let ctx = null;
let master = null;
let mode = 'off';
let pad = null;
let retiring = [];
let impulse = null;
let lastParamUpdate = 0;
let lastBreath = 0;

/* -------------------------------------------------------------------------
   Ambient tuning

   Every number that shapes the pad lives here so it can be adjusted by ear
   without reading the graph code below.
   ------------------------------------------------------------------------- */

const AMBIENT = {
  // Fixed pitches — an open stack of octaves and fifths on C. The pad never
  // glides; the breath moves timbre and level instead. A drone that slides in
  // pitch reads as a siren, which is what the previous version did.
  voices: [
    { hz: 65.41,  type: 'sine',     gain: 0.55, pan: 0.0,   detune: -4 }, // C2, the floor
    { hz: 130.81, type: 'sine',     gain: 1.0,  pan: -0.25, detune: 3 },  // C3, the body
    { hz: 196.0,  type: 'triangle', gain: 0.28, pan: 0.3,   detune: -6 }, // G3, a little edge
    { hz: 261.63, type: 'sine',     gain: 0.3,  pan: -0.15, detune: 5 },  // C4
    { hz: 392.0,  type: 'sine',     gain: 0.22, pan: 0.35,  detune: -3, bloom: true } // G4
  ],

  // The bloom voice stays out of the way until the top of the inhale, so the
  // chord opens up rather than simply getting louder.
  bloomFrom: 0.6,

  // Breath drives the lowpass. Closed on the exhale, open on the inhale.
  cutoffLow: 300,
  cutoffHigh: 1500,
  filterQ: 0.5,

  // Pad level, before the master. Curved rather than linear — see shape().
  levelLow: 0.05,
  levelHigh: 0.13,
  curve: 1.6,

  // Smoothing. Slower on the way down so the pad settles instead of pumping.
  glideIn: 0.18,
  glideOut: 0.42,

  // Filtered noise that swells with the inhale. Reads as air moving.
  airLevel: 0.05,
  airFrom: 0.25,        // silent below this much breath
  airHz: 620,
  airQ: 0.7,

  // Procedural room. Length in seconds, and how much of the pad is sent to it.
  reverbSeconds: 2.8,
  reverbDecay: 3.2,
  reverbSend: 0.42,

  fadeIn: 2.5,
  fadeOut: 2.0,
  duckUnderBell: 0.35   // how far the pad drops when the completion bell lands
};

const MASTER_LEVEL = 1;

/* -------------------------------------------------------------------------
   Context
   ------------------------------------------------------------------------- */

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

/**
 * Single output stage. Every voice goes through this, so levels stay balanced
 * against each other and the pad can be faded as a whole.
 */
function output() {
  const c = context();
  if (!c) return null;
  if (!master) {
    master = c.createGain();
    master.gain.setValueAtTime(MASTER_LEVEL, c.currentTime);
    master.connect(c.destination);
  }
  return master;
}

/** Call from a user gesture handler before anything else needs to make noise. */
export function unlock() {
  const c = context();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function setMode(next) {
  mode = next;
  if (mode !== 'ambient') stopPad();
}

export function getMode() {
  return mode;
}

/* -------------------------------------------------------------------------
   Chime
   ------------------------------------------------------------------------- */

function phaseChime() {
  const c = context();
  const out = output();
  if (!c || !out) return;
  const t = c.currentTime;
  const gain = c.createGain();
  gain.connect(out);

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
  const out = output();
  if (!c || !out) return;
  const t = c.currentTime;
  const gain = c.createGain();
  gain.connect(out);

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
   Ambient pad
   ------------------------------------------------------------------------- */

/**
 * A room, made out of noise. Exponentially decaying white noise convolved with
 * the pad is what separates "an instrument" from "a signal generator", and it
 * costs nothing to ship because we generate it here rather than loading a file.
 * Built once on first use and reused for the life of the page.
 */
function impulseResponse(c) {
  if (impulse) return impulse;
  const length = Math.floor(c.sampleRate * AMBIENT.reverbSeconds);
  const buffer = c.createBuffer(2, length, c.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const decay = Math.pow(1 - i / length, AMBIENT.reverbDecay);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  impulse = buffer;
  return impulse;
}

/** White noise to loop for the air layer. Two seconds is past hearing the seam. */
function noiseBuffer(c) {
  const length = Math.floor(c.sampleRate * 2);
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Perceptual-ish curve, so the swell feels even rather than back-loaded. */
function shape(breath) {
  return Math.pow(Math.max(0, Math.min(1, breath)), AMBIENT.curve);
}

function startPad() {
  const c = context();
  const out = output();
  if (!c || !out || pad) return;

  // Pausing and resuming inside the fade-out window would otherwise build a
  // second pad on top of the first one and double the volume.
  clearRetiring();
  lastBreath = 0;

  const stereo = typeof c.createStereoPanner === 'function';

  // Pad bus: voices -> filter -> level -> (dry + reverb send) -> master.
  const level = c.createGain();
  level.gain.setValueAtTime(0.0001, c.currentTime);

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(AMBIENT.cutoffLow, c.currentTime);
  filter.Q.setValueAtTime(AMBIENT.filterQ, c.currentTime);
  filter.connect(level);

  // Fades the whole pad in at the start of a session and out at the end,
  // separately from the breath-driven level so the two never fight.
  const envelope = c.createGain();
  envelope.gain.setValueAtTime(0.0001, c.currentTime);
  envelope.gain.setTargetAtTime(1, c.currentTime, AMBIENT.fadeIn / 3);
  level.connect(envelope);
  envelope.connect(out);

  if (typeof c.createConvolver === 'function') {
    const send = c.createGain();
    send.gain.setValueAtTime(AMBIENT.reverbSend, c.currentTime);
    const convolver = c.createConvolver();
    convolver.buffer = impulseResponse(c);
    envelope.connect(send);
    send.connect(convolver);
    convolver.connect(out);
  }

  const voices = AMBIENT.voices.map((spec) => {
    const osc = c.createOscillator();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.hz, c.currentTime);
    // A few cents apart so the stack shimmers instead of beating at a fixed rate.
    if (osc.detune) osc.detune.setValueAtTime(spec.detune, c.currentTime);

    const gain = c.createGain();
    gain.gain.setValueAtTime(spec.bloom ? 0.0001 : spec.gain, c.currentTime);
    osc.connect(gain);

    if (stereo) {
      const panner = c.createStereoPanner();
      panner.pan.setValueAtTime(spec.pan, c.currentTime);
      gain.connect(panner);
      panner.connect(filter);
    } else {
      gain.connect(filter);
    }

    osc.start();
    return { osc, gain, spec };
  });

  // Air layer, straight to the envelope so it gets the same fade and reverb.
  const air = c.createBufferSource();
  air.buffer = noiseBuffer(c);
  air.loop = true;
  const airFilter = c.createBiquadFilter();
  airFilter.type = 'bandpass';
  airFilter.frequency.setValueAtTime(AMBIENT.airHz, c.currentTime);
  airFilter.Q.setValueAtTime(AMBIENT.airQ, c.currentTime);
  const airGain = c.createGain();
  airGain.gain.setValueAtTime(0.0001, c.currentTime);
  air.connect(airFilter);
  airFilter.connect(airGain);
  airGain.connect(envelope);
  air.start();

  pad = { level, filter, envelope, voices, air, airGain, airFilter };
}

function stopPad() {
  if (!pad || !ctx) return;
  const graph = pad;
  const t = ctx.currentTime;
  const dead = t + AMBIENT.fadeOut + 0.3;
  pad = null;

  // The oscillators keep running while the tail fades, so hold on to the graph
  // until they are actually gone.
  retiring.push(graph);
  setTimeout(() => {
    retiring = retiring.filter((g) => g !== graph);
  }, (AMBIENT.fadeOut + 0.4) * 1000);

  silence(graph, t, AMBIENT.fadeOut / 3, dead);
}

/** Cut short anything still fading out. */
function clearRetiring() {
  if (!ctx || retiring.length === 0) return;
  const t = ctx.currentTime;
  for (const graph of retiring) silence(graph, t, 0.03, t + 0.2);
  retiring = [];
}

function silence(graph, at, timeConstant, dead) {
  try {
    graph.envelope.gain.cancelScheduledValues(at);
    graph.envelope.gain.setTargetAtTime(0.0001, at, timeConstant);
    graph.voices.forEach(({ osc }) => osc.stop(dead));
    graph.air.stop(dead);
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
  if (!pad) startPad();
  if (!pad || !ctx) return;

  const now = ctx.currentTime;
  if (now - lastParamUpdate < 0.04) return;
  lastParamUpdate = now;

  // Settle more slowly than we open, so the exhale feels like a release rather
  // than a gate closing.
  const glide = breath >= lastBreath ? AMBIENT.glideIn : AMBIENT.glideOut;
  lastBreath = breath;

  const amount = shape(breath);

  pad.filter.frequency.setTargetAtTime(
    AMBIENT.cutoffLow + (AMBIENT.cutoffHigh - AMBIENT.cutoffLow) * amount,
    now,
    glide
  );
  pad.level.gain.setTargetAtTime(
    AMBIENT.levelLow + (AMBIENT.levelHigh - AMBIENT.levelLow) * amount,
    now,
    glide
  );

  // The top voice only arrives near the peak of the inhale.
  const bloom = Math.max(0, breath - AMBIENT.bloomFrom) / (1 - AMBIENT.bloomFrom);
  for (const voice of pad.voices) {
    if (!voice.spec.bloom) continue;
    voice.gain.gain.setTargetAtTime(Math.max(0.0001, voice.spec.gain * bloom), now, glide);
  }

  const air = Math.max(0, breath - AMBIENT.airFrom) / (1 - AMBIENT.airFrom);
  pad.airGain.gain.setTargetAtTime(Math.max(0.0001, AMBIENT.airLevel * air), now, glide);
  pad.airFilter.frequency.setTargetAtTime(AMBIENT.airHz * (1 + 0.6 * amount), now, glide);
}

/* -------------------------------------------------------------------------
   Public cues
   ------------------------------------------------------------------------- */

export function phaseCue() {
  if (mode === 'chime') phaseChime();
}

export function completeCue() {
  if (mode === 'off') return;
  // Duck the pad and let it decay underneath the bell rather than cutting both
  // off at the same instant.
  if (mode === 'ambient' && pad && ctx) {
    pad.envelope.gain.cancelScheduledValues(ctx.currentTime);
    pad.envelope.gain.setTargetAtTime(AMBIENT.duckUnderBell, ctx.currentTime, 0.15);
    setTimeout(stopPad, 400);
  }
  completionBell();
}

export function stop() {
  stopPad();
}

/** Free the hardware when the app is backgrounded; resume on return. */
export function suspend() {
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
}

export function resume() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
