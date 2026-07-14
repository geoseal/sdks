// @geoseal/nativescript — iOS implementation.
//
// Drives the @objc(CheckpointGeofence) shim (CheckpointCore pod) DIRECTLY via
// NativeScript runtime marshalling — the shim IS the binding; there is no
// platform bridge code in this package. Every native access is lazy (inside a
// function) so importing this module off-device (conformance tests in Node)
// never touches the runtime.

import type {
  NativeDiagnostics,
  NativeGeofencePlugin,
  PluginListenerHandle,
  RegionEvent,
  TrackingMode,
} from "@geoseal/capacitor/core";
import {
  assertConfigureCreds,
  makeCheckpoint,
  normalizeDiagnostics,
  normalizeModeState,
  normalizeRegionEvent,
} from "./common.js";

export * from "./common.js";

function shim(): CheckpointGeofence {
  return CheckpointGeofence.shared;
}

// NSDictionary/NSArray proxies → plain JS. NSString/NSNumber leaves marshal to
// primitives on access; only containers and NSNull need explicit handling.
function nsToJs(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof NSNull) return null;
  if (value instanceof NSDictionary) {
    const out: Record<string, unknown> = {};
    const keys = value.allKeys;
    for (let i = 0; i < keys.count; i++) {
      const key = String(keys.objectAtIndex(i));
      out[key] = nsToJs(value.objectForKey(key));
    }
    return out;
  }
  if (value instanceof NSArray) {
    const out: unknown[] = [];
    for (let i = 0; i < value.count; i++) out.push(nsToJs(value.objectAtIndex(i)));
    return out;
  }
  return value;
}

const listeners = new Set<(event: RegionEvent) => void>();
let sinkInstalled = false;

export const NativeGeofence: NativeGeofencePlugin = {
  async configure(options): Promise<void> {
    assertConfigureCreds(options);
    shim().configureWithBaseUrlAnonKeyPublishableKeySubjectExternalIdDeviceIdTrackingModeStreamNowMinIntervalSMaxStrayStreamS(
      options.baseUrl,
      options.anonKey,
      options.publishableKey,
      options.subjectExternalId,
      options.deviceId ?? "ios-native",
      options.trackingMode ?? null,
      // Boxed NSNumber? params: null = "leave the persisted value intact".
      options.streamNow === undefined ? null : options.streamNow ? 1 : 0,
      options.minIntervalS ?? null,
      options.maxStrayStreamS ?? null
    );
  },

  async requestAlwaysAuthorization(): Promise<{ status: string }> {
    return { status: String(shim().requestAlwaysAuthorization()) };
  },

  async requestNotificationAuthorization(): Promise<void> {
    shim().requestNotificationAuthorization();
  },

  async requestBatteryExemption(): Promise<{ ignoringBatteryOptimizations: boolean }> {
    return { ignoringBatteryOptimizations: !!shim().requestBatteryExemption() };
  },

  async openAppSettings(): Promise<void> {
    shim().openAppSettings();
  },

  async addFence(options): Promise<{ monitoredCount: number }> {
    const count = shim().addFenceWithIdLatitudeLongitudeRadiusName(
      options.id,
      options.latitude,
      options.longitude,
      options.radius ?? 200,
      options.name ?? null
    );
    return { monitoredCount: Number(count) };
  },

  async clearFences(): Promise<void> {
    shim().clearFences();
  },

  async setTrackingMode(opts: { mode: TrackingMode }): Promise<{ mode: TrackingMode; streaming: boolean }> {
    return normalizeModeState(nsToJs(shim().setTrackingMode(opts.mode)) as Record<string, unknown>);
  },

  async getTrackingMode(): Promise<{ mode: TrackingMode; streaming: boolean }> {
    return normalizeModeState(nsToJs(shim().getTrackingMode()) as Record<string, unknown>);
  },

  async getDiagnostics(): Promise<NativeDiagnostics> {
    return normalizeDiagnostics(nsToJs(shim().diagnostics()) as Record<string, unknown>);
  },

  async addListener(
    eventName: "regionEvent",
    listener: (event: RegionEvent) => void
  ): Promise<PluginListenerHandle> {
    if (eventName !== "regionEvent") {
      throw new Error(`NativeGeofence.addListener: unknown event "${eventName}" — only "regionEvent" is emitted`);
    }
    listeners.add(listener);
    if (!sinkInstalled) {
      // ONE native sink fanning out to all JS listeners — the engine holds a
      // single onRegionEvent closure (extraction-plan R1).
      shim().onRegionEvent = (dict) => {
        const event = normalizeRegionEvent(nsToJs(dict) as Parameters<typeof normalizeRegionEvent>[0]);
        listeners.forEach((l) => {
          try {
            l(event);
          } catch (e) {
            console.error("Checkpoint: regionEvent listener threw", e);
          }
        });
      };
      sinkInstalled = true;
    }
    return {
      remove: async () => {
        listeners.delete(listener);
        if (listeners.size === 0 && sinkInstalled) {
          shim().onRegionEvent = null;
          sinkInstalled = false;
        }
      },
    };
  },
};

/**
 * Forward the host AppDelegate's location cold-relaunch revive (extraction-plan
 * R2): call from `applicationDidFinishLaunchingWithOptions` when
 * `UIApplicationLaunchOptionsLocationKey` is present so an always+streamNow
 * device resumes streaming after a force-quit.
 */
export function reviveForBackgroundLaunch(): void {
  shim().reviveForBackgroundLaunch();
}

/**
 * Android-only concept (permission-result re-arm hook); no-op on iOS —
 * CLLocationManager accepts startMonitoring(for:) before the grant, so a region
 * registered pre-grant stays registered and activates once authorization lands
 * (Play Services rejects addGeofences without permission, hence the Android hook).
 */
export function notifyPermissionsChanged(): void {}

export const Checkpoint = makeCheckpoint(NativeGeofence);
