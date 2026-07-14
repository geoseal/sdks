package com.checkpoint.core;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;

import com.checkpoint.capacitor.ContinuousLocationService;
import com.checkpoint.capacitor.GeofenceStore;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Capacitor-free, Context-driven shim over the Checkpoint Android engine.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reference core is the {@code com.checkpoint.capacitor} module, whose only
 * public entry point is the Capacitor {@link com.getcapacitor.Plugin} subclass
 * {@code NativeGeofencePlugin} — its {@code @PluginMethod}s take Capacitor
 * {@code PluginCall} objects the Capacitor bridge constructs, NOT callable from a
 * .NET MAUI host. The load-bearing engine state lives in the (now-public)
 * {@code GeofenceStore} (config/fence persistence + native ingest POST) and the
 * receivers/services ({@code GeofenceBroadcastReceiver}, {@code ContinuousLocationService},
 * {@code GeofencePostService}, {@code BootReceiver}).
 *
 * This class re-exposes that engine as a plain class taking an Android {@link Context}
 * so a standard .NET-for-Android *binding library* can project it into C# as
 * {@code com.checkpoint.core.CheckpointGeofence}. It reimplements NONE of the
 * geofencing, the offline queue, or the ingest — every method forwards to the core.
 *
 * API CONTRACT
 * ------------
 * 1:1 with {@code definitions.ts} {@code NativeGeofencePlugin} and with the signatures
 * the MAUI wrapper documents inline in {@code Platforms/Android/AndroidNativeGeofence.cs}.
 * The permission prompts (FG→BG location escalation, POST_NOTIFICATIONS, battery
 * exemption) need an {@link Activity}; the wrapper passes {@code Platform.CurrentActivity}.
 *
 * INTENDED HOME
 * -------------
 * This source SHOULD live in {@code packages/checkpoint-capacitor} (the core, now on
 * {@code main}) — co-located in the existing {@code com.checkpoint.capacitor} module
 * as a new {@code com.checkpoint.core} package (see build-aar notes), since it wraps
 * the core engine and must version-lock with it. It is authored here under
 * {@code packages/checkpoint-maui/native/} only so it is reviewable alongside the
 * wrapper that consumes it; relocate into the core package when the artifact chain
 * (native/BUILD-CHECKLIST.md) is first executed.
 *
 * NOTE on receiver/service package names: the engine's receivers/services stay in
 * {@code com.checkpoint.capacitor}. The MAUI library manifest must therefore reference
 * them as {@code com.checkpoint.capacitor.*} (the manifest in this branch was corrected
 * to match). Only THIS shim entry-point class lives in {@code com.checkpoint.core}.
 */
public final class CheckpointGeofence {

    private static final String TAG = "NativeGeofence";

    private final Context appContext;

    /** Construct with any Context; we retain the application context for the engine. */
    public CheckpointGeofence(Context ctx) {
        this.appContext = ctx.getApplicationContext();
    }

    // MARK: - Region-event bridge  (subscribe to GeofenceStore's live sink)

    /**
     * Install (or clear, with null) the live region-event listener. Subscribes to the
     * core's {@code GeofenceStore.setRegionEventListener} and unpacks the RegionEvent
     * JSON the broadcast receiver emits into the flat callback. ADDITIVE: a no-op for
     * the background-wake POST path (that always runs); only surfaces a live event
     * while the host process is alive.
     */
    public void setRegionEventListener(RegionEventListener l) {
        if (l == null) {
            GeofenceStore.setRegionEventListener(null);
            return;
        }
        GeofenceStore.setRegionEventListener(event -> {
            // event is the exact RegionEvent shape GeofenceStore.emitRegionEvent builds.
            String type = event.optString("type", "");
            String regionId = event.optString("regionId", "");
            double lat = event.optDouble("latitude", 0d);
            double lng = event.optDouble("longitude", 0d);
            double acc = event.optDouble("accuracy", -1d);
            String ts = event.optString("timestamp", "");
            l.onRegionEvent(type, regionId, lat, lng, acc, ts);
        });
    }

    // MARK: - Config  (→ GeofenceStore.configure + directive persistence)

