import { el, icon } from '../dom.js';
import { openSheet } from './sheet.js';

import {
  EXERCISE_IDS,
  getExercise,
  patternLabel,
  sliderValue,
  num,
  TIME_PRESETS,
  ROUND_PRESETS
} from '../exercises.js';
import * as audio from '../audio.js';

export function home(app) {
  const { settings } = app;

  /**
   * Chosen length: a number of minutes/rounds, or null for open-ended.
   * Minutes and rounds are remembered separately — they are not
   * interchangeable, so switching exercise must not clobber the other.
   */
  const lengthKey = () => (getExercise(settings.exercise).mode === 'rounds' ? 'lastRounds' : 'lastMinutes');
  const readLength = () => settings[lengthKey()] || null;
  function writeLength(value) {
    settings[lengthKey()] = value || 0;
    app.save();
  }

  const listWrap = el('div', { class: 'ex-list block' });
  const sliderWrap = el('div', { class: 'block' });
  const quickWrap = el('div', { class: 'quick' });

  const startBtn = el(
    'button',
    { class: 'btn', type: 'button', onclick: start },
    [icon('play'), el('span', {}, 'Start')]
  );

  const root = el('div', { class: 'screen' }, [
    el('div', { class: 'topbar' }, [
      el('h1', { class: 'title' }, 'breathe'),
      el('div', { class: 'topbar__actions' }, [
        el(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            'aria-label': 'History',
            onclick: () => app.go('history')
          },
          [icon('chart')]
        ),
        el(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            'aria-label': 'Settings',
            onclick: () => app.go('settings')
          },
          [icon('settings')]
        )
      ])
    ]),
    el('div', { class: 'screen__scroll' }, [
      listWrap,
      el('div', { class: 'controls' }, [sliderWrap])
    ]),
    el('div', { class: 'home__foot' }, [quickWrap, startBtn])
  ]);

  /* ------------------------------------------------------------- exercises */

  function renderList() {
    const nodes = EXERCISE_IDS.map((id) => {
      const exercise = getExercise(id);
      const selected = id === settings.exercise;
      return el(
        'button',
        {
          class: 'ex',
          type: 'button',
          'aria-pressed': String(selected),
          onclick: () => selectExercise(id)
        },
        [
          el('div', { class: 'ex__body' }, [
            el('div', { class: 'ex__name' }, exercise.name),
            el('div', { class: 'ex__desc' }, exercise.description)
          ]),
          el('div', { class: 'ex__pattern' }, patternLabel(id, settings))
        ]
      );
    });
    listWrap.replaceChildren(...nodes);
  }

  function selectExercise(id) {
    if (settings.exercise === id) return;
    settings.exercise = id;
    app.save();
    // No reset needed — each mode keeps its own remembered length.
    renderAll();
  }

  /* ---------------------------------------------------------------- slider */

  function renderSlider() {
    const exercise = getExercise(settings.exercise);
    if (!exercise.slider) {
      sliderWrap.replaceChildren();
      return;
    }

    const spec = exercise.slider;
    const value = sliderValue(exercise, settings);
    const readout = el('div', { class: 'slider-row__value' }, `${num(value)}s`);

    const input = el('input', {
      type: 'range',
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value,
      'aria-label': spec.label,
      oninput: (e) => {
        const next = Number(e.target.value);
        settings[spec.setting] = next;
        readout.textContent = `${num(next)}s`;
        app.save();
        renderList();
      }
    });

    sliderWrap.replaceChildren(
      el('div', { class: 'slider-row' }, [
        el('div', { class: 'section-label', style: { margin: '0 0 0 2px' } }, spec.label),
        readout
      ]),
      input
    );
  }

  /* --------------------------------------------------------------- length  */

  /** "Open", "5 min", "6 rounds" — what the length chip reads. */
  function lengthLabel() {
    const value = readLength();
    if (!value) return 'Open';
    if (getExercise(settings.exercise).mode === 'rounds') {
      return `${value} ${value === 1 ? 'round' : 'rounds'}`;
    }
    return `${value} min`;
  }

  function openLengthSheet() {
    const rounds = getExercise(settings.exercise).mode === 'rounds';
    const presets = rounds ? ROUND_PRESETS : TIME_PRESETS;

    openSheet({
      title: rounds ? 'Rounds' : 'Session length',
      value: readLength(),
      options: [
        { value: null, label: 'Open — until I end it' },
        ...presets.map((value) => ({
          value,
          label: rounds ? `${value} rounds` : `${value} minutes`
        }))
      ],
      custom: {
        label: 'Custom',
        placeholder: rounds ? 'rounds' : 'minutes'
      },
      onSelect: (value) => {
        writeLength(value);
        renderQuick();
      }
    });
  }

  /* ----------------------------------------------------------- quick chips */

  /**
   * One row: the session length, then the three per-session toggles. The
   * length carries a value you read, the rest you just flip — hence one wide
   * labelled chip and three square icon buttons.
   */
  function renderQuick() {
    const soundOn = settings.sound !== 'off';

    quickWrap.replaceChildren(
      el(
        'button',
        {
          class: 'chip chip--wide',
          type: 'button',
          'data-chip': 'length',
          'aria-haspopup': 'dialog',
          onclick: openLengthSheet
        },
        [icon('clock'), el('span', { class: 'chip__label' }, lengthLabel())]
      ),
      chip('sound', soundOn ? 'volume' : 'volumeOff', 'Sound', soundOn, () => {
        if (settings.sound === 'off') {
          settings.sound = settings.lastSound || 'chime';
        } else {
          // Remember chime-vs-ambient so unmuting restores what was chosen.
          settings.lastSound = settings.sound;
          settings.sound = 'off';
        }
        audio.unlock();
        audio.setMode(settings.sound);
        commit();
      }),
      chip('countdown', 'hash', 'Countdown', settings.countdown, () => {
        settings.countdown = !settings.countdown;
        commit();
      }),
      chip('sleep', 'moon', 'Sleep', settings.sleepMode, () => {
        settings.sleepMode = !settings.sleepMode;
        commit();
      })
    );
  }

  function chip(key, iconName, label, on, onclick) {
    return el(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(Boolean(on)),
        'aria-label': label,
        title: label,
        'data-chip': key,
        onclick
      },
      [icon(iconName)]
    );
  }

  function commit() {
    app.save();
    renderQuick();
  }

  function renderAll() {
    renderList();
    renderSlider();
    renderQuick();
  }

  function start() {
    // Creating the AudioContext inside the tap is what keeps Safari happy.
    audio.unlock();
    const exercise = getExercise(settings.exercise);
    app.go('session', {
      exerciseId: settings.exercise,
      limitMinutes: exercise.mode === 'time' ? readLength() : 0,
      targetRounds: exercise.mode === 'rounds' ? readLength() : 0
    });
  }

  renderAll();

  return { el: root };
}
