import { registerPlugin } from "@capacitor/core";
import type { NativeGeofencePlugin } from "./definitions.js";

/**
 * The raw native plugin handle.
 *
 * `registerPlugin` returns a proxy that bridges to the native `NativeGeofence`
 * implementation on iOS/Android and throws "not implemented" on web (there is no
 * region monitoring in a browser). Callers gate on `Capacitor.getPlatform()` and
 * swallow the web rejection, exactly as the in-app code did before extraction.
 *
 * The JS plugin name MUST stay `"NativeGeofence"` — it is the frozen bridge name
 * the iOS `@objc(NativeGeofence)` / Android `@CapacitorPlugin(name="NativeGeofence")`
 * implementations register under. Changing it silently disconnects JS from native.
 */
export const NativeGeofence = registerPlugin<NativeGeofencePlugin>("NativeGeofence");
