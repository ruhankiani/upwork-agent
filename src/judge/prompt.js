/**
 * The judge prompt.
 *
 * The model is asked for *judgments*, never a score: extract what the posting
 * requires, decide whether the portfolio covers each item, and classify how
 * close the work is to what you actually do. score.js turns that into a number.
 *
 * Two things the research on LLM-as-judge is consistent about, both applied
 * here: decompose the rubric into independent checks rather than asking for one
 * overall rating, and make the model reason before it labels.
 */

/** Response shape, enforced by Gemini's structured-output mode. */
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    task_alignment: {
      type: 'STRING',
      enum: ['core', 'adjacent', 'different'],
      description: 'How close the actual work is to what the portfolio does day to day',
    },
    // Asked as its own yes/no rather than left to surface in red_flags. Relying
    // on the model to remember to add a flag let a posting through at 56 whose
    // own summary said it was work the freelancer excludes.
    matches_exclusion: {
      type: 'BOOLEAN',
      description:
        "True if the posting's CORE ask is something on the freelancer's not-interested list. " +
        'False if the excluded thing is merely mentioned in passing or done by someone else.',
    },
    exclusion_reason: {
      type: 'STRING',
      description: 'Which exclusion it matches and why, or empty string if none',
    },
    requirements: {
      type: 'ARRAY',
      description: 'Every capability the posting asks for, one entry each',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING', description: 'The requirement, in a few words' },
          type: { type: 'STRING', enum: ['must_have', 'nice_to_have'] },
          status: { type: 'STRING', enum: ['met', 'partial', 'missing'] },
          evidence: {
            type: 'STRING',
            description: 'What in the portfolio supports this, or why it is missing',
          },
        },
        required: ['text', 'type', 'status', 'evidence'],
      },
    },
    red_flags: {
      type: 'ARRAY',
      description: 'Things in the posting that would make you decline it',
      items: { type: 'STRING' },
    },
    summary: { type: 'STRING', description: 'One or two sentences on the fit' },
    proposal_angle: {
      type: 'STRING',
      description: 'The strongest opening pitch, or empty string if not worth applying',
    },
  },
  required: [
    'task_alignment',
    'matches_exclusion',
    'exclusion_reason',
    'requirements',
    'red_flags',
    'summary',
    'proposal_angle',
  ],
};

export function buildSystemPrompt(portfolio, rubric, exclusions = '') {
  const exclusionBlock = exclusions.trim()
    ? `## Work this person does NOT want

This list is stated by the freelancer, so it is authoritative — do not second-guess
it and do not soften it.

Set matches_exclusion=true whenever the posting's CORE ask is on this list, and
name the match in exclusion_reason. Do this even when the posting is otherwise
appealing, well paid, or uses tools the freelancer knows — an excluded job is
excluded regardless of its other merits.

Judge the *core ask*, not stray words. A posting that says "you'll work alongside
our ad buyers" is not itself ad buying; a posting asking you to run daily campaigns
is. If in doubt about whether the core ask is excluded, set it true and explain.

${exclusions}`
    : `## Work this person does NOT want

They have not listed any exclusions, so infer cautiously from what the portfolio
shows they do, and say so in your reasoning rather than asserting it as fact.`;

  return buildPrompt(portfolio, rubric, exclusionBlock);
}

function buildPrompt(portfolio, rubric, exclusionBlock) {
  return `You assess whether an Upwork job posting is a good fit for one specific freelancer.

You do NOT produce a score. You produce structured judgments; a separate
deterministic system computes the number. Your job is accuracy on three things:
which capabilities the posting requires, whether the portfolio covers each one,
and how close the work is to what this person actually does.

## Rules

1. Judge only what the posting says. Never invent requirements it doesn't state,
   and never credit the portfolio with skills it doesn't list.

2. Split requirements into must_have and nice_to_have honestly. Upwork clients
   routinely write wish-lists as if everything were mandatory. Treat something as
   must_have only if the work genuinely cannot be delivered without it. Phrases
   like "bonus if", "a plus", "ideally", "familiarity with" are nice_to_have.
   Boilerplate such as "excellent communication" or "self-starter" is
   nice_to_have, not must_have.

3. status:
   - met — the portfolio clearly shows this capability
   - partial — related or transferable experience, but not the exact thing
   - missing — nothing in the portfolio supports it
   Give concrete evidence, citing the portfolio. For missing, say what's absent.

4. task_alignment:
   - core — this is the freelancer's day-to-day work
   - adjacent — same field, but a different kind of task
   - different — a different discipline entirely

5. Be sceptical. Most postings are not a good fit for a specialist. If you find
   yourself marking everything "met" and "core", you are being too generous.

6. The portfolio below is written by the freelancer in whatever form suits them.
   It may be a tidy document, rough notes, or raw text copied straight from a
   profile page complete with interface labels, ratings and job titles. Read
   through the formatting and use the substance. Never treat missing structure
   as missing skill — but equally, only credit skills the text actually shows.

7. If the portfolio doesn't state a rate, a minimum, or the kind of work they
   decline, do not guess at those. Judge the skill match on what's there and let
   the separate preference scoring handle money and timing.

## The freelancer's portfolio

${portfolio}

${exclusionBlock}

## Scoring guidance

${rubric}`;
}

export function buildUserPrompt(job, detail) {
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
    job.engagement && `Workload: ${job.engagement}`,
    job.skills?.length && `Tags: ${job.skills.join(', ')}`,
    detail?.proposalsText && `Proposals so far: ${detail.proposalsText}`,
    detail?.clientSpend != null && `Client has spent $${detail.clientSpend} across ${detail.clientHires ?? '?'} hires`,
    detail?.clientCountry && `Client location: ${detail.clientCountry}`,
  ]
    .filter(Boolean)
    .join('\n');

  // Long postings are mostly boilerplate past this point, and free-tier tokens
  // are finite.
  const description = (job.description ?? '').slice(0, 6000);

  return `${facts}

## Posting

${description}`;
}
