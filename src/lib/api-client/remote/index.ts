// Switches the shared `api` object from the in-browser mock to the real backend.
// main.tsx calls enableRemote(cfg.apiBaseUrl) before the first render when app-config.json sets "apiBaseUrl".
import { api } from '../api';
import { configureHttp } from './http';
import type { Overrides } from './types';
import { overrides as auth, initSession, clearSession } from './auth';
import { overrides as portal } from './portal';
import { overrides as ewaRescue } from './ewaRescue';
import { overrides as finance } from './finance';
import { overrides as vendor } from './vendor';

let enabled = false;
export const remoteEnabled = () => enabled;

export function install(o: Overrides) {
  for (const [ns, methods] of Object.entries(o)) Object.assign((api as Record<string, object>)[ns], methods);
}

/** Point every portal call at the backend, then load the policy, CSRF token and current session (if the cookie is still valid). */
export async function enableRemote(apiBaseUrl: string) {
  configureHttp(apiBaseUrl, { onUnauthenticated: clearSession });
  for (const o of [auth, portal, ewaRescue, finance, vendor]) install(o);
  enabled = true;
  await initSession();
}

export { rememberFile, uploadFile } from './http';
