/**
 * CORS proxy for a CalDAV server, running as a Cloudflare Worker.
 *
 * Browsers only let the Budget PWA talk to CalDAV servers that send CORS headers, which most hosted
 * providers do not. This worker relays the few CalDAV methods the app needs to the server named by
 * the request's `X-Upstream` header (or a default) and adds the headers. It stores nothing. By default
 * any browser origin and any https server are accepted; restrict them with the variables below.
 *
 * Configuration (wrangler.toml `[vars]` or the Cloudflare dashboard), all optional:
 * - UPSTREAM           default CalDAV server origin when the request has no `X-Upstream` header
 * - ALLOWED_UPSTREAMS  comma-separated origins accepted in `X-Upstream`; empty allows any https origin
 * - ALLOWED_ORIGINS    comma-separated browser origins; empty or "*" allows all
 * - ALLOWED_PATHS      comma-separated path prefixes allowed upstream, e.g. "/remote.php/dav/"; empty allows all
 */

const METHODS = ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'REPORT'];
const REQUEST_HEADERS = ['authorization', 'content-type', 'depth', 'if-match', 'if-none-match', 'prefer'];
const UPSTREAM_HEADER = 'x-upstream';
const EXPOSED_HEADERS = ['etag', 'content-type', 'dav', 'allow'];
const MAX_AGE = '86400';

const list = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': METHODS.join(', '),
    'Access-Control-Allow-Headers': REQUEST_HEADERS.concat(UPSTREAM_HEADER).join(', '),
    'Access-Control-Expose-Headers': EXPOSED_HEADERS.join(', '),
    'Access-Control-Max-Age': MAX_AGE,
    'Vary': 'Origin',
  };
}

const reply = (status, message, headers = {}) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

/** The CalDAV server origin for this request: the `X-Upstream` header, else the `UPSTREAM` variable. */
function resolveUpstream(request, env) {
  const requested = request.headers.get(UPSTREAM_HEADER);
  const value = requested ?? env.UPSTREAM;
  if (!value) return { error: 'No upstream: send an X-Upstream header or set UPSTREAM' };
  let upstream;
  try {
    upstream = new URL(value);
  } catch {
    return { error: 'Invalid upstream' };
  }
  if (upstream.protocol !== 'https:' || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    return { error: 'Upstream must be an https origin without path' };
  }
  const allowed = list(env.ALLOWED_UPSTREAMS);
  if (requested !== null && allowed.length > 0 && !allowed.includes(upstream.origin)) return { error: 'Upstream not allowed' };
  return { upstream };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = list(env.ALLOWED_ORIGINS);
    const allowAll = allowedOrigins.length === 0 || allowedOrigins.includes('*');
    if (!allowAll && (!origin || !allowedOrigins.includes(origin))) return reply(403, 'Origin not allowed');
    if (!METHODS.includes(request.method)) return reply(405, 'Method not allowed', { Allow: METHODS.join(', ') });

    const cors = corsHeaders(origin ?? '*');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const resolved = resolveUpstream(request, env);
    if (resolved.error) return reply(resolved.error.startsWith('Upstream not allowed') ? 403 : 400, resolved.error, cors);
    const { upstream } = resolved;
    const url = new URL(request.url);
    const allowedPaths = list(env.ALLOWED_PATHS);
    if (allowedPaths.length > 0 && !allowedPaths.some((prefix) => url.pathname.startsWith(prefix))) {
      return reply(403, 'Path not allowed', cors);
    }

    const target = new URL(url.pathname + url.search, upstream);
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('User-Agent', 'budget-caldav-proxy');

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let response;
    try {
      response = await fetch(target, {
        method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual', duplex: 'half',
      });
    } catch {
      return reply(502, 'Upstream unreachable', cors);
    }

    const out = new Headers(cors);
    for (const name of EXPOSED_HEADERS.concat(['content-length', 'cache-control', 'location'])) {
      const value = response.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    // Redirects are rewritten to stay on the proxy host so the browser keeps the CORS headers.
    const location = out.get('location');
    if (location !== null) {
      const resolved = new URL(location, target);
      if (resolved.origin === upstream.origin) out.set('location', resolved.pathname + resolved.search);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
  },
};
