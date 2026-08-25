/**
 * Write cover letters for the top picks of a run.
 *
 * Runs as its own step *after* fetching, scoring and the notification, rather
 * than inside scoring. Two reasons:
 *
 *   The notification is the time-critical part. Being early on a posting is
 *   worth real points, so nothing may sit between a job being scored and you
 *   being told about it — letters take a model call each and would delay that
 *   by minutes.
 *
 *   A letter is only worth writing once the score is final. Interleaving them
 *   would mean writing letters for jobs that later turn out not to be top picks.
 *
 *   node src/letters.js              write for every top pick that lacks one
 *   node src/letters.js --limit=5    cap how many
 *   node src/letters.js --all        include older top picks, not just recent
 */
import { readFile } from 'node:fs/promises';
import * as store from './store.js';
import * as profile from './profile.js';
import { writeLetter } from './judge/letter.js';
import { profileFile } from './paths.js';

const args = process.argv.slice(2);
const arg = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const LIMIT = Number(arg('limit', '10'));
const ALL = args.includes('--all');
const MIN_SCORE = Number(arg('min-score', '60'));

async function maxAgeHours() {
  try {
    const raw = await readFile(profileFile('preferences.json'), 'utf8');
    return Number(JSON.parse(raw).scoreMaxAgeHours ?? 24);
  } catch {
    return 24;
  }
}

export async function writeLetters({ limit = 10, all = false, minScore = 60, onProgress = () => {} } = {}) {
  const db = await store.load();
  const maxAgeH = await maxAgeHours();
  const cutoff = Date.now() - maxAgeH * 3600 * 1000;

  const queue = Object.values(db.jobs)
    .filter((j) => (j.score?.score ?? -1) >= minScore)
    .filter((j) => !j.letter)
    .filter((j) => all || new Date(j.postedAt ?? j.firstSeenAt ?? 0).getTime() >= cutoff)
    // Best first: if the limit bites, it should bite on the weakest.
    .sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0))
    .slice(0, limit);

  const result = { considered: queue.length, written: 0, failed: 0, errors: [] };
  if (!queue.length) return result;

  const { portfolio, exclusions, letterPrompt, letterSamples } = await profile.readAll();

  for (const [i, job] of queue.entries()) {
    onProgress({ index: i + 1, total: queue.length, title: job.title });
    try {
      job.letter = await writeLetter(job, { portfolio, exclusions, letterPrompt, letterSamples });
      result.written++;
      // Save as we go: a letter already paid for shouldn't be lost because a
      // later one hit a rate limit.
      await store.save(db);
    } catch (err) {
      result.failed++;
      result.errors.push({ id: job.id, title: job.title, message: (err.message ?? String(err)).slice(0, 200) });
    }
  }
  return result;
}

// Run directly, not when imported by the server.
if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  console.log('\n─── Cover letters ───');
  const res = await writeLetters({
    limit: LIMIT,
    all: ALL,
    minScore: MIN_SCORE,
    // The server parses this line for the progress bar; keep the shape stable.
    onProgress: ({ index, total, title }) =>
      process.stdout.write(`  [${index}/${total}] ${title.slice(0, 58)}… `),
  });

  if (!res.considered) {
    console.log('  Nothing to write — every top pick already has a letter.');
  } else {
    console.log(`\nWrote ${res.written} letter(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s` +
      (res.failed ? `, ${res.failed} failed` : ''));
    for (const e of res.errors) console.log(`  ⚠️  ${e.title.slice(0, 50)} — ${e.message}`);
  }
  process.exit(res.failed && !res.written ? 1 : 0);
}
