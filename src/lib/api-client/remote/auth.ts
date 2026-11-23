// Remote (real backend) implementations — area: auth (sign-in, session, password, access requests, ref data). See ./types.ts.
//
// The screens read me() and policy() synchronously, so both are cached here: the policy is loaded once in initSession(),
// the profile comes from /auth/me (at start-up), login / verifyOtp, and is cleared on logout, expiry or any 401.
import { parseRegistrationExtras, resolveGrants, type ClientPortalForm, type RoleCode, type User } from '../../shared';
import type { PortalContact, PortalRealm, PortalSignInResult } from '../portalAuth';
import { PAYEE_ENTITIES, type PayeeEntity } from '../portalAuth';
import { get, post, seg, setCsrfToken, uploadFile } from './http';
import type { Api, Overrides } from './types';

type A = Api['auth'];
type Res<F extends (...a: never[]) => unknown> = Awaited<ReturnType<F>>;
export type SessionUser = User & { grants: ReturnType<typeof resolveGrants>; billingEntity?: PayeeEntity; clientName?: string; vendorName?: string; mustChangePassword?: boolean };

/** Fired on window when the backend says the session is gone (401) — auth.tsx signs the user out of the screens. */
export const SESSION_ENDED_EVENT = 'delbros:session-ended';

// ── Caches ────────────────────────────────────────────────────────────────────────────────────────
let current: SessionUser | null = null;
type Payee = { bank: string; accountName: string; accountNo: string; branch?: string; isDemo: boolean };
type BackendPolicy = Omit<ReturnType<A['policy']>, 'registrationExtras' | 'payee'> & { registrationExtras?: string; otpResendSeconds?: number;
  payee?: Payee; payees?: Partial<Record<PayeeEntity, Payee>> };
const DEMO_PAYEE: Payee = { bank: 'Demo Bank (replace before release)', accountName: 'Delbros Leasing Inc.', accountNo: '0000-0000-0000', branch: 'Head Office', isDemo: true };
const DEFAULT_POLICY: BackendPolicy = {
  maxFailed: 5, lockoutMinutes: 30, passwordMinLength: 10, sessionTimeoutMinutes: 15, secondFactor: 'email_otp', otpMinutes: 5, resetLinkMinutes: 30,
  support: { client: { role: 'Delbros Client Support' }, vendor: { role: 'Delbros Procurement' } }, dpoEmail: '', registrationExtras: 'tin,documents,consent',
};
let policyCache: BackendPolicy = DEFAULT_POLICY;
// DEVELOPMENT ONLY: secrets the backend returns when DEV_EXPOSE_CODES=true (for the demo box). Nothing is kept otherwise.
const devCodes = new Map<string, string>();      // challengeId → sign-in code
const devResets = new Map<string, string>();     // email → reset token
const devApprovals = new Map<string, string>();  // reference → approval link

/** Backend profile (sp_auth_me) → the session shape the screens use (same as the mock's me()). */
export function toSessionUser(p: Record<string, unknown> | null | undefined): SessionUser | null {
  if (!p || !p.userId) return null;
  const roles = (Array.isArray(p.roles) ? p.roles : []) as RoleCode[];
  const s = (k: string) => (p[k] === null || p[k] === undefined ? undefined : String(p[k]));
  return {
    userId: String(p.userId), name: s('name') ?? '', designation: s('designation') ?? '', status: p.status === 'Inactive' ? 'Inactive' : 'Active',
    branchCode: s('branchCode') ?? '', branchAccess: [], email: s('email') ?? '', mobile: s('mobile'), roles, realm: p.realm as User['realm'],
    clientCode: s('clientCode'), vendorId: s('vendorId'), lastLogin: s('lastLogin'), grants: resolveGrants(roles),
    billingEntity: (s('billingEntity') as PayeeEntity | undefined) ?? 'DBL', clientName: s('clientName'), vendorName: s('vendorName'), mustChangePassword: !!p.mustChangePassword,
  };
}
const copy = () => (current ? structuredClone(current) : null);
function setUser(p: Record<string, unknown> | null | undefined) { current = toSessionUser(p); return copy(); }

