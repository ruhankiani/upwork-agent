/**
 * Which model judges your jobs, and with what key.
 *
 * Two providers, one interface. Gemini is free and good enough to be the
 * default; Claude costs money and reasons better about the question that
 * actually matters — is this the kind of work you do, or does it merely mention
 * the same tools. Everything provider-specific lives in ./providers/*, so the
 * judge itself never knows which one it is talking to.
 *
 * Keys are kept in data/llm.json rather than .env: they are per-machine
 * settings a user should be able to paste into the app, not something to edit a
 * dotfile for — and data/ is gitignored and never ships inside the app bundle.
 * An existing GEMINI_API_KEY in the environment or .env still works, so nothing
 * breaks for a setup that predates this.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DATA_DIR, dataFile, ENV_FILE } from '../paths.js';
import * as gemini from './providers/gemini.js';
import * as anthropic from './providers/anthropic.js';

const CONFIG_FILE = dataFile('llm.json');

export const PROVIDERS = { gemini, anthropic };

export const DEFAULTS = {
  provider: 'gemini',
  models: { gemini: gemini.DEFAULT_MODEL, anthropic: anthropic.DEFAULT_MODEL },
  keys: { gemini: '', anthropic: '' },
};

/** Everything the settings UI needs to draw itself, without hardcoding it there. */
export function catalogue() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.ID,
    label: p.LABEL,
    models: p.MODELS,
    defaultModel: p.DEFAULT_MODEL,
    keyUrl: p.KEY_URL,
    keyHint: p.KEY_HINT,
  }));
}

export async function readConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    return {
      provider: raw.provider in PROVIDERS ? raw.provider : DEFAULTS.provider,
      models: { ...DEFAULTS.models, ...(raw.models ?? {}) },
      keys: { ...DEFAULTS.keys, ...(raw.keys ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function writeConfig(patch) {
  const current = await readConfig();
  const next = {
    provider: patch.provider in PROVIDERS ? patch.provider : current.provider,
    models: { ...current.models, ...(patch.models ?? {}) },
    keys: { ...current.keys, ...(patch.keys ?? {}) },
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** The old home for the Gemini key. Still honoured so existing setups keep working. */
async function legacyGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    const env = await readFile(ENV_FILE, 'utf8');
    const line = env.split('\n').find((l) => l.startsWith('GEMINI_API_KEY='));
    if (line) return line.slice('GEMINI_API_KEY='.length).trim();
  } catch {
    /* no .env */
  }
  return null;
}

export async function resolve(overrides = {}) {
  const cfg = await readConfig();
  const id = overrides.provider ?? cfg.provider;
  const provider = PROVIDERS[id] ?? PROVIDERS[DEFAULTS.provider];

  let key = overrides.key ?? cfg.keys[provider.ID] ?? '';
  if (!key && provider.ID === 'gemini') key = (await legacyGeminiKey()) ?? '';
  if (!key && provider.ID === 'anthropic') key = (process.env.ANTHROPIC_API_KEY ?? '').trim();

  return {
    provider,
    key: key.trim(),
    model: overrides.model ?? cfg.models[provider.ID] ?? provider.DEFAULT_MODEL,
  };
}

/** What the judge reports when it cannot start. Names the fix, not just the fault. */
export async function missingKeyMessage() {
  const { provider } = await resolve();
  return `No ${provider.LABEL} API key. Open the app → Judge tab, paste a key from ${provider.KEY_URL}, and save.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One structured-output call, with retries.
 *
 * Retries live here rather than in each provider so both behave the same on a
 * rate limit — which, on Gemini's free tier, is a matter of when and not if.
 */
export async function callModel({ key, model, system, user, schema, provider, maxRetries = 4, timeoutMs }) {
  const target = PROVIDERS[provider] ?? (await resolve()).provider;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await target.callModel({ key, model, system, user, schema, timeoutMs });
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`timed out after ${timeoutMs}ms`) : err;
      // The SDK already retried its own 429s; anything a provider marks as not
      // worth retrying (a bad key, a bad request) will not fix itself either.
      if (err.retryable === false || attempt === maxRetries) break;
      await sleep(Math.min(2 ** attempt * 2000, 30_000));
    }
  }
  throw lastErr ?? new Error('model call failed');
}

/**
 * Prove a key works, before a scheduled run at 3am is the thing that finds out.
 *
 * Deliberately a real round trip with the same structured-output machinery a
 * judgement uses — a key that authenticates but whose model rejects the schema
 * is still broken, and only a real call surfaces that.
 */
export async function testConnection({ provider, key, model } = {}) {
  const target = PROVIDERS[provider] ?? (await resolve()).provider;
  const useKey = (key ?? (await resolve({ provider })).key ?? '').trim();
  if (!useKey) return { ok: false, error: `No ${target.LABEL} key saved yet.` };

  const started = Date.now();
  try {
    const { data, usage } = await target.callModel({
      key: useKey,
      model: model ?? target.DEFAULT_MODEL,
      system: 'You are a connectivity check. Reply with ok set to true.',
      user: 'ping',
      schema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
      timeoutMs: 45_000,
    });
    return {
      ok: data?.ok === true,
      ms: Date.now() - started,
      model: model ?? target.DEFAULT_MODEL,
      tokens: usage?.totalTokenCount ?? null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Simple pacer so a free tier's requests-per-minute cap is respected. */
export function rateLimiter(perMinute = 12) {
  if (!perMinute) return async () => {};
  const gap = 60_000 / perMinute;
  let last = 0;
  return async () => {
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

// Kept so existing imports keep resolving; the real default now depends on the
// chosen provider and comes from resolve().
export const DEFAULT_MODEL = gemini.DEFAULT_MODEL;
