// Who a staged desktop release is offered to (.specs/desktop-release.md →
// Staged rollout). This is electron-updater's rule (AppUpdater.isStagingMatch),
// written once so that the ops service's updater, which reads the feed itself,
// decides the same way. apps/desktop's update-staging.test.ts pins it against
// the installed library.

const FULL_SHARE = 100;
const ID_HEX_LENGTH = 32;
const POINT_HEX_LENGTH = 8;
const POINT_MAX = 0xffffffff;

/** A UUID as its 32 hex digits, or null when it is not one. */
function idHex(installId: string): string | null {
  const hex = installId.trim().replace(/-/g, '');
  return hex.length === ID_HEX_LENGTH && /^[0-9a-f]+$/i.test(hex) ? hex : null;
}

/** True for an id the staging rule can place: a UUID, with or without dashes. */
export const isStagingInstallId = (installId: string): boolean => idHex(installId) !== null;

/**
 * Where an install sits between 0 and 1: its id's last four bytes over
 * 0xffffffff. Null for an id that is not a UUID.
 */
export function stagingPoint(installId: string): number | null {
  const hex = idHex(installId);
  return hex === null ? null : parseInt(hex.slice(-POINT_HEX_LENGTH), 16) / POINT_MAX;
}

/**
 * Whether a feed's `stagingPercentage` offers the release to this install.
 * - No key: everyone.
 * - A value that is not a number: read as no key, as electron-updater does.
 * - Otherwise the install is in when its point is below the share, so 0 is
 *   nobody and the same install stays in as the share is raised.
 * An id that cannot be placed is out of any staged share: it waits for the
 * full release rather than taking a staged one by mistake.
 */
export function isInStagedShare(installId: string, stagingPercentage: unknown): boolean {
  if (stagingPercentage == null) return true;
  const percent = parseInt(String(stagingPercentage), 10);
  if (Number.isNaN(percent)) return true;
  const point = stagingPoint(installId);
  if (point === null) return percent >= FULL_SHARE;
  return point < percent / FULL_SHARE;
}
