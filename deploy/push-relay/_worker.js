// Optional Cloudflare Pages egress for Node hosts that cannot reach Chrome's FCM.
// The VAPID private key and plaintext task data never leave the Node host. This relay
// accepts only encrypted Web Push payloads for FCM, with a server-only 256-bit token.
const MAX_REQUEST_BYTES = 12_000;
const NO_STORE = { 'cache-control': 'no-store' };
const HEADER_NAMES = ['authorization', 'ttl', 'content-encoding', 'content-type'];

function sameToken(actual, expected) {
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expected)) return false;
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) mismatch |= (actual.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

function validDestination(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'fcm.googleapis.com' && !url.port &&
      !url.username && !url.password && !url.hash && !url.search &&
      (/^\/fcm\/send\/[A-Za-z0-9:_-]+$/.test(url.pathname) || /^\/wp\/[A-Za-z0-9:_-]+$/.test(url.pathname));
  } catch { return false; }
}

function validHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...HEADER_NAMES].sort().join(',')) return false;
  return typeof value.authorization === 'string' &&
    /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]{86,88}$/.test(value.authorization) &&
    value.authorization.length <= 1200 && value.ttl === '3600' &&
    value['content-encoding'] === 'aes128gcm' && value['content-type'] === 'application/octet-stream';
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/push' || request.method !== 'POST') return new Response(null, { status: 404, headers: NO_STORE });
    if (!sameToken(request.headers.get('x-otto-push-relay-token') || '', env.RELAY_TOKEN))
      return new Response(null, { status: 403, headers: NO_STORE });
    if (request.headers.get('content-type') !== 'application/json' ||
        Number(request.headers.get('content-length') || 0) > MAX_REQUEST_BYTES)
      return new Response(null, { status: 400, headers: NO_STORE });
    try {
      const raw = await request.arrayBuffer();
      if (raw.byteLength > MAX_REQUEST_BYTES) return new Response(null, { status: 413, headers: NO_STORE });
      const data = JSON.parse(new TextDecoder().decode(raw));
      if (!data || !validDestination(data.endpoint) || !validHeaders(data.headers) ||
          typeof data.body !== 'string' || data.body.length > 11_000 || !/^[A-Za-z0-9_-]+$/.test(data.body))
        return new Response(null, { status: 400, headers: NO_STORE });
      const bytes = Uint8Array.from(atob(data.body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - data.body.length % 4) % 4)), c => c.charCodeAt(0));
      if (bytes.byteLength < 100 || bytes.byteLength > 8192)
        return new Response(null, { status: 400, headers: NO_STORE });
      // Workers do not support redirect:'error'. Manual avoids sending the signed
      // VAPID Authorization header to a redirect target; never follow redirects.
      const response = await fetch(data.endpoint, {
        method: 'POST', headers: data.headers, body: bytes,
        redirect: 'manual', signal: AbortSignal.timeout(9000),
      });
      if (response.status >= 300 && response.status < 400) return new Response(null, { status: 502, headers: NO_STORE });
      // Do not echo the upstream body: it can contain endpoint or credential details.
      return new Response(null, { status: response.status, headers: NO_STORE });
    } catch {
      return new Response(null, { status: 502, headers: NO_STORE });
    }
  },
};
