// Remote (real backend) implementations — area: finance (invoices, SOA, hire coverage, e-wallet, top-ups, cash bonds). See ./types.ts.
//
// The portal screens were written against the in-browser mock, so each method below returns the mock's shape:
//  - billing.invoices → GET /portal/invoices?view=all (every invoice with lines, receipts, credit memos, proof of payment, disputes)
//  - credit.soa       → GET /portal/soa (whole history; the page cuts the period itself), lines carry the running balance
//  - ewallet.ledger   → GET /portal/ewallet?all=1 + /portal/topups + /portal/cash-bonds (cash bond ledger rebuilt here)
//  - files            → the picked file is uploaded first (POST /files → PUT /files/:id/content) and its fileId sent with the form
import { ApiError } from '../core';
import { SOA_SCOPE_NOTE, emptyAging, round2 } from '../../shared';
import { get, post, seg, uploadFile, type UploadPurpose } from './http';
import type { Api, Overrides } from './types';

type R<N extends keyof Api, K extends keyof Api[N]> = Api[N][K] extends (...a: never[]) => infer T ? Awaited<T> : never;
type Row = Record<string, unknown>;

/** 'YYYY-MM-DD' (Manila business date) → an instant on that Manila day, so date formatting and sorting match the mock. */
const dayIso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00+08:00` : (v as string | undefined) ?? undefined);
const n = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const b = (v: unknown) => v === true || v === 1 || v === '1';

/** Backend field names → the names the screens show errors under. */
function renameFields<T>(p: Promise<T>, map: Record<string, string>): Promise<T> {
  return p.catch((e: unknown) => {
    if (e instanceof ApiError && e.fields) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.fields)) fields[map[k] ?? k] = v;
      throw new ApiError(e.code, e.message, e.status, fields, e.details);
    }
    throw e;
  });
}
const upload = (name: string | undefined, purpose: UploadPurpose, field: string) => renameFields(uploadFile(name, purpose), { file: field });

// ── Invoices ─────────────────────────────────────────────────────────────────────────────────
async function invoices(f: { client?: string; status?: string; q?: string; chassis?: string; billType?: string; branch?: string; from?: string; to?: string } = {}) {
  const { items } = await get<{ items: Row[] }>('/portal/invoices', { view: 'all' });
  const rows = items.map((i) => ({
    ...i,
    dueDate: (i.dueDate as string | null) ?? '', issuedAt: (i.issuedAt as string | null) ?? dayIso(i.invoiceDate),
    subtotal: n(i.subtotal), vat: n(i.vat), total: n(i.total), amountPaid: n(i.amountPaid), credited: n(i.credited), balance: n(i.balance),
    daysOverdue: n(i.daysOverdue), daysToHold: i.daysToHold == null ? undefined : n(i.daysToHold), pendingClearance: n(i.pendingClearance),
    hasHeld: b(i.hasHeld), isLease: b(i.isLease),
    acknowledgedAt: i.acknowledgedAt ?? undefined, acknowledgedBy: i.acknowledgedBy ?? undefined, acknowledgedVia: i.acknowledgedVia ?? undefined, cancelReason: i.cancelReason ?? undefined,
    lines: ((i.lines as Row[]) ?? []).map((l) => ({ ...l, from: l.from ?? undefined, to: l.to ?? undefined, chassisNo: l.chassisNo ?? undefined, amount: n(l.amount), held: b(l.held) })),
    payments: ((i.payments as Row[]) ?? []).map((p) => ({ ...p, fromPr: p.fromPr ?? undefined, amount: n(p.amount), counted: b(p.counted) })),
    credits: (i.credits as Row[]) ?? [], advices: (i.advices as Row[]) ?? [], disputes: (i.disputes as Row[]) ?? [],
  })) as unknown as R<'billing', 'invoices'>;
  const like = (s: unknown, q: string) => String(s ?? '').toLowerCase().includes(q.toLowerCase());
  return rows.filter((i) => (!f.client || i.clientCode === f.client)
    && (!f.status || (f.status === 'Held' ? i.hasHeld : i.payment === f.status || i.status === f.status))
    && (!f.chassis || i.lines.some((l) => like(l.chassisNo, f.chassis!)))
    && (!f.billType || i.billType === f.billType) && (!f.branch || i.branchCode === f.branch)
    && (!f.from || i.invoiceDate >= f.from) && (!f.to || i.invoiceDate <= f.to)
    && (!f.q || like(`${i.invoiceNo} ${i.clientName}`, f.q))) as R<'billing', 'invoices'>;
}

// ── Statement of account ─────────────────────────────────────────────────────────────────────
async function soa(code: string) {
  const r = await get<{ header: Row; rows: Row[]; notOnStatement: Row[]; awaitingClearance: Row[] }>('/portal/soa');
  const h = r.header ?? {};
  if (code && h.clientCode && h.clientCode !== code) throw new ApiError('NOT_FOUND', 'Not found', 404);
  const lines = (r.rows ?? []).map((x) => ({ date: dayIso(x.date)!, docType: x.docType as string, docNo: x.docNo as string, due: (x.due as string | null) ?? undefined,
    debit: n(x.debit), credit: n(x.credit), ref: (x.ref as string | null) ?? undefined, balance: round2(n(x.runningBalance)) }));
  const aging = { ...emptyAging(), ...((h.aging as Record<string, number> | null) ?? {}) };
  return {
    soaNo: (h.soaNo as string | null) ?? 'Not yet issued', asOf: new Date().toISOString(), lines,
    client: { clientCode: h.clientCode, clientName: h.clientName ?? h.billingName, billingName: h.billingName, billingCycle: h.billingCycle ?? 'Weekly',
      address1: h.address1 ?? '', address2: h.address2 ?? undefined, city: h.city ?? undefined, zipCode: h.zipCode ?? undefined, country: h.country ?? 'PHILIPPINES', tin: h.tin ?? undefined },
    aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, n(v)])),
    ewallet: undefined, cashBond: 0, stage: 'None', contracts: (h.contracts as string[] | null) ?? [], sends: [], acknowledgedAt: undefined, nextActionDue: undefined, preparedBy: undefined,
    company: { address: '', tin: '', permit: '', payeeBank: '', ...((h.company as Row | null) ?? {}) },
    contactEmail: '',
    notOnStatement: {
      unsettledDebitMemos: (r.notOnStatement ?? []).map((m) => ({ memoNo: m.memoNo, amount: n(m.amount), reason: m.reason, createdAt: m.createdAt })),
      ewalletBalance: h.ewalletBalance == null ? undefined : n(h.ewalletBalance), ewalletDeductions: n(h.ewalletDeductions),
    },
    // Extra (not in the mock): provisional receipts awaiting Treasury clearance and the backend's period totals.
    awaitingClearance: r.awaitingClearance ?? [], scopeNote: h.scopeNote,
  } as unknown as R<'credit', 'soa'>;
}

async function emailSoa(f: { from?: string; to?: string; copyBilling?: boolean } = {}) {
  const r = await post<{ soaNo: string; recipients: Row[]; notOnStatement: Row[] }>('/portal/soa/email', { from: f.from, to: f.to, copyBilling: !!f.copyBilling });
  return { soaNo: r.soaNo, at: new Date().toISOString(), period: { from: f.from, to: f.to },
    recipients: (r.recipients ?? []).map((x) => ({ to: (x.to as string) ?? (x.recipient as string), status: (x.status as string) ?? 'Queued' })),
    scope: SOA_SCOPE_NOTE, notOnStatement: (r.notOnStatement ?? []).map((m) => ({ memoNo: m.memoNo, amount: n(m.amount) })) } as unknown as R<'portal', 'emailSoa'>;
}

async function hireCoverage() {
  const { items } = await get<{ items: Row[] }>('/portal/hire-coverage');
  return items.map((x) => ({ ...x, gateIn: x.gateIn ?? undefined, inDay: x.inDay ?? undefined, cutOff: (x.cutOff as string | null) ?? '',
    billableToCutOff: n(x.billableToCutOff), invoicedDays: n(x.invoicedDays), accruingDays: n(x.accruingDays),
    invoices: (x.invoices as string[] | null) ?? [], missingDays: (x.missingDays as string[] | null) ?? [], billedTwiceDays: (x.billedTwiceDays as string[] | null) ?? [] })) as unknown as R<'portal', 'hireCoverage'>;
}

async function acknowledgeInvoice(invoiceNo: string) {
  const r = await post<Row>(`/portal/invoices/${seg(invoiceNo)}/acknowledge`);
  return { invoiceNo, ...r } as unknown as R<'portal', 'acknowledgeInvoice'>;
}

async function submitPaymentAdvice(f: { invoiceNo: string; amount: number; paidOn: string; method: string; bank?: string; reference: string; proofFileName: string; proofSizeMb?: number; remarks?: string }) {
  const proofFileId = await upload(f.proofFileName, 'PAYMENT_PROOF', 'proofFileName');
  const r = await renameFields(post<{ id: string; status: string }>(`/portal/invoices/${seg(f.invoiceNo)}/payment-advice`,
    { amount: f.amount, paidOn: f.paidOn, method: f.method, bank: f.bank, reference: f.reference, proofFileId, remarks: f.remarks }), { proofFile: 'proofFileName', proofFileId: 'proofFileName' });
  return { ...r, invoiceNo: f.invoiceNo, amount: f.amount, paidOn: f.paidOn, method: f.method, bank: f.bank || undefined, reference: f.reference.trim(), proofFileName: f.proofFileName,
    remarks: f.remarks || undefined, submittedAt: new Date().toISOString(), clientCode: '', submittedBy: '' } as unknown as R<'portal', 'submitPaymentAdvice'>;
}

async function disputeInvoice(f: { invoiceNo: string; reason: string; details: string; amountDisputed?: number; attachment?: string }) {
  const attachmentFileId = f.attachment ? await upload(f.attachment, 'DISPUTE_ATTACHMENT', 'attachment') : null;
  const r = await renameFields(post<{ id: string; status: string }>(`/portal/invoices/${seg(f.invoiceNo)}/dispute`,
    { reason: f.reason, details: f.details, amountDisputed: f.amountDisputed, attachmentFileId }), { attachmentFileId: 'attachment' });
  return { ...r, invoiceNo: f.invoiceNo, reason: f.reason, details: f.details, amountDisputed: f.amountDisputed, attachment: f.attachment,
    submittedAt: new Date().toISOString(), clientCode: '', submittedBy: '' } as unknown as R<'portal', 'disputeInvoice'>;
}

// ── Cash bonds ───────────────────────────────────────────────────────────────────────────────
interface BondsResponse { bonds: Row[]; withdrawals: Row[] }
const loadBonds = () => get<BondsResponse>('/portal/cash-bonds');

function mapBonds(r: BondsResponse) {
  return (r.bonds ?? []).map((bd) => {
    const ws = (r.withdrawals ?? []).filter((w) => w.bondId === bd.id);
    const pv = (bd.preview as Row | null) ?? {};
    const sources = { invoices: [], pendingMemos: [], unsettledMemos: [], ...((pv.sources as Row | null) ?? {}) } as { invoices: unknown[]; pendingMemos: unknown[]; unsettledMemos: { memoNo: string }[] };
    const preview = { ...pv, bond: n(pv.bond), unpaid: n(pv.unpaid), negativeWallet: n(pv.negativeWallet), pendingDm: n(pv.pendingDm), postedUnsettledDm: n(pv.postedUnsettledDm),
      openDm: n(pv.openDm), deductions: n(pv.deductions), refundable: n(pv.refundable), sources, unsettledMemos: sources.unsettledMemos.map((m) => m.memoNo),
      contractBond: pv.contractBond == null ? undefined : n(pv.contractBond), contractExpiry: pv.contractExpiry ?? undefined, contractEnded: b(pv.contractEnded) };
    const request = (w: Row) => ({ id: w.id, amount: n(w.amount), reason: w.reason, requestedAt: w.requestedAt, requestedBy: w.requestedByName ?? undefined, status: w.status, stage: w.stage,
      steps: (w.steps as Row[] | null) ?? [], rejectReason: w.rejectReason ?? undefined, rejectedAt: w.rejectedAt ?? undefined, refund: w.refund ?? undefined,
      breakdown: w.breakdown ?? undefined, recheck: w.recheck ?? undefined });
    return {
      id: bd.id, clientCode: '', contractNo: bd.contractNo ?? undefined, amount: n(bd.amount), dateReceived: bd.dateReceived, receiptRef: bd.receiptRef, status: bd.status,
      paymentMethod: bd.paymentMethod ?? undefined,
      outcome: bd.outcomeKind ? { kind: bd.outcomeKind, at: bd.outcomeAt, amount: n(bd.outcomeAmount), reference: bd.outcomeReference, note: bd.outcomeNote, toContractNo: bd.outcomeToContract ?? undefined } : undefined,
      withdrawals: ws.map((w) => ({ ...request(w), refundable: n((w.breakdown as Row | null)?.refundable), workflowId: '', earlyException: b(w.earlyException) })),
      preview, workflows: [], requests: ws.map(request),
    };
  });
}

async function cashBonds() { return mapBonds(await loadBonds()) as unknown as R<'portal', 'cashBonds'>; }

async function requestWithdrawal(bondId: string, amount: number, reason: string, opts: { earlyException?: boolean } = {}) {
  const r = await post<{ id: string; status: string }>(`/portal/cash-bonds/${seg(bondId)}/withdrawals`, { amount, reason, earlyException: !!opts.earlyException });
  const bond = mapBonds(await loadBonds()).find((x) => x.id === bondId);
  const w = { id: r.id, amount, reason: reason.trim(), refundable: 0, workflowId: '', status: 'Pending', requestedAt: new Date().toISOString(), earlyException: !!opts.earlyException };
  // The new request first (the screen reads withdrawals[0].id).
  return { ...(bond ?? { id: bondId, amount: 0, status: 'Withdrawal Pending' }), withdrawals: [w, ...(bond?.withdrawals ?? []).filter((x) => x.id !== r.id)] } as unknown as R<'contracts', 'requestWithdrawal'>;
}

/** Cash bond ledger entries — the same rules as the mock's ewallet.ledger (received, withdrawal requested / refunded, outcome, applied). */
function bondLedger(bonds: ReturnType<typeof mapBonds>) {
  const entries = bonds.flatMap((bd) => [
    { id: `${bd.id}-R`, at: new Date(dayIso(bd.dateReceived)!).toISOString(), entry: 'Bond received', amount: bd.amount, reference: bd.receiptRef, contractNo: bd.contractNo, status: bd.status },
    ...bd.withdrawals.map((w) => {
      const paid = w.status === 'Refunded' || String(w.status).startsWith('Approved');
      const refund = w.refund as { date?: string; reference?: string } | undefined;
      return { id: w.id, at: refund?.date ? new Date(dayIso(refund.date)!).toISOString() : w.requestedAt, entry: paid ? 'Bond refunded' : 'Withdrawal requested', amount: paid ? -w.amount : 0,
        reference: refund?.reference ?? w.id, contractNo: bd.contractNo, status: w.status, reason: w.reason };
    }),
    ...(bd.outcome && !bd.withdrawals.some((w) => w.status === 'Refunded') ? [{ id: `${bd.id}-O`, at: bd.outcome.at,
      entry: bd.outcome.kind === 'Refunded' ? 'Bond refunded' : bd.outcome.kind === 'Transferred' ? 'Bond transferred' : bd.outcome.kind === 'Forfeited' ? 'Bond forfeited' : 'Bond applied',
      amount: -bd.outcome.amount, reference: bd.outcome.reference, contractNo: bd.contractNo, status: bd.status, reason: bd.outcome.note }] : []),
    ...(bd.status === 'Applied' && !bd.outcome ? [{ id: `${bd.id}-A`, at: new Date().toISOString(), entry: 'Bond applied', amount: -bd.amount, reference: bd.receiptRef, contractNo: bd.contractNo, status: bd.status }] : []),
  ]).sort((x, y) => String(x.at).localeCompare(String(y.at)));
  let run = 0;
  return entries.map((e) => { run = round2(run + e.amount); return { ...e, balanceAfter: run }; });
}

// ── E-wallet ─────────────────────────────────────────────────────────────────────────────────
const mapTopup = (t: Row, code: string) => ({ ...t, clientCode: code, amount: n(t.amount), sendingBank: t.sendingBank ?? undefined, remarks: t.remarks ?? undefined,
  resubmitOf: t.resubmitOf ?? undefined, checkNo: t.checkNo ?? undefined, checkDate: t.checkDate ?? undefined, checkBank: t.checkBank ?? undefined,
  rejectReason: t.rejectReason ?? undefined, rejectedAt: t.rejectedAt ?? undefined, confirmedAt: t.confirmedAt ?? undefined, postedAt: t.postedAt ?? undefined,
  receiptNo: t.receiptNo ?? undefined, txnId: t.txnId ?? undefined, notified: (t.notified as Row[] | undefined) ?? [] });

async function ledger(code: string) {
  const [led, tops, bonds] = await Promise.all([
    get<{ wallet: Row; items: Row[] }>('/portal/ewallet', { all: 1 }),
    get<{ items: Row[] }>('/portal/topups'),
    loadBonds(),
  ]);
  const w = led.wallet ?? {};
  const wallet = w.balance == null ? null : { clientCode: (w.clientCode as string) ?? code, balance: n(w.balance), minimumBalance: n(w.minimumBalance), createdAt: '',
    state: w.state, healthyFrom: w.healthyFrom == null ? undefined : n(w.healthyFrom) };
  const mapped = mapBonds(bonds);
  const txns = (led.items ?? []).map((t) => ({ ...t, clientCode: code, amount: n(t.amount), balanceAfter: n(t.balanceAfter), referenceId: t.referenceId ?? undefined,
    receiptNo: t.receiptNo ?? undefined, reason: t.reason ?? undefined, reversesId: t.reversesId ?? undefined, reversedById: t.reversedById ?? undefined,
    debitMemoNo: t.debitMemoNo ?? undefined, by: '', agingSyncedAt: t.type === 'Replenishment' ? undefined : t.at }));
  return {
    wallet, clientName: undefined, clientStatus: undefined, allowRescue: false, txns, topups: (tops.items ?? []).map((t) => mapTopup(t, code)), payeeBank: '',
    bond: { held: round2(mapped.filter((x) => x.status === 'Held' || x.status === 'Withdrawal Pending').reduce((a, x) => a + x.amount, 0)), entries: bondLedger(mapped) },
    lastAgingSync: txns.find((t) => t.agingSyncedAt)?.agingSyncedAt, notifications: [],
  } as unknown as R<'ewallet', 'ledger'>;
}

async function requestTopup(f: { amount: number; transferDate: string; method: string; sendingBank?: string; reference: string; proofFileName: string; proofSizeMb?: number; remarks?: string; resubmitOf?: string; checkNo?: string; checkDate?: string; checkBank?: string }) {
  const proofFileId = await upload(f.proofFileName, 'TOPUP_PROOF', 'proofFileName');
  const r = await renameFields(post<Row>('/portal/topups', { amount: f.amount, transferDate: f.transferDate, method: f.method, sendingBank: f.sendingBank, reference: f.reference,
    proofFileId, remarks: f.remarks, resubmitOf: f.resubmitOf, checkNo: f.checkNo, checkDate: f.checkDate, checkBank: f.checkBank }), { proofFile: 'proofFileName', proofFileId: 'proofFileName' });
  return { ...mapTopup({ sendingBank: f.sendingBank, remarks: f.remarks, checkNo: f.checkNo, checkDate: f.checkDate, checkBank: f.checkBank, ...r }, ''), proofFileName: f.proofFileName } as unknown as R<'ewallet', 'requestTopup'>;
}

export const overrides: Overrides = {
  billing: { invoices },
  credit: { soa },
  ewallet: { ledger, requestTopup },
  contracts: { requestWithdrawal },
  portal: { emailSoa, hireCoverage, acknowledgeInvoice, submitPaymentAdvice, disputeInvoice, cashBonds },
};
