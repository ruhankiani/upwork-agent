# Architecture

How a job gets from Upwork's search page to a scored card with a cover letter.

## The pipeline

```
                                    ┌──────────── data/jobs.json ───────────┐
                                    │  every job ever seen, keyed by uid    │
                                    └───────────────────────────────────────┘
                                          ▲            ▲            ▲
   fetch.js ─────────────────────────────┘             │            │
     Chrome for Testing → search page                  │            │
     window.__NUXT__ → normalize → merge               │            │
                                                       │            │
   score.js ───────────────────────────────────────────┘            │
     prefilter → detail page → activity gate → LLM → maths          │
                                                                    │
   letters.js ──────────────────────────────────────────────────────┘
     top picks → LLM → letter + verified questions
```

Each stage is a standalone CLI. `server.js` spawns them as child processes and parses
their stdout for progress, so the UI and a terminal run identical code paths.

## Modules

| File | Responsibility |
|---|---|
| `paths.js` | Resolves data/profile/env locations. Dev checkout vs packaged app. |
| `browser.js` | Spawns Chrome for Testing, attaches over CDP, detects challenges. |
| `fetch.js` | One search → normalized jobs → store. |
| `search-url.js` | Every Upwork filter as data; builds and describes URLs. |
| `categories.js` `locations.js` | Generated filter vocabularies (uid → label). |
| `detail.js` | Parses a job's own page: proposals, invites, interviews, client history. |
| `store.js` | JSON store. Atomic writes, dedupe by posting id, run history. |
| `profile.js` | Reads/writes the user's files. Keeps one `.bak` per save. |
| `keywords.js` | Derives keywords from the portfolio; scores relevance. |
| `judge/index.js` | Scoring orchestration, the two gates, error classification. |
| `judge/score.js` | Deterministic maths: coverage, preferences, hard caps. |
| `judge/prompt.js` | Scoring prompt and response schema. |
| `judge/letter.js` | Cover letter prompt, schema, question verification. |
| `judge/llm.js` + `providers/` | Gemini and Anthropic behind one interface. |
| `letters.js` | Batch letter writing for top picks. |
| `scheduler.js` | Day/time windows, intervals, run state. |
| `server.js` | HTTP API, SSE broadcast, spawns the CLIs. |
| `ui/index.html` | The whole interface. One file, no framework. |

## Getting the jobs out of the page

Upwork's search is a Nuxt app that server-renders results into
`window.__NUXT__.state.jobsSearch.jobs`. There is no XHR to intercept on first load.

`findJobArray()` walks the state object looking for the first array whose members carry
job-shaped fields, rather than hardcoding a path — the path has moved before. Captured
JSON responses are a fallback, since pagination and filter changes do go over the wire.

`normalize()` translates Upwork's internals: `type: 1` is fixed-price and `2` is hourly,
a `0` budget means unspecified rather than free, tier strings arrive prefixed
(`jsn_Intermediate_206`), and descriptions contain `<span class="highlight">` markup.

## Scoring

The model returns structured judgments — requirement coverage, task alignment, red flags.
Code turns those into a number:

```
base   = 100 × coverage × (prefFloor + (1 − prefFloor) × preferenceScore)
score  = base, then hard caps applied
```

`coverage` weighs must-haves fully and nice-to-haves at `niceWeight`. `preferenceScore`
combines pay, competition, freshness and client history — **unknown dimensions are dropped
and the remaining weights renormalised**, so a job whose detail page failed isn't punished
for missing data.

Competition takes the worse of proposals and invites: being early on proposals means
nothing if the client has hand-invited ten people.

Hard caps then bound the result — exclusion match, wrong task, missing must-haves, below
pay floor, red flags. A job the user cannot do stays low no matter how well it pays.

## The store

`data/jobs.json`, written atomically via tmp+rename.

```jsonc
{
  "jobs": {
    "~021…": {
      "id": "~021…", "title": "…", "url": "…", "description": "…",
      "jobType": "hourly", "hourlyMin": 30, "hourlyMax": 60, "budget": null,
      "postedAt": "…", "firstSeenAt": "…", "lastSeenAt": "…", "seenCount": 3,
      "raw": { },        // the original payload, so new fields can be back-filled
      "detail": { },     // from the job's own page; null until scored
      "score": { },      // null until judged
      "letter": { }      // only for top picks
    }
  },
  "runs": [ { "at": "…", "searchUrl": "…", "found": 50, "new": 12 } ]
}
```

`raw` is kept deliberately: when a field turns out to matter, historical rows can be
re-parsed instead of re-scraped.

## The three views

Nested slices of one archive, not separate piles:

- **All jobs** — everything ever fetched
- **All recent** — posted within `scoreMaxAgeHours`
- **Top picks** — the recent ones scoring 60+

A top pick therefore also appears in the other two. They used to be mutually exclusive,
which made jobs vanish from Recent the moment they scored well, and put postings in the
old Backlog that were newer than things still showing as recent.

## Server API

| Route | Purpose |
|---|---|
| `GET /api/jobs` | Everything, plus stats and `maxAgeHours` |
| `GET /api/status` | Live progress of the running child |
| `GET /api/events` | SSE: `run-finished`, `letters-finished`, `attention`, `schedule` |
| `POST /api/run` | Fetch + score, then letters after responding |
| `POST /api/score` | Score or re-score |
| `POST /api/letter` | One letter, top picks only |
| `GET POST /api/profile` | The user's five editable files |
| `POST /api/profile/keywords/rebuild` | Re-derive keywords from the portfolio |
| `GET POST /api/filters-state` | Saved search filters |
| `GET POST /api/schedule` | Scheduler settings |

Only one child runs at a time, guarded by a `running` flag.
