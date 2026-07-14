// Frozen public contract — MIRRORED EXACTLY from @geoseal/capacitor
// (packages/checkpoint-capacitor/src/definitions.ts). The whole point of the
// wrapper program is that every framework exposes the SAME types, method names,
// TrackingMode values, RegionEvent shape, and listener semantics. Do NOT diverge
// this file from the Capacitor contract without re-coordinating all wrappers +
// the native builds.
//
// The ONLY intentional difference from the Capacitor definitions is the listener
// handle type: Capacitor returns a `PluginListenerHandle`; React Native returns
// an `EmitterSubscription`-shaped `{ remove(): void }`. The method name, event
// name ("regionEvent"), and payload are identical.

/**
 * Tracking mode — the per-device behavior the org governs and the user selects
 * within policy (tracking-modes §2). FROZEN contract: iOS + Android implement
 * against these exact signatures (§4).
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

/** RN listener handle — the cross-framework analogue of Capacitor's PluginListenerHandle. */
export interface RegionEventSubscription {
  remove(): void;
}

/**
 * Native wake-on-geofence interface (iOS + Android). MIRRORS the Capacitor
 * `NativeGeofencePlugin` interface method-for-method. The native module bridges
 * each of these to the SAME engine the Capacitor SDK uses (iOS `GeofenceManager`,
 * Android `GeofenceStore` + Play Services geofencing + foreground services), so a
 * region crossing wakes a force-quit app and POSTs to /v1/ingest from the native
 * networking layer (URLSession / OkHttp) — never a JS `fetch` (JS dies on
 * backgrounding). JS computes NO geofence logic.
 */
export interface NativeGeofencePlugin {
  /**
   * Persist platform creds (base URL, anon key, publishable key) + the subject's
   * external id natively so background relaunches can POST to /v1/ingest.
   *
   * Tracking-modes §4: the optional `trackingMode` / `streamNow` / `minIntervalS`
   * fields carry the last server directive so a BACKGROUND RELAUNCH (process
   * death + region-wake / reboot) knows what to do WITHOUT first waiting for JS.
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
   * app-standby). No-op on iOS / when already exempt.
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

  /** Persist + apply the effective tracking mode (tracking-modes §4). Idempotent. */
  setTrackingMode(opts: { mode: TrackingMode }): Promise<{ mode: TrackingMode; streaming: boolean }>;

  /** Current mode + whether a continuous stream is live right now (tracking-modes §4). */
  getTrackingMode(): Promise<{ mode: TrackingMode; streaming: boolean }>;

  /** Snapshot of native region-monitoring state for an in-app debug screen. */
  getDiagnostics(): Promise<NativeDiagnostics>;

  /** Fires on a native enter/exit while the JS runtime is alive. */
  addListener(
    eventName: "regionEvent",
    listener: (event: RegionEvent) => void
  ): Promise<RegionEventSubscription>;
}
