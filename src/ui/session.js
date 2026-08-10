import { el, icon, mmss } from '../dom.js';
import { getExercise, getPhases, PHASE_COLORS, PHASE_RGB, num } from '../exercises.js';
import { createRing } from './ring.js';
import * as audio from '../audio.js';
import * as haptics from '../haptics.js';
import * as wakelock from '../wakelock.js';
import { recordSession } from '../storage.js';
import { projectedEnd } from '../engine.js';

const SLEEP_DELAY = 20000;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Colour drifts continuously from this phase's colour toward the next one, so
 * the light swells and fades with the breath rather than switching between
 * four flat states.
 */
function blend(from, to, t) {
  const k = smoothstep(t);
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k)
  ];
}

export function session(app, props) {
  const { settings } = app;
  const exercise = getExercise(props.exerciseId);
  const phases = getPhases(props.exerciseId, settings);

  const limitSeconds = props.limitMinutes ? props.limitMinutes * 60 : 0;
  // What the HUD counts towards: the real end, not the limit. The session
  // always finishes the breath it is on, so these differ by up to a cycle.
  const endsAt = projectedEnd(phases, limitSeconds);
  const targetRounds = props.targetRounds || 0;
  const isRounds = exercise.mode === 'rounds';

  /* ---------------------------------------------------------------- chrome */

  const hudTime = el('div', { class: 'hud__time' }, isRounds ? '' : '0:00');
  const endBtn = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': 'End session', onclick: stop },
    [icon('close')]
  );
  const hud = el('div', { class: 'hud' }, [hudTime, endBtn]);

  const ring = createRing({ showCountdown: settings.countdown });

  const dots = phases.map((phase) =>
    el('div', { class: 'dot', style: { '--dot-color': PHASE_COLORS[phase.kind] } }, [
      el('div', { class: 'dot__mark' }),
      el('div', { class: 'dot__label' }, phase.name)
    ])
  );
  const dotRow = el('div', { class: 'dots' }, dots);

  const stage = el('div', { class: 'session__stage' }, [ring.el, dotRow]);

  const notice = el('div', { class: 'notice' });
  const primaryBtn = el(
    'button',
    { class: 'btn btn--ghost', type: 'button', onclick: togglePause },
    [icon('pause'), el('span', {}, 'Pause')]
  );
  const foot = el('div', { class: 'session__foot' }, [notice, primaryBtn]);

  const root = el('div', { class: 'screen session' }, [hud, stage, foot]);

  /* ------------------------------------------------------------ sleep mode */

  let sleepTimer = 0;
  let asleep = false;

  function wake() {
    if (asleep) {
      asleep = false;
      root.classList.remove('is-dimmed');
      app.setBrightness(settings.brightness);
    }
    clearTimeout(sleepTimer);
    if (settings.sleepMode) sleepTimer = setTimeout(sleep, SLEEP_DELAY);
  }

  function sleep() {
    if (asleep || !settings.sleepMode) return;
    asleep = true;
    root.classList.add('is-dimmed');
    app.setBrightness(Math.min(settings.brightness, settings.dimFloor));
  }

  root.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', onKey);

  function onKey(event) {
    wake();
    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      togglePause();
    } else if (event.key === 'Escape') {
      stop();
    }
  }

  /* --------------------------------------------------------------- engine  */

  const engine = app.engine;
  const off = [];

  off.push(engine.on('frame', onFrame));
  off.push(engine.on('phase', onPhase));
  off.push(engine.on('end', onEnd));

  let lastRgb = '';
  let lastHud = '';

  function onFrame(f) {
    ring.setBreath(f.breath);
    ring.setProgress(f.progress);
    if (settings.countdown) ring.setCountdown(num(f.countdown));

    const next = phases[(f.index + 1) % phases.length];
    const rgb = blend(PHASE_RGB[f.phase.kind], PHASE_RGB[next.kind], f.progress);
    const key = rgb.join(',');
    if (key !== lastRgb) {
      lastRgb = key;
      ring.setColor(`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`, key);
    }

    const label = isRounds
      ? `Round ${Math.min(f.rounds + 1, targetRounds || f.rounds + 1)}${targetRounds ? ` of ${targetRounds}` : ''}`
      : limitSeconds
        ? `${mmss(f.seconds)} / ${mmss(endsAt)}`
        : mmss(f.seconds);
    if (label !== lastHud) {
      lastHud = label;
      hudTime.textContent = label;
    }

    notice.textContent = f.finishing ? 'Finishing current cycle' : '';
    audio.follow(f.breath, f.phase.kind);
  }

  function onPhase({ index, phase, isFinal, initial }) {
    ring.setPhaseName(phase.name);
    dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));

    if (initial) return;
    if (isFinal) {
      audio.completeCue();
      haptics.complete();
    } else {
      audio.phaseCue(phase.kind);
      haptics.phase();
    }
  }

  function onEnd(summary) {
    recordSession({
      exercise: props.exerciseId,
      seconds: summary.seconds,
      rounds: summary.rounds,
      completed: summary.completed
    });
    app.go('complete', {
      ...summary,
      exerciseId: props.exerciseId,
      limitMinutes: props.limitMinutes || 0,
      targetRounds: props.targetRounds || 0
    });
  }

  function togglePause() {
    wake();
    if (engine.paused) {
      audio.unlock();
      engine.resume();
      primaryBtn.replaceChildren(icon('pause'), el('span', {}, 'Pause'));
      wakelock.request();
    } else {
      engine.pause();
      audio.stop();
      primaryBtn.replaceChildren(icon('play'), el('span', {}, 'Resume'));
      wakelock.release();
    }
  }

  /** User-initiated stop. The engine records it as an incomplete session. */
  function stop() {
    engine.end();
  }

  /* ----------------------------------------------------------------- start */

  audio.setMode(settings.sound);
  audio.unlock();
  haptics.setEnabled(settings.haptics);
  wakelock.request();
  wake();

  engine.start({ phases, mode: exercise.mode, limitSeconds, targetRounds });

  return {
    el: root,
    destroy() {
      off.forEach((fn) => fn());
      engine.dispose();
      clearTimeout(sleepTimer);
      window.removeEventListener('keydown', onKey);
      audio.stop();
      haptics.stop();
      wakelock.release();
      app.setBrightness(settings.brightness);
    }
  };
}
