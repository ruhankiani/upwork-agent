/**
 * Claude adapter.
 *
 * The paid option, and the reason to pay: judging a posting against a rubric is
 * a reasoning task, not an extraction one — whether "GA4 audit" is core work or
 * merely adjacent is exactly the call a stronger model gets right more often.
 *
 * Uses the official SDK rather than raw fetch, so retries, timeouts and typed
 * errors come from Anthropic rather than from us.
 */
import Anthropic from '@anthropic-ai/sdk';

export const ID = 'anthropic';
export const LABEL = 'Anthropic Claude';
export const DEFAULT_MODEL = 'claude-opus-5';
export const KEY_URL = 'https://console.anthropic.com/settings/keys';
export const KEY_HINT = 'Paid, billed per token. Create a key and add a little credit — judging a job costs a fraction of a cent.';

export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Best judgement — $5 / $25 per million tokens' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Cheaper, still strong — $3 / $15' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Cheapest — $1 / $5' },
];

/** No free-tier pacing needed; the SDK handles 429s itself. */
export const REQUESTS_PER_MINUTE = 0;

/**
 * prompt.js writes Gemini's OpenAPI dialect (uppercase type names). Claude wants
 * ordinary JSON Schema, and structured outputs additionally require every object
 * to close itself with additionalProperties:false. Converting here keeps one
 * schema definition serving both providers.
 */
export function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && typeof value === 'string') out.type = value.toLowerCase();
    else if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, toJsonSchema(v)]),
      );
    } else if (key === 'items') out.items = toJsonSchema(value);
    else out[key] = value;
  }

  if (out.type === 'object') {
    out.additionalProperties = false;
    // Structured outputs require every property to be listed as required.
    out.required = Object.keys(out.properties ?? {});
  }
  return out;
}

export async function callModel({ key, model = DEFAULT_MODEL, system, user, schema, timeoutMs = 120_000 }) {
  const client = new Anthropic({
    apiKey: key,
    timeout: timeoutMs, // milliseconds in the TS SDK
    maxRetries: 3,
  });

  const response = await client.messages.create({
    model,
    max_tokens: 16_000,
    system,
    messages: [{ role: 'user', content: user }],
    // Adaptive thinking: the model decides how much reasoning a posting needs,
    // which is what makes the paid option worth choosing over the free one.
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: toJsonSchema(schema) },
    },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`declined: ${response.stop_details?.category ?? 'unspecified'}`);
  }

  // With thinking on, the response carries thinking blocks too — the JSON is in
  // the text block, so pick that out rather than assuming content[0].
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('no text in response');

  return {
    data: JSON.parse(text),
    usage: {
      promptTokenCount: response.usage.input_tokens,
      candidatesTokenCount: response.usage.output_tokens,
      totalTokenCount: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}
