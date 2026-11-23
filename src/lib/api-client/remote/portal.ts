// Remote (real backend) implementations — area: portal (dashboard, notifications, feedback, returns, contracts). See ./types.ts.
// Each adapter returns exactly the shape the mock returns, so the screens do not change.
import { rescueUnitState, weeklyCycle } from '../../shared';
import { get, post, seg } from './http';
import type { Api, Overrides } from './types';

type R<F extends (...a: never[]) => unknown> = Awaited<ReturnType<F>>;
type P = Api['portal'];
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Timestamps inside MySQL JSON columns arrive as "2026-11-19 05:01:00.000000" (UTC, no zone); a browser would read them as local time.
 * Turn them into ISO UTC strings. Plain DATE values ("2026-11-19") and real ISO strings are left alone.
 */
const SQL_DT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?$/;
export function fixDates<T>(v: T): T {
  if (typeof v === 'string') {
    const m = SQL_DT.exec(v);
    return (m ? `${m[1]}T${m[2]}${(m[3] ?? '.000').slice(0, 4).padEnd(4, '0')}Z` : v) as T;
  }
  if (Array.isArray(v)) return v.map(fixDates) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, fixDates(x)])) as T;
  return v;
}
const yes = (v: unknown) => v === true || v === 1 || v === '1';
const opt = <T>(v: T | null | undefined) => (v === null ? undefined : v);

/** Notification links are written for the staff app; a portal user gets the matching portal screen (same rule as the mock). */
export function portalLink(link?: string | null) {
  if (!link) return '/client';
  if (link.startsWith('/client')) return link;
  const id = link.split(/[/?]/).filter(Boolean)[1];
  if (link.startsWith('/rescue')) return id && /^RSC-/.test(id) ? `/client/rescue?open=${id}` : '/client/rescue';
  if (link.startsWith('/ewallet') || link.startsWith('/cashbond')) return '/client/ewallet';
  if (link.startsWith('/billing') || link.startsWith('/invoices') || link.startsWith('/credit')) return id && /^INV-/.test(id) ? `/client/invoices?open=${id}` : '/client/invoices';
  if (link.startsWith('/contracts')) return '/client/contracts';
  if (link.startsWith('/gate') || link.startsWith('/ewa')) return id && /^EU-/.test(id) ? `/client/ewa?open=${id}` : '/client/ewa';
  return '/client';
}

/** Delivery list: "role" labels from the outbox, with the (decrypted) person's name in front when known — as the mock shows it. */
const delivery = (n: Row) => ({ ...n, recipient: n.recipientName ? `${n.recipientName} — ${n.recipient}` : n.recipient });

