/**
 * Structurally identical to @capacitor/core's PluginListenerHandle. Localized so
 * this file (re-exported by the Capacitor-free './core' subpath) has zero
 * @capacitor/core reachability; structural typing keeps the two interchangeable.
 */
export interface PluginListenerHandle {
  remove: () => Promise<void>;
}

/**
 * Native wake-on-geofence plugin (iOS + Android).
 *
 * The outer perimeter geofence is registered as a native `CLCircularRegion` /
 * Play Services `Geofence` and monitored by region monitoring, which wakes the
 * app (even from killed/suspended) on enter/exit. On a region event the native
 * code POSTs a location ping to the platform `/v1/ingest` directly from native
 * code (URLSession / HttpURLConnection) — so a crossing is recorded even when
 * this JS/webview is dead. The server trigger + inner-ring evaluation do the
 * rest; JS does NOT compute geofence logic here.
 *
 * Implemented in `ios/Sources/CheckpointCapacitorPlugin/NativeGeofence.swift`
 * (+ `GeofenceManager.swift`) and
 * `android/.../com/checkpoint/capacitor/NativeGeofencePlugin.java` (+ the store
 * / receivers / services).
 */
/**
 * Tracking mode — the per-device behavior the org governs and the user selects
 * within policy (tracking-modes §2). FROZEN contract: iOS + Android implement
 * against these exact signatures (§4). Do not change without re-coordinating the
 * native builds.
 *
 *   geofence (DEFAULT) — region monitoring as today. On perimeter ENTER the
 *                        native layer starts a CONTINUOUS fine stream
 *                        (startUpdatingLocation / requestLocationUpdates,
 *                        distanceFilter ~10 m, interval ~min_interval_s); on
 *                        perimeter EXIT it stops the stream. The one-shot coarse
 *                        wake ping still fires on the crossing as today.
 *   always            — if streamNow ⇒ start the continuous stream immediately
 *                        and keep regions registered as a backstop; if !streamNow
 *                        ⇒ behave exactly as geofence. ("always" is shift-scoped
 *                        by the server, NOT literally 24/7 — streamNow gates it.)
 *   off               — stop the continuous stream and clear/minimize regions.
 */
export type TrackingMode = "geofence" | "always" | "off";

export interface RegionEvent {
  /**
   * `enter`/`exit` are region crossings; `update` is a continuous-stream fix;
   * `stray_stream_stopped` fires when the native stray-stream lifetime cap
   * self-stops a reactive stream that went `maxStrayStreamS` without a single
   * fresh in-fence fix (regionId is "" and lat/lng carry the last off-site fix).
   */
  type: "enter" | "exit" | "update" | "stray_stream_stopped";
  regionId: string;
  latitude: number;
  longitude: number;
  /** meters; -1 when the native fix had an invalid accuracy. */
  accuracy: number;
  timestamp: string;
}

export interface NativeFenceDiag {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius: number;
}

export interface NativeDiagnostics {
  authStatus: string;
  monitoredCount: number;
  monitoredIds: string[];
  configured: boolean;
  subjectExternalId: string;
  baseUrl: string;
  fences: NativeFenceDiag[];
  /** Total armed fences (iOS: fenceGeom count). When it exceeds the OS's 20-region cap the native layer monitors only the nearest 20; monitoredCount then trails this. */
  armedFenceCount?: number;
  /** OS location master switch. false ⇒ every provider is dark and no fix can arrive (the location_services_off outage). iOS: CLLocationManager.locationServicesEnabled(); Android: LocationManagerCompat.isLocationEnabled(). */
  locationServicesEnabled?: boolean;
  /** Android: false means the OEM may force-stop the app + drop geofence broadcasts. Always true on iOS. */
  ignoringBatteryOptimizations?: boolean;
  /** Tracking-modes §4. Current effective mode persisted natively (UserDefaults / SharedPreferences). */
  mode?: TrackingMode;
  /** Whether a continuous fine-location stream is live right now. */
  streaming?: boolean;
  /** ISO timestamp of the last continuous-stream fix the native layer POSTed, or null. */
  lastStreamFixAt?: string | null;
  /** The last server `stream_now` directive the native layer is acting on (always-mode gate). */
  streamNow?: boolean;
  /** iOS only: whether significant-location-change monitoring is armed (the always-mode transit keep-alive that revives a suspended stream mid-drive). */
  slcMonitoring?: boolean;
  /** Stray-stream bound: the active cap in seconds (default 600). A reactive stream that goes this long without one fresh in-fence fix stops itself. */
  maxStrayStreamS?: number;
  /** ISO timestamp of the last stray-cap self-stop, or null. Persisted natively so a field report survives relaunch. */
  lastStrayStreamStopAt?: string | null;
}

