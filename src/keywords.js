/**
 * The vocabulary that decides whether a posting is worth a model call.
 *
 * Upwork's search matches the *entire* job description, so a generalist posting
 * that lists "GA4" once among twenty other tools comes back looking identical to
 * one that is genuinely about GA4. Judging all of them wastes calls on work you
 * would never take.
 *
 * The rule is deliberately generous: a job is skipped only when **none** of your
 * keywords appear in its title or its skill tags. That is a rough net, not a
 * verdict — everything that gets through is still judged properly against your
 * portfolio and your exclusions. A term missing from the list means the job is
 * never seen at all, which is far worse than one extra model call, so the list
 * should be wide.
 *
 * An earlier version derived the vocabulary from the search query alone. That
 * query was five phrases, so the gate had never heard of SEO, Shopify, Tableau
 * or BigQuery, and skipped genuinely relevant jobs. The list now comes from
 * `profile/keywords.md`, which you own and can edit, and the search query is
 * folded in on top of it.
 *
 * No AI is involved in any part of this.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataFile, profileFile } from './paths.js';

const FILTERS_FILE = dataFile('filters.json');
const KEYWORDS_FILE = profileFile('keywords.md');
const PORTFOLIO_FILE = profileFile('portfolio.md');

/**
 * Words too common to mean anything on their own.
 *
 * These are real parts of a query, but as evidence that a job is *yours* they
 * are worthless: almost every marketing posting on Upwork contains them. They
 * still count, just for a quarter. Terms you write in `keywords.md` are always
 * treated as strong — you put them there on purpose.
 */
const WEAK = new Set([
  'google', 'data', 'marketing', 'api', 'web', 'ads', 'analytics', 'digital',
  'ecommerce', 'e-commerce', 'online', 'expert', 'specialist', 'setup',
]);

const clean = (raw) => raw.trim().toLowerCase();

/** Parse `keywords.md` — one term per line, `#` comments and blanks ignored. */
export function parseKeywordFile(text) {
  return (text ?? '')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map(clean);
}

/** Pull terms out of an Upwork query string: quoted phrases and bare words. */
export function keywordsFromQuery(q) {
  if (!q) return [];
  const out = [];
  for (const m of q.matchAll(/"([^"]+)"/g)) out.push(clean(m[1]));
  for (const raw of q.replace(/"[^"]*"/g, ' ').split(/[\s()]+/)) {
    const w = clean(raw.replace(/[^\w.+-]/g, ''));
    if (w && !['and', 'or', 'not'].includes(w)) out.push(w);
  }
  return out;
}

/**
 * Everything the gate knows, as `{term, weight}`.
 *
 * Your own list wins: a term you wrote down is strong even if it is also a
 * common word, because writing it down is the signal.
 */
export async function currentKeywords() {
  const terms = new Map();

  // Your profile already lists what you do, so the list seeds itself from it the
  // first time rather than starting empty and skipping everything.
  let raw = await readFile(KEYWORDS_FILE, 'utf8').catch(() => null);
  if (raw == null || !parseKeywordFile(raw).length) {
    raw = renderKeywordFile(deriveKeywords(await readFile(PORTFOLIO_FILE, 'utf8').catch(() => '')));
    await writeFile(KEYWORDS_FILE, raw).catch(() => {});
  }

  for (const t of parseKeywordFile(raw)) if (t.length >= 2) terms.set(t, 1);

  const { q } = await readFile(FILTERS_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
  for (const t of keywordsFromQuery(q)) {
    if (t.length < 3 || terms.has(t)) continue;
    terms.set(t, WEAK.has(t) ? 0.25 : 1);
  }

  return [...terms].map(([term, weight]) => ({ term, weight }));
}

/**
 * How strongly a posting matches those keywords.
 *
 * The title is what the client chose to lead with, and the skill tags are what
 * they picked off Upwork's own list — both are deliberate. A mention buried in
 * the body is worth very little: a handful of passing references in a long
 * description would otherwise total more than a real title match, which is
 * exactly the confusion this exists to prevent.
 */
export function relevance(job, keywords) {
  if (!keywords.length) return Infinity; // nothing configured: judge everything
  const title = (job.title ?? '').toLowerCase();
  const skills = (job.skills ?? []).join(' ').toLowerCase();
  const body = (job.description ?? '').toLowerCase();
  let n = 0;
  for (const { term, weight } of keywords) {
    const re = wordRe(term);
    if (re.test(title)) n += 3 * weight;
    else if (re.test(skills)) n += 1.5 * weight;
    else if (re.test(body)) n += 0.5 * weight;
  }
  return n;
}

const reCache = new Map();

/**
 * Whole-word match for a term.
 *
 * Plain substring matching quietly mis-fires: "seo" matches "Seoul", "sql"
 * matches "MySQLite", and a short derived term like "we" matches "website" —
 * enough to drag entirely unrelated jobs past the gate. `\b` doesn't work on
 * terms ending in a symbol ("c++", "pixel setup & optimization"), so the
 * boundaries are asserted with lookarounds on word characters instead.
 */
function wordRe(term) {
  let re = reCache.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'i');
    reCache.set(term, re);
  }
  return re;
}

