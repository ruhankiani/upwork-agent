/**
 * Tiny local web UI for the fetcher.
 *
 * Deliberately additive: this does not modify fetch.js or search-url.js. It
 * imports the filter definitions so the form stays in sync with the CLI, and
 * shells out to fetch.js exactly as you would from a terminal.
 *
 * No dependencies beyond what's already installed — Node's built-in http server
 * and one static HTML file, so there is no build step for anyone cloning this.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, dataFile, profileFile } from './paths.js';
import { FILTERS } from './search-url.js';
import { LOCATION_GROUPS } from './locations.js';
import { CATEGORIES, TIMEZONES } from './categories.js';
import * as store from './store.js';
import * as profile from './profile.js';
import * as scheduler from './scheduler.js';
import * as llm from './judge/llm.js';

// ROOT locates code (scripts, the UI file); dataFile/profileFile locate
// everything we write, which lives outside the bundle once packaged.
const UI_FILE = path.join(ROOT, 'src', 'ui', 'index.html');
const JOBS_FILE = dataFile('latest-jobs.json');
const FILTERS_FILE = dataFile('filters.json');
const FETCH_SCRIPT = path.join(ROOT, 'src', 'fetch.js');
const RUN_SCRIPT = path.join(ROOT, 'src', 'run.js');
const PORT = Number(process.env.PORT ?? 5173);

// The Top picks bar. Shared with the UI so the button and the endpoint agree.
const LETTER_MIN_SCORE = 60;

// A fetch drives a real browser, so only one may run at a time.
let running = false;

/**
 * Live progress for whatever is running.
 *
 * A run can take several minutes and previously reported nothing until it
 * finished, so there was no way to tell working from hung. The child scripts
 * already print their progress; this parses that stream as it arrives.
 */
let runState = {
  running: false,
  label: null,
  skipped: 0,
  phase: null,     // fetching | scoring | done
  done: 0,
  total: 0,
  current: null,   // title of the job being judged
  found: null,
  fresh: null,
  startedAt: null,
  finishedAt: null,
  log: '',
};

/**
 * Open server-sent-event streams.
 *
 * The Electron shell subscribes to this to raise native notifications, and the
 * page subscribes to keep its "next run" countdown honest. A stream rather than
 * polling because the interesting moments — a scheduled run finishing at 3am —
 * are exactly the ones nobody is polling for.
 */
const clients = new Set();

function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res); // a closed socket must never break a run
    }
  }
}

function resetRunState(label) {
  runState = {
    running: true, label, phase: 'starting', done: 0, total: 0, skipped: 0,
    current: null, found: null, fresh: null,
    startedAt: Date.now(), finishedAt: null, log: '',
  };
}

/** Pull progress out of the child's stdout as it streams. */
function parseProgress(buffer) {
  if (/─── Fetching ───/.test(buffer) && !/─── Scoring ───/.test(buffer)) runState.phase = 'fetching';
  if (/─── Scoring ───/.test(buffer)) runState.phase = 'scoring';

  const found = buffer.match(/Found (\d+) jobs?/);
  if (found) runState.found = Number(found[1]);

  const fresh = buffer.match(/(\d+) new · \d+ already seen/);
  if (fresh) runState.fresh = Number(fresh[1]);

  const prefiltered = buffer.match(/prefiltered out (\d+), (\d+) to judge/);
  if (prefiltered) {
    runState.skipped = Number(prefiltered[1]);
    runState.total = Number(prefiltered[2]);
  }

  // score.js writes "  [3/174] Some title… " as it goes; take the last one.
  const judged = [...buffer.matchAll(/\[(\d+)\/(\d+)\]\s([^\n]*?)…/g)].pop();
  if (judged) {
    runState.done = Number(judged[1]);
    runState.total = Number(judged[2]);
    runState.current = judged[3].trim();
  }
  if (/─── Cover letters ───/.test(buffer)) runState.phase = 'letters';
  if (/Wrote \d+ letter|Nothing to write/.test(buffer)) runState.phase = 'done';
  if (/─── Done ───|^Done in /m.test(buffer) && runState.phase !== 'letters') runState.phase = 'done';
}

