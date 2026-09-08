# Decisions

Things that look wrong until you know why, and mistakes worth not repeating. Most were
learned by getting them wrong first.

## Scraping

**Playwright drives a browser it did not launch.** A Playwright-launched Chrome is
fingerprinted as automated and loops on the Cloudflare challenge forever — clicking the
checkbox does nothing. Spawning Chrome as an ordinary process and attaching over CDP
passes.

**Chrome for Testing, never the user's Chrome.** Launching `/Applications/Google Chrome.app`
starts a second app-level instance on their profile — a window appears from nowhere — and
shutting it down over CDP sends `Browser.close`, which quits the whole application and
every tab they had open. The installed Chrome is read for a version number only.

**Headless, with a non-headless user-agent.** `cf_clearance` is bound to the UA, so
announcing `HeadlessChrome` gets challenged on every run.

**Off-screen windows do not work on macOS.** `--window-position=-3000,-3000` is clamped
back on screen (verified: landed at 0,25). This was "fixed" once without checking, and the
window kept appearing.

**Test filters with disjoint result sets.** Page size is always 50 and `sort=recency`
churns a job or two between fetches, so counts and overlap both "prove" that filters work
when they do nothing. A whole set of invented URL parameters was confidently reported as
working this way.

## Scoring

**The model judges, code counts.** Models are unreliable at weighted arithmetic. The
schema asks for coverage, alignment and flags; `score.js` produces the number.

**Unknown preference dimensions are dropped, not zeroed.** A job whose detail page was
private would otherwise be punished for data nobody could read.

**Red flags that restate the maths are ignored.** The model lists "50+ proposals" or "rate
is on the low side" as red flags constantly, and both are already in the preference score.
Capping on them again charged one fact twice — a perfect-coverage job capped at 45 for
being 22 hours old with proposals, which the freshness and competition scores had already
handled.

**The interview gate runs after the detail fetch.** Interviews only exist on the job's own
page. It saves the model call, not the page load. Unknown values never reject — an
unreadable page is not evidence of an interview.

**No fixed-price floor.** Upwork budgets are routinely placeholders; a $10 tag on a real
tracking job means "let's discuss". A floor threw away real work. Low pay still costs
points through the preference score.

**The keyword gate is off.** Measured across real runs it rejected nothing — the Upwork
search query already restricts what comes back — while risking the only failure that
matters: skipping a job worth reading. It only orders the queue now.

Its earlier design was worse than useless: keywords were derived from the *search query*,
five phrases, so the gate had never heard of SEO, Shopify, Tableau or BigQuery and skipped
genuinely relevant jobs. Keywords now come from the portfolio.

**Prefilter the whole queue before applying the limit.** Applying the limit first spent it
on jobs the rules would have rejected for free, leaving good jobs unjudged.

## Cover letters

**Written last, after the notification.** Being early on a posting is worth real score
points, so nothing may sit between a job being scored and the user being told. Letters cost
a model call each and would delay that by minutes. A letter is also only worth writing once
the score is final.

**`/api/run` responds before letters start.** Awaiting them held the HTTP request open for
minutes after the jobs were scored and visible — long enough to trip a client timeout and
report a failed run that had succeeded.

**Questions must be quoted verbatim and are then verified.** The model copies each
instruction out of the posting character-for-character; `verifyQuestions()` checks that
text is actually there and discards anything that is not. An invented question is worse
than none — the user pastes an answer to something nobody asked.

Two independent guards doing different jobs: the **prompt** decides whether something *is*
an application question (responsibilities and rhetorical lines are not), the **verifier**
decides whether it is *really in the posting*.

**Answer, don't hedge.** An earlier version reported gaps — "does not explicitly mention
ClickFunnels", "does not list Power BI, though it lists Tableau". Every one was pedantry
about a tool name where the skill obviously carries, and it made the model hedge in its
answers. Now it answers from the nearest equivalent and says the approach transfers. It may
say the technique carries over; it may not claim to have used the tool.

**Echoed headings are stripped, and the separator matters.** Models open with the job's
role title — "Investment Analyst." The first fix split only on `.!?`, so the model switched
to "Investment Analyst:" and walked straight past it. Now handles `.`, `:`, dashes and a
bare newline. A short but real sentence ("Your GA4 is double-counting.") has a verb and is
left alone.

## Packaging and data

**Data lives outside the app bundle.** `Contents/Resources/app` is code-signed: writing
there invalidates the signature and is wiped by the next update. Job history and the
user's portfolio must outlive the bundle.

**Editing the repo does not change the installed app.** It carries its own copy of the
source. `npm run pack && npm run install-app`, with the app quit first. One "the feature
doesn't work" report was an eight-day-old bundle and a working feature.

**Packaged by hand, not by electron-builder.** electron-builder's output died inside
Electron's own startup on this machine, before any JavaScript ran, reproducibly across
asar on/off, with and without entitlements, and with the signature replaced manually.
`scripts/build-app.cjs` copies `Electron.app` and re-points it instead — which is what
`electron .` does anyway, with fewer moving parts and every step reproducible from a
terminal. (Some of that hunt was chasing a symptom caused by `ELECTRON_RUN_AS_NODE` being
set in the debugging shell — see CLAUDE.md — but the failure outlived that explanation.)

**The browser ships inside the bundle.** Playwright keeps Chrome for Testing in
`~/Library/Caches/ms-playwright`, which exists only on a machine that has already run
`npx playwright install chromium` — i.e. one with Node and this repo. Bundling it costs
~365 MB and is what makes the `.app` something you can hand to someone with no toolchain.

**`.env` does not ship.** Keys are per-machine and set in the app's Judge tab. Baking one
into a bundle would hand your key to anyone you gave the app to.

**Runtime dependencies are derived, not listed.** A hardcoded list goes stale the moment a
dependency is added, and the failure — `ERR_MODULE_NOT_FOUND` — only appears on a machine
without a dev `node_modules`. Adding `@anthropic-ai/sdk` did exactly that. The build now
resolves `dependencies` transitively from `package.json` and then *boots the bundled app to
import its own entry point* before signing, so that class of bug fails at build time.

**`profile.js` writes a `.bak` before every save.** This recovered the user's exclusions
file after a `git checkout ||` fallback fired in a repo where that path was not tracked.

## Interface

**Child stdout is an API.** `parseProgress()` reads `[3/40] Title…`,
`prefiltered out N, M to judge` and the `─── Section ───` banners. Changing those lines
breaks the progress bar with no error.

**Paint the finished state explicitly.** The progress panel used to reset only inside the
poller's `!running` branch, but the request resolves in the same instant the child exits
and `stopPolling()` kills the interval — so no tick ever observed the end and the panel
froze on "judging" forever while the log showed a completed run.

**Wire the controls.** The sort dropdowns, search boxes and every Save button in the
Portfolio tab existed as markup with no handler for some time — changing them did nothing
and edits were silently discarded. Worth auditing markup against handlers after adding UI.

**Drive the real page for UI changes.** There is no test harness. The bundled Playwright
against `localhost:5173` is how the cover-letter heading regression was caught, after
reading the code had suggested it was fine.
