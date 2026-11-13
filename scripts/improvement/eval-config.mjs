// Explicit eval profile: share production's model builder, never read production secrets/DB.
import { readFileSync } from 'node:fs';
import { hash } from './provenance.mjs';

const levels = new Set(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export function readEvalProfile(path, env = process.env) {
  let input;
  try { input = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Cannot read eval profile JSON'); }
  const fields = new Set(['provider', 'modelId', 'baseUrl', 'thinkingLevel', 'apiKeyEnv', 'headersEnv', 'label']);
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !fields.has(key))) {
    throw new Error('Invalid eval profile fields; credentials must use apiKeyEnv/headersEnv');
  }
  for (const field of ['provider', 'modelId', 'apiKeyEnv', 'label']) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`Eval profile requires ${field}`);
  }
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(input.label)) throw new Error('Profile label must be a non-secret identifier');
  if (!levels.has(input.thinkingLevel)) throw new Error('Profile requires an explicit thinkingLevel');
  for (const field of ['apiKeyEnv', 'headersEnv']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(input[field]))) throw new Error(`Invalid ${field}`);
  }
  if (input.baseUrl !== undefined) {
    try {
      const url = new URL(input.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { throw new Error('baseUrl must be an HTTP(S) URL without credentials, query or fragment'); }
  }
  if (input.provider.endsWith('-compatible') && !input.baseUrl) throw new Error('Compatible profiles require baseUrl');
  const apiKey = env[input.apiKeyEnv];
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Eval API key environment variable is empty');
  let headers;
  if (input.headersEnv !== undefined) {
    try { headers = JSON.parse(env[input.headersEnv]); } catch { throw new Error('Invalid headers environment JSON'); }
    if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.entries(headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value))) {
      throw new Error('Headers must be a string-valued HTTP header object');
    }
  }
  const config = { provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel, explicit: true,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}), ...(headers ? { headers } : {}) };
  // No keys, raw endpoint (paths can contain tokens), header names/values, or env values.
  const safe = { mode: 'production-builder', label: input.label, provider: input.provider, modelId: input.modelId,
    requestedThinkingLevel: input.thinkingLevel, endpointHash: input.baseUrl ? hash(input.baseUrl) : null,
    customHeaders: headers !== undefined };
  return { config, apiKey, safe };
}
