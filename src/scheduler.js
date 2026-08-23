/**
 * Background scheduler.
 *
 * Runs fetch+score on a repeating window: "every N minutes between 09:00 and
 * 18:00, on these days". It lives in the server process rather than in the
 * Electron shell for three reasons — the `running` mutex that stops two runs
 * colliding is already here, it keeps working in plain `npm run ui` browser
 * mode, and it leaves electron/main.cjs the dumb window shell it was written
 * to be.
 *
 * Timing is wall-clock, not elapsed-time. A chained setInterval drifts, and
 * macOS App Nap throttles timers in background processes, so a run scheduled
 * for 14:00 could arrive minutes late and then stay late forever. Instead a
 * cheap 30-second tick compares Date.now() against a precomputed slot: a
 * throttled tick fires late, but "is it past 14:00 yet" is still the right
 * answer when it does.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, dataFile } from './paths.js';

const CONFIG_FILE = dataFile('schedule.json');
const STATE_FILE = dataFile('schedule-state.json');

/**
 * Scraping too often is the one thing that actually gets you IP-blocked, and
 * until now nothing in the project enforced a floor. A scheduler is where an
 * accidental "every 2 minutes, forever" becomes possible, so the floor is
 * clamped here rather than only in the UI.
 */
export const MIN_INTERVAL_MINUTES = 15;

const TICK_MS = 30_000;

export const DEFAULTS = {
  enabled: false,
  days: [1, 2, 3, 4, 5], // 0 = Sunday
  startTime: '09:00',
  endTime: '18:00',
  intervalMinutes: 60,
  limit: 60,
  runOnLaunch: false,
  notify: true,
  /**
   * Whether closing the window hides the app into the menu bar or quits it.
   *
   * Deliberately separate from `enabled`: "run every hour" and "keep running
   * after I close the window" are different wishes. Someone who only wants the
   * schedule while they have the app open turns this off and gets a normal
   * single-window tool that happens to refresh itself.
   */
  background: true,
  /**
   * Give up on a run after this long.
   *
   * Without a ceiling one wedged run blocks every future slot forever, and the
   * only symptom is "a run is already in progress" repeating until someone
   * reads the log. A run that has not finished in this long is not going to.
   */
  maxRunMinutes: 45,
};

/**
 * Rolling activity log.
 *
 * A scheduler that quietly does nothing is indistinguishable from a scheduler
 * that is working but not due yet, so every decision it makes is recorded.
 * Kept in memory and served to the UI as well as printed, because `npm start`
 * from Finder or an IDE has no terminal to print to.
 */
const LOG_LIMIT = 60;
const activity = [];

function log(message, level = 'info') {
  const entry = { at: new Date().toISOString(), level, message };
  activity.unshift(entry);
  activity.length = Math.min(activity.length, LOG_LIMIT);
  console.log(`[scheduler ${new Date().toLocaleTimeString()}] ${message}`);
  schedulePersist();
  return entry;
}

/**
 * Write the log to disk soon, but not on every line.
 *
 * The whole point of the log is answering "what happened overnight", which it
 * cannot do if a restart wipes it. Batched on a few seconds because a run
 * produces several lines in a burst and each one is otherwise a file write.
 */
let persistTimer = null;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistState().catch(() => {});
  }, 4000);
  persistTimer.unref?.();
}

/**
 * Record something that happened outside this module.
 *
 * The Electron shell owns notifications, but its console is invisible when the
 * app is launched from Finder — so it reports back here and its lines land in
 * the same Activity panel as everything else.
 */
export function note(message, level = 'info') {
  return log(message, level);
}

const shortTime = (d) =>
  d ? new Date(d).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'never';

let ticks = 0;
let lastTickAt = null;
let config = { ...DEFAULTS };
let state = { lastRunAt: null, lastResult: null, nextRunAt: null };
let timer = null;
let hooks = { trigger: async () => {}, isBusy: () => false, onChange: () => {} };
let firing = false;

