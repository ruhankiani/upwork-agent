/**
 * Deterministic scoring.
 *
 * The LLM decides *semantics* — does this requirement match the portfolio, is
 * the task core or adjacent. This file does the *arithmetic*. Models are
 * unreliable at weighted maths and give different numbers run to run for the
 * same input; code doesn't. Splitting it this way makes every score
 * reproducible and lets you see exactly which term moved it.
 */

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Ramp from 0 at `bad` to 1 at `good`, in either direction. */
function ramp(value, bad, good) {
  if (value == null || !Number.isFinite(value)) return null;
  if (bad === good) return value >= good ? 1 : 0;
  return clamp01((value - bad) / (good - bad));
}

/** Minutes since posting, from the ISO timestamp the search listing gives us. */
export function ageMinutes(job) {
  const t = job.postedAt ? new Date(job.postedAt).getTime() : NaN;
  return Number.isFinite(t) ? (Date.now() - t) / 60000 : null;
}

/**
 * The job's effective pay, expressed against your targets.
 * Hourly uses the top of the advertised band, since that's what's negotiable to.
 */
function payFit(job, prefs) {
  if (job.jobType === 'hourly' || job.hourlyMin || job.hourlyMax) {
    const rate = job.hourlyMax ?? job.hourlyMin;
    if (rate == null) return { fit: null, belowFloor: false, note: 'no rate given' };
    return {
      fit: ramp(rate, prefs.hourly.floor, prefs.hourly.target),
      belowFloor: rate < prefs.hourly.floor,
      note: `$${rate}/hr vs $${prefs.hourly.target} target`,
    };
  }
  const amount = job.budget;
  if (amount == null) return { fit: null, belowFloor: false, note: 'no budget given' };
  return {
    fit: ramp(amount, prefs.fixed.floor, prefs.fixed.target),
    belowFloor: amount < prefs.fixed.floor,
    note: `$${amount} fixed vs $${prefs.fixed.target} target`,
  };
}

/** Fewer proposals is better. Uses the upper bound of Upwork's bucket. */
function competitionFit(detail, prefs) {
  const n = detail?.proposalsMax ?? detail?.proposalsMin;
  if (n == null) return { fit: null, note: 'proposal count unknown' };
  return {
    fit: ramp(n, prefs.competition.okMax, prefs.competition.greatMax),
    note: `${detail.proposalsText ?? n} proposals`,
  };
}

function freshnessFit(job, prefs) {
  const mins = ageMinutes(job);
  if (mins == null) return { fit: null, note: 'age unknown' };
  return {
    fit: ramp(mins, prefs.freshness.okMinutes, prefs.freshness.greatMinutes),
    note: mins < 60 ? `${Math.round(mins)}m old` : `${(mins / 60).toFixed(1)}h old`,
  };
}

/** Spend and hire history. A brand-new client isn't bad, just unproven. */
function clientFit(detail, prefs) {
  if (!detail || (detail.clientSpend == null && detail.clientHires == null)) {
    return { fit: null, note: 'no client history' };
  }
  const spend = ramp(detail.clientSpend ?? 0, 0, prefs.client.goodSpend);
  const hires = ramp(detail.clientHires ?? 0, 0, prefs.client.goodHires);
  return {
    fit: clamp01(((spend ?? 0) + (hires ?? 0)) / 2),
    note: `$${detail.clientSpend ?? 0} spent, ${detail.clientHires ?? 0} hires`,
  };
}

/**
 * Combine the preference dimensions. Unknown dimensions are dropped and the
 * remaining weights renormalised, so a missing signal is neutral rather than
 * silently counting as zero.
 */
function preferenceScore(parts, weights) {
  let sum = 0;
  let used = 0;
  for (const [key, part] of Object.entries(parts)) {
    if (part.fit == null) continue;
    const w = weights[key] ?? 0;
    sum += part.fit * w;
    used += w;
  }
  return used > 0 ? sum / used : 0.5; // nothing known → neutral
}

/**
 * Red flags that are not just a restatement of something already scored.
 *
 * Competition, pay, freshness and client history each contribute to the
 * preference score from the actual numbers on the posting. When the model also
 * names them in `red_flags` — which it does constantly — applying a hard cap on
 * top charges the job twice for one fact.
 *
 * Only the qualitative concerns the maths cannot see should reach the cap:
 * vague scope, unrealistic expectations, an unpaid test, work outside your
 * remit. Those are exactly what red flags are for.
 */
const PRICED_IN = [
  /proposals?\b|applicants?\b|competiti|bids?\b/i,
  /\brate\b|\/hr|hourly|budget|pay(ment)?\b|low[- ]?ball|under your|below your|\bcheap\b/i,
  /posted\s+\d|\bhours? old\b|\bdays? old\b|\bstale\b|already\s+\d+\s*h/i,
  /\bspend(ing)?\b|\bspent\b|\bhires?\b|new client|client (rating|review|history)/i,
];

