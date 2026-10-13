/**
 * CORS proxy for a CalDAV server, running as a Cloudflare Worker.
 *
 * Browsers only let the Budget PWA talk to CalDAV servers that send CORS headers, which hosted
 * providers (Infomaniak, Murena, Disroot, ...) do not. This worker relays the few CalDAV methods the
 * app needs to one upstream server and adds the headers. It stores nothing and only answers requests
 * coming from the origins listed in `ALLOWED_ORIGINS`, so it cannot be used as an open proxy.
 *
 * Configuration (wrangler.toml `[vars]` or the Cloudflare dashboard):
 * - UPSTREAM         origin of the CalDAV server, e.g. "https://murena.io"
 * - ALLOWED_ORIGINS  comma-separated browser origins, e.g. "https://cgreg21.github.io,http://localhost:4200"
 * - ALLOWED_PATHS    optional comma-separated path prefixes allowed upstream, e.g. "/remote.php/dav/"
 */

const METHODS = ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'REPORT'];
const REQUEST_HEADERS = ['authorization', 'content-type', 'depth', 'if-match', 'if-none-match', 'prefer'];
const EXPOSED_HEADERS = ['etag', 'content-type', 'dav', 'allow'];
const MAX_AGE = '86400';

const list = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': METHODS.join(', '),
    'Access-Control-Allow-Headers': REQUEST_HEADERS.join(', '),
    'Access-Control-Expose-Headers': EXPOSED_HEADERS.join(', '),
    'Access-Control-Max-Age': MAX_AGE,
    'Vary': 'Origin',
  };
}

const reply = (status, message, headers = {}) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = list(env.ALLOWED_ORIGINS);
    if (!origin || !allowedOrigins.includes(origin)) return reply(403, 'Origin not allowed');
    if (!METHODS.includes(request.method)) return reply(405, 'Method not allowed', { Allow: METHODS.join(', ') });

    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let upstream;
    try {
      upstream = new URL(env.UPSTREAM);
    } catch {
      return reply(500, 'UPSTREAM is not configured', cors);
    }
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
