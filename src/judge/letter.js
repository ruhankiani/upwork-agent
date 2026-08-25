/**
 * Cover letters for the jobs worth applying to.
 *
 * Runs only on demand, and only for top picks: writing a letter costs a model
 * call and there is no point spending one on a job you would not apply to.
 *
 * ## About the client's questions
 *
 * Upwork has two different things that look alike, and only one is reachable:
 *
 *   Screening questions — the boxes on the application form. They are NOT in
 *     any public payload: the search response carries no question field, and the
 *     form itself sits behind a login. Nothing here can answer them, and the UI
 *     says so rather than pretending otherwise.
 *
 *   Questions in the description — "Please answer the following:", "include
 *     your experience with X", "start your reply with the word banana". Clients
 *     do this constantly (46% of stored postings contain an instruction like
 *     it), it is plain text in data already fetched, and ignoring it is the
 *     fastest way to have a proposal binned unread.
 *
 * So the model is asked to pull the client's asks out of the description and
 * answer them individually, alongside the letter.
 */
import { callModel, resolve } from './llm.js';

/** Keep the letter short enough that a client actually reads it. */
const MAX_WORDS = 180;

/**
 * Used when `profile/letter-prompt.md` is empty.
 *
 * The style guidance is the user's to edit — it is the part they have opinions
 * about. The rules that keep the feature working (JSON out, questions quoted
 * verbatim, nothing invented) stay in code below, because a letter that ignores
 * them is not a letter, it is a bug.
 */
const DEFAULT_GUIDANCE = `- Opens by naming the client's actual problem, not by introducing yourself. Never "I am a...", never "I hope this finds you well".
- **The first thing in the letter is a complete sentence.** No greeting, no client name, no job title, no heading.
- Gives concrete evidence from the profile: the specific tools, the specific kind of build. Numbers where the profile provides them.
- Says what you would do first. One or two steps, specific to this posting.
- Ends with one short question about their setup, or a clear offer to start.
- Under ${MAX_WORDS} words. Short is the point — the client is reading twenty of these.
- Plain text. No markdown, no bullet symbols, no headers, no signature block, no subject line.`;

export const LETTER_SCHEMA = {
  type: 'object',
  properties: {
    letter: {
      type: 'string',
      description: `The cover letter itself. Under ${MAX_WORDS} words, plain text, no markdown, no subject line. MUST begin with a complete sentence about the client's problem — never a job title, role label, greeting or heading.`,
    },
    questions: {
      type: 'array',
      description:
        'Only things the client instructs an APPLICANT to provide. Empty array if the posting contains none — that is the common case and a correct answer.',
      items: {
        type: 'object',
        properties: {
          verbatim: {
            type: 'string',
            description:
              'The instruction copied EXACTLY from the posting, character for character, with no rewording. This is checked against the posting text and the question is discarded if it does not appear there.',
          },
          question: { type: 'string', description: 'The same ask, tidied into a plain question.' },
          answer: { type: 'string', description: 'A direct answer from the portfolio. 1-3 sentences.' },
          grounded: {
            type: 'boolean',
            description:
              'True only if the portfolio actually supports this answer. False if answering needs a fact the portfolio does not contain.',
          },
        },
        required: ['verbatim', 'question', 'answer', 'grounded'],
      },
    },
    opening_line: {
      type: 'string',
      description: 'The single strongest sentence for this job, in case the letter needs trimming.',
    },
  },
  required: ['letter', 'questions', 'opening_line'],
};