/* ================= config ================= */

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Accept "9:00", "09:00", "9" — reject anything else back to the default. */
function normalizeTime(value, fallback) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return fallback;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Coerce anything that arrives over HTTP into a config we can safely act on. */
export function sanitize(raw = {}) {
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : DEFAULTS.days;

  return {
    enabled: Boolean(raw.enabled),
    days: days.length ? days : DEFAULTS.days,
    startTime: normalizeTime(raw.startTime, DEFAULTS.startTime),
    endTime: normalizeTime(raw.endTime, DEFAULTS.endTime),
    intervalMinutes: clampInt(raw.intervalMinutes, MIN_INTERVAL_MINUTES, 24 * 60, DEFAULTS.intervalMinutes),
    limit: clampInt(raw.limit, 1, 250, DEFAULTS.limit),
    runOnLaunch: Boolean(raw.runOnLaunch),
    notify: raw.notify === undefined ? true : Boolean(raw.notify),
    background: raw.background === undefined ? true : Boolean(raw.background),
    maxRunMinutes: clampInt(raw.maxRunMinutes, 5, 240, DEFAULTS.maxRunMinutes),
  };
}

/**
 * True when the last readConfig() found a real file.
 *
 * Worth tracking because "your settings went back to defaults" and "the file
 * that holds your settings wasn't there" look identical from the UI, and only
 * the second one is a problem. The startup log says which happened.
 */
let configExisted = false;

export async function readConfig() {
  try {
    const cfg = sanitize(JSON.parse(await readFile(CONFIG_FILE, 'utf8')));
    configExisted = true;
    return cfg;
  } catch {
    configExisted = false;
    return { ...DEFAULTS };
  }
}

async function persistConfig(cfg) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

async function readState() {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    // Restore the log before anything writes to it, so the first lines of this
    // session sit on top of the previous one rather than replacing it.
    activity.length = 0;
    if (Array.isArray(raw.activity)) {
      activity.push(...raw.activity.filter((a) => a && a.at && a.message).slice(0, LOG_LIMIT));
    }
    return { lastRunAt: raw.lastRunAt ?? null, lastResult: raw.lastResult ?? null, nextRunAt: null };
  } catch {
    return { lastRunAt: null, lastResult: null, nextRunAt: null };
  }
}

async function persistState() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    STATE_FILE,
    JSON.stringify({ lastRunAt: state.lastRunAt, lastResult: state.lastResult, activity }, null, 2),
  );
}

/* ================= slot maths ================= */

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Local midnight for the day `offset` days after `from`. */
function midnight(from, offset = 0) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + offset);
  return d;
}

/**
 * How many minutes the window covers.
 *
 * An end at or before the start means the window wraps past midnight ("22:00
 * to 06:00"), and the day it belongs to is the day it *starts* — otherwise a
 * Friday-night window would silently need Saturday ticked too.
 */
function windowSpan(cfg) {
  const start = toMinutes(cfg.startTime);
  const end = toMinutes(cfg.endTime);
  return end > start ? end - start : 24 * 60 - start + end;
}

/**
 * Every run time for one enabled day, as real Dates.
 *
 * Built with setMinutes off local midnight rather than by adding milliseconds,
 * so a DST change shifts the clock time by an hour instead of sliding every
 * slot in the window.
 */
function slotsForDay(cfg, dayStart) {
  const start = toMinutes(cfg.startTime);
  const span = windowSpan(cfg);
  const step = Math.max(MIN_INTERVAL_MINUTES, cfg.intervalMinutes);
  const out = [];
  for (let m = 0; m <= span; m += step) {
    const d = new Date(dayStart);
    d.setMinutes(d.getMinutes() + start + m);
    out.push(d);
  }
  return out;
}

