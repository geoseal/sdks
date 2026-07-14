// Raw native plugin — the React Native analogue of Capacitor's `NativeGeofence`
// (packages/checkpoint-capacitor/src/plugin.ts). Resolves the native module
// (TurboModule on New Arch, legacy bridge module on Old Arch — same JS name
// "CheckpointGeofence"), adapts the codegen-flattened spec back to the frozen
// `NativeGeofencePlugin` contract, and wires the `regionEvent` emitter.

import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import type {
  NativeGeofencePlugin,
  NativeDiagnostics,
  RegionEvent,
  RegionEventSubscription,
  TrackingMode,
} from "./definitions";

const LINKING_ERROR =
  `The package '@geoseal/react-native' doesn't seem to be linked. Make sure:\n` +
  Platform.select({ ios: "- You ran `pod install`\n", default: "" }) +
  "- You rebuilt the app after installing the package\n" +
  "- You are not using Expo Go (use a development build).";

// Prefer the TurboModule (New Architecture). Fall back to the legacy bridge
// module of the same name on the classic architecture. Throw a helpful error if
// neither is present rather than the opaque "undefined is not an object".
function resolveNativeModule() {
  // TurboModuleRegistry path (New Arch). Importing the spec triggers codegen
  // lookup; on Old Arch it resolves to the same NativeModules entry.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const turbo = require("./NativeCheckpointGeofence").default;
    if (turbo) return turbo;
  } catch {
    // codegen spec not available (e.g. pure JS test env) — fall through.
  }
  const legacy = NativeModules.CheckpointGeofence;
  if (legacy) return legacy;
  return new Proxy(
    {},
    {
      get() {
        throw new Error(LINKING_ERROR);
      },
    }
  );
}

const CheckpointGeofence = resolveNativeModule();

// One shared emitter, created lazily: NativeEventEmitter's constructor reads
// addListener/removeListeners off the module on iOS, so constructing it at
// module scope makes an unlinked install throw at import time instead of at
// first native call (the unlinked fallback Proxy throws on any property get).
// On the native side iOS extends RCTEventEmitter and Android uses
// DeviceEventManagerModule.RCTDeviceEventEmitter — both surface here as the
// single "regionEvent" event, payload-identical to the Capacitor contract.
let emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter {
  if (!emitter) emitter = new NativeEventEmitter(CheckpointGeofence);
  return emitter;
}

/**
 * The frozen `NativeGeofencePlugin` surface, implemented over the RN native
 * module. Method names / params / return shapes mirror Capacitor exactly.
 */
export const NativeGeofence: NativeGeofencePlugin = {
  configure(options) {
    return CheckpointGeofence.configure(
      options.baseUrl,
      options.anonKey,
      options.publishableKey,
      options.subjectExternalId,
      options.deviceId,
      options.trackingMode,
      options.streamNow,
      options.minIntervalS,
      options.maxStrayStreamS
    );
  },

  requestAlwaysAuthorization() {
    return CheckpointGeofence.requestAlwaysAuthorization();
  },

  requestNotificationAuthorization() {
    return CheckpointGeofence.requestNotificationAuthorization();
  },

  requestBatteryExemption() {
    return CheckpointGeofence.requestBatteryExemption();
  },

  openAppSettings() {
    return CheckpointGeofence.openAppSettings();
  },

  addFence(options) {
    return CheckpointGeofence.addFence(
      options.id,
      options.latitude,
      options.longitude,
      options.radius,
      options.name
    );
  },

  clearFences() {
    return CheckpointGeofence.clearFences();
  },

  setTrackingMode(opts) {
    return CheckpointGeofence.setTrackingMode(opts.mode) as Promise<{
      mode: TrackingMode;
      streaming: boolean;
    }>;
  },

  getTrackingMode() {
    return CheckpointGeofence.getTrackingMode() as Promise<{
      mode: TrackingMode;
      streaming: boolean;
    }>;
  },

  getDiagnostics() {
    return CheckpointGeofence.getDiagnostics() as Promise<NativeDiagnostics>;
  },

  // Mirror Capacitor's Promise-returning addListener so app code reads identically.
  // The handle's `.remove()` matches both Capacitor's PluginListenerHandle and
  // RN's EmitterSubscription.
  async addListener(
    eventName: "regionEvent",
    listener: (event: RegionEvent) => void
  ): Promise<RegionEventSubscription> {
    const sub = getEmitter().addListener(eventName, listener);
    return { remove: () => sub.remove() };
  },
};
