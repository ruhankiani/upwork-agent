/**
 * Job store — the memory the tool has been missing.
 *
 * Until now every fetch overwrote the last one, so there was no way to tell a
 * genuinely new posting from one we'd already seen. That matters the moment an
 * LLM is involved: without it we'd re-score (and re-alert on) the same jobs on
 * every run.
 *
 * A plain JSON file rather than SQLite: no native module to compile, so
 * installing stays `npm install` for you and your friends. It holds thousands
 * of jobs comfortably; if it ever gets slow the shape here maps 1:1 onto a
 * SQLite table.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, dataFile } from './paths.js';

const STORE_FILE = dataFile('jobs.json');

/** @typedef {{jobs: Record<string, any>, runs: any[], version: number}} Store */

const EMPTY = { version: 1, jobs: {}, runs: [] };

export async function load() {
  try {
    const raw = await readFile(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { ...EMPTY, ...data, jobs: data.jobs ?? {} };
  } catch {
    return structuredClone(EMPTY);
  }
}

/**
 * Write atomically — a crash mid-write would otherwise leave a truncated file
 * and lose every job we've ever seen.
 */
export async function save(store) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2));
  await rename(tmp, STORE_FILE);
}

/**
 * Merge a freshly-scraped batch into the store.
 *
 * Returns the jobs that were genuinely new, which is what later stages
 * (detail fetch, scoring, notifications) should act on.
 */
export function merge(store, scraped, { searchUrl = null, searches = null } = {}) {
  const now = new Date().toISOString();
  const fresh = [];

  for (const job of scraped) {
    if (!job.id) continue;
    const existing = store.jobs[job.id];

    if (existing) {
      // Keep the first-seen timestamp and any score already attached; refresh
      // the posting itself in case the client edited it.
      store.jobs[job.id] = {
        ...existing,
        ...job,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: now,
        seenCount: (existing.seenCount ?? 1) + 1,
        score: existing.score ?? null,
        detail: existing.detail ?? null,
      };
    } else {
      store.jobs[job.id] = {
        ...job,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
        score: null, // filled in by the scorer
        detail: null, // filled in by the detail fetcher
      };
      fresh.push(store.jobs[job.id]);
    }
  }

  store.runs.unshift({
    at: now,
    searchUrl,
    searches,
    found: scraped.length,
    new: fresh.length,
  });
  store.runs = store.runs.slice(0, 200); // keep recent history only

  return fresh;
}

/** Jobs still awaiting a score, newest first. */
export function unscored(store) {
  return Object.values(store.jobs)
    .filter((j) => !j.score)
    .sort((a, b) => new Date(b.postedAt ?? b.firstSeenAt) - new Date(a.postedAt ?? a.firstSeenAt));
}

/** Everything we know, newest first. */
export function all(store) {
  return Object.values(store.jobs).sort(
    (a, b) => new Date(b.postedAt ?? b.firstSeenAt) - new Date(a.postedAt ?? a.firstSeenAt),
  );
}

export function stats(store, { recentRuns = 3, maxAgeHours = 48 } = {}) {
  const jobs = Object.values(store.jobs);
  const ageMs = Date.now() - maxAgeHours * 3600 * 1000;

  // "Recent" is what the counters should report. Counting the whole archive
  // made the header read 77/310 and look broken, when the old jobs are
  // deliberately never judged.
  //
  // Age alone decides this. It used to also count anything seen in the last few
  // runs, but two rules OR'd together meant the header and the tabs could
  // disagree about the same job, and a burst of quick fetches shrank "recent"
  // to a few minutes.
  const isRecent = (j) => new Date(j.postedAt ?? j.firstSeenAt ?? 0).getTime() >= ageMs;
  const recent = jobs.filter(isRecent);

  return {
    total: jobs.length,
    scored: jobs.filter((j) => j.score?.score != null).length,
    unscored: jobs.filter((j) => !j.score).length,
    recentTotal: recent.length,
    recentScored: recent.filter((j) => j.score?.score != null).length,
    recentUnscored: recent.filter((j) => !j.score).length,
    errors: jobs.filter((j) => j.score?.verdict === 'error' || j.detailError).length,
    withDetail: jobs.filter((j) => j.detail).length,
    lastRun: store.runs[0] ?? null,
  };
}

/**
 * Timestamp marking the start of the "recent" window.
 *
 * Recency is what makes a job worth looking at — a great posting from three
 * days ago has already had 50 proposals. A job counts as recent if it arrived
 * in one of the last few runs, so the boundary follows how often you actually
 * run the tool rather than a fixed clock.
 */
export function recentSince(store, runs = 3) {
  const r = store.runs[Math.min(runs, store.runs.length) - 1];
  return r?.at ?? null;
}