/* ---------------------------------------------------------------------------
 * Deriving keywords from the portfolio
 *
 * Your profile already lists what you do — headline, skill tags, the tools named
 * in your work history. Retyping that into a second list is busywork, so this
 * pulls the terms straight out of `portfolio.md`.
 *
 * It is plain pattern matching, not interpretation: separators Upwork uses
 * between skills, capitalised runs, and tokens that look technical (digits,
 * ALL-CAPS, camelCase). No AI, in keeping with the rest of the profile handling.
 *
 * The result is written to `keywords.md` for you to read and edit — the file
 * stays the source of truth, so a term you delete stays deleted.
 * ------------------------------------------------------------------------- */

/** Upwork profile-page chrome, and words about the person rather than the work. */
const FURNITURE = new Set([
  'top rated', 'job success', 'total jobs', 'total hours', 'client feedback', 'work history',
  'portfolio', 'skills', 'rate', 'reviews', 'verified', 'completed jobs', 'upwork', 'rating',
  'about', 'show less', 'member since', 'local time', 'current page', 'pagination',
  'job description', 'private earnings', 'skip skills', 'total', 'hours', 'jobs', 'feedback',
  'history', 'client', 'clients', 'freelancer', 'profile',
]);

/** Generic prose that would match half of Upwork if left in. */
const GENERIC = new Set([
  'experience', 'experienced', 'expert', 'expertise', 'specialist', 'consulting', 'strategies',
  'strategy', 'industries', 'business', 'businesses', 'growth', 'multiple', 'across', 'built',
  'using', 'years', 'performance', 'fluent', 'conversational', 'french', 'spanish', 'english',
  'german', 'remote', 'onsite', 'advanced', 'implementation', 'setup', 'management', 'needed',
  'help', 'report', 'senior', 'junior', 'level', 'looking', 'seeking', 'need', 'great', 'stuff',
  'strong', 'critical', 'thinking', 'proactive', 'communicator', 'consultative', 'approach',
  'work', 'technical', 'nature', 'quick', 'fix', 'audit', 'clean', 'cleanup', 'manage',
  'architecture', 'projects', 'project', 'services', 'solutions', 'team', 'company',
  // Over-broad on their own, even though they head real skill names.
  'google', 'data', 'marketing', 'web', 'digital', 'online', 'ecommerce', 'e-commerce',
  'analysis', 'analyst', 'engineer', 'developer', 'manager', 'consultant', 'platform',
  'about', 'more', 'other', 'also', 'been', 'have', 'they', 'them', 'what', 'when',
  'their', 'there', 'which', 'while', 'would', 'could', 'should', 'from', 'into',
  'over', 'across', 'most', 'much', 'very', 'able', 'make', 'made', 'take', 'good',
  'best', 'full', 'part', 'time', 'name', 'page', 'site', 'sites', 'thing', 'things',
  'big', 'small', 'long', 'term', 'high', 'low', 'new', 'old',
]);

/** Words a real skill name never starts or ends with. */
const CONNECTORS = new Set([
  'and', 'or', 'the', 'a', 'an', 'in', 'on', 'of', 'for', 'with', 'to', 'at', 'by', 'from',
  'we', 'i', 'my', 'his', 'her', 'their', 'our', 'it', 'is', 'are', 'was', 'that', 'this',
]);