// ── Dashboard ────────────────────────────────────────────────────────────────────────────────────────
export function mapDashboard(raw: Row): R<P['dashboard']> {
  const d = fixDates(raw);
  const client = d.client ?? { clientCode: d.clientCode, clientName: d.clientName, billingName: d.billingName, status: d.clientStatus, allowOnline: yes(d.allowOnline), allowRescue: yes(d.allowRescue), billingCycle: 'Weekly' };
  const billing = d.billing ?? {};
  return {
    ...d,
    client: { cwsBranchAccess: [], contacts: [], ...client, allowOnline: yes(client.allowOnline), allowRescue: yes(client.allowRescue), billingCycle: client.billingCycle ?? 'Weekly' },
    accountExecutive: d.accountExecutive && (d.accountExecutive.name || d.accountExecutive.email) ? d.accountExecutive : null,
    creditContact: d.creditContact ?? { role: 'Credit & Collection' },
    gates: { ewa: { allowed: yes(d.gates?.ewa?.allowed), ...opts(d.gates?.ewa) }, rescue: { allowed: yes(d.gates?.rescue?.allowed), ...opts(d.gates?.rescue) } },
    billing: { creditTermBasis: billing.creditTermBasis === 'acknowledgment' ? 'acknowledgment' : 'invoice_date', weekly: billing.weekly ?? weeklyCycle(billing.weeklyCycleStart) },
    oldestDue: opt(d.oldestDue), oldestDueInvoices: d.oldestDueInvoices ?? [], oldestDueOverdue: yes(d.oldestDueOverdue),
    activeContracts: { count: d.activeContracts?.count ?? 0, nearestExpiry: opt(d.activeContracts?.nearestExpiry) },
    ewallet: d.ewallet ?? null,
    walletTxns: d.walletTxns ?? [],
    cashBond: { held: 0, refundable: 0, unpaid: 0, negativeWallet: 0, openDm: 0, ...d.cashBond, withdrawalPending: yes(d.cashBond?.withdrawalPending) },
    onHire: (d.onHire ?? []).map((u: Row) => {
      // One rule for every open rescue status (same as the mock): the unit shows "Under rescue" and cannot be returned until it ends.
      const st: string | undefined = u.rescue?.status ?? (u.status === 'Rescue' ? 'In Progress' : undefined);
      const rs = rescueUnitState(st);
      return {
        ...u, gateOut: opt(u.gateOut), gatePassNo: opt(u.gatePassNo), dailyRate: opt(u.dailyRate), hireDays: opt(u.hireDays), accrued: opt(u.accrued),
        returnRequest: u.returnRequest ?? undefined,
        rescue: rs ? { ...rs, rescueNo: u.rescue?.rescueNo, status: st, eta: opt(u.rescue?.eta) } : undefined,
        canRequestReturn: yes(u.canRequestReturn),
      };
    }),
    returns: (d.returns ?? []).map((r: Row) => ({ ...r, crossBranch: yes(r.crossBranch), isForceInbound: yes(r.isForceInbound), damage: r.damage ?? [], remarks: opt(r.remarks),
      approvalCode: opt(r.approvalCode), durationDays: opt(r.durationDays), billableDays: opt(r.billableDays), dailyRate: opt(r.dailyRate), leaseCharge: opt(r.leaseCharge),
      finalCharges: opt(r.finalCharges ?? (r.leaseCharge != null ? Math.round((r.leaseCharge + (r.damageCharge ?? 0)) * 100) / 100 : undefined)) })),
    returnBranches: d.returnBranches ?? [],
    openRescues: (d.openRescues ?? []).map((r: Row) => ({ ...r, urgent: yes(r.urgent), eta: opt(r.eta) })),
    ewas: (d.ewas ?? []).map((e: Row) => ({ ...e, cancelReason: opt(e.cancelReason), units: (e.units ?? []).map((u: Row) => ({ ...u, usedChassis: u.usedChassis ?? [] })) })),
    contracts: d.contracts ?? [],
    charges: d.charges ?? [],
  } as unknown as R<P['dashboard']>;
}
function opts(g?: Row) {
  if (!g) return {};
  const { allowed: _a, ...rest } = g;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null));
}

