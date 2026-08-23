/**
 * Scoring orchestrator.
 *
 * Pipeline per job:
 *   cheap rule prefilter  →  detail page fetch  →  LLM judgment  →  score maths
 *
 * The prefilter matters on a free tier: obvious misses are rejected in code, so
 * quota and detail-page time are spent only on plausible jobs.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_DIR } from '../paths.js';
import * as store from '../store.js';
import { fetchDetail } from '../detail.js';
import { openBrowser } from '../browser.js';
import { computeScore, ageMinutes } from './score.js';
import { buildSystemPrompt, buildUserPrompt, RESPONSE_SCHEMA } from './prompt.js';
import { callModel, resolve, rateLimiter, missingKeyMessage } from './llm.js';
import { currentKeywords, relevance } from '../keywords.js';

// PROFILE_DIR comes from paths.js so a packaged app reads the copy you can edit.

const readOr = async (file, fallback = '') =>
  readFile(path.join(PROFILE_DIR, file), 'utf8').catch(() => fallback);


export async function loadProfile() {
  const [portfolio, exclusions, rubric, prefsRaw] = await Promise.all([
    readOr('portfolio.md'),
    readOr('exclusions.md'),
    readOr('rubric.md'),
    readFile(path.join(PROFILE_DIR, 'preferences.json'), 'utf8'),
  ]);
  return { portfolio, exclusions, rubric, prefs: JSON.parse(prefsRaw) };
}

/**
 * Reject obvious misses before spending a model call or a page load.
 * Only rules that are certain — anything debatable is left to the model.
 */
export function prefilter(job, prefs, keywords = []) {
  const rate = job.hourlyMax ?? job.hourlyMin;
  if (rate != null && rate < prefs.hourly.floor) {
    return `hourly max $${rate} is under your $${prefs.hourly.floor} floor`;
  }
  if (job.jobType === 'fixed' && job.budget != null && job.budget < prefs.fixed.floor) {
    return `fixed budget $${job.budget} is under your $${prefs.fixed.floor} floor`;
  }

  // A keyword gate, off by default.
  //
  // Its only job was saving model calls, and on a normal run it saved none: the
  // Upwork search query already restricts what comes back, so every fetched job
  // passed anyway. What it could still do was skip something worth reading, and
  // that failure is far more expensive than the call it saves. Whether a job is
  // a fit is the judge's call — this only ever decided whether to ask.
  //
  // Raise `minRelevance` if you start running broad, keyword-free searches.
  const floor = Number(prefs.minRelevance ?? 0);
  if (floor > 0 && keywords.length) {
    const r = relevance(job, keywords);
    if (r < floor) return `none of your keywords in the title or skills — add one in Portfolio → Keywords if this is work you'd take`;
  }
  return null;
}

/** Judge one job that already has its detail fetched. */
export async function judgeOne(job, detail, ctx) {
  const { data, usage } = await callModel({
    key: ctx.key,
    model: ctx.model,
    provider: ctx.provider,
    system: ctx.system,
    user: buildUserPrompt(job, detail),
    schema: RESPONSE_SCHEMA,
  });
  const { score, verdict, breakdown } = computeScore(job, detail, data, ctx.prefs);
  return {
    score,
    verdict,
    summary: data.summary,
    proposalAngle: data.proposal_angle || null,
    requirements: data.requirements,
    redFlags: data.red_flags,
    breakdown,
    model: ctx.model,
    scoredAt: new Date().toISOString(),
    tokens: usage?.totalTokenCount ?? null,
  };
}

/**
 * Score pending jobs.
 * @param {{limit?:number, rescore?:boolean, withDetail?:boolean, onProgress?:Function}} opts
 */
