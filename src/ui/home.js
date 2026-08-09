import { el, icon } from '../dom.js';
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

  /** Chosen length: a number of minutes/rounds, or null for open-ended. */
  let chosen = null;
  let custom = '';

  const listWrap = el('div', { class: 'ex-list block' });
  const sliderWrap = el('div', { class: 'block' });
  const lengthWrap = el('div', { class: 'block' });

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
    // sliderWrap and lengthWrap are wrapped so a wide screen can sit them
    // side by side. On a phone .controls is an ordinary block and the two
    // just stack, exactly as before.
    el('div', { class: 'screen__scroll' }, [
      listWrap,
      el('div', { class: 'controls' }, [sliderWrap, lengthWrap])
    ]),
    el('div', { class: 'home__foot' }, [startBtn])
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
    // Minutes and rounds are not interchangeable, so a mode switch resets it.
    chosen = null;
    custom = '';
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

  function renderLength() {
    const exercise = getExercise(settings.exercise);
    const rounds = exercise.mode === 'rounds';
    const presets = rounds ? ROUND_PRESETS : TIME_PRESETS;

    const customInput = el('input', {
      class: 'pill__custom',
      type: 'text',
      inputmode: 'numeric',
      pattern: '[0-9]*',
      maxlength: '3',
      value: custom,
      placeholder: rounds ? 'rds' : 'min',
      'aria-label': rounds ? 'Custom number of rounds' : 'Custom length in minutes',
      oninput: (e) => {
        const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
        e.target.value = digits;
        custom = digits;
        const parsed = Number.parseInt(digits, 10);
        chosen = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        markPills();
      }
    });

    const openPill = pill('Open', () => {
      chosen = null;
      custom = '';
      customInput.value = '';
      markPills();
    });

    const presetPills = presets.map((value) =>
      pill(String(value), () => {
        chosen = value;
        custom = '';
        customInput.value = '';
        markPills();
      })
    );

    const customPill = el('div', { class: 'pill' }, [customInput]);

    function pill(label, onclick) {
      return el('button', { class: 'pill', type: 'button', onclick }, label);
    }

    function markPills() {
      openPill.setAttribute('aria-pressed', String(chosen === null));
      presetPills.forEach((node, i) => {
        node.setAttribute('aria-pressed', String(chosen === presets[i] && custom === ''));
      });
      customPill.setAttribute('aria-pressed', String(custom !== '' && chosen !== null));
    }

    lengthWrap.replaceChildren(
      el('div', { class: 'section-label' }, rounds ? 'Rounds' : 'Session length'),
      el('div', { class: 'pills' }, [openPill, ...presetPills, customPill]),
      el('div', { class: 'hint' }, 'Open runs until you end it.')
    );
    markPills();
  }

  function renderAll() {
    renderList();
    renderSlider();
    renderLength();
  }

  function start() {
    // Creating the AudioContext inside the tap is what keeps Safari happy.
    audio.unlock();
    const exercise = getExercise(settings.exercise);
    app.go('session', {
      exerciseId: settings.exercise,
      limitMinutes: exercise.mode === 'time' ? chosen : 0,
      targetRounds: exercise.mode === 'rounds' ? chosen : 0
    });
  }

  renderAll();

  return { el: root };
}
