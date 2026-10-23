import type { Claim } from '../../lib/api';
import { redactKeyMaterial } from '../../lib/api/usage.ts';
import type { StringKey } from '../../lib/i18n';

/* Pure display builders for a claim row — every string the Purchases screen
   renders for a claim is produced here so tests can assert on the exact
   rendered content (incl. key-material redaction at the boundary). */

/** Phase-2 issuance note for an approved claim (§7.2). needs_attention maps
    to the reassuring "purchase is safe" copy — never an error string. */
export function issuanceNoteKey(claim: Claim): StringKey | null {
  if (claim.status !== 'approved') return null;
  switch (claim.issuanceState) {
    case 'confirmed':
      return 'purchases.issuanceConfirmed';
    case 'pending':
      return 'purchases.issuancePending';
    case 'needs_attention':
      return 'purchases.issuanceAttention';
    default:
      return null;
  }
}

/** User-visible rejection reason: the admin's human note wins; machine codes
    are never shown. Whatever text survives is key-redacted before render. */
export function claimReasonText(claim: Claim, genericText: string): string {
  const raw = claim.adminNote ?? claim.rejectReason;
  const reason = raw && !/^[a-z][a-z0-9_]*$/.test(raw) ? raw : genericText;
  return redactKeyMaterial(reason);
}
