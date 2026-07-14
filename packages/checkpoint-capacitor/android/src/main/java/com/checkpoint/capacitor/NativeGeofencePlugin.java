package com.checkpoint.capacitor;

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

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;

/**
 * Android wake-on-geofence plugin — the counterpart to ios/App/App/NativeGeofence.
 * Registers the perimeter ring with the Play Services GeofencingClient and a
 * PendingIntent → GeofenceBroadcastReceiver, which the system invokes on a
 * crossing (even when the app is killed) to POST a ping natively.
 *
 * Exposes the SAME JS interface as iOS (src/lib/nativeGeofence.ts) so the shared
 * TypeScript works unchanged. Registered from MainActivity.registerPlugin().
 *
 * Permission model (the bug this file fixes): a geofence registered while only
 * ACCESS_FINE_LOCATION is held fires ONLY while the app has foreground location
 * access — it will NOT wake a force-killed app. Background wakes require
 * ACCESS_BACKGROUND_LOCATION, which on API 30+ is a SEPARATE settings grant that
 * cannot be bundled with foreground and only after foreground is held. We route
 * all permission prompts through Capacitor's framework (@Permission + callbacks)
 * and RE-REGISTER every fence once background is granted — so the regions are
 * actually armed for the background path, not just foreground-only.
 */
@CapacitorPlugin(
        name = "NativeGeofence",
        permissions = {
                @Permission(
                        alias = "location",
                        strings = {
                                Manifest.permission.ACCESS_FINE_LOCATION,
                                Manifest.permission.ACCESS_COARSE_LOCATION
                        }
                ),
                @Permission(
                        alias = "locationBackground",
                        strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }
                ),
                @Permission(
                        alias = "notifications",
                        strings = { Manifest.permission.POST_NOTIFICATIONS }
                )
        }
)
public class NativeGeofencePlugin extends Plugin {

    static final String TAG = GeofenceStore.TAG;

    @PluginMethod
    public void configure(PluginCall call) {
        String baseUrl = call.getString("baseUrl");
        String anonKey = call.getString("anonKey");
        String pk = call.getString("publishableKey");
        String subject = call.getString("subjectExternalId");
        if (baseUrl == null || anonKey == null || pk == null || subject == null) {
            call.reject("configure requires baseUrl, anonKey, publishableKey, subjectExternalId");
            return;
        }
        String deviceId = call.getString("deviceId", "android-native");
        GeofenceStore.configure(getContext(), baseUrl, anonKey, pk, subject, deviceId);

        // Tracking-modes §4: persist the optional directive fields so a BACKGROUND
        // relaunch (region-wake / reboot) knows what to do WITHOUT waiting for JS.
        // Only overwrite a field when the caller actually supplied it, so a plain
        // re-configure can't clobber a previously-set mode/directive.
        String trackingMode = call.getString("trackingMode");
        if (trackingMode != null) GeofenceStore.setTrackingMode(getContext(), trackingMode);
        if (call.hasOption("streamNow")) {
            GeofenceStore.setStreamNow(getContext(), Boolean.TRUE.equals(call.getBoolean("streamNow")));
        }
        if (call.hasOption("minIntervalS")) {
            Integer mi = call.getInt("minIntervalS");
            if (mi != null) GeofenceStore.setMinIntervalS(getContext(), mi);
        }
        // Stray-stream bound: optional cap (seconds) on a reactive stream's
        // lifetime without an in-fence fix. Absent ⇒ keep the persisted/default.
        if (call.hasOption("maxStrayStreamS")) {
            Integer ms = call.getInt("maxStrayStreamS");
            if (ms != null) GeofenceStore.setMaxStrayStreamS(getContext(), ms);
        }
        Log.i(TAG, "configure: baseUrl=" + baseUrl + " subject=" + subject + " device=" + deviceId
                + " mode=" + GeofenceStore.trackingMode(getContext())
                + " streamNow=" + GeofenceStore.streamNow(getContext())
                + " minIntervalS=" + GeofenceStore.minIntervalS(getContext())
                + " maxStrayStreamS=" + GeofenceStore.maxStrayStreamS(getContext()));

        // If a directive was supplied, apply it now so a relaunch resumes the right
        // behavior (e.g. always+streamNow ⇒ start the stream immediately).
        if (trackingMode != null || call.hasOption("streamNow")) applyMode();
        call.resolve();
    }

    /**
     * Two-step "Allow all the time" grant routed through Capacitor's permission
     * framework so the result actually comes back to us (the old code fired
     * ActivityCompat.requestPermissions with hand-rolled request codes that
     * Capacitor never delivered a result for — so nothing re-registered).
     *
     * Step 1: no foreground → request foreground; on grant, escalate to background.
     * Step 2: foreground held, background missing (API 29+) → request background;
     *         on grant, RE-REGISTER all fences so they arm for the killed-app path.
     */
    @PluginMethod
    public void requestAlwaysAuthorization(PluginCall call) {
        if (!hasForegroundLocation()) {
            Log.i(TAG, "requestAlwaysAuthorization: no foreground location, requesting foreground");
            requestPermissionForAlias("location", call, "foregroundCallback");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundLocation()) {
            Log.i(TAG, "requestAlwaysAuthorization: foreground held, requesting background ('Allow all the time')");
            requestPermissionForAlias("locationBackground", call, "backgroundCallback");
            return;
        }
        // Background already held (e.g. granted via Settings in a prior session) —
        // re-register from persisted geometry so the fences are background-armed
        // even if this session's addFence only ran during the foreground-only race.
        Log.i(TAG, "requestAlwaysAuthorization: already authorized=" + authStatus());
        if (hasBackgroundLocation()) registerAllAndLog();
        resolveAuth(call);
    }