/** Keep the UI's idea of "recent" in step with the scorer's age cap. */
async function scoreMaxAge() {
  try {
    const raw = await readFile(profileFile('preferences.json'), 'utf8');
    return Number(JSON.parse(raw).scoreMaxAgeHours ?? 48);
  } catch {
    return 48;
  }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });

/**
 * Run a project script, updating runState from its output as it streams.
 *
 * `timeoutMs` kills the child rather than waiting forever. A run drives a real
 * browser over a websocket, and a socket that fails to close keeps the process
 * alive with all its work already done — indistinguishable from progress
 * without a ceiling.
 */
function runScript(args, label = 'Working', { timeoutMs = 0, onHeartbeat = null } = {}) {
  return new Promise((resolve) => {
    resetRunState(label);
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let out = '';
    let timedOut = false;

    const killTimer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, timeoutMs)
      : null;

    // Say something every couple of minutes, so a long run reads as working
    // rather than wedged.
    const beat = onHeartbeat
      ? setInterval(() => {
          const mins = Math.round((Date.now() - runState.startedAt) / 60000);
          onHeartbeat({ mins, phase: runState.phase, done: runState.done, total: runState.total });
        }, 120_000)
      : null;

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (beat) clearInterval(beat);
    };
    const onData = (d) => {
      out += d;
      runState.log = out.slice(-4000); // tail only; the UI shows a window
      try {
        parseProgress(out);
      } catch {
        /* progress parsing must never break a run */
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      cleanup();
      runState.running = false;
      runState.phase = 'error';
      runState.finishedAt = Date.now();
      resolve({ ok: false, output: `Failed to start: ${e.message}` });
    });
    child.on('close', (code) => {
      cleanup();
      runState.running = false;
      runState.phase = code === 0 && !timedOut ? 'done' : 'error';
      runState.finishedAt = Date.now();
      resolve({ ok: code === 0 && !timedOut, code, timedOut, output: out, command: args.slice(1) });
    });
  });
}

