// Remote (real backend) implementations — area: vendor portal (my POs and invoices, invoice upload). See ./types.ts.
import { get, post, uploadFile } from './http';
import { fixDates } from './portal';
import type { Api, Overrides } from './types';

type R<F extends (...a: never[]) => unknown> = Awaited<ReturnType<F>>;
type V = Api['vendorPortal'];
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const yes = (v: unknown) => v === true || v === 1 || v === '1';
const opt = <T>(v: T | null | undefined) => (v === null ? undefined : v);

const mapInvoice = (i: Row) => ({ ...i, fileName: i.fileName ?? '', rejectReason: opt(i.rejectReason), resubmitOf: opt(i.resubmitOf), resubmitted: yes(i.resubmitted),
  lines: i.lines ?? [], history: (i.history ?? []).map((h: Row) => ({ ...h, note: opt(h.note) })) });

export function mapVendorData(raw: Row): R<V['data']> {
  const d = fixDates(raw);
  return {
    vendor: d.vendor ?? undefined,
    pos: (d.pos ?? []).map((p: Row) => ({ ...p, lines: p.lines ?? (p.lineBalance ?? []).map((l: Row) => ({ partCode: l.partCode, description: l.description, qty: l.ordered, unitPrice: l.unitPrice })),
      lineBalance: p.lineBalance ?? [], receipts: (p.receipts ?? []).map((r: Row) => ({ ...r, lines: r.lines ?? [] })),
      invoiceTranches: (p.invoiceTranches ?? []).map((t: Row) => ({ ...t, lines: t.lines ?? [] })) })),
    invoices: (d.invoices ?? []).map(mapInvoice),
  } as unknown as R<V['data']>;
}

export const overrides: Overrides = {
  vendorPortal: {
    async data() { return mapVendorData(await get<Row>('/vendor/portal')); },
    /** The screen passes the picked file's name (kept with rememberFile); it is uploaded first, then the invoice tranche is submitted with its fileId. */
    async uploadInvoice(input) {
      const fileId = await uploadFile(input.fileName, 'VENDOR_INVOICE');
      const r = await post<Row>('/vendor/invoices', { poNo: input.poNo, invoiceNo: input.invoiceNo, invoiceDate: input.invoiceDate, fileId, lines: input.lines, resubmitOf: input.resubmitOf });
      return mapInvoice(fixDates({ fileName: input.fileName, ...r, ...(r.fileName ? {} : { fileName: input.fileName }) })) as unknown as R<V['uploadInvoice']>;
    },
  },
};