export function buildLetterSystemPrompt(portfolio, exclusions = '', guidance = '', samples = '') {
  return `You write Upwork cover letters for one specific freelancer. You are writing AS them, in first person.

## The freelancer's own profile

${portfolio}

${exclusions ? `## Work they decline\n\n${exclusions}\n` : ''}
## What a good letter does here

${guidance?.trim() || DEFAULT_GUIDANCE}

## Rules you do not break

- **Every claim must come from the profile above.** You may not invent an employer, a client name, a metric, a certification, a year of experience, or a past project. If the profile does not say it, it does not go in the letter. This matters more than the letter sounding impressive — an invented claim is caught in the first interview and costs them the contract.
- Do not promise a timeline, a price, or a delivery date. They set those.
- Do not describe the freelancer as an expert in something the profile does not list.
- If the job names a tool the profile does not, do not dwell on it and do not apologise. Answer from the equivalent experience the profile does show, and say plainly that the approach is the same. Power BI is Looker Studio with a different front end; ClickFunnels is one more site to put a tag on. You may say the technique transfers. You may not say you have used the tool.

## The client's application questions

Some postings tell the applicant to provide specific things: "Please answer the following", "share 2 examples of X", "include the word PURPLE so I know you read this", "state your hourly rate and availability".

Put **only those** in \`questions\`. For each one:

- \`verbatim\`: copy the instruction out of the posting **exactly as written**, character for character. Do not reword, summarise, tidy or merge it. This is checked against the posting text automatically and the entry is thrown away if it does not appear there — so a paraphrase loses the answer entirely.
- \`question\`: the same ask, tidied into a plain question.
- \`answer\`: answer it from the profile, in one to three sentences.
- \`grounded\`: false when an honest answer needs a fact the profile does not contain. Still write your best attempt, but mark it — the user corrects it before sending.

### What is NOT an application question

Be strict. These are **not** questions and must never appear in the list:

- Responsibilities, requirements or deliverables — "Analyze Google Ads performance", "must know GA4". A description of the work is not a question.
- Rhetorical or marketing lines — "Tired of dashboards nobody reads?", "Sound like you?"
- Questions the client is describing about *their own* business — "we need to understand why our conversions dropped". That is the job, not a question for you.
- Anything you inferred, combined from several sentences, or thought would be sensible to ask. If you cannot copy it out of the posting as one continuous piece of text, it does not go in.

**Most postings have no application questions at all.** An empty array is the normal, correct answer. Returning a plausible-looking question that the client did not actually ask is worse than returning none, because the user will paste an answer to a question nobody asked.
${samples?.trim() ? `
## Letters written the way they want theirs to read

Match the tone, the shape and the length. Never reuse their content — the facts must come from this job and this profile.

${samples.trim()}
` : ''}
Return JSON matching the schema.`;
}

