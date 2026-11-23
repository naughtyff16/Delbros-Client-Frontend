// Remote (real backend) implementations — area: EWA (Electronic Withdrawal Authorization) and roadside rescue. See ./types.ts.
//
// Backend: GET/POST /portal/ewa*, /portal/rescue* (Client_Portal_Backend ewaController / rescueController).
// The list endpoints return full rows (lines + released chassis, gate releases, extension history, email log / timeline,
// cost lines, photos, notifications, hire), so each screen gets everything in one call; pages of 100 are fetched until
// the whole list is in (the portal filters and pages on the screen, as with the mock).
import { computeRescueCharge, type EwaDelivery, type EwaForm } from '../../shared';
import { get, post, seg, uploadFile } from './http';
import type { Api, Overrides } from './types';

type R<F extends (...a: never[]) => unknown> = Awaited<ReturnType<F>>;
type EwaRow = R<Api['gate']['ewas']>[number];
type RescueRow = R<Api['rescue']['list']>[number];
type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

/** Outbox row from the backend → the delivery log entry the screens show ("Name — role"). */
type BackendDelivery = Omit<EwaDelivery, 'resend'> & { recipientName?: string | null; resend?: boolean | number; event?: string; subject?: string };
export const toDelivery = (d: BackendDelivery): EwaDelivery => ({
  at: d.at, channel: d.channel, audience: d.audience, to: d.to ?? '',
  recipient: d.recipientName ? `${d.recipientName} — ${d.recipient}` : d.recipient,
  status: d.status === 'Sent' || d.status === 'Failed' ? d.status : 'Queued',
  ...(d.resend ? { resend: true } : {}),
});

/** Every page of a list endpoint (100 per call, at most 50 calls). */
async function all<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await get<Page<T>>(path, { ...query, page, pageSize: 100 });
    out.push(...r.items);
    if (!r.items.length || out.length >= r.total) break;
  }
  return out;
}

type BackendEwa = Omit<EwaRow, 'delivery' | 'extension'> & { delivery?: BackendDelivery[]; extension?: (Omit<NonNullable<EwaRow['extension']>, 'canAct'>) | null };
export function toEwa(e: BackendEwa): EwaRow {
  return {
    ...e,
    units: (e.units ?? []).map((u) => ({ ...u, usedChassis: u.usedChassis ?? [] })),
    gatePasses: e.gatePasses ?? [], extensions: e.extensions ?? [],
    extension: e.extension ? { ...e.extension, canAct: false } : undefined, // the client never approves its own extension
    delivery: (e.delivery ?? []).map(toDelivery),
    truckOrcr: e.truckOrcr ?? undefined, expectedPickupAt: e.expectedPickupAt ?? undefined, remarks: e.remarks ?? undefined,
    cancelledAt: e.cancelledAt ?? undefined, cancelReason: e.cancelReason ?? undefined, cancelledByName: e.cancelledByName ?? undefined,
  };
}

type BackendRescue = Omit<RescueRow, 'notified' | 'charge' | 'elapsedMin' | 'timerStopped' | 'hire'> & {
  notified?: BackendDelivery[]; hire?: RescueRow['hire'] | null; serviceChargePct?: number; vatPct?: number;
};
export function toRescue(r: BackendRescue): RescueRow {
  const endAt = r.completedAt ?? r.cancelledAt ?? r.blockedAt ?? (r.status === 'Blocked' ? r.requestedAt : undefined);
  const n = (v: number | null | undefined) => (v == null ? undefined : Number(v));
  const oneWayKm = n(r.oneWayKm), ratePerKm = n(r.ratePerKm), tireCost = n(r.tireCost), partsCost = n(r.partsCost);
  return {
    ...r, oneWayKm, ratePerKm, tireCost, partsCost, total: n(r.total), eta: r.eta ?? undefined, lat: n(r.lat), lng: n(r.lng),
    photos: r.photos ?? [], costLines: r.costLines ?? [], timeline: r.timeline ?? [],
    notified: (r.notified ?? []).map(toDelivery), hire: r.hire ?? undefined,
    timerStopped: !r.isOpen,
    elapsedMin: !r.isOpen && !endAt ? null : Math.max(0, Math.round(((endAt ? new Date(endAt) : new Date()).getTime() - new Date(r.requestedAt).getTime()) / 60000)),
    // BR-11 breakdown with the backend's service-fee and VAT rates (same formula as the staff app).
    charge: oneWayKm != null ? computeRescueCharge({ oneWayKm, ratePerKm: ratePerKm ?? 0, tireCost: tireCost ?? 0, partsCost: partsCost ?? 0, serviceChargePct: r.serviceChargePct, vatPct: r.vatPct }) : undefined,
  } as RescueRow;
}

