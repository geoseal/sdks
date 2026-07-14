// Shared localStorage helpers for the tracking-mode choice. Extracted into a
// standalone module so both the tracking-mode state machine (which writes/retries
// the pending marker) and the presence orchestrator (which reconciles it after
// minting the device row) can read/clear it WITHOUT importing each other —
// keeping the two off a circular import.
//
// Two keys, per subject (keyed by external_id):
//   - trackingMode.<id>          : the last chosen mode (the optimistic mirror).
//   - trackingMode.pending.<id>  : a mode chosen locally but NOT yet confirmed
//                                  server-side (the pref-write failed because the
//                                  public.devices row didn't exist yet). Set on a
//                                  failed write, cleared once a write lands.

import type { TrackingMode } from "./definitions.js";

export const modeKey = (externalId: string | null) =>
  `checkpoint.trackingMode.${externalId ?? "anon"}`;

const pendingKey = (externalId: string | null) =>
  `checkpoint.trackingMode.pending.${externalId ?? "anon"}`;

function isMode(v: string | null): v is TrackingMode {
  return v === "geofence" || v === "always" || v === "off";
}

const DEFAULT_MODE: TrackingMode = "geofence";

/** The last chosen mode for this subject (the optimistic mirror), or the default. */
export function readStoredMode(externalId: string | null): TrackingMode {
  try {
    const v = localStorage.getItem(modeKey(externalId));
    if (isMode(v)) return v;
  } catch {
    /* private mode */
  }
  return DEFAULT_MODE;
}

/** Persist the optimistic mode mirror. */
export function writeStoredMode(externalId: string | null, mode: TrackingMode): void {
  try {
    localStorage.setItem(modeKey(externalId), mode);
  } catch {
    /* private mode */
  }
}

/** Read the mode that was chosen locally but not yet confirmed server-side. */
export function readPendingMode(externalId: string | null): TrackingMode | null {
  try {
    const v = localStorage.getItem(pendingKey(externalId));
    if (isMode(v)) return v;
  } catch {
    /* private mode */
  }
  return null;
}

/** Mark a mode as owing a server write (call when the pref-write fails). */
export function writePendingMode(externalId: string | null, mode: TrackingMode): void {
  try {
    localStorage.setItem(pendingKey(externalId), mode);
  } catch {
    /* private mode */
  }
}

/** Clear the pending marker (call once a server pref-write lands). */
export function clearPendingMode(externalId: string | null): void {
  try {
    localStorage.removeItem(pendingKey(externalId));
  } catch {
    /* private mode */
  }
}
