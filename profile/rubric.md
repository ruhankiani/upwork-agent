# Scoring rubric

How to score an Upwork posting from 0-100 against the portfolio.

Score the **posting as written**. Do not invent details it doesn't contain.
When information is missing, say so in `concerns` rather than assuming the worst
or the best — a vague posting from a promising client is still vague.

## Weights

| Weight | Dimension | What raises the score |
|--:|---|---|
| 40% | **Skill match** | The work is analytics implementation, tag management, conversion tracking or dashboard/reporting work, and names tools from the portfolio (GA4, GTM, Looker Studio, Tableau, Meta Pixel, BigQuery). Highest when the posting describes a concrete measurement problem. |
| 25% | **Budget fit** | Hourly at or above $45/hr, or fixed at $1,200+ with scope that justifies it. Rates around $25-40/hr score mid. Below the stated minimums score very low regardless of how interesting the work is. |
| 20% | **Scope clarity** | Specific deliverables, named platforms and tools, defined success criteria. A clear small project beats a vague large one. |
| 15% | **Engagement shape** | Ongoing reporting retainers and scoped implementations or audits score highest. Very short one-off tasks and open-ended full-time roles score lower. |

## Hard disqualifiers — score 0-15 and set verdict "skip"

Any of these, regardless of everything else:

- Explicitly in the portfolio's "poor fits" list
- Fixed price under $250 or hourly max under $25
- Equity-only, revenue-share, unpaid, or "prove yourself first"
- Requires on-site presence or a timezone with no Eastern Time overlap
- The core ask is media buying, design, general web/app development, content
  writing, or cold outreach — measurement work *about* those things is fine,
  doing those things is not

## Bands

| Score | Verdict | Meaning |
|---|---|---|
| 80-100 | `strong` | Clear fit, worth a tailored proposal today |
| 60-79 | `decent` | Plausible fit with a caveat — worth a look |
| 30-59 | `weak` | Adjacent but not really the work, or budget is off |
| 0-29 | `skip` | Wrong work, or hits a disqualifier |

## Calibration

Be sceptical by default. A typical Upwork posting is **not** a good fit for a
specialist — most should land in `weak` or `skip`. If more than roughly one in
five postings is scoring `strong`, the scoring is too generous.

Reserve 90+ for postings that are unmistakably the portfolio's exact work at a
good rate. "Interesting and adjacent" is a 60, not an 85.

## Output fields

- `score` — 0-100 integer
- `verdict` — one of `strong` / `decent` / `weak` / `skip`
- `reasoning` — 1-3 sentences, concrete, referencing the posting. No filler.
- `matched_skills` — portfolio skills the posting actually calls for
- `concerns` — risks, ambiguities, or missing information
- `proposal_angle` — one sentence on the strongest opening pitch, or `null` when
  the verdict is `skip`