/** Run fetch.js with the given filters, returning its console output. */
function runFetch(params) {
  return new Promise((resolve) => {
    const args = [FETCH_SCRIPT];
    for (const [key, value] of Object.entries(params)) {
      if (key in FILTERS && value !== '' && value != null) args.push(`--${key}=${value}`);
    }

    // process.execPath is the Node binary currently running this server, so the
    // child always matches the version the user started the UI with.
    const child = spawn(process.execPath, args, { cwd: ROOT });

    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, output: `Failed to start: ${e.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, output: out, command: args.slice(1) }));
  });
}

/** The filters saved from the Filters tab — what a scheduled run searches with. */
async function savedFilters() {
  try {
    return JSON.parse(await readFile(FILTERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Job ids currently in the store, so a run can report what it actually added. */
async function jobIds() {
  const db = await store.load();
  return new Set(Object.keys(db.jobs));
}

/**
 * What to say in the notification.
 *
 * "Fetched 40 jobs" is noise — most are repeats of what you saw an hour ago.
 * The only number worth waking someone for is how many *new* postings cleared
 * the bar, so this diffs the store around the run and scores only the arrivals.
 */
async function summarizeRun(before) {
  const db = await store.load();
  const arrived = Object.values(db.jobs).filter((j) => !before.has(j.id));
  const top = arrived.filter((j) => (j.score?.score ?? 0) >= 60);
  return { added: arrived.length, top: top.length, topTitle: top[0]?.title ?? null };
}

/**
 * Write cover letters for whatever the run just promoted to a top pick.
 *
 * Deliberately the last thing to happen, and only ever *after* the
 * `run-finished` broadcast the shell notifies from. Being early on a posting is
 * worth real points, so nothing may sit between a job being scored and you
 * being told about it — letters cost a model call each and would delay the
 * notification by minutes.
 *
 * Failure here is not run failure: the jobs are scored and you have been told.
 * A missing letter is a button press away.
 */
async function writeLettersAfterRun(limit = 10) {
  try {
    const args = [path.join(ROOT, 'src', 'letters.js'), `--limit=${limit}`, `--min-score=${LETTER_MIN_SCORE}`];
    const out = await runScript(args, 'Writing cover letters');
    broadcast({ type: 'letters-finished', ok: out.ok, at: new Date().toISOString() });
    return out;
  } catch (err) {
    scheduler.note(`   cover letters skipped — ${err.message}`);
    return { ok: false };
  }
}

/**
 * One scheduled fetch+score.
 *
 * Uses the saved filters and always passes --no-interactive, so an expired
 * Cloudflare clearance stops the run cleanly instead of opening a browser
 * window at 3am. Exit code 3 from fetch.js means exactly that, and gets its own
 * notification telling you what to do about it.
 */
async function scheduledRun({ limit, timeoutMs = 45 * 60_000 }) {
  if (running) return { ok: false, skipped: true, reason: 'busy' };
  running = true;
  try {
    const before = await jobIds();
    const args = [RUN_SCRIPT, `--limit=${limit}`, '--no-interactive'];
    for (const [key, value] of Object.entries(await savedFilters())) {
      if (key in FILTERS && value !== '' && value != null) args.push(`--${key}=${value}`);
    }

    const result = await runScript(args, 'Scheduled run', {
      timeoutMs,
      onHeartbeat: ({ mins, phase, done, total }) => {
        const where = phase === 'scoring' && total ? `scoring ${done}/${total}` : (phase ?? 'working');
        scheduler.note(`   …still running — ${where}, ${mins} min elapsed`);
        broadcast({ type: 'schedule', state: scheduler.getState() });
      },
    });

    if (result.timedOut) {
      broadcast({ type: 'run-finished', ok: false, timedOut: true, at: new Date().toISOString() });
      return { ok: false, timedOut: true, at: new Date().toISOString() };
    }

    const needsAttention = result.code === 3 || /NEEDS_ATTENTION cloudflare/.test(result.output ?? '');
    if (needsAttention) {
      broadcast({ type: 'attention', reason: 'cloudflare' });
      return { ok: false, needsAttention: true, at: new Date().toISOString() };
    }

    const summary = result.ok ? await summarizeRun(before) : null;
    broadcast({ type: 'run-finished', ok: result.ok, summary, at: new Date().toISOString() });

    // Only now, with the notification already out.
    if (result.ok) await writeLettersAfterRun();

    return { ok: result.ok, ...summary, at: new Date().toISOString() };
  } finally {
    running = false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // Live progress for the running job, polled by the UI.
    if (url.pathname === '/api/status') {
      return send(res, 200, {
        ...runState,
        elapsedMs: runState.startedAt ? (runState.finishedAt ?? Date.now()) - runState.startedAt : 0,
      });
    }

    // The currently-set search filters. Kept on disk rather than in the
    // browser so the app window, a browser tab and the CLI all agree.
    if (url.pathname === '/api/filters-state' && req.method === 'GET') {
      try {
        return send(res, 200, JSON.parse(await readFile(FILTERS_FILE, 'utf8')));
      } catch {
        return send(res, 200, {});
      }
    }

    if (url.pathname === '/api/filters-state' && req.method === 'POST') {
      const body = await readBody(req);
      const clean = {};
      for (const [k, v] of Object.entries(body)) {
        if (k in FILTERS && v !== '' && v != null) clean[k] = String(v);
      }
      await writeFile(FILTERS_FILE, JSON.stringify(clean, null, 2));
      return send(res, 200, { ok: true, filters: clean });
    }

    // The filter dictionary — the UI builds its whole form from this.
    if (url.pathname === '/api/filters') {
      return send(res, 200, {
        filters: FILTERS,
        locationGroups: LOCATION_GROUPS,
        categories: CATEGORIES,
        timezones: TIMEZONES,
      });
    }

    // Everything we've ever seen, with scores attached.
    if (url.pathname === '/api/jobs') {
      const db = await store.load();
      const maxAgeHours = await scoreMaxAge();
      const jobs = store.all(db).map(({ raw, detail, ...j }) => ({
        ...j,
        // `raw` is huge and the UI never uses it; send the useful detail bits only.
        proposalsText: detail?.proposalsText ?? null,
        letter: j.letter ?? null,
        interviewing: detail?.interviewing ?? null,
        invitesSent: detail?.invitesSent ?? null,
        clientSpend: detail?.clientSpend ?? j.clientSpend ?? null,
        clientHires: detail?.clientHires ?? null,
        clientCountry: detail?.clientCountry ?? j.clientCountry ?? null,
      }));
      return send(res, 200, {
        jobs,
        count: jobs.length,
        stats: store.stats(db, { maxAgeHours }),
        // The UI splits recent from backlog on the same age the scorer uses, so
        // the tabs and the "why wasn't this judged" answer never disagree.
        maxAgeHours,
        letterMinScore: LETTER_MIN_SCORE,
        runs: db.runs.slice(0, 12),
        recentSince: store.recentSince(db, 3),
        fetchedAt: db.runs[0]?.at ?? null,
      });
    }

    // --- profile: portfolio, rubric, preferences ---
    if (url.pathname === '/api/profile' && req.method === 'GET') {
      return send(res, 200, await profile.readAll());
    }

    if (url.pathname === '/api/profile' && req.method === 'POST') {
      const { key, content } = await readBody(req);
      try {
        return send(res, 200, await profile.write(key, content));
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message });
      }
    }

    // Rebuild the keyword list from the portfolio. Pattern matching, not AI —
    // see src/keywords.js.
    if (url.pathname === '/api/profile/keywords/rebuild' && req.method === 'POST') {
      const { deriveKeywords, renderKeywordFile } = await import('./keywords.js');
      const text = await readFile(profileFile('portfolio.md'), 'utf8').catch(() => '');
      if (!text.trim()) {
        return send(res, 200, { ok: false, error: 'Your portfolio is empty — paste it in first.' });
      }
      const terms = deriveKeywords(text);
      await profile.write('keywords', renderKeywordFile(terms));
      return send(res, 200, { ok: true, count: terms.length, content: renderKeywordFile(terms) });
    }

    // Grab a page's text so it can be pasted into the portfolio box. No AI.
    if (url.pathname === '/api/profile/import' && req.method === 'POST') {
      if (running) return send(res, 409, { ok: false, error: 'Something is already running.' });
      running = true;
      try {
        const { url: target } = await readBody(req);
        return send(res, 200, { ok: true, ...(await profile.importFromUrl(String(target ?? '').trim())) });
      } catch (err) {
        return send(res, 200, { ok: false, error: err.message });
      } finally {
        running = false;
      }
    }

    // Fetch and judge in one go — the main action.
    if (url.pathname === '/api/run' && req.method === 'POST') {
      if (running) return send(res, 409, { ok: false, output: 'Something is already running.' });
      running = true;
      try {
        const { params = {}, limit = 60, letters = true } = await readBody(req);
        const before = await jobIds();
        const args = [path.join(ROOT, 'src', 'run.js'), `--limit=${Number(limit) || 60}`];
        for (const [key, value] of Object.entries(params)) {
          if (key in FILTERS && value !== '' && value != null) args.push(`--${key}=${value}`);
        }
        const out = await runScript(args, 'Fetching & scoring');

        if (out.ok) {
          // Same order as a scheduled run: tell the user first, then spend
          // model calls on letters.
          const summary = await summarizeRun(before);
          broadcast({ type: 'run-finished', ok: true, summary, at: new Date().toISOString() });

          if (letters) {
            // Answer the browser *now*. Awaiting the letters here kept the POST
            // open for minutes after the jobs were already scored and visible,
            // long enough for a client to time the request out and report a
            // failed run that had in fact succeeded. The page picks the letters
            // up from the `letters-finished` event instead.
            send(res, 200, out);
            writeLettersAfterRun().finally(() => {
              running = false;
            });
            return;
          }
        }
        send(res, 200, out);
        running = false;
        return;
      } catch (err) {
        running = false;
        throw err;
      }
    }

    // Score pending jobs (or re-score everything after a rubric edit).
    // Write a cover letter for one job. Top picks only — a letter costs a model
    // call, and there is no sense spending one on a job you would not apply to.
    if (url.pathname === '/api/letter' && req.method === 'POST') {
      const { id, force = false } = await readBody(req);
      const db = await store.load();
      const job = db.jobs[String(id ?? '')];
      if (!job) return send(res, 404, { ok: false, error: 'No such job.' });

      const score = job.score?.score ?? -1;
      if (score < LETTER_MIN_SCORE) {
        return send(res, 400, {
          ok: false,
          error: `Letters are for top picks only — this scored ${score < 0 ? 'nothing yet' : score}, and the bar is ${LETTER_MIN_SCORE}.`,
        });
      }
      if (job.letter && !force) return send(res, 200, { ok: true, letter: job.letter, cached: true });

      try {
        const { portfolio, exclusions, letterPrompt, letterSamples } = await profile.readAll();
        const { writeLetter } = await import('./judge/letter.js');
        job.letter = await writeLetter(job, { portfolio, exclusions, letterPrompt, letterSamples });
        await store.save(db);
        return send(res, 200, { ok: true, letter: job.letter });
      } catch (err) {
        return send(res, 200, { ok: false, error: err.message });
      }
    }

    if (url.pathname === '/api/score' && req.method === 'POST') {
      if (running) return send(res, 409, { ok: false, output: 'Something is already running.' });
      running = true;
      try {
        const { limit = 20, rescore = false } = await readBody(req);
        const args = [path.join(ROOT, 'src', 'score.js'), `--limit=${Number(limit) || 20}`];
        if (rescore) args.push('--rescore');
        return send(res, 200, await runScript(args, rescore ? 'Re-scoring' : 'Scoring'));
      } finally {
        running = false;
      }
    }

    if (url.pathname === '/api/fetch' && req.method === 'POST') {
      if (running) return send(res, 409, { ok: false, output: 'A fetch is already running.' });
      running = true;
      try {
        const params = await readBody(req);
        const result = await runFetch(params);
        return send(res, 200, result);
      } finally {
        running = false; // always clears, even if the run throws
      }
    }

    // Let the Electron shell write into the activity log, so notification
    // failures are visible in the app rather than only on a console nobody sees.
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const { message, level } = await readBody(req);
      if (message) {
        scheduler.note(String(message).slice(0, 300), level === 'error' || level === 'warn' ? level : 'info');
        broadcast({ type: 'schedule', state: scheduler.getState() });
      }
      return send(res, 200, { ok: true });
    }

    // Fire a notification on demand. The only way to tell "no runs finished yet"
    // apart from "notifications are broken" is to raise one deliberately.
    if (url.pathname === '/api/notify-test' && req.method === 'POST') {
      scheduler.note('Test notification requested');
      broadcast({ type: 'test' });
      return send(res, 200, { ok: true });
    }

    // --- which model judges, and with what key ---
    if (url.pathname === '/api/llm' && req.method === 'GET') {
      const cfg = await llm.readConfig();
      // Never hand the whole key back to the page. Enough to show which key is
      // saved, not enough to be worth leaking.
      const keys = Object.fromEntries(
        Object.entries(cfg.keys).map(([k, v]) => [k, v ? { set: true, preview: `…${v.slice(-4)}` } : { set: false }]),
      );
      const resolved = await llm.resolve();
      return send(res, 200, {
        provider: cfg.provider,
        models: cfg.models,
        keys,
        // resolve() also honours an older GEMINI_API_KEY in .env, so the page can
        // say "ready" for a setup that never used this screen.
        ready: Boolean(resolved.key),
        activeModel: resolved.model,
        providers: llm.catalogue(),
      });
    }

    if (url.pathname === '/api/llm' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = { provider: body.provider, models: body.models ?? {}, keys: {} };
      // A blank key field means "leave it alone", not "erase it" — the page
      // never receives the real key, so it cannot send it back unchanged.
      for (const [id, value] of Object.entries(body.keys ?? {})) {
        if (typeof value === 'string' && value.trim()) patch.keys[id] = value.trim();
      }
      await llm.writeConfig(patch);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/llm/test' && req.method === 'POST') {
      const { provider, model, key } = await readBody(req);
      return send(res, 200, await llm.testConnection({ provider, model, key }));
    }

    // --- schedule ---
    if (url.pathname === '/api/schedule' && req.method === 'GET') {
      return send(res, 200, scheduler.getState());
    }

    if (url.pathname === '/api/schedule' && req.method === 'POST') {
      const next = await scheduler.setConfig(await readBody(req));
      broadcast({ type: 'schedule', state: next });
      return send(res, 200, next);
    }

    // Fire a scheduled-shape run now, without waiting for the next slot. Used
    // by the tray menu and the Schedule tab's "Run now".
    if (url.pathname === '/api/schedule/run-now' && req.method === 'POST') {
      if (running) return send(res, 409, { ok: false, error: 'Something is already running.' });
      const { limit, maxRunMinutes } = scheduler.getState().config;
      const startedAt = new Date().toISOString();
      scheduler.note('▶ Starting run (you pressed Run now)');
      // Deliberately not awaited: a run takes minutes and the caller only needs
      // to know it started. Progress arrives on /api/status and /api/events.
      scheduledRun({ limit, timeoutMs: (maxRunMinutes ?? 45) * 60_000 })
        .then((result) => scheduler.recordRun(result, { startedAt }))
        .catch(() => {});
      return send(res, 200, { ok: true, started: true });
    }

    // Re-evaluate the schedule immediately — the shell calls this on wake from
    // sleep, when timers that should have fired arrive in an unpredictable clump.
    if (url.pathname === '/api/schedule/refresh' && req.method === 'POST') {
      scheduler.refresh();
      return send(res, 200, scheduler.getState());
    }

    // Event stream: run-finished, attention, schedule.
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'schedule', state: scheduler.getState() })}\n\n`);
      clients.add(res);
      // Proxies and idle sockets drop a silent stream; a comment line every 25s
      // costs nothing and keeps it open.
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* cleaned up by the close handler below */
        }
      }, 25_000);
      req.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return undefined;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, await readFile(UI_FILE, 'utf8'), 'text/html; charset=utf-8');
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