export interface NativeGeofencePlugin {
  /**
   * Persist platform creds (base URL, anon key, publishable key) + the subject's
   * external id to UserDefaults so background relaunches can POST to /v1/ingest.
   *
   * Tracking-modes §4: the optional `trackingMode` / `streamNow` / `minIntervalS`
   * fields carry the last server directive so a BACKGROUND RELAUNCH (process
   * death + region-wake / reboot) knows what to do WITHOUT first waiting for JS
   * to come up. Natives MUST persist these alongside the creds and resume the
   * correct behavior on relaunch:
   *   - trackingMode=always & streamNow ⇒ start the continuous stream immediately
   *   - trackingMode=geofence ⇒ region-monitor only; stream starts on ENTER
   *   - trackingMode=off ⇒ stop streaming + minimize regions
   * Continuous fixes are POSTed by the native layer (URLSession / OkHttp) with
   * source:"continuous_stream" — NOT JS fetch (which dies on backgrounding).
   */
  configure(options: {
    baseUrl: string;
    anonKey: string;
    publishableKey: string;
    subjectExternalId: string;
    deviceId?: string;
    trackingMode?: TrackingMode;
    streamNow?: boolean;
    minIntervalS?: number;
    /**
     * Stray-stream bound: max lifetime (seconds) a REACTIVE continuous stream
     * (geofence mode, or always without streamNow) may run without a single
     * fresh fix landing inside an armed fence before it stops itself and emits
     * a `stray_stream_stopped` regionEvent. Bounds the accepted keep-bias
     * tradeoff (a stream kept alive on an indeterminate mode re-apply can
     * otherwise post off-site indefinitely once its fence is disarmed — no EXIT
     * will ever fire). Default 600 (10 min); non-positive values are ignored.
     * Proactive always+streamNow streams are exempt (off-site streaming is
     * their purpose).
     */
    maxStrayStreamS?: number;
  }): Promise<void>;

  /** Prompt for "Always" location authorization (required for background region wakes). */
  requestAlwaysAuthorization(): Promise<{ status: string }>;

  /** Prompt for local-notification permission (for "arrived/left" alerts on a crossing). */
  requestNotificationAuthorization(): Promise<void>;

  /**
   * Android: prompt to exempt the app from battery optimization (Doze / OEM
   * app-standby). On aggressive OEMs (Samsung One UI especially) an optimized app
   * is force-stopped in the background and its receivers disabled, so geofence
   * broadcasts never wake a killed process. No-op on iOS / when already exempt.
   */
  requestBatteryExemption(): Promise<{ ignoringBatteryOptimizations: boolean }>;

  /** Open the OS Settings page for this app (the only reliable path to change location auth after the one-time prompt is consumed). */
  openAppSettings(): Promise<void>;

  /** Start monitoring a circular region. radius is meters (defaults to 200 native-side). */
  addFence(options: {
    id: string;
    latitude: number;
    longitude: number;
    radius?: number;
    name?: string;
  }): Promise<{ monitoredCount: number }>;

  /** Stop monitoring all regions. */
  clearFences(): Promise<void>;

  /**
   * Persist + apply the effective tracking mode (tracking-modes §4). Idempotent.
   *
   * Native MUST persist the mode across process death (UserDefaults /
   * SharedPreferences) and resume it on relaunch + reboot. Applying a mode:
   *   - geofence ⇒ keep regions registered; do not pre-start a stream (the
   *                stream starts reactively on region ENTER, stops on EXIT).
   *   - always   ⇒ if the current server streamNow directive is true, start the
   *                continuous stream now and keep regions as a backstop; else
   *                behave as geofence.
   *   - off      ⇒ stop any continuous stream and clear/minimize regions.
   * Returns the applied mode and whether a stream is live as a result.
   */
  setTrackingMode(opts: { mode: TrackingMode }): Promise<{ mode: TrackingMode; streaming: boolean }>;

  /** Current mode + whether a continuous stream is live right now (tracking-modes §4). */
  getTrackingMode(): Promise<{ mode: TrackingMode; streaming: boolean }>;

  /** Snapshot of native region-monitoring state for the in-app debug screen. */
  getDiagnostics(): Promise<NativeDiagnostics>;

  /** Fires on a native enter/exit while the webview is alive. */
  addListener(
    eventName: "regionEvent",
    listener: (event: RegionEvent) => void
  ): Promise<PluginListenerHandle>;
}
