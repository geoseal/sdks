package com.checkpoint.reactnative;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.facebook.react.modules.core.PermissionAwareActivity;
import com.facebook.react.modules.core.PermissionListener;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import org.json.JSONObject;

import java.util.List;

// React Native Android binding for Checkpoint.
//
// THIS IS A THIN BRIDGE. It does no geofencing. It mirrors the Capacitor
// `NativeGeofencePlugin.java` dispatch method-for-method, but as a
// `ReactContextBaseJavaModule`, forwarding to the SAME engine the Capacitor SDK
// drives: `GeofenceStore` (SharedPreferences-persisted geometry + native OkHttp
// ingest), the Play Services `GeofencingClient`, the `GeofenceBroadcastReceiver`
// (wakes a killed process), `GeofencePostService` (cold-wake POST), and
// `ContinuousLocationService` (in-ring / in-shift streaming). This mirrors how
// HyperTrack's RN SDK wraps its native Android core.
//
// ARCHITECTURE: classic ReactContextBaseJavaModule (not a TurboModule). On the New
// Architecture RN's interop layer hosts this legacy module unchanged, so one
// implementation serves both. The JS side prefers the TurboModule registry name
// "CheckpointGeofence" and falls back to this module of the same name. Every method
// is a trivial forward — there is no synchronous hot path that would justify JSI.
//
// DEPENDENCY ON THE CORE — see README. `GeofenceStore`'s methods and the services'
// start/stop/RUNNING are `public` in the core on main — the former access-control
// gap is CLOSED, so this module calls them directly across the package boundary.
// The remaining gap is packaging only: the core has no published Maven coordinate
// yet (linked as an in-repo/vendored module — see README). The permission ladder
// below is reproduced (not delegated) because the core's ladder is wired to
// Capacitor's @Permission framework, which RN does not have; it is driven through
// the host's PermissionAwareActivity instead, and the engine calls it forwards to
// are identical.

public class CheckpointGeofenceModule extends ReactContextBaseJavaModule implements PermissionListener {

  static final String TAG = "CheckpointGeofence";
  static final String NAME = "CheckpointGeofence";

  private static final int REQ_LOCATION = 0xC401;
  private static final int REQ_BACKGROUND = 0xC402;

  private final ReactApplicationContext reactCtx;

  // In-flight requestAlwaysAuthorization promise (single slot, resolved exactly
  // once; a superseding call resolves the old promise before taking the slot).
  private Promise pendingAuthPromise;

  CheckpointGeofenceModule(ReactApplicationContext ctx) {
    super(ctx);
    this.reactCtx = ctx;
  }

  @Override
  public String getName() {
    return NAME;
  }

  // Live `regionEvent` bridge (Android analogue of iOS's manager.onRegionEvent):
  // the core's GeofenceBroadcastReceiver hands each crossing to the in-process
  // listener installed here (GeofenceStore.setRegionEventListener) IN ADDITION to
  // its native POST/notification path — installing this listener never affects
  // the wake path. The listener may fire on a binder thread; RCTDeviceEventEmitter
  // marshals to the JS thread itself.
  @Override
  public void initialize() {
    super.initialize();
    com.checkpoint.capacitor.GeofenceStore.setRegionEventListener(event -> {
      try {
        if (!reactCtx.hasActiveReactInstance()) return;
        emitRegionEvent(JsonConvert.toWritableMap(event));
      } catch (Exception e) {
        Log.w(TAG, "regionEvent emit failed: " + e.getMessage());
      }
    });
  }

  @Override
  public void invalidate() {
    com.checkpoint.capacitor.GeofenceStore.setRegionEventListener(null);
    resolvePendingAuth();
    super.invalidate();
  }

  // --- frozen contract (mirrors NativeGeofencePlugin.java) ---

