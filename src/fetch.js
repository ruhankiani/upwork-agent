import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA_DIR, dataFile } from './paths.js';
import { openBrowser, isChallenged } from './browser.js';
import { FILTERS, buildSearchUrl, describeFilters, helpText } from './search-url.js';
import * as store from './store.js';

const PROFILE_DIR = dataFile('chrome-profile');
const OUT_DIR = DATA_DIR;
// Fixed filenames — each run replaces the previous one.
const LATEST_TXT = path.join(OUT_DIR, 'latest-jobs.txt');
const LATEST_JSON = path.join(OUT_DIR, 'latest-jobs.json');
const FILTERS_FILE = path.join(OUT_DIR, 'filters.json');
const DEBUG_JSON = path.join(OUT_DIR, 'debug-capture.json');
const DEBUG_HTML = path.join(OUT_DIR, 'debug-page.html');
const CDP_PORT = 9222;

const args = process.argv.slice(2);
// Runs hidden by default; --visible opens a real window (only needed for debugging).
const VISIBLE = args.includes('--visible');
// Scheduled runs pass --no-interactive: nobody is watching, so a Cloudflare
// challenge must fail fast instead of opening a window from nowhere and
// blocking for three minutes. The caller turns the exit code into a "needs a
// quick check" notification.
const NO_INTERACTIVE = args.includes('--no-interactive');
const DEBUG = args.includes('--debug');

if (args.includes('--help') || args.includes('-h')) {
  console.log(helpText());
  process.exit(0);
}

const arg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

// Collect every --key=value into a params object, then let search-url.js decide
// what is a real Upwork filter. Unknown keys are reported rather than silently
// dropped — Upwork ignores params it doesn't recognize, so a typo would
// otherwise look like a filter that simply had no effect.
const PARAMS = {};
const UNKNOWN = [];
for (const a of args) {
  const m = /^--([a-zA-Z_0-9]+)=(.*)$/.exec(a);
  if (!m) continue;
  const [, key, value] = m;
  if (key === 'url') continue;
  if (key in FILTERS) PARAMS[key] = value;
  else UNKNOWN.push(key);
}

const SEARCH_URL = arg('url') ?? buildSearchUrl(PARAMS);

/**
 * Walk an arbitrary JSON value looking for the array of job postings.
 * Upwork's internal payloads nest the list at different depths, so instead of
 * hardcoding a path we look for the first array whose objects carry the fields
 * a job posting always has.
 */
