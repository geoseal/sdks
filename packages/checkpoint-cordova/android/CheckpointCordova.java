package com.checkpoint.cordova;

import android.Manifest;
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

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;

/**
 * Cordova bridge over the Checkpoint Android engine
 * (dev.checkpoint:checkpoint-core — {@link GeofenceStore},
 * {@link ContinuousLocationService}, the receivers/services declared in the
 * AAR's manifest). Behavior-for-behavior port of the Capacitor plugin
 * {@code NativeGeofencePlugin}: the two-step "Allow all the time" permission
 * escalation with fence RE-REGISTRATION on grant, the battery-exemption
 * prompt, applyMode() with the guarded keep-bias stand-down, and the exact
 * NativeDiagnostics overlay — exposed through {@code cordova.exec} under the
 * service name "CheckpointGeofence" (plugin.xml &lt;feature&gt;).
 *
 * Plus {@code registerRegionEventChannel}: Cordova's analog of
 * {@code addListener("regionEvent", …)} — one long-lived callback
 * (keepCallback) fed by {@code GeofenceStore.setRegionEventListener}, which is
 * ADDITIVE to (never a replacement for) the killed-app wake POST path.
 */
public class CheckpointCordova extends CordovaPlugin {

    private static final String TAG = GeofenceStore.TAG;

    private static final int REQ_LOCATION = 0xCD01;
    private static final int REQ_BACKGROUND = 0xCD02;
    private static final int REQ_NOTIFICATIONS = 0xCD03;