/** Load policy + current session before the first render (an expired cookie simply means "not signed in"). */
export async function initSession() {
  try { policyCache = { ...DEFAULT_POLICY, ...(await get<BackendPolicy>('/auth/policy')) }; } catch { /* defaults until the API answers */ }
  try { setUser(await get<Record<string, unknown>>('/auth/me')); } catch { current = null; }
}
/** Forget the cached session (called on any 401 UNAUTHENTICATED). */
export function clearSession() {
  const had = !!current;
  current = null;
  if (had && typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
}

function policy(): ReturnType<A['policy']> {
  const p = policyCache;
  const support = p.support ?? DEFAULT_POLICY.support;
  return {
    maxFailed: Number(p.maxFailed), lockoutMinutes: Number(p.lockoutMinutes), passwordMinLength: Number(p.passwordMinLength), sessionTimeoutMinutes: Number(p.sessionTimeoutMinutes),
    secondFactor: p.secondFactor === 'off' ? 'off' : 'email_otp', otpMinutes: Number(p.otpMinutes), resetLinkMinutes: Number(p.resetLinkMinutes),
    support: { client: { ...support.client } as PortalContact, vendor: { ...support.vendor } as PortalContact }, dpoEmail: p.dpoEmail ?? '',
    payee: { ...(p.payee ?? p.payees?.DBL ?? DEMO_PAYEE), isDemo: !!(p.payee ?? p.payees?.DBL ?? DEMO_PAYEE).isDemo },
    registrationExtras: parseRegistrationExtras(p.registrationExtras ?? 'tin,documents,consent'),
  } as ReturnType<A['policy']>;
}

function payeeFor(clientCode?: string): ReturnType<A['payeeFor']> {
  const entity: PayeeEntity = current && (!clientCode || current.clientCode === clientCode) ? current.billingEntity ?? 'DBL' : 'DBL';
  const base = policyCache.payees?.[entity] ?? (entity === 'DBL' ? policy().payee : { ...DEMO_PAYEE, accountName: PAYEE_ENTITIES[entity] });
  return { ...base, isDemo: !!base.isDemo, entity, entityName: PAYEE_ENTITIES[entity], basis: entity === 'NAK' ? 'Your home branch is in Mindanao — billed by Nakamura' : 'Billed by Delbros Leasing' } as ReturnType<A['payeeFor']>;
}

type LoginAnswer = { status: 'signed_in'; user: Record<string, unknown>; csrfToken?: string }
  | { status: 'otp_required'; challengeId: string; maskedEmail: string; expiresAt: string; resendAfterSeconds: number; devCode?: string };

const auth: Partial<A> = {
  policy,
  payeeFor,
  me: copy,

  async portalLogin(email: string, password: string, realm: PortalRealm): Promise<PortalSignInResult> {
    const r = await post<LoginAnswer>('/auth/login', { email: email.trim(), password, portal: realm === 'VENDOR_PORTAL' ? 'vendor' : 'client' });
    if (r.status === 'signed_in') { setCsrfToken(r.csrfToken); return { status: 'signed_in', user: setUser(r.user) }; }
    if (r.devCode) devCodes.set(r.challengeId, r.devCode);
    return { status: 'otp_required', challengeId: r.challengeId, maskedEmail: r.maskedEmail, expiresAt: String(r.expiresAt), resendAfterSeconds: Number(r.resendAfterSeconds) };
  },
  async verifyOtp(challengeId: string, code: string) {
    const r = await post<{ user: Record<string, unknown>; csrfToken?: string }>('/auth/otp/verify', { challengeId, code: code.trim() });
    setCsrfToken(r.csrfToken);
    devCodes.delete(challengeId);
    return setUser(r.user);
  },
  async resendOtp(challengeId: string) {
    const r = await post<{ expiresAt: string; resendAfterSeconds: number; devCode?: string }>('/auth/otp/resend', { challengeId });
    if (r.devCode) devCodes.set(challengeId, r.devCode);
    return { expiresAt: String(r.expiresAt), resendAfterSeconds: Number(r.resendAfterSeconds) as 30 }; // typed as the mock constant; the value comes from the server
  },
  demoOtp: (challengeId: string) => devCodes.get(challengeId) ?? null,

  async logout() {
    try { await post('/auth/logout'); } finally { current = null; }
  },
  /** Synchronous for the screens: forget the session now, tell the backend in the background. */
  expireSession(idleMinutes: number) {
    current = null;
    void post('/auth/session-expired', { idleMinutes }).catch(() => { /* the server session expires on its own */ });
  },
  async changePassword(currentPassword: string, next: string) {
    await post('/auth/change-password', { currentPassword, newPassword: next });
    return true;
  },

  async forgotPassword(email: string) {
    const r = await post<{ expiresInMinutes?: number; devResetToken?: string }>('/auth/forgot-password', { email: email.trim() });
    if (r.devResetToken) devResets.set(email.trim().toLowerCase(), r.devResetToken);
    return { expiresInMinutes: Number(r.expiresInMinutes ?? policyCache.resetLinkMinutes) };
  },
  demoResetToken: (email: string) => devResets.get(email.trim().toLowerCase()) ?? null,
  async checkResetToken(token: string) {
    const r = await get<{ email: string; realm: PortalRealm; expiresAt: string; minLength: number }>(`/auth/reset-password/${seg(token)}`);
    return { email: r.email, realm: r.realm, expiresAt: String(r.expiresAt), minLength: Number(r.minLength) };
  },
  async resetPassword(token: string, password: string) {
    const r = await post<{ email: string; realm: PortalRealm }>('/auth/reset-password', { token, newPassword: password });
    return { email: r.email, realm: r.realm };
  },

  async accessRequestStatus(reference: string, email: string) {
    const r = await get<Record<string, unknown> & { notices?: unknown[] }>('/access-requests/status', { reference: reference.trim(), email: email.trim() });
    return { ...r, reviewer: (r.reviewerName as string) || (r.reviewer as string), reviewerNotified: !!r.reviewerNotified,
      companyCode: r.companyCode ?? undefined, billingName: r.billingName ?? undefined, reason: r.reason ?? undefined, decidedAt: r.decidedAt ?? undefined,
      notices: r.notices ?? [] } as unknown as Res<A['accessRequestStatus']>;
  },
  async checkApprovalLink(token: string) {
    const r = await get<Record<string, unknown> & { documents?: { fileName: string }[] }>(`/access-approval/${seg(token)}`);
    return { ...r, documents: (r.documents ?? []).map((d) => d.fileName), expired: !!r.expired, companyCode: r.companyCode ?? undefined,
      decidedAt: r.decidedAt ?? undefined, decidedBy: r.decidedBy ?? undefined, decisionReason: r.decisionReason ?? undefined } as unknown as Res<A['checkApprovalLink']>;
  },
  async decidePortalAccess(token: string, d: { decision: 'approve' | 'deny'; billingName?: string; reason?: string }) {
    const r = await post<Record<string, unknown>>(`/access-approval/${seg(token)}`, d);
    return { ...r, companyCode: r.companyCode ?? undefined, billingName: r.billingName ?? undefined, reason: r.reason ?? undefined } as unknown as Res<A['decidePortalAccess']>;
  },
  demoApprovalLink: (reference: string) => devApprovals.get(reference) ?? null,
};

/** Access request: upload the picked documents first (ACCESS_DOC, no session needed), then send the form with their file ids. */
async function registerPortal(f: ClientPortalForm): Promise<Res<Api['clients']['registerPortal']>> {
  const documents: string[] = [];
  for (const name of f.documents ?? []) { const id = await uploadFile(name, 'ACCESS_DOC'); if (id) documents.push(id); }
  const r = await post<Record<string, unknown> & { reference: string; devApprovalLink?: string }>('/access-requests', {
    accountType: f.accountType, clientName: f.clientName, tin: f.tin, branchCode: f.branchCode, address1: f.address1, firstName: f.firstName, lastName: f.lastName,
    email: f.email, phone: f.phone, password: f.password, documents, consent: f.consent === true,
  });
  if (r.devApprovalLink) devApprovals.set(r.reference, r.devApprovalLink);
  const { devApprovalLink: _d, ...rest } = r;
  return { ...rest, documents: [...(f.documents ?? [])] } as unknown as Res<Api['clients']['registerPortal']>; // the screen lists the file names
}

/** Reference data: branches, equipment types and public settings (also before sign-in, for the access-request form). */
async function refAll(): Promise<Res<Api['ref']['all']>> {
  const r = await get<{ branches: Record<string, unknown>[]; equipmentTypes: Record<string, unknown>[]; settings: Record<string, unknown> }>('/ref');
  return {
    branches: r.branches.map((b) => ({ ...b, isHeadOffice: !!b.isHeadOffice, issuesGatePasses: b.issuesGatePasses === undefined ? undefined : !!b.issuesGatePasses, regionGroup: b.regionGroup ?? undefined })),
    equipmentTypes: r.equipmentTypes, parts: [], vendors: [], users: [], clients: [], settings: r.settings ?? {},
  } as unknown as Res<Api['ref']['all']>;
}

export const overrides: Overrides = {
  auth,
  clients: { registerPortal },
  ref: { all: refAll },
};
