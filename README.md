# Upwork Agent

Watches Upwork for new job postings, judges each one against your portfolio with an LLM, and
ranks them so you only look at what's worth your time.

Runs locally as a macOS app. Nothing is hosted, no Upwork account is logged in, and the browser it
drives stays hidden. It can run on a schedule in the background and tell you when something turns
up.

---

## Quick start

You need a Mac, and about five minutes.

```bash
git clone <this repo> && cd upwork-agent
npm install                      # dependencies + ad-hoc signs the dev Electron
npx playwright install chromium  # the browser it drives (~365 MB, one time)
npm run pack                     # builds "Upwork Agent.app"
npm run install-app              # copies it to /Applications
```

Then open **Upwork Agent** from Applications and do three things:

1. **Judge tab** — pick a model and paste an API key (see below). Press **Test**.
2. **Portfolio tab** — paste your CV or Upwork profile, and list the work you'd turn down.
3. **Fetch & score** — the button in the top right. First run takes a few minutes.

That's it. The **Schedule** tab turns it into something that keeps watching on its own.

### Giving it to someone else

The built app is self-contained — it bundles its own browser and carries no API key — so
`dist/Upwork Agent.app` can be copied to another Mac and it will run with nothing installed. They
open it, add their own key in the Judge tab, and paste their own portfolio.

macOS will warn that it is from an unidentified developer, because the app is ad-hoc signed rather
than notarised (that needs a paid Apple Developer account). Right-click the app → **Open** → **Open**
once, and it never asks again.

---

## Choosing the judge

Every posting is read by a model and scored against your portfolio. Two providers, chosen in the
**Judge** tab — the key is stored on your machine only, and goes nowhere except to the provider.

| | **Google Gemini** | **Anthropic Claude** |
|---|---|---|
| Cost | **Free** (15 requests/min) | Paid, ~a fraction of a cent per job |
| Key from | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Good for | Getting started, high volume | Better judgement on close calls |

**Start with Gemini.** It's free and its scores are reasonable.

**Switch to Claude when the near-misses start costing you.** The hard question isn't "does this
posting mention GA4" — it's "is this the kind of work I actually do, or does it merely use the same
tools." That's a reasoning call, and it's where a stronger model earns its money. Claude runs with
adaptive thinking, so it spends more effort on the ambiguous postings and less on the obvious ones.

Either way, press **Test** after pasting a key. It makes a real round trip, so a key that
authenticates but can't do what the judge needs fails here rather than at 3am.

A `GEMINI_API_KEY` in `.env` or the environment still works if you had one before.

---

## Requirements

- **macOS.** The scheduler, tray and notifications are macOS-specific.
- **Node 20+**, to build. Not needed to *run* the built app.
- Nothing else. The browser is downloaded by `npx playwright install chromium` and bundled into
  the app.

---

## Usage — the app

Open it from Applications. One button — **Fetch & score** — pulls new jobs and judges them in one
pass. The browser stays hidden; it only appears if Cloudflare wants a one-off click.

Four job views:

| Page | What's in it |
|---|---|
| **Top picks** | Recent jobs scoring 60+ — the ones worth acting on |
| **All recent** | Everything posted in the last two days |
| **All jobs** | Every posting ever fetched. Nothing hidden. |
| **Issues** | Anything that failed — rate limits, unreadable job pages, judge errors |

These are **nested slices of one archive, not separate piles**: a top pick also appears in All
recent and in All jobs.

"Recent" means posted within `scoreMaxAgeHours` (48 — two days), the same window the scorer judges,
so a job shown as recent has always actually been judged. Every list sorts newest-first by default
and ties break on recency.

### Where your files live

The app never writes inside its own bundle — that would invalidate its signature and be wiped by
the next build — so everything you own lives outside it:

| | Built app | `npm run ui` (dev) |
|---|---|---|
| Job archive, filters, schedule, API keys | `~/Library/Application Support/upwork-agent/data` | `data/` in the repo |
| Portfolio, rubric, preferences | `~/Library/Application Support/upwork-agent/profile` | `profile/` in the repo |

The `profile/` shipped in the app is only a **seed**, copied out on first run. After that it's
yours, and rebuilding never overwrites it.

