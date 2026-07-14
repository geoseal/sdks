// @geoseal/nativescript — Android implementation.
//
// Drives com.checkpoint.core.CheckpointGeofence (dev.checkpoint:checkpoint-core
// AAR) DIRECTLY via NativeScript runtime marshalling — the shim IS the binding.
// The permission prompts need an Activity; @nativescript/core supplies the
// foreground Activity + application Context.

import { Application, Utils } from "@nativescript/core";
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

let instance: com.checkpoint.core.CheckpointGeofence | null = null;

function shim(): com.checkpoint.core.CheckpointGeofence {
  if (!instance) {
    instance = new com.checkpoint.core.CheckpointGeofence(Utils.android.getApplicationContext());
  }
  return instance;
}

// The shim's prompt methods tolerate null (they log + return current status),
// mirroring the reference plugin's no-Activity guard.
function currentActivity(): android.app.Activity | null {
  return Application.android?.foregroundActivity ?? Application.android?.startActivity ?? null;
}

function modeState(map: java.util.Map<string, any>): { mode: TrackingMode; streaming: boolean } {
  return normalizeModeState({ mode: map.get("mode"), streaming: map.get("streaming") });
}

const listeners = new Set<(event: RegionEvent) => void>();
let sinkInstalled = false;

export const NativeGeofence: NativeGeofencePlugin = {
  async configure(options): Promise<void> {
    assertConfigureCreds(options);
    shim().configure(
      options.baseUrl,
      options.anonKey,
      options.publishableKey,
      options.subjectExternalId,
      options.deviceId ?? "android-native",
      options.trackingMode ?? null,
      // Boxed so null = "leave the persisted value intact" (shim contract).
      options.streamNow === undefined ? null : java.lang.Boolean.valueOf(options.streamNow),
      options.minIntervalS === undefined ? null : java.lang.Integer.valueOf(options.minIntervalS),
      options.maxStrayStreamS === undefined ? null : java.lang.Integer.valueOf(options.maxStrayStreamS)
    );
  },

  async requestAlwaysAuthorization(): Promise<{ status: string }> {
    return { status: String(shim().requestAlwaysAuthorization(currentActivity())) };
  },

  async requestNotificationAuthorization(): Promise<void> {
    shim().requestNotificationAuthorization(currentActivity());
  },

  async requestBatteryExemption(): Promise<{ ignoringBatteryOptimizations: boolean }> {
    return { ignoringBatteryOptimizations: !!shim().requestBatteryExemption(currentActivity()) };
  },

  async openAppSettings(): Promise<void> {
    shim().openAppSettings();
  },

  async addFence(options): Promise<{ monitoredCount: number }> {
    const count = shim().addFence(
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
    return modeState(shim().setTrackingMode(opts.mode));
  },

  async getTrackingMode(): Promise<{ mode: TrackingMode; streaming: boolean }> {
    return modeState(shim().getTrackingMode());
  },

  async getDiagnostics(): Promise<NativeDiagnostics> {
    // org.json.JSONObject → JSON text → plain JS (JSONObject.NULL serializes to null).
    return normalizeDiagnostics(JSON.parse(String(shim().diagnostics().toString())));
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
      // ONE native sink fanning out to all JS listeners (GeofenceStore holds a
      // single wrapper listener). Invoked on the receiver's thread.
      shim().setRegionEventListener(
        new com.checkpoint.core.RegionEventListener({
          onRegionEvent: (type, regionId, latitude, longitude, accuracy, timestamp) => {
            const event = normalizeRegionEvent({ type, regionId, latitude, longitude, accuracy, timestamp });
            listeners.forEach((l) => {
              try {
                l(event);
              } catch (e) {
                console.error("Checkpoint: regionEvent listener threw", e);
              }
            });
          },
        })
      );
      sinkInstalled = true;
    }
    return {
      remove: async () => {
        listeners.delete(listener);
        if (listeners.size === 0 && sinkInstalled) {
          shim().setRegionEventListener(null);
          sinkInstalled = false;
        }
      },
    };
  },
};

/** iOS-only concept (AppDelegate location cold-relaunch); no-op on Android — the engine's BootReceiver / services handle relaunch natively. */
export function reviveForBackgroundLaunch(): void {}

/**
 * Android host hook — call from your Activity's `onRequestPermissionsResult`
 * (or after your own permission flow completes). The shim launches the system
 * permission prompt but owns no Activity, so it never observes the grant; this
 * re-registers persisted fences (background-armed once "Allow all the time" is
 * held) and re-applies the persisted mode/directive. Idempotent and safe to
 * call any time.
 */
export function notifyPermissionsChanged(): void {
  shim().notifyPermissionsChanged();
}

export const Checkpoint = makeCheckpoint(NativeGeofence);