export function buildLetterUserPrompt(job, detail) {
  const money =
    job.hourlyMin || job.hourlyMax
      ? `Hourly: $${job.hourlyMin ?? '?'}-${job.hourlyMax ?? '?'}/hr`
      : job.budget
        ? `Fixed price: $${job.budget}`
        : 'Budget: not stated';

  const facts = [
    `Title: ${job.title}`,
    money,
    job.experienceLevel && `Experience level sought: ${job.experienceLevel}`,
    job.duration && `Project length: ${job.duration}`,
    job.skills?.length && `Tags: ${job.skills.join(', ')}`,
    detail?.clientCountry && `Client location: ${detail.clientCountry}`,
  ]
    .filter(Boolean)
    .join('\n');

  // The judge's own reasoning is the best summary of why this job fits, so hand
  // it over rather than making the model work it out a second time.
  const angle = job.score?.proposalAngle ? `\n## The angle worth taking\n\n${job.score.proposalAngle}\n` : '';
  const strengths = (job.score?.requirements ?? [])
    .filter((r) => r.status === 'met')
    .map((r) => `- ${r.text}${r.evidence ? ` — ${r.evidence}` : ''}`)
    .join('\n');

  return `${facts}
${angle}${strengths ? `\n## Requirements already judged as met\n\n${strengths}\n` : ''}
## The posting, in full

${(job.description ?? '').slice(0, 8000)}`;
}

/**
 * Keep only the questions the client demonstrably asked.
 *
 * The model is told to copy each instruction out of the posting verbatim, and
 * this checks that it did. Anything whose quote is not actually in the text is
 * dropped — a plausible invented question is worse than none at all, because
 * the user pastes an answer to something nobody asked and looks like they did
 * not read the brief.
 *
 * Matching is whitespace- and punctuation-insensitive, since the model
 * reproduces the words reliably but not the line breaks and bullet characters
 * around them. A prefix match handles a quote that trails off mid-list.
 */
const flatten = (t) =>
  String(t ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function verifyQuestions(questions, description) {
  const haystack = flatten(description);
  const kept = [];
  const dropped = [];

  for (const q of questions ?? []) {
    const needle = flatten(q?.verbatim);
    // Too short to be evidence of anything — "please" would match half of Upwork.
    if (needle.length < 12) {
      dropped.push({ ...q, why: 'quote too short to verify' });
      continue;
    }
    // Full quote, or its opening clause for a quote that runs into a bullet list.
    const found = haystack.includes(needle) || haystack.includes(needle.slice(0, 60));
    if (found) kept.push(q);
    else dropped.push({ ...q, why: 'not found in the posting' });
  }
  return { kept, dropped };
}

/**
 * Drop a heading the model echoed from the posting.
 *
 * Asked to open on the client's problem, models sometimes still lead with the
 * role title lifted from the job ad — "Investment Analyst." — as though writing
 * a document header. Instructions alone did not stop it.
 *
 * Only a *verbless* fragment of four words or fewer is removed, which is not a
 * sentence by definition and never a deliberate opener. A short but real
 * sentence ("Your GA4 is double-counting.") contains a verb and survives.
 */
const VERBISH =
  /\b(is|are|was|were|be|been|has|have|had|can|could|will|would|should|do|does|did|need|needs|looks|look|seems|sounds|means|comes|runs|sits|shows|tells|gets|makes|see|read|noticed|spotted)\b/i;

export function stripEchoedHeading(text) {
  const isFragment = (head) =>
    head.split(/\s+/).filter(Boolean).length <= 4 && !VERBISH.test(head) && head.length <= 60;

  // A heading on its own line. Checked first because the punctuation pattern
  // below cannot see it — leading whitespace swallows the line break.
  const nl = text.indexOf('\n');
  if (nl > 0) {
    const head = text.slice(0, nl).replace(/[\s.:\u2014\u2013]+$/, '').trim();
    const rest = text.slice(nl + 1).trim();
    if (rest && isFragment(head)) return { letter: rest, trimmed: head };
  }

  // A heading run into the first sentence. The separator matters as much as the
  // fragment: a first fix only split on sentence punctuation, so the model
  // simply switched to "Investment Analyst:" and slipped straight past it.
  const m = text.match(/^([^.!?:\n\u2014\u2013]{1,60})[.:\u2014\u2013]\s+/);
  if (!m) return { letter: text, trimmed: null };

  const head = m[1].trim();
  const rest = text.slice(m[0].length).trim();
  if (!rest || !isFragment(head)) return { letter: text, trimmed: null };

  return { letter: rest, trimmed: head };
}

/** Write one letter. Returns the parsed result plus what produced it. */
export async function writeLetter(job, { portfolio, exclusions, letterPrompt, letterSamples } = {}, overrides = {}) {
  const { provider, key, model } = await resolve(overrides);
  if (!key) throw new Error(`No API key set for ${provider.LABEL} — add one in Settings.`);

  const { data, usage } = await callModel({
    key,
    model,
    provider: provider.ID,
    system: buildLetterSystemPrompt(portfolio, exclusions, letterPrompt, letterSamples),
    user: buildLetterUserPrompt(job, job.detail),
    schema: LETTER_SCHEMA,
  });

  const { letter, trimmed } = stripEchoedHeading(String(data.letter ?? '').trim());
  const words = letter.split(/\s+/).filter(Boolean).length;

  // Every question must be traceable to text actually in the posting.
  const { kept, dropped } = verifyQuestions(data.questions, job.description);

  return {
    letter,
    // Say what was removed rather than editing silently — the user is about to
    // send this, and should know it isn't verbatim what the model returned.
    trimmed,
    openingLine: data.opening_line ?? null,
    questions: kept,
    // Kept for the record: if this is ever non-empty the prompt needs work, and
    // silently discarding would hide that.
    droppedQuestions: dropped,
    words,
    model,
    provider: provider.ID,
    tokens: usage?.total ?? null,
    generatedAt: new Date().toISOString(),
  };
}