export const overrides: Overrides = {
  portal: {
    ewaOptions: async () => get<R<Api['portal']['ewaOptions']>>('/portal/ewa/options').then((o) => ({ ...o, creditContact: o.creditContact ?? { role: 'Credit & Collection' } })),
    cancelEwa: async (euNo: string, reason: string) => toEwa(await post<BackendEwa>(`/portal/ewa/${seg(euNo)}/cancel`, { reason })) as R<Api['portal']['cancelEwa']>,
    cancelRescue: async (no: string, reason: string) => toRescue(await post<BackendRescue>(`/portal/rescue/${seg(no)}/cancel`, { reason })) as R<Api['portal']['cancelRescue']>,
  },
  gate: {
    ewas: async (f = {}) => {
      const rows = (await all<BackendEwa>('/portal/ewa', { status: f.status, from: f.from, to: f.to })).map(toEwa);
      return f.branch ? rows.filter((e) => e.branchCode === f.branch) : rows;
    },
    createEwa: async (f: EwaForm) => toEwa(await post<BackendEwa>('/portal/ewa', {
      contractNo: f.contractNo, branchCode: f.branchCode, trucker: f.trucker, truckPlateNo: f.truckPlateNo, truckOrcr: f.truckOrcr || undefined,
      driverName: f.driverName, driverLicenseNo: f.driverLicenseNo, expectedPickupAt: f.expectedPickupAt || undefined, remarks: f.remarks || undefined,
      units: f.units.map((u) => ({ equipmentType: u.equipmentType, qty: u.qty })),
    })) as R<Api['gate']['createEwa']>,
    resendEwaEmail: async (euNo: string) => (await post<{ items: BackendDelivery[] }>(`/portal/ewa/${seg(euNo)}/resend-email`)).items.map(toDelivery),
    requestExtension: async (euNo: string, reason: string) => { await post(`/portal/ewa/${seg(euNo)}/extension`, { reason }); return true; },
  },
  rescue: {
    list: async (f = {}) => {
      const rows = (await all<BackendRescue>('/portal/rescue', { status: f.status })).map(toRescue);
      return rows.filter((r) => (f.open == null || r.isOpen === f.open) && (!f.from || r.requestedAt.slice(0, 10) >= f.from) && (!f.to || r.requestedAt.slice(0, 10) <= f.to));
    },
    request: async (f) => {
      // The screen keeps photo NAMES; the files picked in the same form are uploaded first (POST /files → PUT /files/:id/content).
      const photos: string[] = [];
      for (const name of f.photos ?? []) { const id = await uploadFile(name, 'RESCUE_PHOTO'); if (id) photos.push(id); }
      const r = await post<BackendRescue>('/portal/rescue', {
        chassisNo: f.chassisNo, locationText: f.locationText, lat: f.lat, lng: f.lng, problemType: f.problemType, problemDetail: f.problemDetail,
        incident: f.incident, loadStatus: f.loadStatus, sceneContactName: f.sceneContactName, sceneContactPhone: f.sceneContactPhone, urgent: !!f.urgent, photos,
      });
      return toRescue(r) as R<Api['rescue']['request']>;
    },
  },
};
