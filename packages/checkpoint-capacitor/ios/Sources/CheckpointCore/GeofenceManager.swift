import Foundation
import CoreLocation
import UIKit
import UserNotifications

/// Shared region-monitoring engine. Owns the single `CLLocationManager`, persists
/// config to `UserDefaults` (so a background relaunch can POST without the webview),
/// and POSTs location pings to Supabase `location_history` from native Swift.
///
/// A singleton (rather than per-plugin-instance state) so the AppDelegate location
/// relaunch path can revive the manager and receive the queued region event even
/// before any Capacitor plugin instance exists.
///
/// `public` (+ `public shared` / `public reviveForBackgroundLaunch`) so the host
/// app's `AppDelegate` can reach the engine ACROSS the pod module boundary — the
/// access-control change the extraction requires (R2). No logic changed.
public final class GeofenceManager: NSObject, CLLocationManagerDelegate {

    public static let shared = GeofenceManager()

    // UserDefaults keys — config + armed geometry must survive a cold relaunch
    // (a region wake can revive a force-quit app with no webview / in-memory state).
    private enum Key {
        static let baseUrl = "ngf_base_url"
        static let anonKey = "ngf_anon_key"
        static let pk = "ngf_pk"
        static let subjectExternalId = "ngf_subject_external_id"
        static let deviceId = "ngf_device_id"
        static let fenceNames = "ngf_fence_names"
        static let fenceGeom = "ngf_fence_geom"
        // Tracking-modes §4 — persisted so a background relaunch (region wake /
        // significant-location-change / reboot) resumes the right behavior without
        // first waiting for JS to come up.
        static let trackingMode = "ngf_tracking_mode"
        static let streamNow = "ngf_stream_now"
        static let minIntervalS = "ngf_min_interval_s"
        // Stray-stream bound: max reactive-stream lifetime without an in-fence fix
        // + the last self-stop timestamp (diagnostics).
        static let maxStrayStreamS = "ngf_max_stray_stream_s"
        static let lastStrayStopAt = "ngf_last_stray_stop_at"
    }

    /// Tracking-modes §4. Default for a new device is `geofence` (plan §2).
    /// `public` so wrapper SDKs (RN/Flutter/Expo/MAUI) can name the mode across
    /// the pod module boundary (access-control only; cases unchanged).
    public enum TrackingMode: String {
        case geofence
        case always
        case off
    }

    private let locationManager = CLLocationManager()
    private let defaults = UserDefaults.standard

    /// Pending region event waiting for a one-shot location fix.
    private var pendingEventType: String?
    private var pendingRegionId: String?

    /// Whether `startUpdatingLocation` is currently running (a continuous fine
    /// stream is live). Distinct from the one-shot `requestLocation` wake fix.
    private var streaming = false

    /// Whether significant-location-change (SLC) monitoring is armed. SLC is the
    /// ONLY iOS mechanism that relaunches/wakes a suspended app while it travels
    /// without crossing a registered region (≈ every 500 m / cell-tower change).
    /// We use it as a keep-alive for the always-mode continuous stream: a long
    /// drive between two distant fences has NO crossings in the middle, so iOS
    /// would otherwise suspend the app and the `startUpdatingLocation` stream would
    /// silently stop until the next fence ENTER. Each SLC wake re-asserts the
    /// stream so the drive keeps being captured. (iOS/Android parity: Android holds
    /// the stream open with a START_STICKY foreground service; iOS has no
    /// foreground service, so SLC is the equivalent revive hook.)
    private var slcMonitoring = false

    /// Fixes older than this are stale: requestLocation()/region wakes can deliver
    /// a CACHED location (observed up to ~4h old) which, if posted, sorts next to a
    /// fresh point downstream and produces replay teleports / impossible speeds.
    /// Dropped at source. (Data-hygiene WS1.)
    private static let maxFixAgeSeconds: TimeInterval = 30

    /// CLLocationManager monitors AT MOST 20 regions per app; a startMonitoring past
    /// that fails silently (monitoringDidFailFor) and the surviving 20 are undefined.
    /// Multi-site staff assigned to >20 places would therefore lose background wake
    /// for an arbitrary subset. We register only the nearest `maxMonitoredRegions`
    /// to the last known location (the armed set arrives nearest-first from the
    /// server) and re-pick as the device moves.
    private static let maxMonitoredRegions = 20

    /// Reference fix of the last nearest-N region reconciliation + the min movement
    /// before we re-pick, so a continuous stream doesn't thrash startMonitoring.
    private var lastRegionReconcileAt: CLLocation?
    private static let regionReconcileMinMoveMeters: CLLocationDistance = 250

    /// ISO timestamp of the last continuous-stream fix we POSTed, for diagnostics.
    private var lastStreamFixAt: String?

    /// Monotonic clock of the last continuous-stream POST, for `minIntervalS`
    /// throttling. nil until the first stream fix is sent.
    private var lastStreamPostAt: Date?

    /// Default cadence hint (seconds) when the server hasn't sent `minIntervalS`.
    private let defaultMinIntervalS: Double = 15

