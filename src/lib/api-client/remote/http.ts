// HTTP client for the real backend (Client_Portal_Backend, Node/Express under /api/v1).
// Used when app-config.json sets "apiBaseUrl"; otherwise the in-browser mock (../api.ts) stays in charge.
//
// - Cookies carry the session (credentials: 'include'); the backend is on another origin in development.
// - Every POST sends the CSRF token (X-CSRF-Token) from GET /auth/csrf; one automatic retry on CSRF_FAILED.
// - Errors come back as { code, message, fields?, details? } and are thrown as the same ApiError the screens already handle.
import { ApiError } from '../core';

let baseUrl = '';
let csrfToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

/** apiBaseUrl from app-config.json, e.g. "http://localhost:4000/api/v1" (a trailing slash is ignored). */
export function configureHttp(apiBaseUrl: string, opts: { onUnauthenticated?: () => void } = {}) {
  baseUrl = apiBaseUrl.replace(/\/+$/, '');
  if (!/\/api\/v\d+$/.test(baseUrl)) baseUrl += '/api/v1';
  csrfToken = null;
  onUnauthenticated = opts.onUnauthenticated ?? null;
}
export const apiBase = () => baseUrl;
export const setCsrfToken = (t: string | null | undefined) => { if (t) csrfToken = t; };

async function ensureCsrf() {
  if (csrfToken) return csrfToken;
  const r = await raw<{ csrfToken: string }>('GET', '/auth/csrf');
  csrfToken = r.csrfToken;
  return csrfToken;
}

type Query = Record<string, string | number | boolean | undefined | null>;
const qs = (q?: Query) => {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function raw<T>(method: string, path: string, body?: unknown, query?: Query, retried = false): Promise<T> {
  if (!baseUrl) throw new ApiError('NOT_CONFIGURED', 'The portal API address is not configured (app-config.json apiBaseUrl).', 500);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}${qs(query)}`, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the portal service. Check your connection and try again.', 0);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  const data: unknown = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (res.ok) return data as T;
  const e = (data && typeof data === 'object' ? data : {}) as { code?: string; message?: string; fields?: Record<string, string>; details?: Record<string, unknown> };
  const code = e.code ?? `HTTP_${res.status}`;
  if (code === 'CSRF_FAILED' && !retried) { csrfToken = null; await ensureCsrf(); return raw<T>(method, path, body, query, true); }
  if (res.status === 401 && code === 'UNAUTHENTICATED') onUnauthenticated?.();
  throw new ApiError(code, e.message ?? `Request failed (${res.status}).`, res.status, e.fields, e.details);
}

export async function get<T>(path: string, query?: Query): Promise<T> { return raw<T>('GET', path, undefined, query); }
export async function post<T>(path: string, body: unknown = {}): Promise<T> { await ensureCsrf(); return raw<T>('POST', path, body); }

/** Path segment encoding (EU-000781, INV-MNL-00001101 … are safe, but user-typed values may not be). */
export const seg = (v: string) => encodeURIComponent(v);

// ── Files: the screens pick a file and pass its NAME to the API call; the File itself is kept here ─────────
const picked = new Map<string, File>();
/** Call from a file input's onChange: rememberFile(e.target.files?.[0]). Keeps the last 20 files by name. */
export function rememberFile(f?: File | null) {
  if (!f) return;
  picked.delete(f.name);
  picked.set(f.name, f);
  while (picked.size > 20) picked.delete(picked.keys().next().value as string);
}
export const pickedFile = (name?: string) => (name ? picked.get(name) : undefined);

export type UploadPurpose = 'ACCESS_DOC' | 'RESCUE_PHOTO' | 'PAYMENT_PROOF' | 'TOPUP_PROOF' | 'DISPUTE_ATTACHMENT' | 'VENDOR_INVOICE';

/**
 * Upload one file to the portal server: POST /files (register) → PUT /files/:id/content (the file itself; the server checks it
 * really is a PDF / JPG / PNG and stores it). Returns the fileId to send with the form.
 */
export async function uploadFile(fileOrName: File | string | undefined, purpose: UploadPurpose): Promise<string | null> {
  const f = typeof fileOrName === 'string' ? pickedFile(fileOrName) : fileOrName;
  if (!f) {
    if (typeof fileOrName === 'string' && fileOrName) throw new ApiError('VALIDATION_FAILED', 'Choose the file again — it was not kept after the page changed.', 422, { file: 'Choose the file again' });
    return null;
  }
  const contentType = f.type || guessType(f.name);
  const p = await post<{ fileId: string; uploadUrl: string; method?: string }>('/files', { purpose, fileName: f.name, contentType, sizeBytes: f.size });
  let put: Response;
  try {
    put = await fetch(`${baseUrl}${p.uploadUrl}`, { method: p.method || 'PUT', headers: { 'Content-Type': contentType, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }, body: f, credentials: 'include' });
  } catch {
    throw new ApiError('NETWORK', 'The file upload did not finish. Check your connection and try again.', 0);
  }
  if (!put.ok) {
    const e = await put.json().catch(() => ({})) as { code?: string; message?: string; fields?: Record<string, string> };
    throw new ApiError(e.code ?? 'UPLOAD_FAILED', e.message ?? 'The file upload was refused. Try again or choose another file.', put.status, e.fields ?? { file: 'Upload failed' });
  }
  return p.fileId;
}
const guessType = (name: string) => (/\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/octet-stream');

/** Open a file download (short-lived signed link from the backend). */
export async function downloadUrl(fileId: string) { return (await get<{ downloadUrl: string }>(`/files/${seg(fileId)}`)).downloadUrl; }

/** Fetch a non-JSON download (e.g. SOA CSV) as a Blob with the cookies. */
export async function getBlob(path: string, query?: Query): Promise<Blob> {
  const res = await fetch(`${baseUrl}${path}${qs(query)}`, { credentials: 'include' });
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as { code?: string; message?: string };
    throw new ApiError(e.code ?? `HTTP_${res.status}`, e.message ?? 'Download failed.', res.status);
  }
  return res.blob();
}