  @ReactMethod
  public void configure(String baseUrl,
                        String anonKey,
                        String publishableKey,
                        String subjectExternalId,
                        String deviceId,
                        String trackingMode,
                        Boolean streamNow,
                        Double minIntervalS,
                        Double maxStrayStreamS,
                        Promise promise) {
    if (baseUrl == null || anonKey == null || publishableKey == null || subjectExternalId == null) {
      promise.reject("E_ARGS", "configure requires baseUrl, anonKey, publishableKey, subjectExternalId");
      return;
    }
    Context ctx = reactCtx;
    String dev = deviceId != null ? deviceId : "android-native";
    // ↓↓↓ requires GeofenceStore.* to be public (see DEPENDENCY note above).
    com.checkpoint.capacitor.GeofenceStore.configure(ctx, baseUrl, anonKey, publishableKey, subjectExternalId, dev);
    if (trackingMode != null) com.checkpoint.capacitor.GeofenceStore.setTrackingMode(ctx, trackingMode);
    if (streamNow != null) com.checkpoint.capacitor.GeofenceStore.setStreamNow(ctx, streamNow);
    if (minIntervalS != null) com.checkpoint.capacitor.GeofenceStore.setMinIntervalS(ctx, (int) Math.round(minIntervalS));
    // Stray-stream bound: optional cap (seconds) on a reactive stream's lifetime
    // without an in-fence fix. Absent ⇒ keep the persisted/default (engine 600).
    if (maxStrayStreamS != null) com.checkpoint.capacitor.GeofenceStore.setMaxStrayStreamS(ctx, (int) Math.round(maxStrayStreamS));
    if (trackingMode != null || streamNow != null) applyMode();
    promise.resolve(null);
  }

  @ReactMethod
  public void requestAlwaysAuthorization(Promise promise) {
    // Two-step "Allow all the time" grant (mirrors NativeGeofencePlugin /
    // CheckpointCordova), driven natively through the host's
    // PermissionAwareActivity so the OS prompt actually shows — Android 10+
    // forbids bundling background with foreground, so the escalation is staged.
    //
    // Step 1: no foreground → request foreground; on grant, escalate to background.
    // Step 2: foreground held, background missing (API 29+) → request background;
    //         on grant, RE-REGISTER all fences so they arm for the killed-app path.
    if (hasBackgroundLocation()) {
      // Background already held (e.g. granted via Settings in a prior session) —
      // re-register from persisted geometry so the fences are background-armed
      // even if this session's addFence only ran during the foreground-only race.
      Log.i(TAG, "requestAlwaysAuthorization: already authorized=" + authStatus());
      registerAllAndLog();
      resolveAuth(promise);
      return;
    }
    Activity activity = getCurrentActivity();
    if (!(activity instanceof PermissionAwareActivity)) {
      // No prompt surface (headless JS / detached or non-PermissionAware host) —
      // fall back to reporting the current status.
      Log.w(TAG, "requestAlwaysAuthorization: no PermissionAwareActivity, cannot prompt; status=" + authStatus());
      resolveAuth(promise);
      return;
    }
    // Single pending slot: a second call while one is in flight resolves the OLD
    // promise with the status as of now (never orphan a JS await), then the new
    // call takes over the slot.
    if (pendingAuthPromise != null) {
      Log.w(TAG, "requestAlwaysAuthorization: superseding an in-flight request, resolving its promise with current status");
      resolvePendingAuth();
    }
    pendingAuthPromise = promise;
    try {
      if (!hasForegroundLocation()) {
        Log.i(TAG, "requestAlwaysAuthorization: no foreground location, requesting foreground");
        ((PermissionAwareActivity) activity).requestPermissions(new String[]{
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        }, REQ_LOCATION, this);
        return;
      }
      Log.i(TAG, "requestAlwaysAuthorization: foreground held, requesting background ('Allow all the time')");
      ((PermissionAwareActivity) activity).requestPermissions(new String[]{
          Manifest.permission.ACCESS_BACKGROUND_LOCATION
      }, REQ_BACKGROUND, this);
    } catch (Exception e) {
      Log.w(TAG, "requestAlwaysAuthorization: requestPermissions failed (" + e.getMessage() + "), resolving current status");
      resolvePendingAuth();
    }
  }

