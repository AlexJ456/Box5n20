/**
 * The breathing guide.
 *
 * A fixed outer ring carries a hairline arc showing progress through the
 * current phase; an inner orb scales with the breath itself. Both are driven
 * by CSS custom properties written once per frame, so the animation stays on
 * the compositor and the main thread does almost nothing.
 */

import { el, svg } from '../dom.js';

const R = 112;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function createRing({ showCountdown }) {
  const track = svg('circle', { class: 'ring__track', cx: 120, cy: 120, r: R });
  const arc = svg('circle', {
    class: 'ring__arc',
    cx: 120,
    cy: 120,
    r: R,
    'stroke-dasharray': CIRCUMFERENCE,
    'stroke-dashoffset': CIRCUMFERENCE
  });

  const graphic = svg(
    'svg',
    { class: 'ring__svg', viewBox: '0 0 240 240', 'aria-hidden': 'true' },
    [track, arc]
  );

  const phaseText = el('div', { class: 'ring__phase', 'aria-live': 'polite' });
  const countText = el('div', { class: 'ring__count' });
  countText.hidden = !showCountdown;

  const root = el('div', { class: 'ring', role: 'img' }, [
    el('div', { class: 'ring__glow' }),
    graphic,
    el('div', { class: 'ring__orb' }),
    el('div', { class: 'ring__label' }, [phaseText, countText])
  ]);

  // Cached so we only touch the DOM when the rendered value actually changes.
  let lastPhase = '';
  let lastCount = '';
  let lastOffset = -1;

  return {
    el: root,

    setPhaseName(name) {
      if (name === lastPhase) return;
      lastPhase = name;
      phaseText.textContent = name;
      root.setAttribute('aria-label', `${name} phase`);
    },

    setCountdown(text) {
      if (countText.hidden || text === lastCount) return;
      lastCount = text;
      countText.textContent = text;
    },

    showCountdown(show) {
      countText.hidden = !show;
      if (!show) lastCount = '';
    },

    /** 0 = lungs empty, 1 = lungs full. */
    setBreath(value) {
      root.style.setProperty('--breath', value.toFixed(4));
    },

    /** 0–1 through the current phase. */
    setProgress(value) {
      const offset = Math.round(CIRCUMFERENCE * (1 - value) * 10) / 10;
      if (offset === lastOffset) return;
      lastOffset = offset;
      arc.setAttribute('stroke-dashoffset', offset);
    },

    setColor(hex, rgb) {
      root.style.setProperty('--phase-color', hex);
      root.style.setProperty('--phase-rgb', rgb);
    },

    /** Used by the complete screen for a final, settled state. */
    settle() {
      arc.setAttribute('stroke-dashoffset', 0);
    }
  };
}
