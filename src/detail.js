/**
 * Job detail fetcher.
 *
 * The search listing carries no client reputation and no proposal count — both
 * are strong signals for "is this worth applying to". Those only exist on the
 * individual job page, so this opens it in the same hidden browser and reads
 * the rendered values.
 *
 * Reads the rendered DOM text rather than the page's internal state: the detail
 * page wipes `window.__NUXT__` after hydration, and the visible text is what
 * Upwork actually shows a human — a more stable contract than their internals.
 */

const NUM = String.raw`[\d,]+(?:\.\d+)?`;

/** "$16K total spent" / "$1.2M total spent" -> 16000 / 1200000 */
function parseMoney(text) {
  if (!text) return null;
  const m = text.match(/\$\s*([\d,.]+)\s*([KMB])?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase()];
  return mult ? n * mult : n;
}

/**
 * Pull the value that follows a label. Upwork renders label and value in
 * separate elements, so in the flattened innerText they land on adjacent lines.
 */
function afterLabel(lines, label) {
  const i = lines.findIndex((l) => new RegExp(`^${label}\\s*:?$`, 'i').test(l));
  if (i >= 0 && lines[i + 1]) return lines[i + 1].trim();
  // fall back to "Label: value" on one line
  const inline = lines.find((l) => new RegExp(`^${label}\\s*:`, 'i').test(l));
  return inline ? inline.split(':').slice(1).join(':').trim() : null;
}

/**
 * Take only the lines belonging to a section. Client stats and job activity sit
 * under their own headings, and matching across the whole page picks up
 * unrelated numbers from the job description — an early version reported a 4.9
 * client rating for a client who had joined the day before.
 */
function section(lines, startRe, endRe, span = 14) {
  const i = lines.findIndex((l) => startRe.test(l));
  if (i < 0) return [];
  const rest = lines.slice(i + 1, i + 1 + span);
  const end = endRe ? rest.findIndex((l) => endRe.test(l)) : -1;
  return end >= 0 ? rest.slice(0, end) : rest;
}

/** Turn the page's visible text into the signals the scorer needs. */
export function parseDetailText(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const activity = section(lines, /^Activity on this job/i, /^About the client/i);
  const client = section(lines, /^About the client/i, /^(Explore similar|Job link|Similar jobs)/i, 16);
  const clientText = client.join('\n');

  const intOrNull = (v) => {
    if (v == null) return null;
    const m = String(v).match(new RegExp(NUM));
    if (!m) return null;
    const n = Number(m[0].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  // Upwork reports proposals as a bucket ("5 to 10", "20 to 50", "Less than 5"),
  // never an exact count. Keep the text and derive a conservative upper bound,
  // since "how contested is this" is what the score actually needs.
  const proposalsText = afterLabel(activity, 'Proposals');
  let proposalsMin = null;
  let proposalsMax = null;
  if (proposalsText) {
    const range = proposalsText.match(new RegExp(`(${NUM})\\s*(?:to|-|–)\\s*(${NUM})`, 'i'));
    const less = proposalsText.match(new RegExp(`less than\\s*(${NUM})`, 'i'));
    const more = proposalsText.match(new RegExp(`(${NUM})\\s*\\+|more than\\s*(${NUM})`, 'i'));
    if (range) {
      proposalsMin = Number(range[1].replace(/,/g, ''));
      proposalsMax = Number(range[2].replace(/,/g, ''));
    } else if (less) {
      proposalsMin = 0;
      proposalsMax = Number(less[1].replace(/,/g, ''));
    } else if (more) {
      proposalsMin = Number((more[1] ?? more[2]).replace(/,/g, ''));
      proposalsMax = null;
    } else {
      proposalsMin = proposalsMax = intOrNull(proposalsText);
    }
  }

  const hires = clientText.match(new RegExp(`(${NUM})\\s+hires?`, 'i'));
  const activeHires = clientText.match(new RegExp(`(${NUM})\\s+active`, 'i'));
  const spent = clientText.match(/\$\s*[\d,.]+\s*[KMB]?\s*total spent/i);
  const member = clientText.match(/Member since\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
  const rating = clientText.match(/([\d.]+)\s*(?:out of 5|★)/i);
  const posted = lines.join('\n').match(/Posted\s+([^\n]{2,30}ago)/i);

  return {
    proposalsText,
    proposalsMin,
    proposalsMax,
    interviewing: intOrNull(afterLabel(activity, 'Interviewing')),
    invitesSent: intOrNull(afterLabel(activity, 'Invites sent')),
    unansweredInvites: intOrNull(afterLabel(activity, 'Unanswered invites')),
    lastViewedByClient: afterLabel(activity, 'Last viewed by client'),
    clientSpend: spent ? parseMoney(spent[0]) : null,
    clientHires: hires ? Number(hires[1].replace(/,/g, '')) : null,
    clientActiveHires: activeHires ? Number(activeHires[1].replace(/,/g, '')) : null,
    clientRating: rating ? Number(rating[1]) : null,
    clientMemberSince: member ? member[1] : null,
    // "Individual client" vs a company account
    clientType: client.find((l) => /^(Individual client|Company)/i.test(l)) ?? null,
    clientCountry: client[1]?.length < 40 && !/\$|hires|Member/i.test(client[1] ?? '') ? client[1] : null,
    postedText: posted ? posted[1] : null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch one job's detail page.
 *
 * Three things can come back besides a normal page, and they need telling
 * apart — an early version lumped them together as "detail with every field
 * null", which looked like a successful fetch:
 *
 *   private   — Upwork says "This job is a private listing" and shows nothing.
 *               The posting still appears in public search, so it can be judged
 *               on its search data; there is simply no client or proposal info.
 *   challenge — Cloudflare interstitial, usually from fetching too fast.
 *               Worth retrying later.
 *   no-data   — page loaded but carried no activity section for some other reason.
 *
 * Returns `{ error }` for all three rather than a hollow object.
 */
export async function fetchDetail(context, url, { timeout = 45_000, settle = 6000 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(settle);

    const title = await page.title().catch(() => '');
    if (/just a moment|challenge|attention required|verifying/i.test(title)) {
      return { error: 'challenge' };
    }

    const text = await page.evaluate(() => document.body.innerText);

    if (/this job is a private listing/i.test(text)) {
      return { error: 'private' };
    }
    if (/cloudflare ray id/i.test(text) && text.length < 500) {
      return { error: 'challenge' };
    }

    const parsed = parseDetailText(text);
    // If nothing at all came out, the page didn't carry what we came for.
    // Storing that as "detail" would misreport unknowns as known-empty.
    const gotSomething =
      parsed.proposalsText != null || parsed.clientMemberSince != null || parsed.clientSpend != null;
    return gotSomething ? parsed : { error: 'no-data' };
  } catch (err) {
    return { error: err.message.split('\n')[0].slice(0, 120) };
  } finally {
    await page.close().catch(() => {});
  }
}
