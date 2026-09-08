# Working on Upwork Agent

Local desktop app: scrapes Upwork's public job search, judges each posting against the
user's portfolio with an LLM, and writes cover letters for the best ones. Electron shell
around a plain Node HTTP server and a single-file UI.

`README.md` is the user manual. This file is the engineering context — the things that
are expensive to re-derive and easy to get wrong.

## The one that will catch you out

**The user runs the installed app at `/Applications/Upwork Agent.app`, which carries its
own copy of the source.** Editing this repo changes nothing they can see. Restarting the
app changes nothing either.

```bash
osascript -e 'quit app "Upwork Agent"'   # install onto a running bundle fails
npm run pack && npm run install-app
```

This has already caused one "the feature doesn't work" report where the feature was fine
and the app was eight days old. If a change should be visible and isn't, check
`/Applications/Upwork Agent.app/Contents/Resources/app/` before debugging anything else.

## Where the data actually is

`src/paths.js` resolves everything. The packaged app sets env vars; a dev checkout falls
back to the repo.

| | Dev checkout | Installed app |
|---|---|---|
| Data | `./data/` | `~/Library/Application Support/upwork-agent/data/` |
| Profile | `./profile/` | `~/Library/Application Support/upwork-agent/profile/` |
| API key | `./.env` | `~/Library/Application Support/upwork-agent/.env` |

**The repo has no `data/` directory** — it is gitignored and the packaged app never uses
it. To operate on the user's real data from the CLI, export the three env vars first
(`UPWORK_AGENT_DATA_DIR`, `UPWORK_AGENT_PROFILE_DIR`, `UPWORK_AGENT_ENV_FILE`) or you will
silently read an empty store.

**Never delete anything under those directories.** `jobs.json` is months of scored history
and `profile/` is the user's own writing. Both have been nearly lost once. `profile.js`
writes a `.bak` before every save — that is what recovered `exclusions.md` after a bad
`git checkout ||` fallback in a repo that is not a git checkout for that path.

## Architecture

```
fetch.js    one search → Upwork → window.__NUXT__ → normalize → store
score.js    unscored jobs → prefilter → detail page → LLM → deterministic maths
letters.js  top picks → LLM → job.letter
server.js   HTTP + SSE, spawns the three above as child processes
scheduler.js cron-ish windows, drives server.js's scheduledRun
```

The three scripts are independent CLIs. The server shells out to them rather than
importing, so the UI and the terminal exercise identical paths. Progress is parsed out of
child stdout by `parseProgress()` — **the log lines are an interface.** Changing
`[3/40] Title…`, `prefiltered out N, M to judge`, or `─── Scoring ───` breaks the progress
bar silently.

### Run order, which is deliberate

```
fetch → score → broadcast run-finished (shell notifies) → letters
```

Letters come last and never block. Being early on a posting is worth real score points, so
nothing may sit between a job being scored and the user being told. `/api/run` sends its
HTTP response before letters start — awaiting them held the request open for minutes and
tripped client timeouts on a run that had actually succeeded.

## Scoring

`judge/index.js` orchestrates; `judge/score.js` does the arithmetic. **The model returns
judgments, code does the maths** — models are unreliable at weighted sums.

Two gates, at different stages, for a reason:

- `prefilter()` — pay floor, age. Runs before anything, costs nothing.
- `activityGate()` — client already interviewing. Can only run *after* the detail page,
  because that is the only place the number exists. Saves the model call, not the page load.

`minRelevance` (keyword gate) is **0 / off**. Measured on real runs it rejected nothing —
the Upwork query already filters — while risking the one failure that matters, skipping a
job worth reading. Keywords now only order the judging queue. Raise it only for broad,
keyword-free searches.

Red flags that merely restate competition, pay, freshness or client history are dropped
before the hard caps (`substantiveFlags()`). The model names "50+ proposals" as a red flag
constantly, and those numbers are already in the preference score — capping on them again
charged a job twice for one fact.

## The browser

Upwork is behind Cloudflare. Plain HTTP gets a 403 challenge page.

- **Playwright's bundled Chrome for Testing**, spawned as an ordinary process and attached
  to over CDP (`connectOverCDP`). A Playwright-*launched* browser is fingerprinted and
  loops on the challenge forever.
- **Never launch or kill the user's Chrome.** `/Applications/Google Chrome.app` starts a
  second app-level instance on their profile, and closing it over CDP quits the whole
  application and their tabs. `browser.js` kills its own process with SIGKILL; SIGTERM
  triggers Chrome's graceful app-quit path.
