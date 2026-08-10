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
    el('div', { class: 'screen__scroll' }, [listWrap]),
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

  /* ------------------------------------------------------------ phase time */

  /**
   * Every slider range is only three or four steps wide (Box 3–6, Coherent
   * 4.5–6 by halves, Long Exhale 6–8), so the sheet lists them rather than
   * offering a slider — easier to hit and consistent with session length.
   */
  function sliderSteps(spec) {
    const out = [];
    for (let v = spec.min; v <= spec.max + 1e-9; v += spec.step) {
      out.push(Math.round(v * 100) / 100);
    }
    return out;
  }

  function openPhaseSheet() {
    const exercise = getExercise(settings.exercise);
    const spec = exercise.slider;
    if (!spec) return;

    openSheet({
      title: spec.label,
      value: sliderValue(exercise, settings),
      options: sliderSteps(spec).map((v) => ({ value: v, label: `${num(v)} seconds` })),
      onSelect: (value) => {
        if (value === null) return;
        settings[spec.setting] = value;
        app.save();
        renderList();
        renderQuick();
      }
    });
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
   * One row: session length, phase time (when the exercise has one), then the
   * three per-session toggles. The first two carry values you read, the rest
   * you just flip — hence wide labelled chips and square icon buttons.
   */
  function renderQuick() {
    const soundOn = settings.sound !== 'off';

    // Filtered, because replaceChildren stringifies null rather than skipping
    // it — phaseChip() returns null for the exercises with no slider.
    const children = [
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
      phaseChip(),
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
    ];
    quickWrap.replaceChildren(...children.filter(Boolean));
  }

  /** Only the three sliderless exercises omit this. */
  function phaseChip() {
    const exercise = getExercise(settings.exercise);
    if (!exercise.slider) return null;
    return el(
      'button',
      {
        class: 'chip chip--value',
        type: 'button',
        'data-chip': 'phase',
        'aria-haspopup': 'dialog',
        'aria-label': exercise.slider.label,
        title: exercise.slider.label,
        onclick: openPhaseSheet
      },
      [el('span', { class: 'chip__label' }, `${num(sliderValue(exercise, settings))}s`)]
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
