// Test helper for remote/*.test.ts: a scripted fetch. Each route answers one "METHOD /path" (query string ignored
// unless the key contains '?'); every request is recorded so tests can check the URL, body and CSRF header.
import { vi } from 'vitest';
import { configureHttp } from './http';

export interface Recorded { method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> }
type Answer = { status?: number; body?: unknown } | ((req: Recorded) => { status?: number; body?: unknown });

export const BASE = 'http://api.test/api/v1';

export function mockFetch(routes: Record<string, Answer>) {
  const calls: Recorded[] = [];
  const all: Record<string, Answer> = { 'GET /auth/csrf': { body: { csrfToken: 'csrf-1' } }, ...routes };
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = u.pathname.replace('/api/v1', '');
    let body: unknown = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    const rec: Recorded = { method, path, query: u.searchParams, body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(rec);
    const key = Object.keys(all).find((k) => k === `${method} ${path}${u.search}`) ?? Object.keys(all).find((k) => k === `${method} ${path}`)
      ?? Object.keys(all).find((k) => { const [m, p] = k.split(' '); return m === method && new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}$`).test(path); });
    if (!key) return new Response(JSON.stringify({ code: 'NOT_FOUND', message: `No mock for ${method} ${path}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const a = all[key]; const r = typeof a === 'function' ? a(rec) : a;
    const status = r.status ?? 200;
    if (status === 204 || r.body === undefined) return new Response(null, { status: status === 200 ? 204 : status });
    return new Response(JSON.stringify(r.body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  configureHttp(BASE);
  return { calls, fn, last: (m: string, p: string) => [...calls].reverse().find((c) => c.method === m && c.path === p) };
}
