/**
 * Session clock.
 *
 * Phase position is always derived from absolute elapsed time
 * (`elapsed % cycleSeconds`) rather than accumulated per-frame deltas, so it
 * cannot drift no matter how the frame rate behaves. Pause works by banking
 * the paused duration and subtracting it, which means resuming picks the
 * breath back up exactly where it was left.
 *
 * Events: `frame`, `phase`, `round`, `pause`, `resume`, `end`.
 */

const now = () => performance.now();

/** The easing the previous build used for the breath — keep it. */
function ease(p) {
  return 0.5 - Math.cos(Math.PI * p) / 2;
}

/**
 * When a time-limited session will actually finish.
 *
 * A session never stops mid-breath: the limit only arms the ending, and the
 * session runs on until the current exhale completes. So the real duration is
 * the first exhale-completion at or after the limit, which can be most of a
 * cycle longer than the limit itself — a 5 minute Box session at 5s a phase
 * really runs 5:15. The HUD shows this rather than the limit, so the countdown
 * is honest about when it will end.
 *
 * Kept next to the rule it mirrors: `isFinal` below ends on the same instant.
 */
export function projectedEnd(phases, limitSeconds) {
  if (!limitSeconds) return 0;
  const outIndex = phases.findIndex((p) => p.kind === 'out');
  if (outIndex < 0) return limitSeconds; // nothing to end on; should not happen

  const cycle = phases.reduce((total, p) => total + p.duration, 0);
  const exhaleEnds = phases
    .slice(0, outIndex + 1)
    .reduce((total, p) => total + p.duration, 0);

  const cycles = Math.max(0, Math.ceil((limitSeconds - exhaleEnds) / cycle));
  return Math.round((cycles * cycle + exhaleEnds) * 1000) / 1000;
}

export function createEngine() {
  const handlers = new Map();
  let raf = 0;
  let s = null;

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => handlers.get(event).delete(fn);
  }

  function emit(event, payload) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of set) fn(payload);
  }

  function elapsedSeconds() {
    if (!s) return 0;
    const paused = s.running ? 0 : now() - s.pausedAt;
    return (now() - s.t0 - s.pausedTotal - paused) / 1000;
  }

  /**
   * @param {object} config
   * @param {Array}  config.phases        resolved phase list
   * @param {string} config.mode          'time' | 'rounds'
   * @param {number} config.limitSeconds  0 = open-ended
   * @param {number} config.targetRounds  0 = open-ended
   */
  function start(config) {
    stopLoop();

    const phases = config.phases;
    s = {
      phases,
      cycle: phases.reduce((total, p) => total + p.duration, 0),
      outIndex: phases.findIndex((p) => p.kind === 'out'),
      mode: config.mode,
      limitSeconds: config.limitSeconds || 0,
      targetRounds: config.targetRounds || 0,
      t0: now(),
      pausedAt: 0,
      pausedTotal: 0,
      running: true,
      index: 0,
      rounds: 0,
      whole: -1,
      countdown: null,
      finishing: false,
      limitReached: false
    };

    emit('phase', { index: 0, phase: phases[0], isFinal: false, initial: true });
    raf = requestAnimationFrame(tick);
  }

  function tick() {
    if (!s || !s.running) return;

    const elapsed = elapsedSeconds();
    const cyclePos = elapsed % s.cycle;

    let acc = 0;
    let index = 0;
    let phaseStart = 0;
    for (let i = 0; i < s.phases.length; i++) {
      if (cyclePos < acc + s.phases[i].duration) {
        index = i;
        phaseStart = acc;
        break;
      }
      acc += s.phases[i].duration;
    }

    const phase = s.phases[index];
    const phaseElapsed = cyclePos - phaseStart;
    const progress = phaseElapsed / phase.duration;
    const remaining = phase.duration - phaseElapsed;

    // Half-second phases (Coherent at 4.5s) hold their full value for the
    // first half-second rather than showing a bare "5".
    const hasHalf = phase.duration % 1 !== 0;
    const countdown = hasHalf && remaining > Math.floor(phase.duration)
      ? phase.duration
      : Math.ceil(remaining);

    const previous = s.index;
    s.index = index;
    const changed = index !== previous;
    const exhaleJustFinished = changed && s.outIndex >= 0 && previous === s.outIndex;

    // A round completes on the wrap from the last phase back to the first.
    if (changed && previous === s.phases.length - 1 && index === 0) {
      s.rounds += 1;
      emit('round', { rounds: s.rounds });
      if (s.mode === 'rounds' && s.targetRounds > 0 && s.rounds >= s.targetRounds) {
        s.finishing = true;
      }
    }

    if (s.mode === 'time' && s.limitSeconds > 0 && !s.limitReached && elapsed >= s.limitSeconds) {
      s.limitReached = true;
      s.finishing = true;
    }

    // Every ending lands on the completion of an exhale, never mid-breath.
    const isFinal = exhaleJustFinished && s.finishing;

    if (changed) emit('phase', { index, phase, isFinal, initial: false });

    const whole = Math.floor(elapsed);
    if (whole !== s.whole) s.whole = whole;
    s.countdown = countdown;

    let breath;
    if (phase.kind === 'in') breath = ease(progress);
    else if (phase.kind === 'out') breath = 1 - ease(progress);
    else if (phase.kind === 'hold') breath = 1;
    else breath = 0;

    emit('frame', {
      elapsed,
      seconds: whole,
      index,
      phase,
      progress,
      countdown,
      breath,
      rounds: s.rounds,
      finishing: s.finishing,
      limitReached: s.limitReached
    });

    if (isFinal) {
      finish(true);
      return;
    }

    raf = requestAnimationFrame(tick);
  }

  function finish(completed) {
    if (!s) return;
    const summary = {
      completed,
      seconds: Math.round(elapsedSeconds()),
      rounds: s.rounds,
      mode: s.mode
    };
    stopLoop();
    s = null;
    emit('end', summary);
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function pause() {
    if (!s || !s.running) return;
    s.running = false;
    s.pausedAt = now();
    stopLoop();
    emit('pause');
  }

  function resume() {
    if (!s || s.running) return;
    s.pausedTotal += now() - s.pausedAt;
    s.running = true;
    emit('resume');
    raf = requestAnimationFrame(tick);
  }

  return {
    on,
    start,
    pause,
    resume,
    /** User-initiated stop. Records the session as not completed. */
    end: () => finish(false),
    /** Tear down without emitting `end` — used when navigating away. */
    dispose: () => { stopLoop(); s = null; },
    get active() { return s !== null; },
    get paused() { return s !== null && !s.running; },
    get elapsed() { return elapsedSeconds(); }
  };
}