    /// Stray-stream bound (keep-bias cap). The plausiblyInsideAnyFence keep-bias
    /// deliberately leaves an indeterminate stream running (killing a real
    /// in-ring dwell stream loses data). The accepted cost was "battery until the
    /// next EXIT" — but with no restored fences, or the dwelt-in fence disarmed,
    /// NO EXIT can ever fire, so the stream can postPing off-site indefinitely.
    /// This cap bounds that: a REACTIVE stream (geofence mode, or always without
    /// streamNow) that goes `maxStrayStreamS` without a single fresh fix landing
    /// INSIDE any armed fence stops itself and emits a diagnosable
    /// `stray_stream_stopped` event. A proactive always+streamNow stream is
    /// exempt — streaming off-site is its entire point (shift transit capture).
    private let defaultMaxStrayStreamS: Double = 600

    /// When the current continuous stream started (anchor for the stray cap when
    /// no in-fence fix has ever confirmed it).
    private var strayStreamStartedAt: Date?

    /// Monotonic-ish wall clock of the last fresh fix that landed INSIDE any
    /// armed fence (per validatedCrossingType tolerance). Resets the stray cap.
    private var lastConfirmingFixAt: Date?

    /// Fence id -> display name, for "Arrived at / Left" local notifications.
    private var fenceNames: [String: String] = [:]

    /// Fence id -> [lat, lng, radius]. Used to validate a coarse region event
    /// against the precise one-shot fix before notifying (suppresses a stale/
    /// false-direction "Arrived"/"Left"). Persisted so a cold wake can validate.
    private var fenceGeom: [String: [Double]] = [:]

    /// Called when the webview is alive so JS can react. Set by the plugin.
    /// `public` so wrapper SDKs can install their own live listener across the
    /// pod module boundary (access-control only; assignment semantics unchanged).
    public var onRegionEvent: (([String: Any]) -> Void)?

    private override init() {
        super.init()
        locationManager.delegate = self
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.pausesLocationUpdatesAutomatically = false
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        // Tune iOS's location heuristics for a worker who DRIVES between sites.
        // The default activityType (.other) lets CoreLocation apply conservative
        // power heuristics; .otherNavigation tells iOS this is continuous
        // position tracking for movement that may be vehicular OR pedestrian, so
        // it keeps delivering fixes during transit instead of culling them. (We
        // also set pausesLocationUpdatesAutomatically = false above; activityType
        // only matters if iOS ever re-enables auto-pause, but it's the correct
        // hint regardless.)
        locationManager.activityType = .otherNavigation
        // No distance filter: a displacement gate would suppress fixes from a
        // STATIONARY in-ring worker (e.g. a nurse at a station), starving the
        // engine's 3-consecutive-fix M-of-N so interior never confirms. Cadence
        // is bounded purely by time (`minIntervalS`) in didUpdateLocations.
        // Matches Android (W2). See plan §5 Phase 2 throttle alignment.
        locationManager.distanceFilter = kCLDistanceFilterNone
        // Restore armed-fence metadata so a cold region wake can name + validate
        // the crossing without the webview having re-registered yet.
        fenceNames = (defaults.dictionary(forKey: Key.fenceNames) as? [String: String]) ?? [:]
        fenceGeom = (defaults.dictionary(forKey: Key.fenceGeom) as? [String: [Double]]) ?? [:]
    }

    // MARK: - Config

    /// Persist creds + (optionally) the latest server tracking directive. The
    /// tracking fields are optional so an older JS caller is unaffected; when
    /// present they re-apply the mode so a background relaunch resumes correctly
    /// without waiting for JS (§4).
    public func configure(baseUrl: String,
                   anonKey: String,
                   publishableKey: String,
                   subjectExternalId: String,
                   deviceId: String,
                   trackingMode: String?,
                   streamNow: Bool?,
                   minIntervalS: Double?,
                   maxStrayStreamS: Double? = nil) {
        // Normalize: strip a trailing slash so we can append the function path cleanly.
        let trimmed = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        defaults.set(trimmed, forKey: Key.baseUrl)
        defaults.set(anonKey, forKey: Key.anonKey)
        defaults.set(publishableKey, forKey: Key.pk)
        defaults.set(subjectExternalId, forKey: Key.subjectExternalId)
        defaults.set(deviceId, forKey: Key.deviceId)

        if let streamNow = streamNow { defaults.set(streamNow, forKey: Key.streamNow) }
        if let minIntervalS = minIntervalS, minIntervalS > 0 {
            defaults.set(minIntervalS, forKey: Key.minIntervalS)
        }
        if let maxStrayStreamS = maxStrayStreamS, maxStrayStreamS > 0 {
            defaults.set(maxStrayStreamS, forKey: Key.maxStrayStreamS)
        }
        // Apply the directive's mode last so it acts on the freshly-persisted
        // streamNow gate. If no mode was supplied, leave the persisted one intact.
        if let trackingMode = trackingMode, let mode = TrackingMode(rawValue: trackingMode) {
            applyTrackingMode(mode)
        }
    }

    private var baseUrl: String? { defaults.string(forKey: Key.baseUrl) }
    private var anonKey: String? { defaults.string(forKey: Key.anonKey) }
    private var pk: String? { defaults.string(forKey: Key.pk) }
    private var subjectExternalId: String? { defaults.string(forKey: Key.subjectExternalId) }
    private var deviceId: String? { defaults.string(forKey: Key.deviceId) }

