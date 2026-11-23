// Remote implementations replace mock methods one-for-one, with the SAME signatures (TypeScript checks the shapes
// the screens receive). Each area file exports `overrides`; index.ts installs them on the shared `api` object.
import type { api } from '../api';

export type Api = typeof api;
export type Overrides = { [N in keyof Api]?: { [K in keyof Api[N]]?: Api[N][K] } };

/** Every api method the portal screens call (src/pages, src/auth.tsx, src/router.tsx). remote.test.ts checks all are replaced. */
export const PORTAL_METHODS = {
  auth: ['accessRequestStatus', 'changePassword', 'checkApprovalLink', 'checkResetToken', 'decidePortalAccess', 'demoApprovalLink', 'demoOtp', 'demoResetToken',
    'expireSession', 'forgotPassword', 'logout', 'me', 'payeeFor', 'policy', 'portalLogin', 'resendOtp', 'resetPassword', 'verifyOtp'],
  billing: ['invoices'],
  clients: ['registerPortal'],
  contracts: ['requestWithdrawal'],
  credit: ['soa'],
  ewallet: ['ledger', 'requestTopup'],
  gate: ['createEwa', 'ewas', 'requestExtension', 'resendEwaEmail'],
  portal: ['acknowledgeInvoice', 'cancelEwa', 'cancelRescue', 'cashBonds', 'contracts', 'dashboard', 'disputeInvoice', 'emailSoa', 'ewaOptions', 'hireCoverage',
    'markNotificationsRead', 'myFeedback', 'notifications', 'requestContractChange', 'requestReturn', 'submitFeedback', 'submitPaymentAdvice'],
  ref: ['all'],
  rescue: ['list', 'request'],
  vendorPortal: ['data', 'uploadInvoice'],
} as const;
