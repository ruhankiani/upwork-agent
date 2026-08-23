/**
 * Upwork search URL construction.
 *
 * Every filter Upwork's search UI exposes is declared here as data, so the same
 * definitions can drive the CLI now and a settings UI later. Nothing is applied
 * by default except paging and sort — an unset filter means "no restriction",
 * which is how Upwork's own search behaves.
 *
 * Multi-value filters are comma-separated in the URL (`location=Americas,Europe`).
 */

import { CATEGORIES, TIMEZONES } from './categories.js';

export const BASE_URL = 'https://www.upwork.com/nx/search/jobs';

/** uid -> readable name, so summaries don't print bare numbers. */
const LABELS = {
  category2_uid: Object.fromEntries(CATEGORIES.map((c) => [c.uid, c.label])),
  subcategory2_uid: Object.fromEntries(
    CATEGORIES.flatMap((c) => c.subs.map((s) => [s.uid, s.label])),
  ),
  timezone: Object.fromEntries(TIMEZONES.map((t) => [t.value, t.label])),
};

/** @type {Record<string, {label: string, multi?: boolean, values?: Record<string,string>, example?: string, note?: string}>} */
export const FILTERS = {
  q: {
    label: 'Search keywords',
    example: 'react typescript',
    note: 'Supports AND / OR / NOT and quoted phrases',
  },

  location: {
    label: 'Client location',
    multi: true,
    ui: 'locations',
    example: 'Americas,Europe',
    note: 'Regions, subregions or individual countries — all verified working',
  },

  category2_uid: {
    label: 'Category',
    multi: true,
    ui: 'categories',
    example: '531770282580668420',
    note: "Upwork's top-level job categories",
  },

  subcategory2_uid: {
    label: 'Subcategory',
    multi: true,
    ui: 'subcategories',
    example: '531770282593251329',
    note: 'Narrows within the chosen categories',
  },

  timezone: {
    label: 'Client timezone',
    multi: true,
    ui: 'timezones',
    example: 'America/New_York,Europe/London',
    note: "Upwork's own IANA ids — Alaska is America/Nome, not America/Anchorage",
  },

  t: {
    label: 'Job type',
    multi: true,
    values: { 0: 'Hourly', 1: 'Fixed-Price' },
    example: '0,1',
    note: 'Auto-set from --hourly_rate / --amount when not given explicitly',
  },

  hourly_rate: {
    label: 'Hourly rate (USD)',
    ui: 'range',
    example: '10-50',
    note: 'Open-ended forms work: 40- is $40+, -50 is up to $50. Implies job type hourly.',
  },

  amount: {
    label: 'Fixed-price budget',
    multi: true,
    ui: 'buckets+range',
    // Verified by clicking each bucket in Upwork's own filter panel and
    // reading the resulting URL.
    values: {
      '0-99': 'Less than $100',
      '100-499': '$100 to $500',
      '500-999': '$500 - $1K',
      '1000-4999': '$1K - $5K',
      '5000-': '$5K+',
    },
    example: '100-499,500-999,5000-',
    note: 'A custom MIN-MAX also works. Implies job type fixed.',
  },

  contractor_tier: {
    label: 'Experience level',
    multi: true,
    values: { 1: 'Entry level', 2: 'Intermediate', 3: 'Expert' },
    example: '2,3',
  },

  client_hires: {
    label: 'Client history',
    multi: true,
    values: { 0: 'No hires', '1-9': '1 to 9 hires', '10-': '10+ hires' },
    example: '10-',
  },

  // Deliberately absent: `proposals` and `payment_verified`. Both exist in
  // Upwork's logged-in search but not in the public one this scraper uses —
  // tested, and they return identical result sets, i.e. silently ignored.

  duration_v3: {
    label: 'Project length',
    multi: true,
    values: {
      week: 'Less than one month',
      month: '1 to 3 months',
      semester: '3 to 6 months',
      ongoing: 'More than 6 months',
    },
    example: 'month,semester,ongoing',
  },

  workload: {
    label: 'Hours per week',
    multi: true,
    values: { as_needed: 'Less than 30 hrs/week', full_time: 'More than 30 hrs/week' },
    example: 'as_needed,full_time',
  },

  contract_to_hire: {
    label: 'Job duration',
    values: { true: 'Contract-to-hire roles' },
    example: 'true',
  },

  sort: {
    label: 'Result ordering',
    values: {
      recency: 'newest first',
      'relevance+desc': 'most relevant',
      'client_total_charge+desc': 'highest client spend',
    },
    example: 'recency',
    note: 'Defaults to recency',
  },

  per_page: {
    label: 'Results per page',
    values: { 10: '10', 20: '20', 50: '50' },
    note: 'Defaults to 50, which is the maximum Upwork renders',
  },

  page: { label: 'Page number', note: 'Defaults to 1' },
};