    // MARK: - Tracking mode (tracking-modes §4)

    /// Persisted effective mode. Defaults to `geofence` for a device that has
    /// never been told otherwise (plan §2 default).
    private var trackingMode: TrackingMode {
        get { TrackingMode(rawValue: defaults.string(forKey: Key.trackingMode) ?? "") ?? .geofence }
        set { defaults.set(newValue.rawValue, forKey: Key.trackingMode) }
    }

    /// Last server `stream_now` directive (the always-mode gate). Defaults false.
    private var streamNow: Bool { defaults.bool(forKey: Key.streamNow) }

    /// Cadence hint in seconds; falls back to the default when unset/non-positive.
    private var minIntervalS: Double {
        let stored = defaults.double(forKey: Key.minIntervalS)
        return stored > 0 ? stored : defaultMinIntervalS
    }

    /// Stray-stream cap in seconds; falls back to the default when unset/non-positive.
    private var maxStrayStreamS: Double {
        let stored = defaults.double(forKey: Key.maxStrayStreamS)
        return stored > 0 ? stored : defaultMaxStrayStreamS
    }

    public func currentMode() -> TrackingMode { trackingMode }
    public func isStreaming() -> Bool { streaming }

    /// Persist + apply a mode (idempotent). Returns whether a stream is live as a
    /// result. Region monitoring is left to addFence/clearFences and the server's
    /// fence set — applying a mode only governs the continuous stream + (for off)
    /// tears region monitoring down.
    @discardableResult
    public func applyTrackingMode(_ mode: TrackingMode) -> Bool {
        trackingMode = mode
        switch mode {
        case .geofence:
            // Stream is reactive: it starts on region ENTER, stops on EXIT. Do not
            // pre-start it here — and do NOT blindly kill a running one: JS
            // re-applies the directive on every app boot/resync, so an
            // unconditional stop killed the legitimate in-ring stream the ENTER
            // had just started (arrive → open app → stream dies after ~1 fix →
            // the engine's M-of-N never confirms). Android's applyMode has this
            // guard ("a running stream may be a legitimate in-ring dwell that
            // only the receiver's EXIT should stop"). Stop only when the freshest
            // fix says we are clearly outside every armed fence — i.e. a
            // proactive stream left over from an always→geofence switch.
            if streaming && !plausiblyInsideAnyFence() { stopContinuousStream() }
            // SLC is the always-mode keep-alive only; geofence mode wakes on the
            // regions themselves, so disarm it here.
            stopSignificantLocationMonitoring()
        case .always:
            // Shift-scoped: the server's streamNow gate decides. Regions stay
            // registered as a backstop (handled by addFence, untouched here).
            if streamNow {
                startContinuousStream()
                // Arm SLC so iOS revives a suspended app mid-drive (no crossings
                // between distant fences) and re-asserts the stream — the fix for
                // the silent transit gap.
                startSignificantLocationMonitoring()
            } else {
                // "Behaves exactly as geofence" (§4): an ENTER can have started a
                // legitimate in-ring stream here too (toggleOnCrossing = !streamNow),
                // and the JS boot re-apply must not kill it — same guard as the
                // .geofence branch. A stream left over from a streamNow window
                // ending mid-drive (fresh fix, outside all fences) still stops.
                if streaming && !plausiblyInsideAnyFence() { stopContinuousStream() }
                stopSignificantLocationMonitoring()
            }
        case .off:
            stopContinuousStream()
            stopSignificantLocationMonitoring()
            clearFences()
        }
        return streaming
    }

    /// Best-effort in-ring check for mode re-application. True when the freshest
    /// known fix lands within any armed fence's radius (+ tolerance), or when we
    /// cannot tell (no fences restored, no fix, stale fix) — the caller must then
    /// leave a running stream alone: killing a real in-ring dwell stream starves
    /// M-of-N confirmation and loses the exit (the original stuck-at-perimeter
    /// bug), while keeping a stray one only costs battery until the next EXIT,
    /// mode change, or app termination (no EXIT can fire when no fence is armed
    /// or the dwelt-in fence was disarmed — accepted keep-bias tradeoff).
    /// Tolerance mirrors validatedCrossingType (accuracy, floor 50m).
    private func plausiblyInsideAnyFence() -> Bool {
        guard !fenceGeom.isEmpty else { return true }
        guard let fix = locationManager.location,
              -fix.timestamp.timeIntervalSinceNow <= Self.maxFixAgeSeconds else {
            return true
        }
        let tolerance = max(fix.horizontalAccuracy >= 0 ? fix.horizontalAccuracy : 0, 50)
        for (_, geom) in fenceGeom where geom.count == 3 {
            let center = CLLocation(latitude: geom[0], longitude: geom[1])
            if fix.distance(from: center) <= geom[2] + tolerance { return true }
        }
        return false
    }

    // MARK: - Continuous stream (tracking-modes §4)

