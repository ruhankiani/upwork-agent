/**
 * One command: fetch, then judge whatever came back.
 *
 * Fetching and scoring were separate buttons, which meant jobs could sit
 * unscored indefinitely. Every fetched job should end up graded, so this runs
 * them back to back and reports a single combined result.
 *
 *   node src/run.js --q="GA4" --location="Americas"
 *   node src/run.js --limit=30        cap how many get judged this run
 *   node src/run.js --no-score        fetch only
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const arg = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

/** Run a child script, echoing its output live so the UI log stays useful. */
function runScript(file, scriptArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', file), ...scriptArgs], { cwd: ROOT });
    let out = '';
    const pipe = (buf) => {
      const s = String(buf);
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    child.on('error', (e) => resolve({ ok: false, out: `Failed to start ${file}: ${e.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, out, code }));
  });
}

// Everything that isn't ours belongs to fetch.js (search filters).
const OURS = new Set(['limit', 'no-score']);
const fetchArgs = args.filter((a) => {
  const key = /^--([a-zA-Z_0-9-]+)/.exec(a)?.[1];
  return key && !OURS.has(key);
});

console.log('\n─── Fetching ───');
const fetched = await runScript('fetch.js', fetchArgs);

if (!fetched.ok) {
  console.log('\n⚠️  Fetch failed — skipping scoring so nothing is judged on stale data.');
  // Pass the child's code through rather than flattening to 1: the scheduler
  // tells "needs a Cloudflare click" (3) apart from "genuinely broken" and
  // notifies differently for each.
  process.exit(fetched.code ?? 1);
}

if (args.includes('--no-score')) {
  console.log('\nDone (scoring skipped).');
  process.exit(0);
}

// Only judge what still needs it; already-scored jobs are left alone.
console.log('\n─── Scoring ───');
const scored = await runScript('score.js', [`--limit=${arg('limit', '50')}`]);

console.log('\n─── Done ───');
process.exit(scored.ok ? 0 : 1);
