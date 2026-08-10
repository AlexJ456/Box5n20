import { el, icon, mmss } from '../dom.js';
import { getExercise } from '../exercises.js';
import { loadHistory, historyStats, heatmapData, clearHistory, exportHistory } from '../storage.js';

const RECENT_SHOWN = 20;

function intensity(seconds) {
  if (seconds <= 0) return 0.05;
  if (seconds < 120) return 0.22;
  if (seconds < 300) return 0.42;
  if (seconds < 600) return 0.66;
  return 0.9;
}

function relative(ts) {
  const day = 86400000;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const diff = Math.floor((midnight.getTime() - ts) / day);
  if (diff < 0) return 'Today';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff + 1} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function history(app) {
  let list = loadHistory();

  const body = el('div', { class: 'screen__scroll' });

  const root = el('div', { class: 'screen' }, [
    el('div', { class: 'topbar' }, [
      el(
        'button',
        { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => app.go('home') },
        [icon('back')]
      ),
      el('h1', { class: 'title' }, 'history'),
      el('div', { style: { width: '44px' } })
    ]),
    body
  ]);

  function stat(value, label) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'stat__value' }, String(value)),
      el('div', { class: 'stat__label' }, label)
    ]);
  }

  function render() {
    if (list.length === 0) {
      body.replaceChildren(
        el('div', { class: 'empty' }, 'No sessions yet. Your first one will show up here.')
      );
      return;
    }

    const s = historyStats(list);

    const cells = heatmapData(list).map((cell) =>
      el('div', {
        class: 'heat',
        style: { '--heat': cell.future ? 0.02 : intensity(cell.seconds) },
        title: `${new Date(cell.ts).toLocaleDateString()} — ${Math.round(cell.seconds / 60)} min`
      })
    );

    const recent = list
      .slice(-RECENT_SHOWN)
      .reverse()
      .map((entry) =>
        el('div', { class: 'log__item' }, [
          el('div', {}, getExercise(entry.exercise).name),
          el('div', { class: 'log__when' }, `${relative(entry.ts)} · ${mmss(entry.seconds)}`)
        ])
      );

    body.replaceChildren(
      el('div', { class: 'stats' }, [
        stat(s.streak, 'day streak'),
        stat(s.totalMinutes, 'minutes'),
        stat(s.sessions, 'sessions')
      ]),
      el('div', { class: 'section-label' }, 'Last 12 weeks'),
      el('div', { class: 'heatmap' }, cells),
      el('div', { class: 'section-label' },
        list.length > RECENT_SHOWN ? `Recent · ${RECENT_SHOWN} of ${list.length}` : 'Recent'),
      el('div', { class: 'log' }, recent),
      el('div', { class: 'history__actions' }, [
        el(
          'button',
          { class: 'btn btn--quiet', type: 'button', onclick: () => exportHistory(list) },
          'Export'
        ),
        el(
          'button',
          {
            class: 'btn btn--quiet',
            type: 'button',
            onclick: () => {
              if (!confirm('Delete all session history? This cannot be undone.')) return;
              clearHistory();
              list = [];
              render();
            }
          },
          'Clear'
        )
      ])
    );
  }

  render();

  return { el: root };
}