    /// Start the continuous fine-location stream. Idempotent.
    func startContinuousStream() {
        guard !streaming else { return }
        guard CLLocationManager.locationServicesEnabled() else {
            NSLog("[NativeGeofence] location services disabled; cannot stream")
            return
        }
        streaming = true
        // Anchor the stray-stream cap: a brand-new stream has not yet been
        // confirmed by an in-fence fix.
        strayStreamStartedAt = Date()
        lastConfirmingFixAt = nil
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.pausesLocationUpdatesAutomatically = false
        // §4 allows NearestTenMeters or best; use best so stream fixes are precise
        // enough to land in the tight interior ring (plan §1, the whole point) and
        // so a concurrent region-wake requestLocation() isn't degraded. init already
        // sets kCLLocationAccuracyBest; restated here for clarity + after an `off`.
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        // Time-only throttle (see init): never gate on displacement, or a
        // stationary in-ring worker stops emitting and M-of-N never confirms.
        locationManager.distanceFilter = kCLDistanceFilterNone
        // Restate the navigation activity hint after an `off` may have reset state.
        locationManager.activityType = .otherNavigation
        locationManager.startUpdatingLocation()
        NSLog("[NativeGeofence] continuous stream STARTED")
    }

    /// Arm significant-location-change monitoring. Idempotent. This is what lets
    /// iOS WAKE/RELAUNCH a suspended app during a long drive that crosses no
    /// registered region, so `ensureStreamingIfDirected()` can re-assert the
    /// continuous stream and the transit keeps being captured. Cheap (cell-tower
    /// granularity), so it's safe to leave armed whenever always+streamNow is in
    /// force. Requires Always authorization (already required for region wakes).
    func startSignificantLocationMonitoring() {
        guard !slcMonitoring else { return }
        guard CLLocationManager.significantLocationChangeMonitoringAvailable() else {
            NSLog("[NativeGeofence] SLC monitoring unavailable on this device")
            return
        }
        slcMonitoring = true
        locationManager.startMonitoringSignificantLocationChanges()
        NSLog("[NativeGeofence] SLC monitoring STARTED")
    }

    /// Disarm SLC monitoring. Idempotent.
    func stopSignificantLocationMonitoring() {
        guard slcMonitoring else { return }
        slcMonitoring = false
        locationManager.stopMonitoringSignificantLocationChanges()
        NSLog("[NativeGeofence] SLC monitoring STOPPED")
    }

    /// Re-assert the continuous stream + SLC keep-alive IF the persisted directive
    /// says we should be streaming (always + streamNow). Safe to call from any
    /// background wake (region event, SLC wake, cold relaunch): idempotent, and a
    /// no-op when we shouldn't be streaming. This is the self-heal that bridges a
    /// drive whose stream iOS suspended between two distant fences.
    private func ensureStreamingIfDirected() {
        guard trackingMode == .always, streamNow else { return }
        startSignificantLocationMonitoring()
        if !streaming { startContinuousStream() }
    }

    /// Stop the continuous stream. Idempotent. Leaves region monitoring intact.
    func stopContinuousStream() {
        guard streaming else { return }
        streaming = false
        locationManager.stopUpdatingLocation()
        lastStreamPostAt = nil
        strayStreamStartedAt = nil
        lastConfirmingFixAt = nil
        NSLog("[NativeGeofence] continuous stream STOPPED")
    }

    // MARK: - Stray-stream bound (client lifetime cap)

    /// STRICT in-fence test for the stray cap — the opposite bias of
    /// plausiblyInsideAnyFence: with no armed geometry a fix can NOT confirm the
    /// stream (that is exactly the no-restored-fences stray case the cap exists
    /// to bound), so empty geometry returns false, not true. Tolerance mirrors
    /// validatedCrossingType (accuracy, floor 50m).
    private func fixInsideAnyFence(_ fix: CLLocation) -> Bool {
        guard !fenceGeom.isEmpty else { return false }
        let tolerance = max(fix.horizontalAccuracy >= 0 ? fix.horizontalAccuracy : 0, 50)
        for (_, geom) in fenceGeom where geom.count == 3 {
            let center = CLLocation(latitude: geom[0], longitude: geom[1])
            if fix.distance(from: center) <= geom[2] + tolerance { return true }
        }
        return false
    }

    /// Whether the live stream has exceeded its stray lifetime: a REACTIVE stream
    /// (geofence, or always without streamNow) that has gone `maxStrayStreamS`
    /// without one fresh in-fence fix. Proactive always+streamNow streams are
    /// exempt (off-site streaming is their purpose; the server directive bounds
    /// them). The anchor is the last confirming fix, else the stream start; a
    /// stream revived without a recorded start (e.g. state predating this build)
    /// anchors NOW so the cap counts a full window before firing.
    private func strayCapExceeded(now: Date = Date()) -> Bool {
        guard streaming else { return false }
        if trackingMode == .always && streamNow { return false }
        if strayStreamStartedAt == nil { strayStreamStartedAt = now }
        let anchor = lastConfirmingFixAt ?? strayStreamStartedAt ?? now
        return now.timeIntervalSince(anchor) > maxStrayStreamS
    }