    /**
     * Persist creds + subject external id, plus the optional server tracking directive
     * (mode / streamNow / minIntervalS / maxStrayStreamS), then apply it (so a relaunch
     * resumes correctly).
     * Boxed Boolean/Integer so "absent" (null) leaves the persisted value intact, exactly
     * as {@code NativeGeofencePlugin.configure} does via {@code call.hasOption(...)}.
     */
    public void configure(String baseUrl, String anonKey, String pk, String subject,
                          String deviceId, String mode, Boolean streamNow, Integer minIntervalS,
                          Integer maxStrayStreamS) {
        GeofenceStore.configure(appContext, baseUrl, anonKey, pk, subject,
                deviceId != null ? deviceId : "android-native");
        if (mode != null) GeofenceStore.setTrackingMode(appContext, mode);
        if (streamNow != null) GeofenceStore.setStreamNow(appContext, streamNow);
        if (minIntervalS != null) GeofenceStore.setMinIntervalS(appContext, minIntervalS);
        if (maxStrayStreamS != null) GeofenceStore.setMaxStrayStreamS(appContext, maxStrayStreamS);
        Log.i(TAG, "configure: subject=" + subject + " device=" + deviceId
                + " mode=" + GeofenceStore.trackingMode(appContext)
                + " streamNow=" + GeofenceStore.streamNow(appContext)
                + " minIntervalS=" + GeofenceStore.minIntervalS(appContext));
        // Apply if a directive was supplied so a relaunch resumes the right behavior.
        if (mode != null || streamNow != null) applyMode();
    }

    // MARK: - Authorization