/** The next run time strictly after `from`, or null if nothing is scheduled. */
export function computeNext(cfg, from = new Date()) {
  if (!cfg.enabled || !cfg.days.length) return null;
  // Starts at yesterday, not today: a window that wraps past midnight belongs
  // to the day it opened, so at 01:00 on Saturday the next slot may still come
  // from Friday's 22:00-06:00 window. Slots already in the past are filtered
  // out below anyway. Eight days ahead, so a once-a-week schedule still
  // resolves no matter which day you ask from.
  for (let offset = -1; offset <= 8; offset += 1) {
    const dayStart = midnight(from, offset);
    if (!cfg.days.includes(dayStart.getDay())) continue;
    for (const slot of slotsForDay(cfg, dayStart)) {
      if (slot.getTime() > from.getTime()) return slot;
    }
  }
  return null;
}

/**
 * Is `when` inside an active window right now?
 *
 * This is what decides whether a slot missed while the machine slept still
 * deserves to run. Waking at 15:00 having missed the 10:00 slot should fetch
 * once — the postings are real and still fresh. Waking at 15:00 having missed
 * an 08:00-09:00 window should not, because a run then is just a scrape at a
 * time you deliberately said you didn't want one.
 */
export function withinWindow(cfg, when = new Date()) {
  if (!cfg.enabled || !cfg.days.length) return false;
  const span = windowSpan(cfg);
  const start = toMinutes(cfg.startTime);
  // Check today and yesterday, since a wrapping window can still be open after midnight.
  for (const offset of [0, -1]) {
    const dayStart = midnight(when, offset);
    if (!cfg.days.includes(dayStart.getDay())) continue;
    const open = new Date(dayStart);
    open.setMinutes(open.getMinutes() + start);
    const close = new Date(open);
    close.setMinutes(close.getMinutes() + span);
    if (when >= open && when <= close) return true;
  }
  return false;
}

/* ================= public state ================= */

export function getState() {
  return {
    config,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    nextRunAt: state.nextRunAt ? new Date(state.nextRunAt).toISOString() : null,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    activity,
    // Proof the tick is actually alive. If this stops advancing while the
    // schedule is on, the process is being suspended rather than mis-scheduled.
    lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
  };
}

function reschedule(reason = null) {
  const previous = state.nextRunAt ? new Date(state.nextRunAt).getTime() : null;
  state.nextRunAt = config.enabled ? computeNext(config, new Date()) : null;
  const now = state.nextRunAt ? new Date(state.nextRunAt).getTime() : null;
  if (reason && previous !== now) log(`${reason} — next run ${shortTime(state.nextRunAt)}`);
  hooks.onChange(getState());
}

export async function setConfig(patch) {
  const was = config.enabled;
  config = sanitize({ ...config, ...patch });
  await persistConfig(config);

  if (config.enabled !== was) {
    log(config.enabled ? 'Schedule turned ON' : 'Schedule turned OFF');
  }
  if (config.enabled) {
    const days = config.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(' ');
    log(`Settings saved: ${days} · ${config.startTime}-${config.endTime} · every ${config.intervalMinutes} min · background=${config.background}`);
  }

  reschedule('Rescheduled');
  return getState();
}

/* ================= the loop ================= */

async function fire(reason) {
  // A run drives a real browser and can take minutes; overlapping one with a
  // manual run would fight over the same Chrome profile. Skip rather than
  // queue — a backlog of catch-up scrapes firing back to back is exactly the
  // traffic pattern that gets an IP blocked.
  if (firing || hooks.isBusy()) {
    log('Slot due, but a run is already in progress — skipping this one', 'warn');
    reschedule('Skipped');
    return;
  }
  firing = true;
  state.lastRunAt = new Date().toISOString();
  log(`▶ Starting run (${reason}) — judging up to ${config.limit} jobs`);
  reschedule();
  try {
    state.lastResult = await hooks.trigger({
      reason,
      limit: config.limit,
      timeoutMs: config.maxRunMinutes * 60_000,
    });
    const r = state.lastResult ?? {};
    if (r.timedOut) {
      log(`■ Run gave up after ${config.maxRunMinutes} min and was stopped. The next slot will try again.`, 'error');
    } else if (r.needsAttention) log('■ Run stopped — Cloudflare wants a check. Open the app and press Fetch & score.', 'warn');
    else if (r.ok === false) log(`■ Run failed${r.error ? `: ${r.error}` : ''}`, 'error');
    else log(`■ Run finished — ${r.added ?? 0} new, ${r.top ?? 0} top pick(s)`);
  } catch (err) {
    state.lastResult = { ok: false, error: err.message };
    log(`■ Run threw: ${err.message}`, 'error');
  } finally {
    firing = false;
    const mins = Math.round((Date.now() - new Date(state.lastRunAt).getTime()) / 60000);
    if (mins > config.intervalMinutes) {
      log(
        `That run took ${mins} min, longer than your ${config.intervalMinutes} min interval — ` +
          'slots in between were skipped. Raise the interval or lower "jobs per run".',
        'warn',
      );
    }
    await persistState().catch(() => {});
    reschedule('Rescheduled after run');
  }
}