const looksTechnical = (w) =>
  /\d/.test(w) || /^[A-Z]{2,}$/.test(w) || /^[a-z]+[A-Z]/.test(w);

/** Extract candidate phrases from the profile text. */
function candidatePhrases(text) {
  const out = [];
  text = text ?? '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Upwork separates distinct skills with these.
    for (let frag of trimmed.split(/[|,·]| — |—|\u2022/)) {
      frag = frag.replace(/^[\s"'(\[]+|[\s"'.)\]]+$/g, '').trim();
      if (frag && frag.split(/\s+/).length <= 4) out.push(frag);
    }
    // Capitalised runs inside prose ("Shopify", "Google Tag Manager").
    for (const m of trimmed.matchAll(/\b[A-Z][a-zA-Z0-9+.&]*(?:\s+[A-Z][a-zA-Z0-9+.&]*){0,3}\b/g)) {
      out.push(m[0]);
    }
    // Lowercase tokens that are obviously technical ("ga4", "dataLayer", "CAPI").
    for (const w of trimmed.split(/[\s(),.]+/)) if (w && looksTechnical(w)) out.push(w);
  }

  // Words like "tracking", "tagging" and "analytics" are core to the work but
  // appear mid-sentence in lower case, so none of the rules above would catch
  // them. Anything said more than once is unlikely to be incidental.
  const freq = new Map();
  for (const w of (text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [])) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  for (const [w, n] of freq) if (n >= 2) out.push(w);

  return out;
}

/** Turn portfolio text into a sorted list of keyword terms. */
export function deriveKeywords(text) {
  const counts = new Map();

  for (const raw of candidatePhrases(text ?? '')) {
    const term = raw.replace(/[\s.]+$/, '').trim();
    const low = term.toLowerCase();
    const words = low.split(/\s+/);

    if (low.length < 3) continue;
    if (FURNITURE.has(low) || GENERIC.has(low)) continue;
    if (CONNECTORS.has(words[0]) || CONNECTORS.has(words[words.length - 1])) continue;
    if (/^[\d$%]/.test(low)) continue;              // "17 total jobs", "$30.00/hr", "100% ..."
    if (/[:$/]/.test(term)) continue;               // "Rate: $30.00/hr", "ad/conversion/tag"
    if (/[(){}[\]]/.test(term)) continue;            // "portfolio (5", "google analytics (ga4"
    if (/\.\s/.test(term)) continue;                 // two sentences run together
    if (/^[A-Z][a-z]+ [A-Z]\.?$/.test(term)) continue; // a person's name
    // Two letters anywhere, not three in a row: "ga4" and "c++" are real terms
    // and a consecutive-letters test quietly dropped every one of them.
    if ((term.match(/[a-zA-Z]/g) ?? []).length < 2) continue;
    // A single generic English word carries no signal on its own.
    if (words.length === 1 && GENERIC.has(low)) continue;

    counts.set(low, (counts.get(low) ?? 0) + 1);
  }

  // Where one term contains another, keep the shorter one and drop the longer.
  //
  // "ga4" matches every job "ga4 expert" would and many more besides, so keeping
  // the long form instead — which an earlier version did, having the comparison
  // backwards — quietly threw away the most valuable terms in the list.
  const terms = [...counts.keys()];
  return terms
    .filter((t) => !terms.some((o) => o !== t && o.length < t.length && wordRe(o).test(t)))
    .sort();
}

/** Render a derived list as the contents of `keywords.md`. */
export function renderKeywordFile(terms) {
  return [
    '# Words that mean a job might be yours.',
    '#',
    '# A job is skipped without being judged only if NONE of these appear in its',
    '# title or skill tags. Anything that gets through is still judged properly',
    '# against your portfolio and exclusions — this is a net, not a verdict.',
    '#',
    '# Derived from your portfolio, then yours to edit. Adding a term costs one',
    '# model call; leaving one out means those jobs are never seen at all.',
    '# One per line. Lines starting with # are ignored.',
    '',
    ...terms,
    '',
  ].join('\n');
}
