/**
 * Settings and session history. Everything lives in localStorage and never
 * leaves the device.
 */

const SETTINGS_KEY = 'breathe.settings.v1';
const HISTORY_KEY = 'breathe.history.v1';
const LEGACY_SETTINGS_KEY = 'breathingExercisesSettings';

const HISTORY_LIMIT = 500;

export const DEFAULTS = {
  exercise: 'box',
  // One key per exercise with a slider. They used to share `phaseTime`,
  // which meant setting one silently moved the other.
  phaseTime: 4,        // Box Breathing
  coherentTime: 5,     // Coherent Breathing
  exhaleDuration: 6,   // Long Exhale
  sound: 'off',        // 'off' | 'chime' | 'ambient'
  // Session length, remembered per mode. Minutes and rounds are not
  // interchangeable, so switching exercise must not clobber the other one.
  lastMinutes: 0,      // 0 = open-ended
  lastRounds: 0,       // 0 = open-ended
  phaseInput: 'list',  // how the phase-time sheet picks: 'list' | 'slider'
  countdown: false,
  haptics: false,
  sleepMode: true,
  brightness: 1,       // 0.25 – 1
  dimFloor: 0.35       // brightness sleep mode fades down to
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn('Could not read', key, e);
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('Could not write', key, e);
  }
}

/**
 * Pull forward the settings saved by the previous build. The old key is left
 * in place deliberately, so rolling back to the old app still finds it.
 */
function migrateLegacy() {
  const old = read(LEGACY_SETTINGS_KEY, null);
  if (!old || typeof old !== 'object') return null;

  const migrated = {};
  if (typeof old.soundEnabled === 'boolean') migrated.sound = old.soundEnabled ? 'chime' : 'off';
  if (typeof old.countdownEnabled === 'boolean') migrated.countdown = old.countdownEnabled;
  if (typeof old.exerciseType === 'string') migrated.exercise = old.exerciseType;
  if (typeof old.phaseTime === 'number') migrated.phaseTime = old.phaseTime;
  if (typeof old.exhaleDuration === 'number') migrated.exhaleDuration = old.exhaleDuration;
  return migrated;
}

export function loadSettings() {
  const stored = read(SETTINGS_KEY, null);
  const base = stored || migrateLegacy() || {};

  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = base[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== typeof DEFAULTS[key]) continue;
    settings[key] = value;
  }

  // One-time migration, safe to delete once installs have turned over.
  // Coherent used to share Box's `phaseTime`. Carry the value across when it
  // is valid for Coherent so the card keeps showing what it showed before;
  // otherwise leave the default. Either way Box is untouched.
  // Range mirrors EXERCISES.coherent.slider — that is the source of truth.
  if (base.coherentTime === undefined && typeof base.phaseTime === 'number') {
    const shared = base.phaseTime;
    const onGrid = Math.abs(shared * 2 - Math.round(shared * 2)) < 1e-9;
    if (shared >= 4.5 && shared <= 6 && onGrid) settings.coherentTime = shared;
  }

  // Guard the ranged values in case the stored copy was hand-edited.
  settings.brightness = clamp(settings.brightness, 0.25, 1);
  settings.dimFloor = clamp(settings.dimFloor, 0.15, 1);
  if (!['off', 'chime', 'ambient'].includes(settings.sound)) settings.sound = 'off';
  if (!['list', 'slider'].includes(settings.phaseInput)) settings.phaseInput = 'list';

  if (!stored) write(SETTINGS_KEY, settings);
  return settings;
}

export function saveSettings(settings) {
  write(SETTINGS_KEY, settings);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* -------------------------------------------------------------------------
   History
   ------------------------------------------------------------------------- */

export function loadHistory() {
  const list = read(HISTORY_KEY, []);
  return Array.isArray(list) ? list.filter((e) => e && typeof e.ts === 'number') : [];
}

export function recordSession(entry) {
  // Filter out mis-taps, but stay below one 4-7-8 round (19s) so a genuine
  // single-round session is still recorded.
  if (!entry || entry.seconds < 10) return loadHistory();
  const list = loadHistory();
  list.push({
    ts: Date.now(),
    exercise: entry.exercise,
    seconds: Math.round(entry.seconds),
    rounds: entry.rounds || 0,
    completed: Boolean(entry.completed)
  });
  const trimmed = list.slice(-HISTORY_LIMIT);
  write(HISTORY_KEY, trimmed);
  return trimmed;
}

export function clearHistory() {
  write(HISTORY_KEY, []);
}

/** Local calendar day, not UTC — a 11pm session belongs to that day. */
export function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function historyStats(list) {
  const days = new Set(list.map((e) => dayKey(e.ts)));
  const totalSeconds = list.reduce((sum, e) => sum + e.seconds, 0);

  // Count back from today. A day with no session yet does not break the
  // streak until it is over, so we allow starting from yesterday.
  const DAY = 86400000;
  let streak = 0;
  let cursor = Date.now();
  if (!days.has(dayKey(cursor))) cursor -= DAY;
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor -= DAY;
  }

  const weekAgo = Date.now() - 7 * DAY;
  const thisWeek = list.filter((e) => e.ts >= weekAgo).length;

  return {
    sessions: list.length,
    totalMinutes: Math.round(totalSeconds / 60),
    streak,
    thisWeek,
    days
  };
}

/**
 * Seconds breathed per day for the last `weeks` weeks, ordered oldest first
 * and aligned so each column is a Sunday-to-Saturday week.
 */
export function heatmapData(list, weeks = 12) {
  const DAY = 86400000;
  const perDay = new Map();
  for (const entry of list) {
    const key = dayKey(entry.ts);
    perDay.set(key, (perDay.get(key) || 0) + entry.seconds);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = today.getTime() + (6 - today.getDay()) * DAY; // end of this week
  const start = end - (weeks * 7 - 1) * DAY;

  const cells = [];
  for (let t = start; t <= end; t += DAY) {
    cells.push({ ts: t, seconds: perDay.get(dayKey(t)) || 0, future: t > today.getTime() });
  }
  return cells;
}

export function exportHistory(list) {
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `breathe-history-${dayKey(Date.now())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