Moving an existing dev checkout to the installed app, carry your history over once:

```bash
cp -R data ~/Library/Application\ Support/upwork-agent/
```

Worth doing: `data/chrome-profile` holds the Cloudflare cookies.

---

## Usage — browser instead

If you'd rather use a tab than an app window:

```bash
npm run ui        # then open http://localhost:5173
```

Same app, in a tab. Reads and writes the repo's `data/` and `profile/` rather than Application
Support, so it's the right mode for development. It cannot show notifications — see below.

---

## Notifications

### The menu-bar count

Next to the briefcase in the menu bar, the app shows a number: how many things have turned up
since you last opened it. Top picks when there are any, otherwise new postings. A `⚠` means a run
needs a Cloudflare check. Opening the window clears it.

This exists because a banner is a **transient** thing — it draws for a few seconds and is gone, and
whether it draws at all depends on macOS agreeing to. The count does not: nothing can suppress
`setTitle`, it survives you being away from the desk, and it is still correct an hour later. Treat
the banner as the nudge and the count as the record.

The dock icon carries the same number as a badge.

### Notifications need a signed app

macOS will not display a notification from an unsigned app — Electron 42 moved to Apple's
`UNNotification` API, and an unsigned bundle silently emits `failed` instead of showing anything.
The Electron that npm installs is unsigned, so `npm install` runs `scripts/sign-dev.cjs` to ad-hoc
sign it. That needs no Apple Developer account and no network, and takes about a second.

If notifications ever go quiet, run it again:

```bash
npm run sign
```