    /** In-flight requestAlwaysAuthorization callback (resolved from the permission result). */
    private CallbackContext authCallback;
    /** In-flight requestNotificationAuthorization callback. */
    private CallbackContext notificationsCallback;
    /** The live regionEvent channel (null until JS registers). */
    private CallbackContext regionEventChannel;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        switch (action) {
            case "configure":
                configure(args.optJSONObject(0), callbackContext);
                return true;
            case "requestAlwaysAuthorization":
                requestAlwaysAuthorization(callbackContext);
                return true;
            case "requestNotificationAuthorization":
                requestNotificationAuthorization(callbackContext);
                return true;
            case "requestBatteryExemption":
                requestBatteryExemption(callbackContext);
                return true;
            case "openAppSettings":
                openAppSettings(callbackContext);
                return true;
            case "addFence":
                addFence(args.optJSONObject(0), callbackContext);
                return true;
            case "clearFences":
                clearFences(callbackContext);
                return true;
            case "setTrackingMode":
                setTrackingMode(args.optJSONObject(0), callbackContext);
                return true;
            case "getTrackingMode":
                getTrackingMode(callbackContext);
                return true;
            case "getDiagnostics":
                getDiagnostics(callbackContext);
                return true;
            case "registerRegionEventChannel":
                registerRegionEventChannel(callbackContext);
                return true;
            default:
                return false;
        }
    }

    // --- regionEvent channel ---

    /**
     * Hold the callback open (keepCallback) and forward every RegionEvent JSON the
     * core's broadcast receiver emits — exactly the shape definitions.ts pins
     * (type/regionId/latitude/longitude/accuracy/timestamp). Fires only while the
     * process is alive; a crossing during process death is still POSTed natively.
     */
    private void registerRegionEventChannel(CallbackContext callbackContext) {
        regionEventChannel = callbackContext;
        GeofenceStore.setRegionEventListener(event -> {
            CallbackContext channel = regionEventChannel;
            if (channel == null) return;
            PluginResult result = new PluginResult(PluginResult.Status.OK, event);
            result.setKeepCallback(true);
            channel.sendPluginResult(result);
        });
        PluginResult pending = new PluginResult(PluginResult.Status.NO_RESULT);
        pending.setKeepCallback(true);
        callbackContext.sendPluginResult(pending);
    }

    // --- config ---

    private void configure(JSONObject opts, CallbackContext callbackContext) {
        if (opts == null) {
            callbackContext.error("configure requires baseUrl, anonKey, publishableKey, subjectExternalId");
            return;
        }
        String baseUrl = opts.optString("baseUrl", null);
        String anonKey = opts.optString("anonKey", null);
        String pk = opts.optString("publishableKey", null);
        String subject = opts.optString("subjectExternalId", null);
        if (baseUrl == null || anonKey == null || pk == null || subject == null) {
            callbackContext.error("configure requires baseUrl, anonKey, publishableKey, subjectExternalId");
            return;
        }
        String deviceId = opts.optString("deviceId", "android-native");
        Context ctx = appContext();
        GeofenceStore.configure(ctx, baseUrl, anonKey, pk, subject, deviceId);

        // Tracking-modes §4: persist the optional directive fields so a BACKGROUND
        // relaunch (region-wake / reboot) knows what to do WITHOUT waiting for JS.
        // Only overwrite a field when the caller actually supplied it, so a plain
        // re-configure can't clobber a previously-set mode/directive.
        String trackingMode = (opts.has("trackingMode") && !opts.isNull("trackingMode"))
                ? opts.optString("trackingMode") : null;
        if (trackingMode != null) GeofenceStore.setTrackingMode(ctx, trackingMode);
        boolean hasStreamNow = opts.has("streamNow") && !opts.isNull("streamNow");
        if (hasStreamNow) {
            GeofenceStore.setStreamNow(ctx, opts.optBoolean("streamNow", false));
        }
        if (opts.has("minIntervalS") && !opts.isNull("minIntervalS")) {
            GeofenceStore.setMinIntervalS(ctx, opts.optInt("minIntervalS", GeofenceStore.DEFAULT_MIN_INTERVAL_S));
        }
        // Stray-stream bound: optional cap (seconds) on a reactive stream's
        // lifetime without an in-fence fix. Absent ⇒ keep the persisted/default.
        if (opts.has("maxStrayStreamS") && !opts.isNull("maxStrayStreamS")) {
            GeofenceStore.setMaxStrayStreamS(ctx, opts.optInt("maxStrayStreamS", GeofenceStore.DEFAULT_MAX_STRAY_STREAM_S));
        }
        Log.i(TAG, "configure: baseUrl=" + baseUrl + " subject=" + subject + " device=" + deviceId
                + " mode=" + GeofenceStore.trackingMode(ctx)
                + " streamNow=" + GeofenceStore.streamNow(ctx)
                + " minIntervalS=" + GeofenceStore.minIntervalS(ctx)
                + " maxStrayStreamS=" + GeofenceStore.maxStrayStreamS(ctx));

        // If a directive was supplied, apply it now so a relaunch resumes the right
        // behavior (e.g. always+streamNow ⇒ start the stream immediately).
        if (trackingMode != null || hasStreamNow) applyMode();
        callbackContext.success();
    }

    // --- authorization ---

    /**
     * Two-step "Allow all the time" grant, routed through Cordova's permission
     * framework so the result comes back to {@link #onRequestPermissionsResult}.
     *
     * Step 1: no foreground → request foreground; on grant, escalate to background.
     * Step 2: foreground held, background missing (API 29+) → request background;
     *         on grant, RE-REGISTER all fences so they arm for the killed-app path.
     */
    private void requestAlwaysAuthorization(CallbackContext callbackContext) {
        if (!hasForegroundLocation()) {
            Log.i(TAG, "requestAlwaysAuthorization: no foreground location, requesting foreground");
            authCallback = callbackContext;
            cordova.requestPermissions(this, REQ_LOCATION, new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
            });
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundLocation()) {
            Log.i(TAG, "requestAlwaysAuthorization: foreground held, requesting background ('Allow all the time')");
            authCallback = callbackContext;
            cordova.requestPermissions(this, REQ_BACKGROUND, new String[]{
                    Manifest.permission.ACCESS_BACKGROUND_LOCATION
            });
            return;
        }
        // Background already held (e.g. granted via Settings in a prior session) —
        // re-register from persisted geometry so the fences are background-armed
        // even if this session's addFence only ran during the foreground-only race.
        Log.i(TAG, "requestAlwaysAuthorization: already authorized=" + authStatus());
        if (hasBackgroundLocation()) registerAllAndLog();
        resolveAuth(callbackContext);
    }

    /**
     * cordova-android (through at least 15.x) delivers {@code cordova.requestPermissions}
     * results via the deprecated singular {@code onRequestPermissionResult}
     * (CordovaInterfaceImpl); the plural overload is the documented replacement and the
     * one PermissionHelper dispatches to. Implement BOTH, delegating to one handler —
     * per-request callbacks are removed on delivery, so only one entry point fires per
     * result (and the handler nulls its CallbackContext, so a hypothetical double
     * delivery is still a no-op).
     */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        handlePermissionResult(requestCode);
    }

    @Override
    public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) {
        handlePermissionResult(requestCode);
    }

    private void handlePermissionResult(int requestCode) {
        switch (requestCode) {
            case REQ_LOCATION: {
                boolean granted = hasForegroundLocation();
                Log.i(TAG, "foregroundCallback: granted=" + granted);
                // Foreground just landed — register whatever we can now (foreground
                // path), then immediately escalate to background so the killed-app
                // path arms too.
                if (granted) {
                    registerAllAndLog();
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundLocation()) {
                        Log.i(TAG, "foregroundCallback: escalating to background permission");
                        cordova.requestPermissions(this, REQ_BACKGROUND, new String[]{
                                Manifest.permission.ACCESS_BACKGROUND_LOCATION
                        });
                        return;
                    }
                }
                CallbackContext cb = authCallback;
                authCallback = null;
                if (cb != null) resolveAuth(cb);
                break;
            }
            case REQ_BACKGROUND: {
                boolean granted = hasBackgroundLocation();
                Log.i(TAG, "backgroundCallback: ACCESS_BACKGROUND_LOCATION granted=" + granted);
                // THE fix (ported from the Capacitor plugin): re-register every fence
                // now that background location is held, so Play Services will deliver
                // transitions to a killed process (a fence armed foreground-only never
                // wakes a killed app).
                if (granted) registerAllAndLog();
                CallbackContext cb = authCallback;
                authCallback = null;
                if (cb != null) resolveAuth(cb);
                break;
            }
            case REQ_NOTIFICATIONS: {
                Log.i(TAG, "notificationsCallback: granted=" + hasNotificationsPermission());
                CallbackContext cb = notificationsCallback;
                notificationsCallback = null;
                if (cb != null) cb.success();
                break;
            }
            default:
                break;
        }
    }

    private void requestNotificationAuthorization(CallbackContext callbackContext) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationsPermission()) {
            Log.i(TAG, "requestNotificationAuthorization: requesting POST_NOTIFICATIONS");
            notificationsCallback = callbackContext;
            cordova.requestPermissions(this, REQ_NOTIFICATIONS, new String[]{
                    Manifest.permission.POST_NOTIFICATIONS
            });
            return;
        }
        callbackContext.success();
    }

    /**
     * Request exemption from battery optimization (Doze / OEM app-standby). On
     * Samsung One UI in particular, an optimized app gets force-stopped in the
     * background and its statically-registered receivers are disabled, so Play
     * Services geofence broadcasts are never delivered to a killed process. Shows
     * the system dialog; no-op if already exempt or on pre-M. We never await a
     * result here — the user grants it in the system UI.
     */
    private void requestBatteryExemption(CallbackContext callbackContext) {
        JSONObject ret = new JSONObject();
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                ret.put("ignoringBatteryOptimizations", true);
                callbackContext.success(ret);
                return;
            }
            Context ctx = appContext();
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
            Log.i(TAG, "requestBatteryExemption: alreadyIgnoring=" + ignoring);
            if (!ignoring && cordova.getActivity() != null) {
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + ctx.getPackageName()));
                    cordova.getActivity().startActivity(intent);
                } catch (Exception e) {
                    // Some OEMs hide/deny this intent; fall back to the battery settings list.
                    Log.w(TAG, "requestBatteryExemption: direct request failed (" + e.getMessage() + "), opening settings list");
                    try {
                        cordova.getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    } catch (Exception ignored) {}
                }
            }
            ret.put("ignoringBatteryOptimizations", ignoring);
            callbackContext.success(ret);
        } catch (JSONException e) {
            callbackContext.error("requestBatteryExemption failed: " + e.getMessage());
        }
    }

    /**
     * Open this app's details page in the OS Settings — the reliable escape hatch
     * to change location authorization. Mirrors iOS openAppSettings: once the
     * runtime prompt is consumed/declined, re-prompting is a no-op, so the gate
     * must route the user into Settings. Falls back to the general Settings screen
     * if the OEM hides the app-details intent.
     */
    private void openAppSettings(CallbackContext callbackContext) {
        Context ctx = appContext();
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "openAppSettings: app-details intent failed (" + e.getMessage() + "), opening general settings");
            try {
                Intent fallback = new Intent(Settings.ACTION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(fallback);
            } catch (Exception ignored) {}
        }
        callbackContext.success();
    }

    // --- fences ---

    private void addFence(JSONObject opts, CallbackContext callbackContext) {
        if (opts == null) {
            callbackContext.error("addFence requires id, latitude, longitude");
            return;
        }
        String id = opts.optString("id", null);
        Double lat = (opts.has("latitude") && !opts.isNull("latitude")) ? opts.optDouble("latitude") : null;
        Double lng = (opts.has("longitude") && !opts.isNull("longitude")) ? opts.optDouble("longitude") : null;
        if (id == null || lat == null || lng == null) {
            callbackContext.error("addFence requires id, latitude, longitude");
            return;
        }
        double radius = opts.optDouble("radius", 200.0);
        String name = opts.optString("name", null);
        Context ctx = appContext();
        GeofenceStore.putFence(ctx, id, lat, lng, radius, name);
        Log.i(TAG, "addFence: id=" + id + " lat=" + lat + " lng=" + lng + " r=" + radius
                + " fg=" + hasForegroundLocation() + " bg=" + hasBackgroundLocation());

        if (!hasForegroundLocation()) {
            // Geometry is stored; it'll register once location is granted (the
            // permission callback re-registers everything on grant).
            Log.i(TAG, "addFence: foreground location not held — stored only, will register on grant");
            callbackContext.success(countObj());
            return;
        }

        // Register via the shared store path so the foreground (plugin) and the
        // boot/cold-wake paths build the geofence + PendingIntent identically.
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
            geofencingClient().addGeofences(request, GeofenceStore.geofencePendingIntent(ctx))
                    .addOnSuccessListener(v -> {
                        Log.i(TAG, "addFence: addGeofences SUCCESS id=" + id
                                + (hasBackgroundLocation() ? " (background-armed)" : " (FOREGROUND-ONLY — won't wake a killed app until 'Allow all the time' is granted)"));
                        callbackContext.success(countObj());
                    })
                    .addOnFailureListener(e -> {
                        Log.e(TAG, "addFence: addGeofences FAILED id=" + id + " err=" + e.getMessage(), e);
                        callbackContext.error("addGeofences failed: " + e.getMessage());
                    });
        } catch (SecurityException se) {
            Log.e(TAG, "addFence: SecurityException — missing location permission", se);
            callbackContext.error("Missing location permission");
        }
    }

    private void clearFences(CallbackContext callbackContext) {
        Context ctx = appContext();
        List<String> ids = GeofenceStore.fenceIds(ctx);
        GeofenceStore.clearFences(ctx);
        Log.i(TAG, "clearFences: removing " + ids.size() + " fence(s)");
        if (ids.isEmpty()) {
            callbackContext.success();
            return;
        }
        geofencingClient().removeGeofences(ids)
                .addOnSuccessListener(v -> callbackContext.success())
                .addOnFailureListener(e -> callbackContext.success()); // best-effort
    }

    // --- tracking mode (tracking-modes §4) ---

    private void setTrackingMode(JSONObject opts, CallbackContext callbackContext) {
        String mode = (opts != null) ? opts.optString("mode", null) : null;
        if (mode == null) {
            callbackContext.error("setTrackingMode requires mode");
            return;
        }
        Context ctx = appContext();
        String normalized = GeofenceStore.normalizeMode(mode);
        GeofenceStore.setTrackingMode(ctx, normalized);
        Log.i(TAG, "setTrackingMode: mode=" + normalized);
        applyMode();
        try {
            JSONObject ret = new JSONObject();
            ret.put("mode", GeofenceStore.trackingMode(ctx));
            ret.put("streaming", ContinuousLocationService.RUNNING);
            callbackContext.success(ret);
        } catch (JSONException e) {
            callbackContext.error("setTrackingMode failed: " + e.getMessage());
        }
    }

    private void getTrackingMode(CallbackContext callbackContext) {
        try {
            JSONObject ret = new JSONObject();
            ret.put("mode", GeofenceStore.trackingMode(appContext()));
            ret.put("streaming", ContinuousLocationService.RUNNING);
            callbackContext.success(ret);
        } catch (JSONException e) {
            callbackContext.error("getTrackingMode failed: " + e.getMessage());
        }
    }

    private void getDiagnostics(CallbackContext callbackContext) {
        Context ctx = appContext();
        JSONObject d = GeofenceStore.diagnostics(ctx, authStatus(), GeofenceStore.fenceIds(ctx).size());
        try {
            // Surface battery-optimization state — the field-invisible reason a
            // Samsung device silently drops geofence broadcasts to a killed app.
            d.put("ignoringBatteryOptimizations", isIgnoringBatteryOptimizations());
            // Whether the OS location toggle is ON — false means every provider is
            // dark and no fix can arrive (the location_services_off outage). Mirrors
            // iOS surfacing CLLocationManager.locationServicesEnabled().
            d.put("locationServicesEnabled", isLocationServicesEnabled());
            // Live streaming state (the store default is false; overlay the real
            // service liveness here, where we can read it). Tracking-modes §4.
            d.put("streaming", ContinuousLocationService.RUNNING);
            callbackContext.success(d);
        } catch (JSONException e) {
            callbackContext.error("getDiagnostics failed: " + e.getMessage());
        }
    }

    // --- helpers (ported verbatim from NativeGeofencePlugin) ---

    /**
     * Apply the persisted tracking mode + server directive to the running services
     * (tracking-modes §4). Shared by setTrackingMode, the directive-bearing
     * configure(), and the boot path. ENTER/EXIT-driven streaming for geofence mode
     * lives in GeofenceBroadcastReceiver; this only handles the proactive/standdown
     * decisions that are independent of a live region crossing.
     */
    private void applyMode() {
        Context ctx = appContext();
        String mode = GeofenceStore.trackingMode(ctx);
        if (GeofenceStore.MODE_OFF.equals(mode)) {
            Log.i(TAG, "applyMode: off — stopping continuous stream + clearing fences");
            ContinuousLocationService.stop(ctx);
            // Minimize regions: remove from Play Services + drop persisted geometry
            // so a later boot/relaunch doesn't re-arm them. Best-effort.
            List<String> ids = GeofenceStore.fenceIds(ctx);
            if (!ids.isEmpty()) {
                try {
                    geofencingClient().removeGeofences(ids);
                } catch (Exception ignored) {}
            }
            GeofenceStore.clearFences(ctx);
            return;
        }
        // geofence | always: keep regions armed as the trigger/backstop.
        if (hasBackgroundLocation()) registerAllAndLog();
        if (GeofenceStore.shouldStreamProactively(ctx)) {
            // always + streamNow ⇒ stream immediately and keep it alive.
            Log.i(TAG, "applyMode: " + mode + " + streamNow — starting continuous stream");
            ContinuousLocationService.start(ctx);
        } else if (GeofenceStore.MODE_ALWAYS.equals(mode)) {
            // always without streamNow ⇒ behaves as geofence (§4): the receiver's
            // ENTER starts a legitimate in-ring stream in this mode too, and JS
            // re-applies the directive on every app boot — so an unconditional
            // stop here killed that stream mid-dwell and starved the engine's
            // M-of-N confirmation (the bug class iOS #44 fixed). Stand down only
            // when the freshest fix says we're clearly outside every armed fence;
            // when indeterminate, keep it.
            standDownStreamIfClearlyOutside(ctx);
        } else {
            // geofence ⇒ stream is purely ENTER/EXIT-driven by the receiver. Don't
            // pre-start and don't kill a possibly-live in-ring stream here.
            Log.i(TAG, "applyMode: geofence — reactive stream only (receiver drives ENTER/EXIT)");
        }
    }

    /**
     * Guarded stand-down for the always/!streamNow re-apply (port of iOS
     * plausiblyInsideAnyFence, PR #44). Stops the continuous stream only when the
     * freshest fix is fresh (≤ MAX_FIX_AGE_MS) AND clearly outside every armed
     * fence — distance from center > radius + max(accuracy, 50m), the same
     * tolerance as iOS. Null/stale fix, task failure, missing permission, or no
     * persisted fences ⇒ keep the stream and log why.
     */
    private void standDownStreamIfClearlyOutside(Context ctx) {
        if (!ContinuousLocationService.RUNNING) {
            Log.i(TAG, "applyMode: always w/o streamNow — no stream running, nothing to stand down");
            return;
        }
        List<String> fenceIds = GeofenceStore.fenceIds(ctx);
        if (fenceIds.isEmpty()) {
            Log.i(TAG, "applyMode: always w/o streamNow — no armed fences, keeping stream (can't prove it's stray)");
            return;
        }
        try {
            LocationServices.getFusedLocationProviderClient(ctx)
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
                            double[] g = GeofenceStore.fenceGeomFor(ctx, id);
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
                        if (GeofenceStore.shouldStreamProactively(ctx)) {
                            Log.i(TAG, "applyMode: always w/o streamNow — streamNow turned on mid-check, keeping stream");
                            return;
                        }
                        Log.i(TAG, "applyMode: always w/o streamNow — fresh fix clearly outside all "
                                + fenceIds.size() + " fence(s), standing down proactive stream");
                        ContinuousLocationService.stop(ctx);
                    })
                    .addOnFailureListener(e ->
                            Log.i(TAG, "applyMode: always w/o streamNow — getLastLocation failed ("
                                    + e.getMessage() + "), keeping stream (indeterminate)"));
        } catch (SecurityException se) {
            Log.i(TAG, "applyMode: always w/o streamNow — no location permission for last-fix check, keeping stream (indeterminate)");
        }
    }

    private void registerAllAndLog() {
        Context ctx = appContext();
        boolean ok = GeofenceStore.registerAll(ctx);
        Log.i(TAG, "registerAll: " + (ok ? "re-registered " + GeofenceStore.fenceIds(ctx).size()
                + " fence(s) for the background path" : "no-op (no bg permission or no fences)"));
    }

    private void resolveAuth(CallbackContext callbackContext) {
        try {
            JSONObject ret = new JSONObject();
            ret.put("status", authStatus());
            callbackContext.success(ret);
        } catch (JSONException e) {
            callbackContext.error("requestAlwaysAuthorization failed: " + e.getMessage());
        }
    }

    private Context appContext() {
        return cordova.getActivity().getApplicationContext();
    }

    private GeofencingClient geofencingClient() {
        return LocationServices.getGeofencingClient(appContext());
    }

    private boolean hasForegroundLocation() {
        return ContextCompat.checkSelfPermission(appContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBackgroundLocation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return hasForegroundLocation();
        return ContextCompat.checkSelfPermission(appContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationsPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(appContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) appContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(appContext().getPackageName());
    }

    /** OS location master switch. False ⇒ all providers dark (location_services_off).
     *  Indeterminate (no LocationManager) ⇒ true, so we never raise a false outage. */
    private boolean isLocationServicesEnabled() {
        LocationManager lm = (LocationManager) appContext().getSystemService(Context.LOCATION_SERVICE);
        return lm == null || LocationManagerCompat.isLocationEnabled(lm);
    }

    private String authStatus() {
        if (!hasForegroundLocation()) return "denied";
        return hasBackgroundLocation() ? "authorizedAlways" : "authorizedWhenInUse";
    }

    private JSONObject countObj() {
        JSONObject o = new JSONObject();
        try {
            o.put("monitoredCount", GeofenceStore.fenceIds(appContext()).size());
        } catch (JSONException ignored) {}
        return o;
    }
}