export function substantiveFlags(flags) {
  return flags.filter((f) => !PRICED_IN.some((re) => re.test(String(f))));
}

/**
 * @param job      normalized search-listing job
 * @param detail   parsed detail page (may be null)
 * @param judgment LLM output: { requirements[], task_alignment, ... }
 * @param prefs    profile/preferences.json
 */
export function computeScore(job, detail, judgment, prefs) {
  const reqs = judgment?.requirements ?? [];
  const must = reqs.filter((r) => r.type === 'must_have');
  const nice = reqs.filter((r) => r.type !== 'must_have');

  const value = (r) => (r.status === 'met' ? 1 : r.status === 'partial' ? 0.5 : 0);
  const mustMissing = must.filter((r) => r.status === 'missing').length;

  // Weighted coverage: must-haves count fully, nice-to-haves partially.
  const mustTotal = must.length;
  const niceTotal = nice.length;
  const wNice = prefs.niceWeight ?? 0.35;
  const denom = mustTotal + niceTotal * wNice;
  const numer = must.reduce((s, r) => s + value(r), 0) + nice.reduce((s, r) => s + value(r) * wNice, 0);
  const coverage = denom > 0 ? numer / denom : judgment?.task_alignment === 'core' ? 1 : 0.5;

  const parts = {
    pay: payFit(job, prefs),
    competition: competitionFit(detail, prefs),
    freshness: freshnessFit(job, prefs),
    client: clientFit(detail, prefs),
  };
  const prefScore = preferenceScore(parts, prefs.weights);

  // Base from skill coverage, then preferences scale it within a floor — so
  // great preferences can't rescue a bad fit, and mediocre preferences can't
  // destroy a great one.
  const floor = prefs.prefFloor ?? 0.7;
  let score = 100 * coverage * (floor + (1 - floor) * prefScore);

  // Hard gates, applied last. These are caps, not subtractions.
  const gates = [];
  const cap = (limit, why) => {
    if (score > limit) {
      score = limit;
      gates.push(why);
    }
  };

  // Your own not-interested list wins over everything, including good pay.
  if (judgment?.matches_exclusion) {
    cap(
      prefs.gates.matchesExclusion ?? prefs.gates.differentTask,
      judgment.exclusion_reason?.trim()
        ? `on your not-interested list: ${judgment.exclusion_reason}`
        : 'on your not-interested list',
    );
  }

  if (judgment?.task_alignment === 'different') cap(prefs.gates.differentTask, 'task is not the work you do');
  else if (judgment?.task_alignment === 'adjacent') cap(prefs.gates.adjacentTask, 'adjacent work, not your core');

  if (mustMissing >= 3) cap(prefs.gates.threePlusMustMissing, `${mustMissing} required skills missing`);
  else if (mustMissing === 2) cap(prefs.gates.twoMustMissing, '2 required skills missing');
  else if (mustMissing === 1) cap(prefs.gates.oneMustMissing, '1 required skill missing');

  if (parts.pay.belowFloor) cap(prefs.gates.belowPayFloor, 'pay is below your floor');

  // The model's own "I'd decline this" list. Ignoring it let a posting the
  // model called "too vague, outside core focus" score 81.
  //
  // But only the flags that say something the maths hasn't already accounted
  // for. The model reliably lists "50+ proposals" or "rate is on the low side"
  // as red flags, and those exact figures are already priced into the preference
  // score above — counting them again let a job with perfect skill coverage get
  // capped at 45 for facts it had already been penalised for once.
  const flags = substantiveFlags(judgment?.red_flags ?? []);
  if (flags.length >= 2) cap(prefs.gates.multipleRedFlags, `${flags.length} red flags`);
  else if (flags.length === 1) cap(prefs.gates.oneRedFlag, '1 red flag');

  score = Math.round(clamp01(score / 100) * 100);

  const b = prefs.bands;
  const verdict = score >= b.strong ? 'strong' : score >= b.decent ? 'decent' : score >= b.weak ? 'weak' : 'skip';

  return {
    score,
    verdict,
    breakdown: {
      coverage: Number(coverage.toFixed(3)),
      mustHaves: { total: mustTotal, met: must.filter((r) => r.status === 'met').length, missing: mustMissing },
      niceToHaves: { total: niceTotal, met: nice.filter((r) => r.status === 'met').length },
      taskAlignment: judgment?.task_alignment ?? null,
      redFlags: flags.length,
      redFlagsPricedIn: (judgment?.red_flags ?? []).length - flags.length,
      preferences: Object.fromEntries(
        Object.entries(parts).map(([k, v]) => [k, { fit: v.fit == null ? null : Number(v.fit.toFixed(2)), note: v.note }]),
      ),
      preferenceScore: Number(prefScore.toFixed(3)),
      gates,
    },
  };
}