    /**
     * "Allow all the time" grant: foreground location → background location escalation.
     *
     * NOTE — synchronous, best-effort. The Capacitor plugin routed this through
     * Capacitor's @PermissionCallback framework (which delivers an async result and
     * re-registers fences on grant). A MAUI host has no such callback dispatcher here,
     * so this shim launches the system permission request via the Activity and returns
     * the CURRENT auth status synchronously. The host MUST call
     * {@link #notifyPermissionsChanged()} from its permission-result callback
     * (onRequestPermissionsResult) so fences stored pre-grant re-register and the
     * persisted directive re-applies; re-query getDiagnostics()/getTrackingMode()
     * after the prompt resolves for the updated status.
     */
    public String requestAlwaysAuthorization(Activity activity) {
        boolean fg = hasForegroundLocation();
        if (activity == null) {
            Log.w(TAG, "requestAlwaysAuthorization: no Activity — cannot prompt; returning current status");
            return authStatus();
        }
        if (!fg) {
            Log.i(TAG, "requestAlwaysAuthorization: requesting foreground location");
            activity.requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
            }, REQ_LOCATION);
            return authStatus();
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundLocation()) {
            Log.i(TAG, "requestAlwaysAuthorization: foreground held, requesting background");
            activity.requestPermissions(new String[]{
                    Manifest.permission.ACCESS_BACKGROUND_LOCATION
            }, REQ_BACKGROUND);
            return authStatus();
        }
        // Already authorized — re-register from persisted geometry so fences are
        // background-armed (parity with the plugin's already-authorized branch).
        if (hasBackgroundLocation()) GeofenceStore.registerAll(appContext);
        return authStatus();
    }

    /**
     * Host hook — hosts MUST call this from their permission-result callback
     * ({@code Activity.onRequestPermissionsResult}) or after their own permission
     * flow completes. Idempotent and safe to call at any time, whatever the
     * current permission state.
     *
     * WHY: {@link #requestAlwaysAuthorization(Activity)} launches the system
     * prompt but returns the PRE-grant status synchronously — this shim owns no
     * Activity, so (unlike the Capacitor plugin's @PermissionCallback path) it
     * never observes the grant itself. Without this hook, a fence stored
     * pre-grant (addFence's "stored only, will register on grant" branch) never
     * arms until the next boot/relaunch path runs. Mirrors the plugin's
     * foreground/background permission callbacks: when (at least) foreground
     * location is now held, re-register all persisted fences
     * ({@code GeofenceStore.registerAll} self-guards on
     * ACCESS_BACKGROUND_LOCATION, so fences background-arm exactly when
     * "Allow all the time" is held) and re-apply the persisted mode/server
     * directive so the stream state resumes correctly.
     */
    public void notifyPermissionsChanged() {
        boolean fg = hasForegroundLocation();
        Log.i(TAG, "notifyPermissionsChanged: fg=" + fg + " bg=" + hasBackgroundLocation());
        if (!fg) {
            Log.i(TAG, "notifyPermissionsChanged: foreground location not held — nothing to arm");
            return;
        }
        GeofenceStore.registerAll(appContext);
        applyMode();
    }

    /** Prompt for POST_NOTIFICATIONS (API 33+); no-op below Tiramisu / when granted. */
    public void requestNotificationAuthorization(Activity activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && activity != null
                && ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "requestNotificationAuthorization: requesting POST_NOTIFICATIONS");
            activity.requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATIONS);
        }
    }

    /**
     * Request exemption from battery optimization (Doze / OEM app-standby) — the
     * field-invisible reason aggressive OEMs (Samsung) drop geofence broadcasts to a
     * killed app. Shows the system dialog via the Activity; returns whether the app is
     * ALREADY exempt at call time (the dialog result is async; re-query after).
     * Mirrors {@code NativeGeofencePlugin.requestBatteryExemption}.
     */
    public boolean requestBatteryExemption(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(appContext.getPackageName());
        Log.i(TAG, "requestBatteryExemption: alreadyIgnoring=" + ignoring);
        if (!ignoring && activity != null) {
            try {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + appContext.getPackageName()));
                activity.startActivity(intent);
            } catch (Exception e) {
                Log.w(TAG, "requestBatteryExemption: direct request failed (" + e.getMessage() + "), opening settings list");
                try {
                    activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                } catch (Exception ignored) {}
            }
        }
        return ignoring;
    }

    /**
     * Open this app's details page in the OS Settings — the reliable escape hatch to
     * change location authorization once the runtime prompt is consumed/declined
     * (re-prompting is then a silent no-op). Launched from the retained application
     * context with {@code FLAG_ACTIVITY_NEW_TASK}; falls back to the general Settings
     * screen if the OEM hides the app-details intent. Mirrors
     * {@code NativeGeofencePlugin.openAppSettings}.
     */
    public void openAppSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + appContext.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            appContext.startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "openAppSettings: app-details intent failed (" + e.getMessage() + "), opening general settings");
            try {
                Intent fallback = new Intent(Settings.ACTION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                appContext.startActivity(fallback);
            } catch (Exception ignored) {}
        }
    }

    // MARK: - Fences

    /**
     * Persist + register a circular region. Stores geometry via the core
     * ({@code GeofenceStore.putFence}) and, when foreground location is held, registers
     * it with Play Services using the SAME PendingIntent the core builds (so the
     * register/boot/cold-wake paths match byte-for-byte). Returns the fence count.
     *
     * Mirrors {@code NativeGeofencePlugin.addFence}: if foreground location isn't held
     * yet, geometry is stored only and registers later via the permission/applyMode path.
     */
    public int addFence(String id, double lat, double lng, double radius, String name) {
        GeofenceStore.putFence(appContext, id, lat, lng, radius, name);
        Log.i(TAG, "addFence: id=" + id + " lat=" + lat + " lng=" + lng + " r=" + radius
                + " fg=" + hasForegroundLocation() + " bg=" + hasBackgroundLocation());
        if (!hasForegroundLocation()) {
            Log.i(TAG, "addFence: foreground location not held — stored only, will register on grant");
            return GeofenceStore.fenceIds(appContext).size();
        }
        Geofence geofence = new Geofence.Builder()
                .setRequestId(id)
                .setCircularRegion(lat, lng, (float) radius)
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER | Geofence.GEOFENCE_TRANSITION_EXIT)
                .build();
        GeofencingRequest request = new GeofencingRequest.Builder()
                .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
                .addGeofence(geofence)
                .build();
        try {
            geofencingClient().addGeofences(request, GeofenceStore.geofencePendingIntent(appContext))
                    .addOnSuccessListener(v -> Log.i(TAG, "addFence: addGeofences SUCCESS id=" + id
                            + (hasBackgroundLocation() ? " (background-armed)" : " (FOREGROUND-ONLY until 'Allow all the time')")))
                    .addOnFailureListener(e -> Log.e(TAG, "addFence: addGeofences FAILED id=" + id + " err=" + e.getMessage(), e));
        } catch (SecurityException se) {
            Log.e(TAG, "addFence: SecurityException — missing location permission", se);
        }
        return GeofenceStore.fenceIds(appContext).size();
    }

    /** Stop monitoring all regions (Play Services removeGeofences + drop geometry). */
    public void clearFences() {
        List<String> ids = GeofenceStore.fenceIds(appContext);
        GeofenceStore.clearFences(appContext);
        Log.i(TAG, "clearFences: removing " + ids.size() + " fence(s)");
        if (!ids.isEmpty()) {
            try {
                geofencingClient().removeGeofences(ids);
            } catch (Exception ignored) {}
        }
    }

    // MARK: - Tracking mode (tracking-modes §4)

    /**
     * Persist + apply the effective tracking mode (idempotent). Returns
     * {@code { "mode": String, "streaming": Boolean }} as a {@link Map} the .NET
     * binding projects. Mirrors {@code NativeGeofencePlugin.setTrackingMode}.
     */
    public Map<String, Object> setTrackingMode(String mode) {
        String normalized = GeofenceStore.normalizeMode(mode);
        GeofenceStore.setTrackingMode(appContext, normalized);
        Log.i(TAG, "setTrackingMode: mode=" + normalized);
        applyMode();
        return modeState();
    }

    /** Current mode + whether a continuous stream is live right now. */
    public Map<String, Object> getTrackingMode() {
        return modeState();
    }

    private Map<String, Object> modeState() {
        Map<String, Object> out = new HashMap<>();
        out.put("mode", GeofenceStore.trackingMode(appContext));
        out.put("streaming", ContinuousLocationService.RUNNING);
        return out;
    }

    // MARK: - Diagnostics

    /**
     * Snapshot of native region-monitoring state (NativeDiagnostics shape) for the
     * in-app debug screen. Overlays live battery-optimization + streaming state on top
     * of {@code GeofenceStore.diagnostics(...)} exactly as the plugin does.
     */
    public JSONObject diagnostics() {
        JSONObject d = GeofenceStore.diagnostics(appContext, authStatus(),
                GeofenceStore.fenceIds(appContext).size());
        try {
            d.put("ignoringBatteryOptimizations", isIgnoringBatteryOptimizations());
            d.put("locationServicesEnabled", isLocationServicesEnabled());
            d.put("streaming", ContinuousLocationService.RUNNING);
        } catch (Exception ignored) {}
        return d;
    }

    // MARK: - helpers (mirror NativeGeofencePlugin.applyMode + auth helpers)

    /**
     * Apply the persisted mode + server directive to the running services. ENTER/EXIT
     * streaming for geofence mode lives in the broadcast receiver; this handles the
     * proactive/standdown decisions independent of a live crossing. Mirrors
     * {@code NativeGeofencePlugin.applyMode}.
     */
    private void applyMode() {
        String mode = GeofenceStore.trackingMode(appContext);
        if (GeofenceStore.MODE_OFF.equals(mode)) {
            Log.i(TAG, "applyMode: off — stopping stream + clearing fences");
            ContinuousLocationService.stop(appContext);
            List<String> ids = GeofenceStore.fenceIds(appContext);
            if (!ids.isEmpty()) {
                try {
                    geofencingClient().removeGeofences(ids);
                } catch (Exception ignored) {}
            }
            GeofenceStore.clearFences(appContext);
            return;
        }
        if (hasBackgroundLocation()) GeofenceStore.registerAll(appContext);
        if (GeofenceStore.shouldStreamProactively(appContext)) {
            Log.i(TAG, "applyMode: " + mode + " + streamNow — starting continuous stream");
            ContinuousLocationService.start(appContext);
        } else if (GeofenceStore.MODE_ALWAYS.equals(mode)) {
            // Keep-bias guard (NativeGeofencePlugin.applyMode parity, iOS #44 bug
            // class): an unconditional stop here kills a legitimate in-ring stream
            // mid-dwell and starves the engine's M-of-N confirmation. Stand down
            // only when a fresh fix says we're clearly outside every armed fence.
            standDownStreamIfClearlyOutside();
        } else {
            Log.i(TAG, "applyMode: geofence — reactive stream only (receiver drives ENTER/EXIT)");
        }
    }

    /** Verbatim port of {@code NativeGeofencePlugin.standDownStreamIfClearlyOutside}. */
    private void standDownStreamIfClearlyOutside() {
        if (!ContinuousLocationService.RUNNING) {
            Log.i(TAG, "applyMode: always w/o streamNow — no stream running, nothing to stand down");
            return;
        }
        List<String> fenceIds = GeofenceStore.fenceIds(appContext);
        if (fenceIds.isEmpty()) {
            Log.i(TAG, "applyMode: always w/o streamNow — no armed fences, keeping stream (can't prove it's stray)");
            return;
        }
        try {
            LocationServices.getFusedLocationProviderClient(appContext)
                    .getLastLocation()
                    .addOnSuccessListener(fix -> {
                        if (fix == null) {
                            Log.i(TAG, "applyMode: always w/o streamNow — no last fix, keeping stream (indeterminate)");
                            return;
                        }
                        long ageMs = (SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()) / 1_000_000L;
                        if (ageMs > GeofenceStore.MAX_FIX_AGE_MS) {
                            Log.i(TAG, "applyMode: always w/o streamNow — last fix stale (" + ageMs + "ms), keeping stream (indeterminate)");
                            return;
                        }
                        float tolerance = Math.max(fix.hasAccuracy() ? fix.getAccuracy() : 0f, 50f);
                        for (String id : fenceIds) {
                            double[] g = GeofenceStore.fenceGeomFor(appContext, id);
                            if (g == null) continue;
                            float[] dist = new float[1];
                            Location.distanceBetween(fix.getLatitude(), fix.getLongitude(), g[0], g[1], dist);
                            if (dist[0] <= g[2] + tolerance) {
                                Log.i(TAG, "applyMode: always w/o streamNow — plausibly inside fence " + id
                                        + " (d=" + (int) dist[0] + "m r=" + (int) g[2] + "m tol=" + (int) tolerance
                                        + "m), keeping in-ring stream (receiver's EXIT stops it)");
                                return;
                            }
                        }
                        // The decision was async — a streamNow=true directive may have
                        // landed meanwhile and (re)started a stream we must not kill.
                        if (GeofenceStore.shouldStreamProactively(appContext)) {
                            Log.i(TAG, "applyMode: always w/o streamNow — streamNow turned on mid-check, keeping stream");
                            return;
                        }
                        Log.i(TAG, "applyMode: always w/o streamNow — fresh fix clearly outside all "
                                + fenceIds.size() + " fence(s), standing down proactive stream");
                        ContinuousLocationService.stop(appContext);
                    })
                    .addOnFailureListener(e ->
                            Log.i(TAG, "applyMode: always w/o streamNow — getLastLocation failed ("
                                    + e.getMessage() + "), keeping stream (indeterminate)"));
        } catch (SecurityException se) {
            Log.i(TAG, "applyMode: always w/o streamNow — no location permission for last-fix check, keeping stream (indeterminate)");
        }
    }

    private boolean isLocationServicesEnabled() {
        LocationManager lm = (LocationManager) appContext.getSystemService(Context.LOCATION_SERVICE);
        return lm == null || LocationManagerCompat.isLocationEnabled(lm);
    }

    private GeofencingClient geofencingClient() {
        return LocationServices.getGeofencingClient(appContext);
    }

    private boolean hasForegroundLocation() {
        return ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBackgroundLocation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return hasForegroundLocation();
        return ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(appContext.getPackageName());
    }

    private String authStatus() {
        if (!hasForegroundLocation()) return "denied";
        return hasBackgroundLocation() ? "authorizedAlways" : "authorizedWhenInUse";
    }

    // Request codes for the synchronous permission prompts (the host may observe the
    // result via Activity.onRequestPermissionsResult if it wants to react).
    private static final int REQ_LOCATION = 0xC001;
    private static final int REQ_BACKGROUND = 0xC002;
    private static final int REQ_NOTIFICATIONS = 0xC003;
}
