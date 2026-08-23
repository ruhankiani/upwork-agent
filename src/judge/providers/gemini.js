/**
 * Gemini adapter.
 *
 * The free option. The free tier allows 15 requests/minute, so calls are paced
 * — see rateLimiter in ../llm.js. Gemini takes an OpenAPI-flavoured schema with
 * uppercase type names, which is the shape prompt.js writes natively.
 */
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const ID = 'gemini';
export const LABEL = 'Google Gemini';
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
export const KEY_URL = 'https://aistudio.google.com/apikey';
export const KEY_HINT = 'Free. Sign in with a Google account and click "Create API key".';

export const MODELS = [
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', note: 'Free tier — fastest, the default' },
  { id: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash', note: 'Free tier — a bit sharper, a bit slower' },
];

/** Free tier is 15/min; stay under it. */
export const REQUESTS_PER_MINUTE = 12;

/** True when the failure is worth trying again — rate limits and server faults. */
const retryable = (status) => status === 429 || status >= 500;

export async function callModel({ key, model = DEFAULT_MODEL, system, user, schema, timeoutMs = 60_000 }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0, // judging should be as reproducible as the model allows
    },
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const json = await res.json();

    if (!res.ok) {
      const err = new Error(`${res.status} ${json.error?.message ?? 'request failed'}`);
      err.retryable = retryable(res.status);
      throw err;
    }

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty response');
    return { data: JSON.parse(text), usage: json.usageMetadata ?? null };
  } finally {
    clearTimeout(timer);
  }
}