function tick() {
  ticks += 1;
  lastTickAt = Date.now();
  if (!config.enabled || !state.nextRunAt) return;

  const now = new Date();
  const dueAt = new Date(state.nextRunAt).getTime();

  if (now.getTime() < dueAt) {
    // A heartbeat every 10th tick (~5 min). Enough to prove the loop is alive
    // and to expose the tell-tale of a suspended process — long gaps between
    // consecutive heartbeats — without burying the real events.
    if (ticks % 10 === 0) {
      const mins = Math.round((dueAt - now.getTime()) / 60000);
      log(`Waiting — next run ${shortTime(state.nextRunAt)} (in ${mins} min)`);
    }
    return;
  }

  // The slot is due. Whether it still deserves to run depends on the window,
  // not on how late we are — see withinWindow above.
  const lateBy = Math.round((now.getTime() - dueAt) / 60000);
  if (withinWindow(config, now)) {
    if (lateBy >= 2) log(`Slot was ${lateBy} min late (asleep or throttled) but still inside the window`);
    fire('schedule');
  } else {
    log(`Slot at ${shortTime(state.nextRunAt)} was missed and the window has closed — skipping to the next one`, 'warn');
    reschedule('Skipped');
  }
}

/**
 * Record a run that did not come from a slot — "Run now", from the app or the
 * menu bar. Without this the Last run panel only ever reflected the scheduler,
 * so a manual run appeared to have left no trace.
 */
export async function recordRun(result, { startedAt = null } = {}) {
  state.lastRunAt = startedAt ?? new Date().toISOString();
  state.lastResult = result;
  const r = result ?? {};
  if (r.needsAttention) log('■ Run stopped — Cloudflare wants a check.', 'warn');
  else if (r.ok === false) log(`■ Run failed${r.error ? `: ${r.error}` : ''}`, 'error');
  else log(`■ Run finished — ${r.added ?? 0} new, ${r.top ?? 0} top pick(s)`);
  await persistState().catch(() => {});
  reschedule();
}

/**
 * Re-evaluate immediately rather than waiting for the next tick.
 *
 * Called after the machine wakes from sleep: timers that should have fired
 * during sleep arrive in an unpredictable clump, and we would rather decide
 * from the current wall clock the moment we are conscious again.
 */
export function refresh() {
  log('Woke up or was nudged — re-checking the schedule against the clock');
  reschedule();
  tick();
}

export async function start(newHooks = {}) {
  hooks = { ...hooks, ...newHooks };
  config = await readConfig();
  state = await readState();
  reschedule();

  if (timer) clearInterval(timer);
  ticks = 0;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.(); // never hold the server process open on its own account

  log(
    configExisted
      ? `Loaded saved settings from data/schedule.json`
      : 'No data/schedule.json found — starting from defaults. Anything you set will be saved there.',
    configExisted ? 'info' : 'warn',
  );

  if (config.enabled) {
    log(`Scheduler started — next run ${shortTime(state.nextRunAt)}`);
  } else {
    log('Scheduler started — schedule is OFF, nothing will run on its own');
  }

  if (config.enabled && config.runOnLaunch) fire('launch');
  return getState();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  // Flush whatever the debounce is still holding, or the last lines before a
  // quit — often the interesting ones — never reach disk.
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return persistState().catch(() => {});
}