    @PermissionCallback
    private void foregroundCallback(PluginCall call) {
        boolean granted = getPermissionState("location") == PermissionState.GRANTED;
        Log.i(TAG, "foregroundCallback: granted=" + granted);
        // Foreground just landed — register whatever we can now (foreground path),
        // then immediately escalate to background so the killed-app path arms too.
        if (granted) {
            registerAllAndLog();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundLocation()) {
                Log.i(TAG, "foregroundCallback: escalating to background permission");
                requestPermissionForAlias("locationBackground", call, "backgroundCallback");
                return;
            }
        }
        resolveAuth(call);
    }

    @PermissionCallback
    private void backgroundCallback(PluginCall call) {
        boolean granted = getPermissionState("locationBackground") == PermissionState.GRANTED;
        Log.i(TAG, "backgroundCallback: ACCESS_BACKGROUND_LOCATION granted=" + granted);
        // THE fix: re-register every fence now that background location is held, so
        // Play Services will deliver transitions to a killed process (a fence armed
        // foreground-only never wakes a killed app).
        if (granted) registerAllAndLog();
        resolveAuth(call);
    }

    @PluginMethod
    public void requestNotificationAuthorization(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            Log.i(TAG, "requestNotificationAuthorization: requesting POST_NOTIFICATIONS");
            requestPermissionForAlias("notifications", call, "notificationsCallback");
            return;
        }
        call.resolve();
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        Log.i(TAG, "notificationsCallback: granted=" + (getPermissionState("notifications") == PermissionState.GRANTED));
        call.resolve();
    }

    /**
     * Request exemption from battery optimization (Doze / OEM app-standby). On
     * Samsung One UI in particular, an optimized app gets force-stopped in the
     * background and its statically-registered receivers are disabled, so Play
     * Services geofence broadcasts are never delivered to a killed process. The
     * exemption is also a documented exemption for starting a foreground service
     * from the background. Shows the system dialog; no-op if already exempt or on
     * pre-M. We never await a result here — the user grants it in the system UI.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            ret.put("ignoringBatteryOptimizations", true);
            call.resolve(ret);
            return;
        }
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        Log.i(TAG, "requestBatteryExemption: alreadyIgnoring=" + ignoring);
        if (!ignoring && getActivity() != null) {
            try {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + ctx.getPackageName()));
                getActivity().startActivity(intent);
            } catch (Exception e) {
                // Some OEMs hide/deny this intent; fall back to the battery settings list.
                Log.w(TAG, "requestBatteryExemption: direct request failed (" + e.getMessage() + "), opening settings list");
                try {
                    getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                } catch (Exception ignored) {}
            }
        }
        ret.put("ignoringBatteryOptimizations", ignoring);
        call.resolve(ret);
    }

    /**
     * Open this app's details page in the OS Settings — the reliable escape hatch
     * to change location authorization. Mirrors iOS openAppSettings: once the
     * runtime prompt is consumed/declined, re-prompting is a no-op, so the gate
     * must route the user into Settings. Falls back to the general Settings screen
     * if the OEM hides the app-details intent.
     */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Context ctx = getContext();
        if (ctx != null) {
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
        }
        call.resolve();
    }

    @PluginMethod
    public void addFence(PluginCall call) {
        String id = call.getString("id");
        Double lat = call.getDouble("latitude");
        Double lng = call.getDouble("longitude");
        if (id == null || lat == null || lng == null) {
            call.reject("addFence requires id, latitude, longitude");
            return;
        }
        double radius = call.getDouble("radius", 200.0);
        String name = call.getString("name");
        GeofenceStore.putFence(getContext(), id, lat, lng, radius, name);
        Log.i(TAG, "addFence: id=" + id + " lat=" + lat + " lng=" + lng + " r=" + radius
                + " fg=" + hasForegroundLocation() + " bg=" + hasBackgroundLocation());

        if (!hasForegroundLocation()) {
            // Geometry is stored; it'll register once location is granted (the
            // permission callback re-registers everything on grant).
            Log.i(TAG, "addFence: foreground location not held — stored only, will register on grant");
            call.resolve(countObj());
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
            geofencingClient().addGeofences(request, GeofenceStore.geofencePendingIntent(getContext()))
                    .addOnSuccessListener(v -> {
                        Log.i(TAG, "addFence: addGeofences SUCCESS id=" + id
                                + (hasBackgroundLocation() ? " (background-armed)" : " (FOREGROUND-ONLY — won't wake a killed app until 'Allow all the time' is granted)"));
                        call.resolve(countObj());
                    })
                    .addOnFailureListener(e -> {
                        Log.e(TAG, "addFence: addGeofences FAILED id=" + id + " err=" + e.getMessage(), e);
                        call.reject("addGeofences failed: " + e.getMessage());
                    });
        } catch (SecurityException se) {
            Log.e(TAG, "addFence: SecurityException — missing location permission", se);
            call.reject("Missing location permission");
        }
    }

    @PluginMethod
    public void clearFences(PluginCall call) {
        List<String> ids = GeofenceStore.fenceIds(getContext());
        GeofenceStore.clearFences(getContext());
        Log.i(TAG, "clearFences: removing " + ids.size() + " fence(s)");
        if (ids.isEmpty()) {
            call.resolve();
            return;
        }
        geofencingClient().removeGeofences(ids)
                .addOnSuccessListener(v -> call.resolve())
                .addOnFailureListener(e -> call.resolve()); // best-effort
    }

    /**
     * Persist + apply the effective tracking mode (tracking-modes §4). Idempotent.
     * The mode is persisted in SharedPreferences so a background relaunch / reboot
     * resumes it. Applying the mode:
     *   geofence ⇒ keep regions registered; do NOT pre-start a stream (it starts
     *              reactively on a region ENTER, stops on EXIT — handled in the
     *              broadcast receiver). Stop any stream that a prior `always` left up.
     *   always   ⇒ if the current server streamNow directive is true, start the
     *              continuous stream now and keep regions as a backstop; else as
     *              geofence.
     *   off      ⇒ stop any continuous stream and clear/minimize regions.
     * Returns { mode, streaming } reflecting the applied state.
     */
    @PluginMethod
    public void setTrackingMode(PluginCall call) {
        String mode = call.getString("mode");
        if (mode == null) {
            call.reject("setTrackingMode requires mode");
            return;
        }
        String normalized = GeofenceStore.normalizeMode(mode);
        GeofenceStore.setTrackingMode(getContext(), normalized);
        Log.i(TAG, "setTrackingMode: mode=" + normalized);
        applyMode();
        JSObject ret = new JSObject();
        ret.put("mode", GeofenceStore.trackingMode(getContext()));
        ret.put("streaming", ContinuousLocationService.RUNNING);
        call.resolve(ret);
    }

    /** Current mode + whether a continuous stream is live right now (tracking-modes §4). */
    @PluginMethod
    public void getTrackingMode(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("mode", GeofenceStore.trackingMode(getContext()));
        ret.put("streaming", ContinuousLocationService.RUNNING);
        call.resolve(ret);
    }

    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        JSONObject d = GeofenceStore.diagnostics(getContext(), authStatus(), GeofenceStore.fenceIds(getContext()).size());
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
            call.resolve(JSObject.fromJSONObject(d));
        } catch (JSONException e) {
            call.reject("getDiagnostics failed: " + e.getMessage());
        }
    }

    // --- helpers ---

    /**
     * Apply the persisted tracking mode + server directive to the running services
     * (tracking-modes §4). Shared by setTrackingMode, the directive-bearing
     * configure(), and the boot path. ENTER/EXIT-driven streaming for geofence mode
     * lives in GeofenceBroadcastReceiver; this only handles the proactive/standdown
     * decisions that are independent of a live region crossing.
     */
    private void applyMode() {
        Context ctx = getContext();
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
            // when the freshest fix says we're clearly outside every armed fence
            // (i.e. a proactive stream left over from a streamNow window ending
            // mid-drive); when indeterminate, keep it: a stray stream costs
            // battery until EXIT/mode change/process death, a killed in-ring
            // stream loses data.
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
     * persisted fences ⇒ keep the stream and log why. getLastLocation is an async
     * Task, so the stop lands a beat later than the old unconditional one — worst
     * case the service runs a few hundred ms longer, which is fine.
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
        boolean ok = GeofenceStore.registerAll(getContext());
        Log.i(TAG, "registerAll: " + (ok ? "re-registered " + GeofenceStore.fenceIds(getContext()).size()
                + " fence(s) for the background path" : "no-op (no bg permission or no fences)"));
    }

    private void resolveAuth(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("status", authStatus());
        call.resolve(ret);
    }

    private GeofencingClient geofencingClient() {
        return LocationServices.getGeofencingClient(getContext());
    }

    private boolean hasForegroundLocation() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBackgroundLocation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return hasForegroundLocation();
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    /** OS location master switch. False ⇒ all providers dark (location_services_off).
     *  Indeterminate (no LocationManager) ⇒ true, so we never raise a false outage. */
    private boolean isLocationServicesEnabled() {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        return lm == null || LocationManagerCompat.isLocationEnabled(lm);
    }

    private String authStatus() {
        if (!hasForegroundLocation()) return "denied";
        return hasBackgroundLocation() ? "authorizedAlways" : "authorizedWhenInUse";
    }

    private JSObject countObj() {
        JSObject o = new JSObject();
        o.put("monitoredCount", GeofenceStore.fenceIds(getContext()).size());
        return o;
    }
}