function findJobArray(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    if (value.length && looksLikeJob(value[0])) return value;
    for (const item of value) {
      const found = findJobArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    const found = findJobArray(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function looksLikeJob(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = new Set(Object.keys(o));
  const hasTitle = keys.has('title');
  const hasId = keys.has('ciphertext') || keys.has('uid') || keys.has('id');
  const hasJobish =
    keys.has('description') ||
    keys.has('createdOn') ||
    keys.has('publishedOn') ||
    keys.has('amount') ||
    keys.has('hourlyBudget') ||
    keys.has('hourlyBudgetMin') ||
    keys.has('jobType') ||
    keys.has('type');
  return hasTitle && hasId && hasJobish;
}

function pick(o, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'object' ? Number(v.amount ?? v.rawValue ?? v.min ?? NaN) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * When a search query is present, Upwork wraps matched terms in
 * <span class="highlight"> inside title and description. Strip the markup and
 * decode the handful of entities it emits.
 */
const stripHtml = (v) => {
  if (typeof v !== 'string') return v;
  return v
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
};

/** Upwork encodes 0 to mean "not specified" for both budget shapes. */
const money = (v) => {
  const n = num(v);
  return n && n > 0 ? n : null;
};

/** "jsn_Intermediate_206" -> "Intermediate"; "usnuxt_Engagement_421.partTime" -> "part time" */
const unprefix = (v) => {
  if (typeof v !== 'string') return null;
  const tail = v.includes('.') ? v.split('.').pop() : v.split('_')[1];
  if (!tail) return null;
  return tail.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
};

/** Normalize one raw posting into the shape the rest of the tool will use. */
function normalize(raw) {
  const ciphertext = pick(raw, 'ciphertext', 'uid', 'id');
  const client = raw.client ?? raw.buyer ?? {};
  // type 1 = fixed-price, 2 = hourly
  const isHourly = raw.type === 2;

  return {
    id: String(ciphertext ?? ''),
    title: stripHtml(pick(raw, 'title')),
    url: ciphertext
      ? `https://www.upwork.com/jobs/${String(ciphertext).startsWith('~') ? '' : '~'}${ciphertext}`
      : null,
    description: stripHtml(pick(raw, 'description')),
    jobType: isHourly ? 'hourly' : 'fixed',
    hourlyMin: money(raw.hourlyBudget?.min),
    hourlyMax: money(raw.hourlyBudget?.max),
    budget: money(raw.amount?.amount),
    experienceLevel: unprefix(pick(raw, 'tierText', 'tier', 'contractorTier')),
    engagement: unprefix(raw.engagement),
    duration: pick(raw, 'durationLabel', 'duration'),
    skills:
      (pick(raw, 'attrs', 'skills', 'ontologySkills') ?? [])
        .map?.((s) => (typeof s === 'string' ? s : (s?.prettyName ?? s?.name ?? s?.prefLabel)))
        .filter(Boolean) ?? [],
    proposals: unprefix(pick(raw, 'proposalsTier')) ?? pick(raw, 'totalApplicants'),
    // NOTE: the search-list payload leaves all client fields null. Populating
    // these needs a per-job detail fetch — deliberately not done here.
    clientCountry: pick(client, 'location.country', 'country'),
    clientSpend: money(pick(client, 'totalSpent', 'totalCharges')),
    clientRating: num(pick(client, 'totalFeedback', 'feedback')),
    clientReviews: num(pick(client, 'totalReviews')),
    clientPaymentVerified: client.isPaymentVerified ?? null,
    postedAt: pick(raw, 'publishedOn', 'createdOn', 'renewedOn'),
    raw,
  };
}

function fmtBudget(j) {
  if (j.hourlyMin || j.hourlyMax) {
    if (j.hourlyMin && j.hourlyMax) return `$${j.hourlyMin}-${j.hourlyMax}/hr`;
    return `$${j.hourlyMin ?? j.hourlyMax}/hr`;
  }
  if (j.budget) return `$${j.budget} fixed`;
  return j.jobType === 'hourly' ? 'hourly, rate n/a' : 'budget n/a';
}

function fmtAge(iso) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return null;
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/**
 * Render the run as text. Returned rather than printed so the same content can
 * go to both the terminal and the report file.
 */
function render(jobs, meta) {
  // `total` lets the terminal preview show the real count while rendering a slice.
  const total = meta.total ?? jobs.length;
  const out = [];
  out.push(`Upwork fetch — ${new Date().toLocaleString()}`);
  out.push(meta.searchUrl);
  out.push(`Found ${total} job${total === 1 ? '' : 's'}`);
  out.push('');

  for (const j of jobs) {
    const line = [fmtBudget(j), j.experienceLevel, j.duration, j.engagement, fmtAge(j.postedAt)]
      .filter(Boolean)
      .join(' · ');

    out.push(`  ${j.title ?? '(no title)'}`);
    out.push(`    ${line}`);
    if (j.skills?.length) out.push(`    ${j.skills.slice(0, 8).join(', ')}`);
    if (j.description) {
      const d = j.description.replace(/\s+/g, ' ').trim();
      out.push(`    ${d.slice(0, 200)}${d.length > 200 ? '…' : ''}`);
    }
    out.push(`    ${j.url ?? '(no url)'}`);
    out.push('');
  }
  return out.join('\n');
}


/**
 * Load one search URL and pull the postings out of it.
 *
 * Split out of main() so several searches can share a single browser: launching
 * Chrome is the slow part, and a fresh launch per search would also mean
 * re-proving the Cloudflare clearance each time.
 */
async function scrapeSearch(page, url, captured) {
  captured.length = 0; // per-search, so we don't pick up the previous one's jobs
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await page
    .waitForSelector('[data-test="JobTile"], article[data-ev-label], [data-test="job-tile-list"]', {
      timeout: 30_000,
    })
    .catch(() => console.log('  (job tiles not detected in DOM — relying on captured JSON)'));
  await page.waitForTimeout(3000);

  // Upwork's search page is Nuxt and server-renders the results into
  // window.__NUXT__, so the postings are in the page state rather than an XHR.
  // Read that first; fall back to any captured JSON response (pagination and
  // filter changes do go over the wire).
  const candidates = [];
  try {
    const nuxt = await page.evaluate(() => window.__NUXT__ ?? null);
    if (nuxt) candidates.push({ url: 'window.__NUXT__', body: nuxt });
  } catch {
    /* state not exposed */
  }
  candidates.push(...captured);

  let jobs = [];
  let sourceUrl = null;
  for (const cap of candidates) {
    const arr = findJobArray(cap.body);
    if (arr && arr.length > jobs.length) {
      jobs = arr;
      sourceUrl = cap.url;
    }
  }
  return { jobs: jobs.map(normalize), sourceUrl };
}

async function main() {
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  if (UNKNOWN.length) {
    console.log(`\n⚠️  Not a recognized Upwork filter, ignoring: ${UNKNOWN.join(', ')}`);
    console.log('   Run with --help to see the full list.');
  }

  // One search per run. Three ways to say what it is, most specific first:
  //   --url=…               a URL copied from a browser
  //   --q=… / --location=…  built from flags
  //   (nothing)             the filters saved in the app
  let params = PARAMS;
  if (!arg('url') && !Object.keys(params).length) {
    params = await readFile(FILTERS_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
  }
  const searches = [
    arg('url')
      ? { name: 'custom URL', url: arg('url') }
      : { name: describeFilters(params) || 'all newest jobs', url: buildSearchUrl(params) },
  ];
  if (!arg('url')) console.log(`\nFilters:\n  ${describeFilters(params)}`);

  // One hidden, headless browser for all of them. Nothing appears on screen. If
  // Cloudflare wants a click we reopen visibly further down, only then.
  console.log('Starting Chrome (hidden)...');
  let session;
  try {
    session = await openBrowser({ port: CDP_PORT, visible: VISIBLE });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  let { context } = session;

  // Chrome is a real OS process, so it has to be killed even when something
  // throws — otherwise a failed run leaves it running in the background.
  try {
    // Every JSON response the page fetches, kept so we can find the jobs payload
    // and so `--debug` can show what endpoints Upwork actually calls.
    const captured = [];

    context.on('response', async (res) => {
      const url = res.url();
      if (!/upwork\.com/.test(url)) return;
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      try {
        const body = await res.json();
        captured.push({ url, status: res.status(), body });
        if (DEBUG) console.log(`  [xhr] ${res.status()} ${url}`);
      } catch {
        /* non-JSON or already-consumed body */
      }
    });

    // Reuse Chrome's existing blank tab if there is one, so we don't leave a stray window.
    let page = context.pages()[0] ?? (await context.newPage());

    // Clear Cloudflare once, on the first search, rather than per search.
    console.log(`\nOpening ${searches[0].url}`);
    await page.goto(searches[0].url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // The challenge page reloads itself, which destroys the JS execution context,
    // so this polls from the Node side rather than evaluating inside the page.
    let isChallenge = () => isChallenged(page);

    if (await isChallenge()) {
      /**
       * Poll until the interstitial goes away, or the time runs out.
       *
       * Reads `page` and `isChallenge` fresh each loop because swapping to a
       * visible browser below reassigns both.
       */
      const settle = async (ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          await page.waitForTimeout(2000);
          if (!(await isChallenge())) return true;
        }
        return false;
      };

      // Most interstitials clear themselves: the page reloads once or twice and
      // hands over a cf_clearance cookie with nobody touching it. Only some
      // actually want a click. Waiting first is what makes an unattended run
      // viable — bailing the moment one appears gave up on challenges that would
      // have resolved in ten seconds. It also means fewer surprise windows in
      // the attended case.
      console.log('\n⚠️  Cloudflare interstitial — waiting for it to clear itself…');
      let cleared = await settle(NO_INTERACTIVE ? 90_000 : 20_000);

      if (cleared) {
        console.log('   ✅ Cleared on its own.\n');
      } else if (NO_INTERACTIVE) {
        // NEEDS_ATTENTION is parsed by the server to notify you; keep it stable.
        console.log('\n⚠️  NEEDS_ATTENTION cloudflare — this one wants a click.');
        console.log('   Nobody is watching a scheduled run, so this stops here rather than');
        console.log('   opening a browser window you did not ask for. Open the app and press');
        console.log('   Fetch & score once to clear it — the clearance is then reused by');
        console.log('   every scheduled run until it expires.\n');
        await session.close().catch(() => {});
        process.exit(3);
      } else {
        if (VISIBLE) {
          console.log('\n⚠️  Cloudflare challenge — solve it in the open window.');
        } else {
          // Headless can't be clicked, so swap to a real window just for this.
          console.log('\n⚠️  Cloudflare needs a one-off check. Opening a window…');
          await session.close();
          session = await openBrowser({ port: CDP_PORT + 1, visible: true });
          context = session.context;
          page = context.pages()[0] ?? (await context.newPage());
          await page.goto(searches[0].url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          isChallenge = () => isChallenged(page);
        }
        console.log('   Click the checkbox if one appears. Waiting up to 3 minutes…\n');
        cleared = await settle(180_000);
        console.log(cleared ? '   ✅ Cleared. Future runs stay hidden.\n' : '   ❌ Still challenged after 3 minutes.\n');
      }
    }

    // Run every search, keeping one entry per posting. A job that turns up in
    // three searches is still one job — the searches overlap by design.
    const byId = new Map();
    const perSearch = [];
    let lastSource = null;

    for (const search of searches) {
      let found = [];
      try {
        const res = await scrapeSearch(page, search.url, captured);
        found = res.jobs;
        lastSource = res.sourceUrl ?? lastSource;
      } catch (err) {
        // One failing search shouldn't lose the results of the others.
        console.log(`failed: ${err.message.split('\n')[0].slice(0, 80)}`);
        perSearch.push({ ...search, found: 0, added: 0, error: err.message.slice(0, 120) });
        continue;
      }
      let added = 0;
      for (const job of found) {
        if (!job.id || byId.has(job.id)) continue;
        byId.set(job.id, job);
        added++;
      }
      perSearch.push({ ...search, found: found.length, added });
    }

    const normalized = [...byId.values()];

    // Every output file is a fixed name, overwritten each run — one current
    // snapshot rather than an ever-growing pile.
    if (normalized.length) {
      // Persist into the long-lived store and find out which of these we've
      // never seen before — that's what scoring and alerts will run on.
      const db = await store.load();
      const fresh = store.merge(db, normalized, {
        searchUrl: searches[0].url,
        searches: perSearch.map(({ name, url, found, added, error }) => ({ name, url, found, added, error })),
      });
      await store.save(db);
      const st = store.stats(db);

      const report = render(normalized, { searchUrl: searches.map((s) => s.url).join('\n') });

      console.log(`\n✅ Source: ${lastSource}`);
      console.log(`Found ${normalized.length} jobs`);
      console.log(
        `   ${fresh.length} new · ${normalized.length - fresh.length} already seen · ${st.total} known in total`,
      );
      // Long runs are tedious to scroll in a terminal; print a preview and point
      // at the full report instead.
      const PREVIEW = 5;
      if (normalized.length > PREVIEW) {
        console.log(render(normalized.slice(0, PREVIEW), { total: normalized.length }));
        console.log(`  … ${normalized.length - PREVIEW} more in ${path.relative(ROOT, LATEST_TXT)}\n`);
      } else {
        console.log(report);
      }

      await writeFile(LATEST_TXT, report);
      await writeFile(
        LATEST_JSON,
        JSON.stringify(
          {
            fetchedAt: new Date().toISOString(),
            searches: perSearch,
            count: normalized.length,
            jobs: normalized,
          },
          null,
          2,
        ),
      );
      console.log(`Saved ${normalized.length} jobs:`);
      console.log(`  ${path.relative(ROOT, LATEST_TXT)}   (readable)`);
      console.log(`  ${path.relative(ROOT, LATEST_JSON)}  (full data)`);
    } else {
      console.log('\n❌ No jobs found in the page.');
      console.log(`   Captured ${captured.length} JSON responses:`);
      for (const c of captured) console.log(`     ${c.status} ${c.url}`);
      await writeFile(DEBUG_JSON, JSON.stringify(captured, null, 2));
      await writeFile(DEBUG_HTML, await page.content());
      console.log(`\n   Wrote ${path.relative(ROOT, DEBUG_JSON)} and ${path.relative(ROOT, DEBUG_HTML)}`);
      console.log('   If the page shows a challenge, re-run without --headless and click the checkbox.');
    }
  } finally {
    await session.close();
  }
}

main()
  .then(() => {
    /**
     * Everything is written and the browser is closed, so if the event loop is
     * still alive something is holding a stray handle. Waiting on it hangs the
     * run forever, and an unattended scheduler has nobody to notice — so give
     * the output a moment to flush and then leave.
     *
     * unref'd: if the process was going to exit cleanly it still does, well
     * before this fires.
     */
    setTimeout(() => process.exit(0), 2000).unref();
  })
  .catch((err) => {
    console.error('\nFailed:', err.message);
    process.exit(1);
  });