/**
 * Flush the scheduler's log before dying.
 *
 * The shell kills this process on quit, and the activity log is written on a
 * few-seconds debounce — so without this the last lines before a quit, which
 * are usually the ones you want to read afterwards, would never reach disk.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await scheduler.stop();
    process.exit(0);
  });
}

// A stale instance holding the port would otherwise keep serving old code
// while the new one dies silently — fail loudly instead.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — another copy is probably running.`);
    console.error(`  Stop it with:  lsof -ti :${PORT} | xargs kill -9\n`);
  } else {
    console.error('\n  Server error:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, async () => {
  console.log(`\n  Upwork Agent UI  →  http://localhost:${PORT}\n`);
  console.log('  Ctrl+C to stop.\n');

  const state = await scheduler.start({
    trigger: ({ limit, timeoutMs }) => scheduledRun({ limit, timeoutMs }),
    // The scheduler must see manual runs too, or a slot could fire straight
    // into a fetch you started yourself and fight over the same Chrome profile.
    isBusy: () => running,
    onChange: (next) => broadcast({ type: 'schedule', state: next }),
  });

  if (state.config.enabled) {
    const next = state.nextRunAt ? new Date(state.nextRunAt).toLocaleString() : 'never';
    console.log(`  Schedule on — next run ${next}\n`);
  }
});