export async function run(opts = {}) {
  const {
    limit = 20,
    rescore = false,
    withDetail = true,
    all = false, // ignore the age cap — used for a one-off catch-up
    onProgress = () => {},
  } = opts;

  // Which model judges, and with which key — chosen in the app's Judge tab.
  const llm = await resolve({ model: opts.model, provider: opts.provider });
  if (!llm.key) throw new Error(await missingKeyMessage());

  const { portfolio, exclusions, rubric, prefs } = await loadProfile();
  const db = await store.load();

  let queue = store.all(db).filter((j) => (rescore ? true : !j.score));

  // Don't spend calls on stale postings. Without this the unscored pile grows
  // forever: each run judges the newest N, so yesterday's jobs are never
  // reached while new ones keep arriving.
  let agedOut = 0;
  const maxAgeH = Number(prefs.scoreMaxAgeHours ?? 48);
  if (!all && maxAgeH > 0) {
    const cutoff = Date.now() - maxAgeH * 3600 * 1000;
    const before = queue.length;
    queue = queue.filter((j) => {
      const t = new Date(j.postedAt ?? j.firstSeenAt ?? 0).getTime();
      return !Number.isFinite(t) || t >= cutoff;
    });
    agedOut = before - queue.length;
  }

  const keywords = await currentKeywords();

  const result = { considered: queue.length, agedOut, skipped: 0, scored: 0, failed: 0, jobs: [] };
  if (agedOut) onProgress({ phase: 'aged-out', count: agedOut, maxAgeH });
  if (!queue.length) return result;

  const ctx = {
    key: llm.key,
    model: llm.model,
    provider: llm.provider.ID,
    prefs,
    system: buildSystemPrompt(portfolio, rubric, exclusions),
  };

  // Prefilter the *whole* queue before the limit is applied.
  //
  // Applying the limit first meant it could be spent entirely on postings that
  // merely arrived most recently — including ones the rules would have rejected
  // for free — so genuinely relevant jobs went unjudged while the model was
  // called on jobs nothing to do with your work. Rejections are recorded here
  // and cost neither a model call nor a page load, so doing all of them is cheap.
  const toJudge = [];
  for (const job of queue) {
    const reason = prefilter(job, prefs, keywords);
    if (reason) {
      job.score = {
        score: 0,
        verdict: 'skip',
        summary: `Filtered before scoring: ${reason}.`,
        breakdown: { gates: [reason], prefiltered: true },
        scoredAt: new Date().toISOString(),
      };
      result.skipped++;
    } else {
      toJudge.push(job);
    }
  }

  // Judge the closest match first: being early on a posting is worth real points,
  // so the strongest candidates should not wait behind weaker ones.
  toJudge.sort((a, b) => {
    const d = relevance(b, keywords) - relevance(a, keywords);
    if (d !== 0) return d;
    return new Date(b.postedAt ?? b.firstSeenAt ?? 0) - new Date(a.postedAt ?? a.firstSeenAt ?? 0);
  });

  // Anything past the limit keeps its place for the next run rather than being
  // dropped — it stays unscored, and it is already at the front of the queue.
  const deferred = toJudge.splice(limit);
  result.deferred = deferred.length;

  onProgress({ phase: 'prefiltered', skipped: result.skipped, remaining: toJudge.length });

  // Browser only if we actually need detail pages.
  // Hidden headless browser for the detail pages. Nothing appears on screen.
  let session = null;
  let bctx = null;
  if (withDetail && toJudge.length) {
    try {
      session = await openBrowser({ port: 9223 });
      bctx = session.context;
    } catch {
      // Detail data is a bonus, not a requirement — score without it.
      onProgress({ phase: 'no-browser' });
    }
  }

  // Pacing is the provider's business: Gemini's free tier caps requests per
  // minute, Claude's does not and its SDK backs off on its own.
  const pace = rateLimiter(llm.provider.REQUESTS_PER_MINUTE);

  try {
    for (const [i, job] of toJudge.entries()) {
      onProgress({ phase: 'judging', index: i + 1, total: toJudge.length, title: job.title });
      try {
        let detail = job.detail;
        if (withDetail && bctx && !detail) {
          detail = await fetchDetail(bctx, job.url);
          if (detail?.error) {
            // Keep the reason — a private, removed or challenged job page is
            // something worth seeing rather than silently scoring without.
            job.detailError = detail.error;
            detail = null;
          } else if (detail) {
            job.detail = detail;
            delete job.detailError;
          }
        }
        await pace();
        job.score = await judgeOne(job, job.detail, ctx);
        result.scored++;
        result.jobs.push({ id: job.id, title: job.title, score: job.score.score, verdict: job.score.verdict });
      } catch (err) {
        result.failed++;
        const msg = err.message ?? String(err);
        // Classify so the errors page can say what to actually do about it.
        const kind = /429|rate limit|quota|RESOURCE_EXHAUSTED/i.test(msg)
          ? 'rate_limit'
          : /timed out|ETIMEDOUT|ECONNRESET|network|fetch failed/i.test(msg)
            ? 'network'
            : /API key|401|403|PERMISSION/i.test(msg)
              ? 'auth'
              : 'other';
        job.score = {
          score: null,
          verdict: 'error',
          errorKind: kind,
          summary: msg.slice(0, 300),
          scoredAt: new Date().toISOString(),
        };
        result.errors ??= [];
        result.errors.push({ id: job.id, title: job.title, kind, message: msg.slice(0, 200) });
      }
      // Save as we go — a crash 40 jobs in shouldn't throw away the work.
      await store.save(db);
    }
  } finally {
    await session?.close();
    await store.save(db);
  }

  result.jobs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return result;
}
