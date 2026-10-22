import { getSetting } from '../settings.js';
import { isAdminPhone, forbidden } from '../util.js';

/**
 * Admin capabilities — Liro's capability-staff model (src/lib/money/perm.ts),
 * minus the referral/KYC/payout caps the owner removed with the referral
 * system (PRD §6.5/§9.1):
 *
 *   OWNER   — phone in ADMIN_PHONES env: every capability, always.
 *   STAFF   — finance staff stored in the `finance_staff` settings document
 *             ([{phone, caps[]}]); each staff member holds only their caps.
 *             Staff may log in to the admin app exactly like the owner, but
 *             every API enforces caps SERVER-side (the UI merely hides).
 *
 * Capabilities are computed per request from the settings document, so an
 * owner editing the staff list takes effect on the very next call — no
 * re-login needed for a revocation to bite.
 */

export const ALL_CAPS = [
  'finance_view',   // overview, orders queue (read), finance (read), analytics
  'finance_user',   // user list + dossier (read), manual credit adjustment
  'risk_manage',    // suspend/activate, device revoke, risk flags
  'expense_write',  // expenses create/edit/delete
  'refund_write',   // record refunds on approved orders
  'policy_write',   // settings editors (card/packs/models/token config), periods
  'export',         // finance CSV export
];
const CAP_SET = new Set(ALL_CAPS);

export function sanitizeCaps(caps) {
  if (!Array.isArray(caps)) return [];
  return [...new Set(caps.filter((c) => CAP_SET.has(c)))];
}

export async function getFinanceStaff(db, cfg) {
  const staff = await getSetting(db, cfg, 'finance_staff');
  if (!Array.isArray(staff)) return [];
  return staff
    .filter((s) => s && typeof s.phone === 'string')
    .map((s) => ({ phone: s.phone, caps: sanitizeCaps(s.caps) }));
}

export async function findStaff(db, cfg, phone) {
  const staff = await getFinanceStaff(db, cfg);
  return staff.find((s) => s.phone === phone) ?? null;
}

/** Anyone allowed to log in to the admin app at all: owner or finance staff. */
export async function isAdminOrStaff(db, cfg, phone) {
  if (isAdminPhone(cfg, phone)) return true;
  return Boolean(await findStaff(db, cfg, phone));
}

/**
 * Effective role + caps for a session phone.
 * Returns { role: 'owner'|'staff', caps: string[] } or null when the phone is
 * neither owner nor staff (e.g. removed from the staff list mid-session).
 */
export async function effectiveCaps(db, cfg, phone) {
  if (isAdminPhone(cfg, phone)) return { role: 'owner', caps: [...ALL_CAPS] };
  const staff = await findStaff(db, cfg, phone);
  if (staff) return { role: 'staff', caps: staff.caps };
  return null;
}

/** Route guard helper: throws 403 unless the session holds the capability. */
export async function requireCap(db, cfg, session, cap) {
  const eff = await effectiveCaps(db, cfg, session.phone);
  if (!eff) throw forbidden('not_an_admin', 'This phone number is not an admin.');
  if (!eff.caps.includes(cap)) throw forbidden('cap_required', `Missing capability: ${cap}.`);
  return eff;
}

/** Owner-only guard (staff list editing, audit viewer, claim approval). */
export async function requireOwner(cfg, session) {
  if (!isAdminPhone(cfg, session.phone)) throw forbidden('owner_required', 'Owner access required.');
  return { role: 'owner', caps: [...ALL_CAPS] };
}