- Headless with a **non-headless user-agent** — `cf_clearance` is bound to the UA.
- `--window-position=-3000,-3000` does not hide a window on macOS. The OS clamps it back
  on screen. Headless is the only thing that works.
- Ports: fetch 9222 (9223 for the visible challenge fallback), scoring 9223.

- **A leftover Chrome poisons the next run.** Chrome refuses two instances on one
  `--user-data-dir`: a second launch hands its command line to the first and exits. The
  spawned handle then points at a dead launcher, so `close()` kills nothing, the CDP
  socket stays open, and Node cannot exit — a fetch that saved all 50 jobs and then hung
  for 45 minutes, blocking every later slot behind "a run is already in progress".
  `openBrowser()` clears the port before spawning and `close()` disconnects the socket
  *before* killing; `fetch.js` and `score.js` also force-exit 2s after their work is done,
  because an unattended run has nobody to notice a stray handle.

When testing, `pkill -9 -f "chrome-profile"` — matching on "Google Chrome" kills the
user's browser.

## The desktop shell

Five traps, each of which produced a silent or misleading failure.

**`ELECTRON_RUN_AS_NODE=1` in your environment breaks every manual launch.** It makes the
Electron binary behave as plain Node, so `require('electron')` returns a *path string* and
`app` is undefined. The app exits 0 with no output, which reads exactly like a crash in
your own code. Claude Code is itself an Electron app and exports this, so an agent
debugging here will hit it. Always launch with `env -u ELECTRON_RUN_AS_NODE …`. Hours were
lost chasing a phantom `codesign_util / task_name_for_pid` error that was only ever this.

**macOS grants notification permission per bundle id, and only to installed apps.**
`npm start` runs as `com.github.Electron` — the identity shared by every Electron dev app —
from inside `node_modules`. Notifications there are *accepted by the API and never
displayed*: the log says `Notification shown` and nothing appears. Only the packaged app in
`/Applications`, with its own id, can notify. Electron 42+ also needs the bundle signed at
all (UNNotification), which is what `scripts/sign-dev.cjs` is for.

**`app.isPackaged` is decided by the executable's *filename*.** Leave it named `Electron`
and a real installed app believes it is a dev checkout, and writes job history inside its
own signed bundle. `build-app.cjs` renames it to the product name.

**App Nap throttles the scheduler.** It does not merely idle a hidden app, it explicitly
reduces how often its timers fire — precisely fatal for something whose whole job while
hidden is a 30-second tick. The shell holds a `prevent-app-suspension` blocker whenever
background running is on, and releases it when it is off.

**The single-instance lock cannot be load-bearing.** Electron arbitrates it by comparing
code signatures; an ad-hoc signed build fails that check and `requestSingleInstanceLock()`
returns false on a machine where nothing else is running. Quitting on that turned every
launch into an immediate silent exit. It is advisory here; `portInUse()` handles a real
second copy.

## Verifying scraper changes

Compare **disjoint result sets**, never counts. Page size is always 50, and `sort=recency`
churns one or two jobs between fetches, so both counts and overlap will happily "prove" a
filter works when it does nothing. This produced a confident and completely wrong report
that nonsense URL params were being applied.

## Conventions

- ESM, Node 20+, two runtime deps (`playwright`, `@anthropic-ai/sdk`). Keep it that way —
  no build step is a feature.
- `src/ui/index.html` is one file: markup, CSS and JS. No framework, no bundler.
- Comments explain *why*, especially where the obvious approach was tried and failed.
  Most of this file's content came from those comments.
- LLM output is never trusted structurally. Verify it in code — see `verifyQuestions()`,
  which discards any client question whose verbatim quote is not literally in the posting.

## Checks worth running

```bash
node --check src/<file>.js
node -e "const h=require('fs').readFileSync('src/ui/index.html','utf8');new Function(h.match(/<script>([\s\S]*)<\/script>/)[1])"
```

Launching the built app to check something:

```bash
env -u ELECTRON_RUN_AS_NODE "/Applications/Upwork Agent.app/Contents/MacOS/Upwork Agent"
```

The UI has no test harness, so drive the real page with the bundled Playwright when
changing it — that is how a regression in the cover-letter heading strip was caught after
the code review passed. Import it by absolute path from `node_modules/playwright/index.mjs`
when running scripts outside the repo root.