/** Only paging/ordering — these don't change which jobs match. */
const NON_FILTER_KEYS = new Set(['sort', 'per_page', 'page']);

/**
 * Build a search URL from a plain `{param: value}` object.
 * Only `sort`, `per_page` and `page` get defaults; everything else is applied
 * solely when the caller sets it.
 */
export function buildSearchUrl(params = {}) {
  const url = new URL(BASE_URL);

  url.searchParams.set('sort', params.sort ?? 'recency');
  url.searchParams.set('per_page', params.per_page ?? '50');
  url.searchParams.set('page', params.page ?? '1');

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (!(key in FILTERS)) continue;
    if (['sort', 'per_page', 'page'].includes(key)) continue;
    url.searchParams.set(key, String(value));
  }

  // Upwork gates rate filters behind the job-type param: hourly_rate only
  // applies with t=0, amount only with t=1. Derive it so a rate filter given
  // on its own isn't silently ignored.
  if (!params.t) {
    const types = [];
    if (params.hourly_rate) types.push('0');
    if (params.amount) types.push('1');
    if (types.length) url.searchParams.set('t', types.join(','));
  }

  return url.toString();
}

/** Human-readable summary of which filters are actually in effect. */
export function describeFilters(params = {}) {
  const active = Object.entries(params).filter(
    ([k, v]) => k in FILTERS && !NON_FILTER_KEYS.has(k) && v !== undefined && v !== '',
  );
  if (!active.length) return 'no filters — all newest jobs';

  return active
    .map(([k, v]) => {
      const f = FILTERS[k];
      const lookup = f.values ?? LABELS[k];
      const decoded = lookup
        ? String(v)
            .split(',')
            .map((part) => lookup[part] ?? part)
            .join(', ')
        : v;
      return `${f.label}: ${decoded}`;
    })
    .join('\n  ');
}

/** `--help` output, generated from the definitions above. */
export function helpText() {
  const lines = ['', 'Usage: node src/fetch.js [--filter=value ...]', ''];
  lines.push('Filters (none are applied unless you set them):');
  for (const [key, f] of Object.entries(FILTERS)) {
    lines.push('');
    lines.push(`  --${key}=${f.example ?? '<value>'}`);
    lines.push(`      ${f.label}${f.multi ? ' (comma-separated for multiple)' : ''}`);
    if (f.values) {
      const opts = Object.entries(f.values)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      lines.push(`      options: ${opts}`);
    }
    if (f.note) lines.push(`      ${f.note}`);
  }
  lines.push('');
  lines.push('Other options:');
  lines.push('  --url=<full Upwork search URL>   use a URL copied from your browser instead');
  lines.push('  --visible                        show the browser window (debugging only)');
  lines.push('  --debug                          log every network call');
  lines.push('  --help                           this message');
  lines.push('');
  lines.push('Examples:');
  lines.push('  node src/fetch.js --q="react" --location="Americas,Europe" --hourly_rate="40-"');
  lines.push('  node src/fetch.js --amount="1000-4999,5000-" --proposals="0-4"');
  lines.push('  node src/fetch.js --contractor_tier="3" --client_hires="10-" --payment_verified=1');
  lines.push('');
  return lines.join('\n');
}