    /// Stop a stream the cap has judged stray, persist the stop for diagnostics,
    /// and emit a diagnosable `stray_stream_stopped` event to a live listener.
    /// The triggering fix is NOT posted — the whole point is to stop recording
    /// off-site positions the fence lifecycle can no longer bound.
    private func stopStrayStream(lastFix: CLLocation) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let stoppedAt = iso.string(from: Date())
        defaults.set(stoppedAt, forKey: Key.lastStrayStopAt)
        NSLog("[NativeGeofence] STRAY STREAM self-stop: no in-fence fix for %.0fs (cap %.0fs, %d armed fences) — stopping continuous stream",
              Date().timeIntervalSince(lastConfirmingFixAt ?? strayStreamStartedAt ?? Date()),
              maxStrayStreamS, fenceGeom.count)
        stopContinuousStream()
        onRegionEvent?([
            "type": "stray_stream_stopped",
            "regionId": "",
            "latitude": lastFix.coordinate.latitude,
            "longitude": lastFix.coordinate.longitude,
            "accuracy": lastFix.horizontalAccuracy >= 0 ? lastFix.horizontalAccuracy : -1,
            "timestamp": stoppedAt
        ])
    }

    // MARK: - Authorization

    public func requestAlwaysAuthorization() {
        // Region monitoring + background relaunch requires "Always".
        locationManager.requestAlwaysAuthorization()
    }

    /// Ask for local-notification permission so a crossing can surface a banner —
    /// even when the app was woken from killed/background by the region event.
    public func requestNotificationAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    /// Fire a local notification for a crossing. Runs in native code during the
    /// region-wake window, so it surfaces even when the webview/JS is dead.
    private func notifyCrossing(type: String, regionId: String) {
        let name = fenceNames[regionId] ?? "the facility"
        let content = UNMutableNotificationContent()
        content.title = "Checkpoint IRL"
        content.body = type == "enter" ? "Arrived at \(name)" : "Left \(name)"
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    public func authorizationStatusString() -> String {
        let status: CLAuthorizationStatus
        if #available(iOS 14.0, *) {
            status = locationManager.authorizationStatus
        } else {
            status = CLLocationManager.authorizationStatus()
        }
        switch status {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "authorizedAlways"
        case .authorizedWhenInUse: return "authorizedWhenInUse"
        @unknown default: return "unknown"
        }
    }

    // MARK: - Fences

    public func addFence(id: String, latitude: Double, longitude: Double, radius: Double, name: String?) {
        // Always ask for Always auth before monitoring; harmless if already granted.
        requestAlwaysAuthorization()
        if let name = name { fenceNames[id] = name }

        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else {
            NSLog("[NativeGeofence] region monitoring unavailable on this device")
            return
        }

        // iOS caps region radius at maximumRegionMonitoringDistance; clamp to be safe.
        let maxRadius = locationManager.maximumRegionMonitoringDistance
        let clamped = (maxRadius > 0 && radius > maxRadius) ? maxRadius : radius

        // Persist geometry (validation) + name (notification) BEFORE deciding whether
        // to register — the geometry must exist for reconcileMonitoredRegions() to
        // pick this fence up when the device later moves toward it.
        fenceGeom[id] = [latitude, longitude, clamped]
        persistFenceMetadata()

        // 20-region cap: iOS silently fails a startMonitoring past 20, so if we're
        // already at the cap and this fence isn't one of the monitored set, defer it.
        // The armed set arrives nearest-first (server order), so the first
        // `maxMonitoredRegions` we register are the nearest; the remainder are
        // re-picked by reconcileMonitoredRegions() as the device moves.
        let alreadyMonitored = locationManager.monitoredRegions.contains { $0.identifier == id }
        if !alreadyMonitored && locationManager.monitoredRegions.count >= Self.maxMonitoredRegions {
            NSLog("[NativeGeofence] armed fences exceed OS region limit (%d) — deferring %@ (monitoring nearest %d; re-picked on movement)",
                  Self.maxMonitoredRegions, id, Self.maxMonitoredRegions)
            return
        }

        let center = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        let region = CLCircularRegion(center: center, radius: clamped, identifier: id)
        region.notifyOnEntry = true
        region.notifyOnExit = true
        locationManager.startMonitoring(for: region)
    }

    /// Re-pick the OS-monitored region set to the nearest `maxMonitoredRegions`
    /// armed fences to `reference`. A no-op when the armed set fits under the cap
    /// (every fence is already monitored). Emits a distinct log when it re-picks so
    /// multi-site region truncation is visible in the field. Called on significant
    /// movement (see maybeReconcileRegions) so staff keep wakes for the sites they
    /// are now closest to, not the ones they were closest to at sync time.
    private func reconcileMonitoredRegions(reference: CLLocation) {
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        guard fenceGeom.count > Self.maxMonitoredRegions else { return }

        let ranked = fenceGeom
            .filter { $0.value.count == 3 }
            .map { (id: $0.key, geom: $0.value,
                    dist: reference.distance(from: CLLocation(latitude: $0.value[0], longitude: $0.value[1]))) }
            .sorted { $0.dist < $1.dist }
        let keep = Array(ranked.prefix(Self.maxMonitoredRegions))
        let keepIds = Set(keep.map { $0.id })

        var changed = false
        // Drop any monitored region that is no longer among the nearest set.
        for region in locationManager.monitoredRegions where !keepIds.contains(region.identifier) {
            locationManager.stopMonitoring(for: region)
            changed = true
        }
        // Register any nearest-set fence not currently monitored.
        let monitored = Set(locationManager.monitoredRegions.map { $0.identifier })
        for item in keep where !monitored.contains(item.id) {
            let region = CLCircularRegion(
                center: CLLocationCoordinate2D(latitude: item.geom[0], longitude: item.geom[1]),
                radius: item.geom[2], identifier: item.id)
            region.notifyOnEntry = true
            region.notifyOnExit = true
            locationManager.startMonitoring(for: region)
            changed = true
        }
        if changed {
            NSLog("[NativeGeofence] region set re-picked to nearest %d of %d armed fences",
                  keepIds.count, fenceGeom.count)
        }
    }

    /// Reconcile the nearest-N region set on SIGNIFICANT movement only, so the
    /// continuous stream (many fixes) doesn't thrash startMonitoring/stopMonitoring.
    /// No-op unless more fences are armed than the OS can monitor.
    private func maybeReconcileRegions(with location: CLLocation) {
        guard fenceGeom.count > Self.maxMonitoredRegions else { return }
        if let last = lastRegionReconcileAt,
           location.distance(from: last) < Self.regionReconcileMinMoveMeters {
            return
        }
        lastRegionReconcileAt = location
        reconcileMonitoredRegions(reference: location)
    }

    public func clearFences() {
        for region in locationManager.monitoredRegions {
            locationManager.stopMonitoring(for: region)
        }
        fenceNames.removeAll()
        fenceGeom.removeAll()
        // Force the next fresh fix to re-evaluate the nearest-N set from scratch.
        lastRegionReconcileAt = nil
        persistFenceMetadata()
    }

    private func persistFenceMetadata() {
        defaults.set(fenceNames, forKey: Key.fenceNames)
        defaults.set(fenceGeom, forKey: Key.fenceGeom)
    }

    public func monitoredCount() -> Int {
        return locationManager.monitoredRegions.count
    }

    /// Snapshot of native region-monitoring state for the in-app debug screen
    /// (task #9). Surfaces the things otherwise invisible in the field:
    /// authorization, how many regions the OS is actually monitoring, and the
    /// registered fence geometry.
    public func diagnostics() -> [String: Any] {
        var fences: [[String: Any]] = []
        for (id, g) in fenceGeom where g.count == 3 {
            fences.append([
                "id": id,
                "name": fenceNames[id] ?? id,
                "latitude": g[0],
                "longitude": g[1],
                "radius": g[2],
            ])
        }
        return [
            "authStatus": authorizationStatusString(),
            "monitoredCount": monitoredCount(),
            // Total armed fences vs monitoredCount: when this exceeds
            // maxMonitoredRegions (20) the OS can't monitor them all and we track
            // the nearest — the multi-site region-cap signal for the debug screen.
            "armedFenceCount": fenceGeom.count,
            "monitoredIds": locationManager.monitoredRegions.map { $0.identifier },
            "configured": baseUrl != nil && pk != nil && subjectExternalId != nil,
            "subjectExternalId": subjectExternalId ?? "",
            "baseUrl": baseUrl ?? "",
            // OS location master switch. false ⇒ no provider can deliver a fix (the
            // location_services_off outage). Surfaced for reconcileOutages + debug.
            "locationServicesEnabled": CLLocationManager.locationServicesEnabled(),
            "fences": fences,
            // Tracking-modes §4.
            "mode": trackingMode.rawValue,
            "streaming": streaming,
            "lastStreamFixAt": lastStreamFixAt as Any? ?? NSNull(),
            "streamNow": streamNow,
            // SLC keep-alive liveness — confirms on-device that the always-mode
            // transit-revive hook is armed.
            "slcMonitoring": slcMonitoring,
            // Stray-stream bound: the active cap + when the cap last self-stopped
            // a stream (persisted, so a field report survives relaunch).
            "maxStrayStreamS": maxStrayStreamS,
            "lastStrayStreamStopAt": defaults.string(forKey: Key.lastStrayStopAt) as Any? ?? NSNull(),
        ]
    }

    /// Called from AppDelegate on a location relaunch to ensure the delegate is wired
    /// and queued region events are delivered. The singleton's `init` already set the
    /// delegate; touching `shared` is enough to re-instantiate. Kept explicit for clarity.
    ///
    /// Tracking-modes §4: also resume the persisted mode WITHOUT waiting for JS. An
    /// `always` + `streamNow` device must start streaming again immediately on a
    /// cold relaunch (the very scenario the POC's wake-once path failed). `geofence`
    /// streams reactively on region ENTER, so there is nothing to pre-start there.
    public func reviveForBackgroundLaunch() {
        locationManager.delegate = self
        locationManager.allowsBackgroundLocationUpdates = true
        // Re-assert the stream AND the SLC keep-alive. A relaunch can be triggered
        // by either a region event (launchOptions[.location]) or an SLC wake; in
        // always+streamNow both must leave the device streaming + SLC-armed so the
        // rest of the drive is captured.
        ensureStreamingIfDirected()
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        handleRegionEvent(type: "enter", region: region, manager: manager)
    }

    public func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        handleRegionEvent(type: "exit", region: region, manager: manager)
    }

    public func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        NSLog("[NativeGeofence] monitoring failed for %@: %@", region?.identifier ?? "?", error.localizedDescription)
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[NativeGeofence] location manager failed: %@", error.localizedDescription)
        // No fix to validate against — fire the raw crossing so we don't miss it,
        // then clear the pending event.
        if let pending = pendingEventType, pending == "enter" || pending == "exit" {
            notifyCrossing(type: pending, regionId: pendingRegionId ?? "")
        }
        pendingEventType = nil
        pendingRegionId = nil
    }

    private func handleRegionEvent(type: String, region: CLRegion, manager: CLLocationManager) {
        pendingEventType = type
        pendingRegionId = region.identifier
        // Defer the notification + POST until the one-shot fix arrives so we can
        // validate the crossing direction against precise coordinates
        // (didUpdateLocations). didFailWithError fires the raw crossing as a
        // fallback. Region monitoring is coarse + can fire for a stale region, so
        // notifying blind is what produced the phantom "Arrived" in testing.
        //
        // NOTE: the one-shot `requestLocation()` is what produces the existing
        // `native_region_wake` ping (still required + the safety net). We keep it
        // for BOTH geofence and always modes regardless of streaming.
        manager.requestLocation()

        // Tracking-modes §4: wake-and-STREAM (not wake-and-post-once).
        //  geofence            ⇒ ENTER starts the continuous stream, EXIT stops it.
        //  always & streamNow  ⇒ already streaming continuously; the perimeter is
        //                         only a backstop, so don't toggle on its crossings.
        //  always & !streamNow ⇒ "behave exactly as geofence" (§4) — toggle on the
        //                         crossing just like geofence mode.
        //  off                 ⇒ never reaches here (regions cleared), guarded anyway.
        let toggleOnCrossing: Bool
        switch trackingMode {
        case .geofence: toggleOnCrossing = true
        case .always:   toggleOnCrossing = !streamNow
        case .off:      toggleOnCrossing = false
        }
        if toggleOnCrossing {
            if type == "enter" {
                startContinuousStream()
            } else if type == "exit" {
                stopContinuousStream()
            }
        } else {
            // always + streamNow: the crossing must NOT toggle the stream, but use
            // the wake to self-heal in case iOS had suspended the stream/SLC before
            // this region fired (idempotent; no-op when already streaming + armed).
            ensureStreamingIfDirected()
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }

        // A pending region event means this fix is the one-shot wake fix from
        // `requestLocation()` (the `native_region_wake` path). Consume it here so a
        // concurrently-running continuous stream's fixes aren't mistaken for it.
        // Stale-fix guard (WS1): drop a cached/old fix so it can't post as a
        // downstream teleport. Computed once for both the wake + stream paths.
        let fixAge = -location.timestamp.timeIntervalSinceNow
        let isStale = fixAge > Self.maxFixAgeSeconds

        // On a fresh fix, re-pick the nearest-N monitored region set if the device
        // has moved significantly (no-op unless >20 fences are armed). Runs for both
        // region-wake and stream fixes, before the wake branch consumes + returns.
        if !isStale { maybeReconcileRegions(with: location) }

        // Stray-stream bound: any fresh fix INSIDE an armed fence (wake or stream)
        // re-confirms a live stream; a reactive stream that goes maxStrayStreamS
        // without one such fix stops itself below.
        if !isStale && streaming && fixInsideAnyFence(location) {
            lastConfirmingFixAt = Date()
        }

        if let rawType = pendingEventType {
            let regionId = pendingRegionId
            pendingEventType = nil
            pendingRegionId = nil

            if rawType == "enter" || rawType == "exit" {
                if isStale {
                    // A stale fix can't validate direction — trust the real-time OS event.
                    notifyCrossing(type: rawType, regionId: regionId ?? "")
                } else if let notifyType = validatedCrossingType(rawType: rawType, regionId: regionId, fix: location) {
                    // Only notify if the precise fix agrees with the coarse region event.
                    notifyCrossing(type: notifyType, regionId: regionId ?? "")
                } else {
                    NSLog("[NativeGeofence] suppressed contradicted %@ for %@", rawType, regionId ?? "?")
                }
            }
            // POST the crossing fix unless it's stale — the continuous stream
            // started on this ENTER carries the fresh signal the engine needs.
            if isStale {
                NSLog("[NativeGeofence] dropped stale region-wake fix (age %.0fs)", fixAge)
            } else {
                postPing(location: location, eventType: rawType, regionId: regionId, source: "native_region_wake")
            }
            return
        }

        // No pending region event. This fix is either a continuous-stream fix
        // (startUpdatingLocation) or an SLC keep-alive wake (the app was suspended
        // mid-drive and iOS revived us on a significant location change).
        //
        // SLC self-heal: if we SHOULD be streaming (always + streamNow) but the
        // stream isn't live, this is an SLC wake — iOS suspended the
        // startUpdatingLocation stream between two distant fences. Re-assert the
        // stream so the rest of the drive is captured at fine cadence again, and
        // still POST this fix below (it's a real transit position, source
        // continuous_stream). Without this, a long inter-facility drive records
        // nothing between the EXIT wake and the next ENTER → the replay teleport.
        if !streaming {
            guard trackingMode == .always, streamNow else { return }
            NSLog("[NativeGeofence] SLC wake while directed to stream — re-asserting continuous stream")
            startSignificantLocationMonitoring()
            startContinuousStream()
        }
        if isStale {
            NSLog("[NativeGeofence] skipped stale continuous fix (age %.0fs)", fixAge)
            return
        }

        // Stray-stream lifetime cap: a reactive stream that has gone
        // maxStrayStreamS without a single fresh in-fence fix is stray (fences
        // gone/disarmed ⇒ no EXIT will ever stop it). Stop it here — before the
        // throttle, and WITHOUT posting this off-site fix.
        if strayCapExceeded() {
            stopStrayStream(lastFix: location)
            return
        }

        // Throttle to ~minIntervalS to protect battery + ingest rate limits.
        // Time is the ONLY throttle (no distanceFilter) so a stationary in-ring
        // worker keeps emitting the consecutive fixes M-of-N needs.
        let now = Date()
        if let last = lastStreamPostAt, now.timeIntervalSince(last) < minIntervalS {
            return
        }
        lastStreamPostAt = now

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        lastStreamFixAt = iso.string(from: location.timestamp)

        postPing(location: location, eventType: "update", regionId: nil, source: "continuous_stream")
    }

    /// Validate a coarse region event against the precise fix + the fence's last
    /// registered geometry. Returns the type to notify, or nil to suppress a
    /// contradicted crossing (a stale/false-direction event). Unknown geometry →
    /// trust the OS event (better to notify than miss a real crossing).
    private func validatedCrossingType(rawType: String, regionId: String?, fix: CLLocation) -> String? {
        guard let regionId = regionId, let geom = fenceGeom[regionId], geom.count == 3 else {
            return rawType
        }
        let center = CLLocation(latitude: geom[0], longitude: geom[1])
        let radius = geom[2]
        let distance = fix.distance(from: center)
        // Tolerance absorbs GPS error + the perimeter→interior gap; never below 50m.
        let tolerance = max(fix.horizontalAccuracy >= 0 ? fix.horizontalAccuracy : 0, 50)
        if rawType == "enter" {
            return distance <= radius + tolerance ? "enter" : nil
        } else if rawType == "exit" {
            return distance >= radius - tolerance ? "exit" : nil
        }
        return rawType
    }

    // MARK: - Native POST (URLSession), guarded by a background-task assertion.

    private func postPing(location: CLLocation, eventType: String, regionId: String?, source: String) {
        guard let baseUrl = baseUrl,
              let anonKey = anonKey,
              let pk = pk,
              let subjectExternalId = subjectExternalId else {
            NSLog("[NativeGeofence] not configured; dropping ping")
            return
        }

        // Begin a background task so the POST has time to complete after a region
        // wake (iOS grants a short window; this prevents suspension mid-request).
        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ngf-ping") {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }

        let endBg = {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }

        guard let url = URL(string: "\(baseUrl)/functions/v1/v1-ingest") else {
            endBg()
            return
        }

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = iso.string(from: location.timestamp)
        // horizontalAccuracy is negative when invalid; CLLocation.speed (m/s) and
        // .course (degrees) are likewise negative when the fix has no valid value.
        let accuracy: Any = location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : NSNull()
        let speed: Any = location.speed >= 0 ? location.speed : NSNull()
        let heading: Any = location.course >= 0 ? location.course : NSNull()

        // Checkpoint /v1/ingest contract: `location` is a {lat,lng} object only
        // (flat lat/lng are GENERATED ALWAYS server-side); `client_ping_id` is the
        // device-side idempotency key so a retried batch is deduped server-side.
        let body: [String: Any] = [
            "external_id": subjectExternalId,
            "device_id": deviceId ?? "ios-native",
            "pings": [[
                "client_ping_id": UUID().uuidString,
                "location": [
                    "latitude": location.coordinate.latitude,
                    "longitude": location.coordinate.longitude
                ],
                "accuracy_m": accuracy,
                "speed_mps": speed,
                "heading": heading,
                "captured_at": timestamp,
                "source": source,
                // Carry the device's authoritative crossing so the server can
                // confirm arrivals for geofence-only (sparse) tracking without
                // waiting for M-of-N density. Only for real crossings, not the
                // in-perimeter stream. region_ref is the armed region id (fnc_…).
                "region_event": (eventType == "enter" || eventType == "exit") ? eventType as Any : NSNull(),
                "region_ref": regionId.map { $0 as Any } ?? NSNull()
            ]]
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(pk)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        } catch {
            NSLog("[NativeGeofence] failed to encode ping: %@", error.localizedDescription)
            endBg()
            return
        }

        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error {
                NSLog("[NativeGeofence] POST error: %@", error.localizedDescription)
            } else if let http = response as? HTTPURLResponse {
                NSLog("[NativeGeofence] POST %@ -> %d", eventType, http.statusCode)
            }
            endBg()
        }
        task.resume()

        // Notify JS if the webview is alive (best-effort; survives a dead webview as a no-op).
        onRegionEvent?([
            "type": eventType,
            "regionId": regionId ?? "",
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : -1,
            "timestamp": timestamp
        ])
    }
}
