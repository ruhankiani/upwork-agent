/**
 * CLI: score stored jobs.
 *
 *   node src/score.js                 score up to 20 unscored jobs
 *   node src/score.js --limit=5       fewer
 *   node src/score.js --rescore       re-judge everything (after editing the rubric)
 *   node src/score.js --no-detail     skip detail pages (faster, less signal)
 *   node src/score.js --all           ignore the age cap and judge old jobs too
 */
import { run } from './judge/index.js';
import * as store from './store.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const opts = {
  limit: Number(arg('limit', 20)),
  rescore: args.includes('--rescore'),
  all: args.includes('--all'), // ignore the age cap (one-off catch-up)
  withDetail: !args.includes('--no-detail'),
  onProgress: (p) => {
    if (p.phase === 'aged-out') {
      console.log(`  skipping ${p.count} posting${p.count === 1 ? '' : 's'} older than ${p.maxAgeH}h (use --all to include them)`);
    } else if (p.phase === 'prefiltered') {
      console.log(`  prefiltered out ${p.skipped}, ${p.remaining} to judge\n`);
    } else if (p.phase === 'judging') {
      process.stdout.write(`  [${p.index}/${p.total}] ${p.title.slice(0, 58)}… `);
    }
  },
};

console.log(`\nScoring${opts.rescore ? ' (re-scoring everything)' : ''}…\n`);

const t0 = Date.now();
const res = await run({
  ...opts,
  onProgress: (p) => {
    opts.onProgress(p);
  },
});

// Reload to print the results with their reasoning.
const db = await store.load();
const scored = store
  .all(db)
  .filter((j) => j.score?.score != null)
  .sort((a, b) => b.score.score - a.score.score);

console.log(`\n\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s — ` +
  `${res.scored} scored, ${res.skipped} prefiltered, ${res.failed} failed\n`);

const icon = { strong: '🟢', decent: '🟡', weak: '⚪️', skip: '🔴', error: '⚠️' };
for (const j of scored.slice(0, 25)) {
  const s = j.score;
  console.log(`${icon[s.verdict] ?? ' '} ${String(s.score).padStart(3)}  ${j.title.slice(0, 62)}`);
  if (s.summary) console.log(`         ${s.summary.slice(0, 110)}`);
  const b = s.breakdown;
  if (b?.mustHaves) {
    console.log(
      `         must-haves ${b.mustHaves.met}/${b.mustHaves.total} · ${b.taskAlignment} · ` +
        Object.entries(b.preferences ?? {})
          .filter(([, v]) => v.fit != null)
          .map(([k, v]) => `${k} ${(v.fit * 100) | 0}%`)
          .join(' · '),
    );
  }
  if (b?.gates?.length) console.log(`         capped: ${b.gates.join('; ')}`);
  console.log('');
}

/**
 * Same guard as fetch.js: scoring loads job detail pages through the very same
 * browser helper, so it can be held open by the same stray handle. Nothing
 * below this point is pending work — only a socket that forgot to close.
 */
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
