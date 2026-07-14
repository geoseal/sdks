// Layer 1 — the raw NativeGeofence bridge over cordova.exec.
//
// The service name "CheckpointGeofence" matches the <feature> entries in
// plugin.xml (iOS ios-package CheckpointCordova, Android
// com.checkpoint.cordova.CheckpointCordova). The METHOD surface and every wire
// value mirror the frozen contract in @geoseal/capacitor's definitions.ts —
// the native bridges forward to the exact same engines (iOS
// GeofenceManager.shared via the CheckpointCore pod, Android
// GeofenceStore/ContinuousLocationService via dev.checkpoint:checkpoint-core).
import exec from "cordova/exec";
import type {
  NativeGeofencePlugin,
  NativeDiagnostics,
  PluginListenerHandle,
  RegionEvent,
  TrackingMode,
} from "@geoseal/capacitor/core";

const SERVICE = "CheckpointGeofence";

function invoke<T>(action: string, args: unknown[] = []): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    exec(
      (result?: T) => resolve(result as T),
      (err?: unknown) =>
        reject(err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err ?? "unknown error"))),
      SERVICE,
      action,
      args
    );
  });
}

// ── regionEvent channel ───────────────────────────────────────────────────────
// Cordova has no addListener primitive, so the native side keeps ONE long-lived
// exec callback (PluginResult keepCallback=true) and pushes every RegionEvent
// through it; JS fans out to the registered listeners. Started lazily on the
// first addListener — the channel is best-effort while the webview is alive,
// exactly like the Capacitor `regionEvent` listener (the background POST path
// is native and independent of JS).

type RegionEventListener = (event: RegionEvent) => void;
const regionEventListeners = new Set<RegionEventListener>();
let channelStarted = false;

function ensureRegionEventChannel(): void {
  if (channelStarted) return;
  channelStarted = true;
  exec(
    (event?: RegionEvent) => {
      if (!event) return;
      for (const listener of Array.from(regionEventListeners)) {
        try {
          listener(event);
        } catch (e) {
          console.error("Checkpoint: regionEvent listener threw", e);
        }
      }
    },
    (err?: unknown) => {
      // Channel registration failed (e.g. plugin missing) — allow a retry on the
      // next addListener instead of wedging silently.
      channelStarted = false;
      console.error("Checkpoint: regionEvent channel failed", err);
    },
    SERVICE,
    "registerRegionEventChannel",
    []
  );
}

/**
 * The raw native plugin handle (Layer 1). Method-for-method mirror of
 * `@geoseal/capacitor`'s `NativeGeofence` registerPlugin proxy — same frozen
 * contract (`NativeGeofencePlugin`), bridged over cordova.exec instead.
 */
export const NativeGeofence: NativeGeofencePlugin = {
  configure(options): Promise<void> {
    return invoke<void>("configure", [options]);
  },

  requestAlwaysAuthorization(): Promise<{ status: string }> {
    return invoke<{ status: string }>("requestAlwaysAuthorization");
  },

  requestNotificationAuthorization(): Promise<void> {
    return invoke<void>("requestNotificationAuthorization");
  },

  requestBatteryExemption(): Promise<{ ignoringBatteryOptimizations: boolean }> {
    return invoke<{ ignoringBatteryOptimizations: boolean }>("requestBatteryExemption");
  },

  openAppSettings(): Promise<void> {
    return invoke<void>("openAppSettings");
  },

  addFence(options): Promise<{ monitoredCount: number }> {
    return invoke<{ monitoredCount: number }>("addFence", [options]);
  },

  clearFences(): Promise<void> {
    return invoke<void>("clearFences");
  },

  setTrackingMode(opts): Promise<{ mode: TrackingMode; streaming: boolean }> {
    return invoke<{ mode: TrackingMode; streaming: boolean }>("setTrackingMode", [opts]);
  },

  getTrackingMode(): Promise<{ mode: TrackingMode; streaming: boolean }> {
    return invoke<{ mode: TrackingMode; streaming: boolean }>("getTrackingMode");
  },

  getDiagnostics(): Promise<NativeDiagnostics> {
    return invoke<NativeDiagnostics>("getDiagnostics");
  },

  async addListener(
    eventName: "regionEvent",
    listener: (event: RegionEvent) => void
  ): Promise<PluginListenerHandle> {
    void eventName; // "regionEvent" is the only event (type-enforced).
    ensureRegionEventChannel();
    regionEventListeners.add(listener);
    return {
      remove: async () => {
        regionEventListeners.delete(listener);
      },
    };
  },
};
