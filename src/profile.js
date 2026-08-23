/**
 * Profile management — reading, writing and importing the files that drive
 * scoring: portfolio.md, rubric.md and preferences.json.
 *
 * No AI anywhere in this file. The portfolio is stored exactly as the user
 * writes or pastes it; importing from a URL just grabs the page's text. All the
 * actual thinking — matching a portfolio against a job posting — happens in the
 * judging step, which reads whatever is here as-is. Format doesn't matter.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_DIR } from './paths.js';
import { openBrowser, readPageText } from './browser.js';

const DIR = PROFILE_DIR;

/** Only these files are writable — never take a path from the client. */
const FILES = {
  portfolio: { file: 'portfolio.md', type: 'text' },
  exclusions: { file: 'exclusions.md', type: 'text' },
  keywords: { file: 'keywords.md', type: 'text' },
  rubric: { file: 'rubric.md', type: 'text' },
  preferences: { file: 'preferences.json', type: 'json' },
};

export async function readAll() {
  const out = {};
  for (const [key, { file }] of Object.entries(FILES)) {
    try {
      out[key] = await readFile(path.join(DIR, file), 'utf8');
    } catch {
      out[key] = '';
    }
  }
  return out;
}

export async function write(key, content) {
  const spec = FILES[key];
  if (!spec) throw new Error(`Unknown profile file: ${key}`);
  if (typeof content !== 'string') throw new Error('Content must be a string');

  if (spec.type === 'json') {
    try {
      JSON.parse(content); // refuse to save something the scorer can't load
    } catch (e) {
      throw new Error(`Not valid JSON: ${e.message}`);
    }
  }

  await mkdir(DIR, { recursive: true });
  const target = path.join(DIR, spec.file);
  // Keep one backup, so an accidental overwrite of a tuned portfolio isn't fatal.
  await copyFile(target, `${target}.bak`).catch(() => {});
  await writeFile(target, content);
  return { ok: true, bytes: content.length };
}

/**
 * Grab the readable text of a public page so it can be pasted into the
 * portfolio box. This is a fetch, not an interpretation — whatever the page
 * says arrives verbatim for the user to keep, trim or ignore.
 *
 * Uses the same hidden browser as the scraper, so JavaScript-rendered pages
 * work. Pages behind a login (LinkedIn) return their sign-in screen.
 */
export async function importFromUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a full URL starting with http:// or https://');

  let browser = null;
  try {
    browser = await openBrowser({ port: 9281 });
    const { title, text } = await readPageText(browser.context, url);

    const clean = (text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');

    if (clean.length < 200) {
      throw new Error(
        'That page had almost no readable text — it may need a login, or block automated access.',
      );
    }
    return { text: clean, sourceTitle: title, url };
  } finally {
    await browser?.close();
  }
}
