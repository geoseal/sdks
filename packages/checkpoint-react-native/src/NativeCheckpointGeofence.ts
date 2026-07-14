// TurboModule codegen spec (New Architecture).
//
// React Native's codegen reads this `Spec` to generate the native interface
// (`NativeCheckpointGeofenceSpec` on Android, the `<ModuleName>Spec` protocol on
// iOS). The file name MUST start with `Native` and the default export MUST be the
// result of `TurboModuleRegistry.get(...)` for codegen to pick it up.
//
// Codegen constraints force a few shape compromises vs the rich contract in
// definitions.ts (the New-Arch typed bridge does not allow string-literal unions
// or optional-bag object params). We therefore:
//   - take the configure options as discrete params (codegen-friendly), and
//   - return diagnostics / mode results as `Object` and re-type them at the JS
//     facade boundary (plugin.ts) back to the frozen contract types.
// The PUBLIC API the app imports (index.ts) is byte-identical to Capacitor; this
// spec is an internal bridge detail.

import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  configure(
    baseUrl: string,
    anonKey: string,
    publishableKey: string,
    subjectExternalId: string,
    deviceId?: string,
    trackingMode?: string,
    streamNow?: boolean,
    minIntervalS?: number,
    maxStrayStreamS?: number
  ): Promise<void>;

  requestAlwaysAuthorization(): Promise<{ status: string }>;

  requestNotificationAuthorization(): Promise<void>;

  requestBatteryExemption(): Promise<{ ignoringBatteryOptimizations: boolean }>;

  openAppSettings(): Promise<void>;

  addFence(
    id: string,
    latitude: number,
    longitude: number,
    radius?: number,
    name?: string
  ): Promise<{ monitoredCount: number }>;

  clearFences(): Promise<void>;

  setTrackingMode(mode: string): Promise<{ mode: string; streaming: boolean }>;

  getTrackingMode(): Promise<{ mode: string; streaming: boolean }>;

  // Codegen requires the capital-O `Object` type for an untyped bag (see header).
  // eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
  getDiagnostics(): Promise<Object>;

  // RCTEventEmitter / DeviceEventManagerModule bookkeeping. RN requires these to
  // exist on a module that emits events; the JS NativeEventEmitter calls them.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>("CheckpointGeofence");