Notifications are configured as **alerts**, not banners (`NSUserNotificationAlertStyle` in the
bundle's Info.plist), so they stay on screen until you dismiss or click them. A banner disappears
after about five seconds, which is the wrong behaviour for something reporting on work you were not
watching.

If banners still never appear while the Activity log says `Notification shown`, macOS has accepted
them and decided not to draw them. Check **System Settings → Notifications → Upwork Agent**:
"Allow Notifications" on, and the style set to **Alerts** rather than None. The menu-bar count above
keeps working either way.

---

## Running on a schedule

The **Schedule** tab turns the app into something that watches Upwork for you: pick the days, a
window ("between 09:00 and 18:00"), and how often to run inside it. Runs use whatever is saved on
the Filters tab.

Close the window and the app drops into the menu bar with the schedule still running. The tray
icon shows the next run time and has **Run now**, both toggles below, a **Stop background runs**
item, and **Open at login**, which starts it straight into the menu bar rather than throwing a
window at you on boot.

### What "background" actually means

Two separate switches, because "run every hour" and "keep running after I close the window" are
different wishes:

| Switch | Off | On |
|---|---|---|
| **Enable the schedule** | Nothing runs on its own | Runs on its slots |
| **Keep running after I close the window** | Closing the window quits the app, and the schedule stops with it | Closing the window hides it into the menu bar, schedule intact |

The Schedule tab's **Right now** panel says in plain English which of these three states you are
in, because the combinations are easy to get wrong — a schedule that is on but set to quit with
the window will not fire overnight, and nothing else on the page would tell you.

**Quitting stops everything.** The server is a child process of the app, so there is no run that
survives a quit, a reboot, or a logout. This is a menu-bar agent, not a system daemon. If you want
it back automatically after a restart, turn on **Open at login**.

To stop it without quitting, use **Stop background runs** — in the Schedule tab or the menu bar.

When a run finishes you get a notification — *"12 new jobs · 3 top picks"* — and clicking it opens
the app on Top picks.

**Fifteen minutes is the floor**, clamped in the code and not just the UI. Nothing else in this
project enforced a minimum interval, and a scheduler is where "every 2 minutes, forever" becomes
possible by accident. Freshness stops paying off long before then anyway, and polling that hard is
the realistic way to get your IP blocked.

An end time earlier than the start means the window runs overnight: `22:00` to `06:00` belongs to
the day it *starts* on, so a Friday night window doesn't need Saturday ticked too.

### Everything here is saved

Like the filters, the schedule lives on disk rather than in the browser, so the app window, a
browser tab and the CLI all agree, and a restart changes nothing:

| What | Where |
|---|---|
| Days, window, interval, limit, and every toggle | `data/schedule.json` |
| When it last ran, what that run found, and the activity log | `data/schedule-state.json` |

On startup the Activity log says which happened: `Loaded saved settings from data/schedule.json`,
or `No data/schedule.json found — starting from defaults`. If your settings ever appear to reset,
that line tells you whether the file was missing or the settings simply weren't saved.

The next run time is the one thing deliberately *not* stored — it's recomputed from the clock on
startup, so a schedule can never come back holding a slot that went stale while the app was closed.

### Seeing what it's doing

The Schedule tab has an **Activity** panel: every decision the scheduler makes, newest first —
when it started, when settings changed, when a slot fired, when one was skipped and why. The same
lines print to the terminal you ran `npm start` from, prefixed `[scheduler]`.

A `Waiting — next run 3:00 PM (in 23 min)` line appears every ~5 minutes. That heartbeat is the
useful one: if the gap between two of them is much longer than five minutes, the app was suspended
rather than mis-scheduled. The panel also shows how long ago the timer last ticked, and warns if
that exceeds 90 seconds.

There is also a **Send a test notification** button next to the notify toggle. It raises a real
banner on demand and writes the outcome — `Notification shown`, or the exact failure — into the
same Activity panel, which is the only way to tell "no runs have finished yet" apart from
"notifications are broken".

If a schedule seems not to fire, check in this order:

1. **Is the next run when you think?** Slots are anchored to the *start time*, not to when you
   enabled it. Turning on a `09:00-18:00` schedule at 23:00 means the first run is 09:00 tomorrow.
2. **Does the Right now panel say "Running in the background"?** If it says "only while the app is
   open", closing the window quit the app.
3. **Is the heartbeat advancing?** If not, the process is being suspended — see below.

### How to tell whether it's working

Every run ends in exactly one of these, and each says so in the Activity log **and** in a
notification. Silence after `▶ Starting run` is the only state that means something is wrong,
and it can no longer last more than `maxRunMinutes`.

| Activity line | What it means | Do you need to do anything? |
|---|---|---|
| `■ Run finished — 12 new, 3 top pick(s)` | Worked. Check **Top picks**. | No |
| `■ Run finished — 0 new, 0 top pick(s)` | Worked. Upwork had nothing you hadn't seen. | No |
| `■ Run stopped — Cloudflare wants a check` | Clearance expired. | Press **Fetch & score** once |
| `■ Run gave up after 45 min` | Wedged and was killed; next slot retries. | No, but lower "jobs per run" |
| `Slot due, but a run is already in progress` | The previous run is still going. | Raise the interval |
| `…still running — scoring 8/40, 6 min elapsed` | Healthy progress on a long run. | No |

**New jobs are not the same as top picks.** A run that adds 37 postings adds them to **All jobs**
and **All recent** immediately; they only reach **Top picks** once they're *scored* and clear 60.
If a run fetched but never finished scoring, the jobs are there but ungraded — which looks
exactly like "nothing happened" if you only ever look at Top picks.

**Budget the time.** Scoring costs roughly 15 seconds per job, because each one needs its own page
load for proposal counts and client history. 40 jobs is about 10 minutes. If a run routinely
outlasts your interval, the log says so explicitly and every slot in between gets skipped — raise
the interval or lower "jobs per run".

### App Nap

macOS App Nap doesn't merely idle a background app, it explicitly reduces how often its timers
fire. An app whose only job while hidden is to check a timer every 30 seconds is exactly what it
punishes, and the symptom is a schedule that never runs while the window is closed.

The shell holds a `prevent-app-suspension` power-save blocker whenever background running is on,
and releases it the moment you turn background runs off. It allows the display to sleep and the
machine to idle normally — it only stops *this app* being suspended.

### What it does when you're not there

Two things are deliberately different about an unattended run:

- **It never opens a browser window.** Scheduled runs pass `--no-interactive`. Most Cloudflare
  interstitials clear themselves — the page reloads once or twice and hands over a `cf_clearance`
  cookie with nobody touching it — so an unattended run waits up to 90 seconds for that before
  giving up. Only a challenge that genuinely wants a click stops the run, and then you get a
  *"needs a moment"* notification rather than Chrome appearing at 3am. Open the app, press
  **Fetch & score** once, and every later scheduled run reuses that clearance until it expires.
  (An attended run waits 20 seconds the same way before opening a window, so there are fewer
  surprise windows there too.)
- **A missed slot is judged on the window, not on how late it is.** Sleep through the 10:00 slot
  and wake at 15:00 inside an 08:00–18:00 window and it runs once, because those postings are real
  and still fresh. Sleep through an 08:00–09:00 window entirely and it skips to tomorrow, because
  a scrape at 15:00 is one you said you didn't want. Missed slots are never queued up and replayed
  back to back.

Timing is wall-clock rather than elapsed-time: macOS throttles timers in background processes, so
the scheduler compares `Date.now()` against a precomputed slot on a 30-second tick instead of
chaining intervals that would drift and then stay drifted. It also re-checks the moment the machine
wakes from sleep.

---

### What reaches the model, and what doesn't

Two rules run before a model call is made. Rejections are free — no API call, no page load —
and are recorded, so a job is only ever rejected once.

| Rule | Default | Set in |
|---|---|---|
| Under your pay floor | $25/hr, $250 fixed | `hourly.floor`, `fixed.floor` |
| Older than two days | 48 hours | `scoreMaxAgeHours` |

**Nothing is skipped for being off-topic.** There is a keyword gate (`minRelevance`) and it is
**off by default**, because measuring it on real runs showed it saved nothing: your Upwork
search query already restricts what comes back, so every fetched job passed the gate anyway
(51 of 51, at every threshold). All it could still do was skip a job worth reading — and that
failure costs far more than the model call it saves. Whether a job fits is the judge's call;
the gate only ever decided whether to ask.

Turn it up only if you start running broad, keyword-free searches and need to cap AI usage.
A keyword scores 3 in the title, 1.5 in the skill tags, 0.5 in the body — so `1.5` means "a
keyword in the title or skills" and `0.5` means "a keyword anywhere".

### Keywords

`profile/keywords.md` is read from your portfolio by pattern matching — Upwork's skill
separators, capitalised runs, and technical-looking tokens. **No AI**, in keeping with the rest
of the profile handling. It seeds itself on first run, and **Portfolio → Rebuild from my
portfolio** regenerates it after you edit your profile. The file is yours to edit; a term you
delete stays deleted.

With the gate off, keywords are used only to decide **what gets judged first** — being early on
a posting is worth real points, so the closest matches shouldn't wait behind weaker ones.

**Fetch often.** Freshness and proposal count carry real weight: the same job that rates 70 in
its first hour rates 45 once it's a day old with 50 proposals in.

### Why old jobs stay unscored

New jobs keep arriving, so without an age cap yesterday's postings would sit at the back of the
queue forever and the unscored pile would only grow. Postings older than
`scoreMaxAgeHours` (48 by default, in `profile/preferences.json`) are skipped instead: by then
they've collected proposals and a score wouldn't change what you do. They still appear in
**All jobs**, just ungraded.

To judge everything anyway, including old postings:

```bash
node src/score.js --all --limit=250
```

Under the hood it runs the same local server and the same `src/fetch.js`; the window is just a shell
around it. Closing the window shuts the server down too — unless a schedule is enabled, in which
case it keeps running in the menu bar and **Quit** from the tray menu is what stops it.

---

## Usage — command line

```bash
node src/run.js                    # fetch + score, using the saved filters
node src/run.js --q="GA4"          # override them for one run
node src/fetch.js                  # fetch only
node src/score.js --limit=50       # judge whatever is pending
node src/score.js --rescore        # re-judge after editing your portfolio
node src/fetch.js --url="<paste any Upwork search URL>"
```

### Flags

Run `node src/fetch.js --help` for the generated list with all valid values.

**No filter is applied unless you set it.** Only `sort=recency`, `per_page=50` and `page=1` have defaults.

| Flag | Values | Notes |
|---|---|---|
| `--q=` | keywords | supports AND / OR / NOT and quoted phrases |
| `--location=` | `Americas,Europe,Asia,Africa,Oceania,Middle East` or country names | |
| `--category2_uid=` | Upwork category id | 12 categories, pick from the app |
| `--subcategory2_uid=` | Upwork subcategory id | 64 of them, scoped to the chosen category |
| `--timezone=` | Upwork's IANA ids, e.g. `America/Nome` | 72 options |
| `--t=` | `0` hourly, `1` fixed | auto-set from the rate filters below |
| `--hourly_rate=` | `10-50`, `40-` ($40+), `-50` (up to $50) | implies `t=0` |
| `--amount=` | `0-99`, `100-499`, `500-999`, `1000-4999`, `5000-` | implies `t=1` |
| `--contractor_tier=` | `1` entry, `2` intermediate, `3` expert | |
| `--client_hires=` | `0` none, `1-9`, `10-` | |
| `--duration_v3=` | `week`, `month`, `semester`, `ongoing` | <1mo / 1-3mo / 3-6mo / 6mo+ |
| `--workload=` | `as_needed` (<30 hrs/wk), `full_time` (30+) | |
| `--contract_to_hire=` | `true` | |
| `--per_page=` `--page=` `--sort=` | | paging and ordering |
| `--no-interactive` | | never open a window for a Cloudflare check; exit 3 instead |

Multiple values are comma-separated: `--location="Americas,Europe"`.
Combine an hourly and a fixed filter to search both types at once (`t` becomes `0,1`).

Two quirks worth knowing:

- **`hourly_rate` matches overlapping ranges, not minimums.** `--hourly_rate=40-` returns a
  `$20-65/hr` job, because its top end clears $40. That's Upwork's behavior, not a bug here.
- **`proposals` and `payment_verified` are not supported.** Those filters exist in Upwork's
  logged-in search but are silently ignored by the public search this uses — tested and confirmed,
  so they're deliberately left out rather than shipped as flags that do nothing.

Unrecognized flags are reported rather than ignored, since Upwork itself would just drop them.

**Easiest way to build a filter:** set the filters you want on the Upwork search page in a normal
browser, copy the URL, and pass it with `--url=`.

## The Cloudflare bit

Upwork sits behind Cloudflare. A plain HTTP request gets a `403` challenge page, so this uses a real
Chrome browser instead.

**Runs stay invisible, and your own Chrome is never touched.** The browser driven here is
Playwright's bundled *Chrome for Testing*, a separate app bundle — not the Chrome you browse with.
Launching your installed Chrome on macOS quietly starts a second app-level instance using your
normal profile (a window appears from nowhere), and shutting it down can quit the whole Chrome
application, closing the tabs you had open. Your installed Chrome is only ever read for its version
number, to build the user-agent string.

It runs headless with a normal (non-headless) user-agent — the saved `cf_clearance` cookie is bound
to the UA, so announcing "HeadlessChrome" would get challenged every time. It's spawned as an
ordinary process and attached to over its debugging port, because a Playwright-*launched* browser
gets fingerprinted as automated and loops on the challenge forever.

Clearance expires after a few hours and is tied to your IP. When that happens the run detects it,
opens a real window **just for that click**, waits for you, then goes back to hidden. `--visible`
forces a window if you want to watch.

(On macOS, `--window-position=-3000,-3000` does not hide a window — the OS clamps it back on-screen.
Headless is the only thing that actually works.)

## Known limits

- **50 jobs per page.** Upwork's maximum; use `--page=2` to go further back.
- **Client details cost a page load.** Proposal counts, client spend, hires and history only exist on
  each job's own page, so scoring fetches them one at a time (~10-20s per job). That's what makes
  scoring slow, not the AI.
- **Upwork's `hourly_rate` filter matches overlapping ranges**, so `40-` still returns a `$20-65/hr`
  job. Your own pay floor in `preferences.json` is the strict one.
- Automated scraping is against Upwork's Terms of Service. No Upwork account is logged in here, so the
  realistic risk is an IP-level block rather than an account ban. Polling very frequently raises that
  risk, which is why the scheduler clamps to a 15-minute floor. Nothing stops you running `fetch.js`
  in a loop yourself, though.
