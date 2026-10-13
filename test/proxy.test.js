import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

const env = {
  UPSTREAM: 'https://dav.example.org',
  ALLOWED_ORIGINS: 'https://app.example.org,http://localhost:4200',
  ALLOWED_PATHS: '/remote.php/dav/',
};
const ORIGIN = 'https://app.example.org';

/** Runs the worker with `fetch` replaced by a stub recording the upstream call. */
async function run(request, upstream = () => new Response('ok')) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return upstream(url, init);
  };
  try {
    return { response: await worker.fetch(request, env), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('rejects requests without an allowed origin', async () => {
  const { response, calls } = await run(new Request('https://proxy/remote.php/dav/calendars/u/c/', { method: 'PROPFIND' }));
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
  const other = await run(new Request('https://proxy/remote.php/dav/x', { headers: { Origin: 'https://evil.example' } }));
  assert.equal(other.response.status, 403);
});

test('answers preflight without touching the upstream', async () => {
  const { response, calls } = await run(new Request('https://proxy/remote.php/dav/calendars/u/c/', {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PROPFIND', 'Access-Control-Request-Headers': 'authorization,depth' },
  }));
  assert.equal(response.status, 204);
  assert.equal(calls.length, 0);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /PROPFIND/);
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /REPORT/);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /if-match/);
});

test('relays CalDAV requests with their headers and body, and exposes ETag', async () => {
  const request = new Request('https://proxy/remote.php/dav/calendars/u/c/t.ics?x=1', {
    method: 'PUT',
    headers: { Origin: ORIGIN, Authorization: 'Basic abc', 'Content-Type': 'text/calendar', 'If-None-Match': '*', 'X-Forwarded-For': 'nope' },
    body: 'BEGIN:VCALENDAR',
  });
  const { response, calls } = await run(request, async (_url, init) => {
    const body = await new Response(init.body).text();
    return new Response(null, { status: 201, headers: { ETag: '"1"', 'Set-Cookie': 'secret=1' } });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://dav.example.org/remote.php/dav/calendars/u/c/t.ics?x=1');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.get('authorization'), 'Basic abc');
  assert.equal(calls[0].init.headers.get('if-none-match'), '*');
  assert.equal(calls[0].init.headers.get('x-forwarded-for'), null);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('ETag'), '"1"');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(response.headers.get('Access-Control-Expose-Headers'), /etag/);
});

test('refuses paths outside the allowed prefixes and unknown methods', async () => {
  const path = await run(new Request('https://proxy/index.php/login', { headers: { Origin: ORIGIN } }));
  assert.equal(path.response.status, 403);
  assert.equal(path.calls.length, 0);
  const method = await run(new Request('https://proxy/remote.php/dav/x', { method: 'MKCOL', headers: { Origin: ORIGIN } }));
  assert.equal(method.response.status, 405);
});

test('keeps redirects on the proxy host', async () => {
  const { response } = await run(
    new Request('https://proxy/remote.php/dav/calendars/u/c', { method: 'PROPFIND', headers: { Origin: ORIGIN } }),
    () => new Response(null, { status: 301, headers: { Location: 'https://dav.example.org/remote.php/dav/calendars/u/c/' } }),
  );
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), '/remote.php/dav/calendars/u/c/');
});

test('reports an unreachable upstream as 502 with CORS headers', async () => {
  const { response } = await run(
    new Request('https://proxy/remote.php/dav/x', { method: 'PROPFIND', headers: { Origin: ORIGIN } }),
    () => { throw new TypeError('fetch failed'); },
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});