  // PermissionListener — the host activity delivers the OS prompt result here.
  // Return value = "this listener is done" (the delegate drops it on true); when
  // escalating FG→BG we return false so the SAME listener stays installed for
  // the background result (returning true would null it out after the
  // re-registration in requestPermissions, orphaning the second prompt).
  @Override
  public boolean onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    if (requestCode == REQ_LOCATION) {
      boolean granted = hasForegroundLocation();
      Log.i(TAG, "foregroundCallback: granted=" + granted);
      // Foreground just landed — register whatever we can now (foreground path),
      // then immediately escalate to background so the killed-app path arms too.
      if (granted) {
        registerAllAndLog();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundLocation()) {
          Activity activity = getCurrentActivity();
          if (activity instanceof PermissionAwareActivity) {
            Log.i(TAG, "foregroundCallback: escalating to background permission");
            ((PermissionAwareActivity) activity).requestPermissions(new String[]{
                Manifest.permission.ACCESS_BACKGROUND_LOCATION
            }, REQ_BACKGROUND, this);
            return false;
          }
          Log.w(TAG, "foregroundCallback: activity gone/non-PermissionAware, cannot escalate to background");
        }
      }
      resolvePendingAuth();
      return true;
    }
    if (requestCode == REQ_BACKGROUND) {
      // THE fix (ported from the Capacitor plugin): re-register every fence now
      // that background location is held, so Play Services will deliver
      // transitions to a killed process (a fence armed foreground-only never
      // wakes a killed app).
      boolean granted = hasBackgroundLocation();
      Log.i(TAG, "backgroundCallback: ACCESS_BACKGROUND_LOCATION granted=" + granted);
      if (granted) registerAllAndLog();
      resolvePendingAuth();
      return true;
    }
    return false;
  }

  @ReactMethod
  public void requestNotificationAuthorization(Promise promise) {
    // POST_NOTIFICATIONS (API 33+) is requested from JS via PermissionsAndroid;
    // nothing to do natively. Resolve to keep the contract identical.
    promise.resolve(null);
  }

  @ReactMethod
  public void requestBatteryExemption(Promise promise) {
    WritableMap ret = Arguments.createMap();
    Context ctx = reactCtx;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      ret.putBoolean("ignoringBatteryOptimizations", true);
      promise.resolve(ret);
      return;
    }
    PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
    boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    Activity activity = getCurrentActivity();
    if (!ignoring && activity != null) {
      try {
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + ctx.getPackageName()));
        activity.startActivity(intent);
      } catch (Exception e) {
        try {
          activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        } catch (Exception ignored) {}
      }
    }
    ret.putBoolean("ignoringBatteryOptimizations", ignoring);
    promise.resolve(ret);
  }

  // Open the OS Settings page for this app — the only reliable path back to
  // location authorization once the runtime prompt has been consumed/declined
  // (re-prompting is a no-op). Mirrors the core NativeGeofencePlugin.openAppSettings:
  // app-details intent first, general Settings as the OEM fallback.
  @ReactMethod
  public void openAppSettings(Promise promise) {
    Context ctx = reactCtx;
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
    promise.resolve(null);
  }

  @ReactMethod
  public void addFence(String id, double latitude, double longitude, Double radius, String name, Promise promise) {
    if (id == null) {
      promise.reject("E_ARGS", "addFence requires id, latitude, longitude");
      return;
    }
    Context ctx = reactCtx;
    double r = radius != null ? radius : 200.0;
    com.checkpoint.capacitor.GeofenceStore.putFence(ctx, id, latitude, longitude, r, name);

    if (!hasForegroundLocation()) {
      // Geometry stored; registers once location is granted + requestAlwaysAuthorization re-registers.
      promise.resolve(countObj());
      return;
    }
    Geofence geofence = new Geofence.Builder()
        .setRequestId(id)
        .setCircularRegion(latitude, longitude, (float) r)
        .setExpirationDuration(Geofence.NEVER_EXPIRE)
        .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER | Geofence.GEOFENCE_TRANSITION_EXIT)
        .build();
    GeofencingRequest request = new GeofencingRequest.Builder()
        .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
        .addGeofence(geofence)
        .build();
    try {
      geofencingClient().addGeofences(request, com.checkpoint.capacitor.GeofenceStore.geofencePendingIntent(ctx))
          .addOnSuccessListener(v -> promise.resolve(countObj()))
          .addOnFailureListener(e -> promise.reject("E_ADD", "addGeofences failed: " + e.getMessage()));
    } catch (SecurityException se) {
      promise.reject("E_PERM", "Missing location permission");
    }
  }

  @ReactMethod
  public void clearFences(Promise promise) {
    Context ctx = reactCtx;
    List<String> ids = com.checkpoint.capacitor.GeofenceStore.fenceIds(ctx);
    com.checkpoint.capacitor.GeofenceStore.clearFences(ctx);
    if (ids.isEmpty()) {
      promise.resolve(null);
      return;
    }
    geofencingClient().removeGeofences(ids)
        .addOnSuccessListener(v -> promise.resolve(null))
        .addOnFailureListener(e -> promise.resolve(null));
  }

  @ReactMethod
  public void setTrackingMode(String mode, Promise promise) {
    if (mode == null) {
      promise.reject("E_ARGS", "setTrackingMode requires mode");
      return;
    }
    Context ctx = reactCtx;
    String normalized = com.checkpoint.capacitor.GeofenceStore.normalizeMode(mode);
    com.checkpoint.capacitor.GeofenceStore.setTrackingMode(ctx, normalized);
    applyMode();
    WritableMap ret = Arguments.createMap();
    ret.putString("mode", com.checkpoint.capacitor.GeofenceStore.trackingMode(ctx));
    ret.putBoolean("streaming", com.checkpoint.capacitor.ContinuousLocationService.RUNNING);
    promise.resolve(ret);
  }

  @ReactMethod
  public void getTrackingMode(Promise promise) {
    Context ctx = reactCtx;
    WritableMap ret = Arguments.createMap();
    ret.putString("mode", com.checkpoint.capacitor.GeofenceStore.trackingMode(ctx));
    ret.putBoolean("streaming", com.checkpoint.capacitor.ContinuousLocationService.RUNNING);
    promise.resolve(ret);
  }

  @ReactMethod
  public void getDiagnostics(Promise promise) {
    Context ctx = reactCtx;
    JSONObject d = com.checkpoint.capacitor.GeofenceStore.diagnostics(
        ctx, authStatus(), com.checkpoint.capacitor.GeofenceStore.fenceIds(ctx).size());
    try {
      d.put("ignoringBatteryOptimizations", isIgnoringBatteryOptimizations());
      // OS location master switch — false means every provider is dark (the
      // location_services_off outage). Mirrors NativeGeofencePlugin.getDiagnostics.
      d.put("locationServicesEnabled", isLocationServicesEnabled());
      d.put("streaming", com.checkpoint.capacitor.ContinuousLocationService.RUNNING);
      promise.resolve(jsonToWritableMap(d));
    } catch (Exception e) {
      promise.reject("E_DIAG", "getDiagnostics failed: " + e.getMessage());
    }
  }

  // RCTDeviceEventEmitter bookkeeping. Required by NativeEventEmitter on the JS
  // side. "regionEvent" is LIVE on Android: the listener installed in initialize()
  // (GeofenceStore.setRegionEventListener) re-emits each crossing the core's
  // broadcast receiver hands it while the JS runtime is alive.
  @ReactMethod
  public void addListener(String eventName) { /* no-op; emitter is JS-side */ }

  @ReactMethod
  public void removeListeners(double count) { /* no-op */ }

  // --- helpers (mirror NativeGeofencePlugin.java) ---

  private void applyMode() {
    Context ctx = reactCtx;
    String mode = com.checkpoint.capacitor.GeofenceStore.trackingMode(ctx);
    if (com.checkpoint.capacitor.GeofenceStore.MODE_OFF.equals(mode)) {
      com.checkpoint.capacitor.ContinuousLocationService.stop(ctx);
      List<String> ids = com.checkpoint.capacitor.GeofenceStore.fenceIds(ctx);
      if (!ids.isEmpty()) {
        try { geofencingClient().removeGeofences(ids); } catch (Exception ignored) {}
      }
      com.checkpoint.capacitor.GeofenceStore.clearFences(ctx);
      return;
    }
    if (hasBackgroundLocation()) registerAllAndLog();
    if (com.checkpoint.capacitor.GeofenceStore.shouldStreamProactively(ctx)) {
      com.checkpoint.capacitor.ContinuousLocationService.start(ctx);
    } else if (com.checkpoint.capacitor.GeofenceStore.MODE_ALWAYS.equals(mode)) {
      // Keep-bias guard (NativeGeofencePlugin.applyMode parity, iOS #44 bug
      // class): an unconditional stop here kills a legitimate in-ring stream
      // mid-dwell and starves the engine's M-of-N confirmation. Stand down
      // only when a fresh fix says we're clearly outside every armed fence.
      standDownStreamIfClearlyOutside(ctx);
    }
    // geofence ⇒ reactive stream only (the receiver drives ENTER/EXIT).
  }

  /**
   * Guarded stand-down for the always/!streamNow re-apply (port of iOS
   * plausiblyInsideAnyFence, PR #44; verbatim from NativeGeofencePlugin).
   * Stops the continuous stream only when the freshest fix is fresh
   * (≤ MAX_FIX_AGE_MS) AND clearly outside every armed fence — distance from
   * center > radius + max(accuracy, 50m), the same tolerance as iOS. Null/stale
   * fix, task failure, missing permission, or no persisted fences ⇒ keep the
   * stream and log why. getLastLocation is an async Task, so the stop lands a
   * beat later than the old unconditional one — worst case the service runs a
   * few hundred ms longer, which is fine.
   */
  private void standDownStreamIfClearlyOutside(Context ctx) {
    if (!com.checkpoint.capacitor.ContinuousLocationService.RUNNING) {
      Log.i(TAG, "applyMode: always w/o streamNow — no stream running, nothing to stand down");
      return;
    }
    List<String> fenceIds = com.checkpoint.capacitor.GeofenceStore.fenceIds(ctx);
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
            if (ageMs > com.checkpoint.capacitor.GeofenceStore.MAX_FIX_AGE_MS) {
              Log.i(TAG, "applyMode: always w/o streamNow — last fix stale (" + ageMs + "ms), keeping stream (indeterminate)");
              return;
            }
            float tolerance = Math.max(fix.hasAccuracy() ? fix.getAccuracy() : 0f, 50f);
            for (String id : fenceIds) {
              double[] g = com.checkpoint.capacitor.GeofenceStore.fenceGeomFor(ctx, id);
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
            if (com.checkpoint.capacitor.GeofenceStore.shouldStreamProactively(ctx)) {
              Log.i(TAG, "applyMode: always w/o streamNow — streamNow turned on mid-check, keeping stream");
              return;
            }
            Log.i(TAG, "applyMode: always w/o streamNow — fresh fix clearly outside all "
                + fenceIds.size() + " fence(s), standing down proactive stream");
            com.checkpoint.capacitor.ContinuousLocationService.stop(ctx);
          })
          .addOnFailureListener(e ->
              Log.i(TAG, "applyMode: always w/o streamNow — getLastLocation failed ("
                  + e.getMessage() + "), keeping stream (indeterminate)"));
    } catch (SecurityException se) {
      Log.i(TAG, "applyMode: always w/o streamNow — no location permission for last-fix check, keeping stream (indeterminate)");
    }
  }

  private void registerAllAndLog() {
    boolean ok = com.checkpoint.capacitor.GeofenceStore.registerAll(reactCtx);
    Log.i(TAG, "registerAll: " + (ok ? "re-registered for background path" : "no-op"));
  }

  private void resolveAuth(Promise promise) {
    WritableMap ret = Arguments.createMap();
    ret.putString("status", authStatus());
    promise.resolve(ret);
  }

  // Take-and-null so the slot resolves exactly once; no-op if nothing pending.
  private void resolvePendingAuth() {
    Promise p = pendingAuthPromise;
    pendingAuthPromise = null;
    if (p != null) resolveAuth(p);
  }

  private GeofencingClient geofencingClient() {
    return LocationServices.getGeofencingClient(reactCtx);
  }

  private boolean hasForegroundLocation() {
    return ContextCompat.checkSelfPermission(reactCtx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
  }

  private boolean hasBackgroundLocation() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return hasForegroundLocation();
    return ContextCompat.checkSelfPermission(reactCtx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
  }

  private boolean isIgnoringBatteryOptimizations() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
    PowerManager pm = (PowerManager) reactCtx.getSystemService(Context.POWER_SERVICE);
    return pm != null && pm.isIgnoringBatteryOptimizations(reactCtx.getPackageName());
  }

  private boolean isLocationServicesEnabled() {
    android.location.LocationManager lm =
        (android.location.LocationManager) reactCtx.getSystemService(Context.LOCATION_SERVICE);
    return lm == null || androidx.core.location.LocationManagerCompat.isLocationEnabled(lm);
  }

  private String authStatus() {
    if (!hasForegroundLocation()) return "denied";
    return hasBackgroundLocation() ? "authorizedAlways" : "authorizedWhenInUse";
  }

  private WritableMap countObj() {
    WritableMap o = Arguments.createMap();
    o.putInt("monitoredCount", com.checkpoint.capacitor.GeofenceStore.fenceIds(reactCtx).size());
    return o;
  }

  private void emitRegionEvent(WritableMap payload) {
    reactCtx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
        .emit("regionEvent", payload);
  }

  private WritableMap jsonToWritableMap(JSONObject json) {
    // Minimal JSON→WritableMap for the diagnostics object (flat + nested arrays).
    return JsonConvert.toWritableMap(json);
  }
}