// ── Contracts ────────────────────────────────────────────────────────────────────────────────────────
export function mapContract(raw: Row) {
  const c = fixDates(raw);
  const pt = c.preTermination ?? {};
  const entitlement = (c.entitlement ?? []).map((e: Row) => ({ ...e, rateCard: opt(e.rateCard), entitled: opt(e.entitled), remaining: opt(e.remaining) }));
  return {
    ...c,
    expiryDate: opt(c.expiryDate),
    region: c.regionName,
    rates: entitlement.map((e: Row) => ({ equipmentType: e.equipmentType, dailyRate: e.dailyRate, indemnity: e.indemnity, qty: e.entitled })),
    penalties: { nonReturn: c.penaltyNonReturn ?? 0, deferredCheck: c.penaltyDeferredCheck ?? 0, lateInterestPct: c.penaltyLateInterestPct ?? 0, dishonoredCheck: c.penaltyDishonoredCheck ?? 0 },
    termination: c.terminationDate || c.terminationReason ? { workflowId: '', status: 'Approved', reason: c.terminationReason ?? '', effectiveDate: c.terminationDate } : undefined,
    renewal: c.renewalState ? { state: c.renewalState, date: opt(c.renewalDate), note: opt(c.renewalNote), successor: opt(c.renewedTo) } : undefined,
    lockInEnd: opt(pt.lockInEnd),
    preTermination: { ...pt, inLockIn: yes(pt.inLockIn) },
    renewalNotices: (c.renewalNotices ?? []).map((n: Row) => ({ ...n, sent: yes(n.sent) })),
    entitlement,
    entitlementTotals: c.entitlementTotals ?? undefined,
    rateHistory: (c.rateHistory ?? []).map((v: Row) => ({ ...v, validTo: opt(v.validTo), rates: v.rates ?? [] })),
    onHireUnits: c.onHireUnits ?? [],
    branches: { covered: c.branches?.covered ?? [], activity: (c.branches?.activity ?? []).map((b: Row) => ({ ...b, covered: yes(b.covered) })), outside: c.branches?.outside ?? [] },
    requests: (c.requests ?? []).map((r: Row) => ({ ...r, termMonths: opt(r.termMonths), changeArea: opt(r.changeArea), effectiveDate: opt(r.effectiveDate), feeEstimate: opt(r.feeEstimate),
      decisionNote: opt(r.decisionNote), decidedByName: opt(r.decidedByName) })),
    bonds: (c.bonds ?? []).map((b: Row) => ({ ...b, outcome: b.outcome ?? undefined, refund: b.refund ?? undefined })),
    history: (c.history ?? []).map((h: Row) => ({ ...h, by: h.byName })),
    signatory: c.signatory ? { name: [c.signatory.firstName, c.signatory.lastName].filter(Boolean).join(' '), email: c.signatory.email, phone: c.signatory.phone } : undefined,
    ewalletMinimum: opt(c.ewalletMinimum),
  };
}

export const overrides: Overrides = {
  portal: {
    async dashboard() { return mapDashboard(await get<Row>('/portal/dashboard')); },
    async notifications() {
      const r = await get<{ items: Row[] }>('/portal/notifications');
      return fixDates(r.items).map((n) => ({ ...n, id: String(n.id), link: portalLink(n.link), read: yes(n.read), requiresAck: yes(n.requiresAck) })) as unknown as R<P['notifications']>;
    },
    async markNotificationsRead(id?: string) {
      await post('/portal/notifications/read', id ? { id } : {});
      return true;
    },
    async submitFeedback(f) {
      return fixDates(await post<Row>('/portal/feedback', f)) as unknown as R<P['submitFeedback']>;
    },
    async myFeedback() {
      const r = await get<{ items: Row[] }>('/portal/feedback');
      return fixDates(r.items).map((x) => ({ ...x, rating: opt(x.rating), topic: opt(x.topic), reference: opt(x.reference) })) as unknown as R<P['myFeedback']>;
    },
    async requestReturn(f) {
      const r = fixDates(await post<Row>('/portal/returns', f));
      return { ...r, crossBranch: yes(r.crossBranch), notes: opt(r.notes), notified: (r.notified ?? []).map(delivery) } as unknown as R<P['requestReturn']>;
    },
    async contracts() {
      const r = await get<{ items: Row[] }>('/portal/contracts');
      return r.items.map(mapContract) as unknown as R<P['contracts']>;
    },
    async requestContractChange(f) {
      const { contractNo, ...body } = f;
      const r = fixDates(await post<Row>(`/portal/contracts/${seg(contractNo)}/requests`, body));
      return { ...r, termMonths: opt(r.termMonths), changeArea: opt(r.changeArea), effectiveDate: opt(r.effectiveDate), feeEstimate: opt(r.feeEstimate) } as unknown as R<P['requestContractChange']>;
    },
  },
};
