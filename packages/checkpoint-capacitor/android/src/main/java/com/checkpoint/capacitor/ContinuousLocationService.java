package com.checkpoint.capacitor;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Long-running foreground service that STREAMS fine location fixes while it
 * matters and POSTs each to /v1/ingest with source:"continuous_stream"
 * (tracking-modes §3/§4 — "wake and stream", not "wake and post once").
 *
 * Why this exists: the old path (GeofenceBroadcastReceiver → GeofencePostService)
 * posts ONE coarse ping per crossing then dies, so the server engine never gets
 * the 3 consecutive in-ring fixes it needs (interior never confirmed) and EXIT
 * depends on a single OS broadcast a Doze/OEM-force-stopped process can miss
 * (no tracking on leave). A foreground service holding requestLocationUpdates
 * keeps the process alive and emitting fixes — the robust fix for both.
 *
 * Lifecycle:
 *   - geofence mode: started by GeofenceBroadcastReceiver on a perimeter ENTER,
 *     stopped on EXIT.
 *   - always mode (streamNow): started by the plugin / boot receiver immediately,
 *     stays alive (regions remain as a backstop).
 *   - off mode: never started; stopped if running.
 *
 * START_STICKY so the OS restarts us after a low-memory kill; on a null-intent
 * restart we re-decide from persisted prefs whether we should still be streaming.
 *
 * The foreground-service type is `location` (manifest + startForeground), which
 * is what lets a long-lived background location service run on API 29+ and is
 * mandatory + enforced on API 34+.
 */
public class ContinuousLocationService extends Service {
    private static final String CHANNEL_ID = "checkpoint_continuous";
    private static final int NOTIF_ID = 0x6373; // "cs"
    static final String ACTION_STOP = "com.nursa.checkpointirl.STOP_CONTINUOUS";

    /** Live liveness flag for getTrackingMode()/getDiagnostics() `streaming`.
     * `public` so wrapper SDKs can read live stream liveness across the module
     * boundary (access-control only). */
    public static volatile boolean RUNNING = false;

    private FusedLocationProviderClient fused;
    private LocationCallback callback;
    private volatile long lastPostedAtMs = 0L;
    private volatile int minIntervalMs = GeofenceStore.DEFAULT_MIN_INTERVAL_S * 1000;

    /**
     * Stray-stream bound (client lifetime cap). The keep-bias paths
     * (standDownStreamIfClearlyOutside keeping an indeterminate stream, no EXIT
     * broadcast once the dwelt-in fence is removed from Play Services,
     * START_STICKY restarts) can leave this service streaming off-site with
     * nothing left to stop it. Bound: a REACTIVE stream (geofence mode, or
     * always without streamNow) that goes maxStrayStreamS without ONE fix
     * landing inside a persisted fence stops itself and emits a diagnosable
     * `stray_stream_stopped` event. A proactive always+streamNow stream is
     * exempt — off-site streaming is its purpose (shift transit capture).
     */
    private volatile long streamStartedAtMs = 0L;      // anchor when never confirmed
    private volatile long lastConfirmingFixAtMs = 0L;  // last fresh in-fence fix
    private volatile long maxStrayStreamMs = GeofenceStore.DEFAULT_MAX_STRAY_STREAM_S * 1000L;

    /** Start (or no-op if already running) the continuous stream. */
    public static void start(Context c) {
        Intent i = new Intent(c, ContinuousLocationService.class);
        try {
            ContextCompat.startForegroundService(c.getApplicationContext(), i);
        } catch (Exception e) {
            // Background-start limits on some OEMs can throw if we're not in an
            // allowed state (no battery exemption / not foreground). The geofence
            // ENTER broadcast and the foreground plugin call are both allowed
            // start reasons, so this should be rare; log and move on.
            Log.w(GeofenceStore.TAG, "ContinuousLocationService.start: startForegroundService failed — " + e.getMessage(), e);
        }
    }

    /** Stop the continuous stream if running. */
    public static void stop(Context c) {
        try {
            Intent i = new Intent(c, ContinuousLocationService.class);
            i.setAction(ACTION_STOP);
            c.getApplicationContext().startService(i);
        } catch (Exception e) {
            // If the process is already gone the service is already stopped.
            Log.w(GeofenceStore.TAG, "ContinuousLocationService.stop: " + e.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            Log.i(GeofenceStore.TAG, "ContinuousLocationService: stop requested");
            stopStreamingAndSelf();
            return START_NOT_STICKY;
        }

        // Must promote to foreground within a few seconds of startForegroundService.
        try {
            startForegroundCompat();
        } catch (Exception e) {
            Log.e(GeofenceStore.TAG, "ContinuousLocationService: startForeground failed — " + e.getMessage(), e);
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        // On a system restart (null intent) only keep streaming if the persisted
        // mode/directive still warrants it; otherwise stand down. (geofence mode is
        // reactive to ENTER/EXIT — a null-intent restart there has no live region
        // state, so a sticky restart should not resurrect it; always+streamNow
        // should resume.)
        if (intent == null && !GeofenceStore.shouldStreamProactively(getApplicationContext())) {
            Log.i(GeofenceStore.TAG, "ContinuousLocationService: null-intent restart but no proactive-stream directive — stopping");
            stopStreamingAndSelf();
            return START_NOT_STICKY;
        }

        minIntervalMs = Math.max(1, GeofenceStore.minIntervalS(getApplicationContext())) * 1000;
        maxStrayStreamMs = Math.max(1, GeofenceStore.maxStrayStreamS(getApplicationContext())) * 1000L;
        startStreaming();
        // STICKY: if the OS kills us under memory pressure we want to come back and
        // re-evaluate (the null-intent guard above stands us down if we shouldn't).
        return START_STICKY;
    }

    private void startStreaming() {
        if (RUNNING) {
            Log.i(GeofenceStore.TAG, "ContinuousLocationService: already streaming (minIntervalMs=" + minIntervalMs + ")");
            return;
        }
        if (!hasFineLocation()) {
            Log.e(GeofenceStore.TAG, "ContinuousLocationService: ACCESS_FINE_LOCATION not held — cannot stream");
            stopStreamingAndSelf();
            return;
        }

        fused = LocationServices.getFusedLocationProviderClient(getApplicationContext());
        // TIME-driven, not displacement-driven. The engine confirms presence on
        // M-of-N = 3 CONSECUTIVE in-ring fixes (tracking-modes §1); a worker who
        // walks in and stands still (nurse at a station) must keep emitting fixes
        // or interior is never confirmed. setMinUpdateDistanceMeters(~10m) — the
        // literal contract hint — would gate out exactly those stationary fixes and
        // defeat the whole point, so we DELIBERATELY omit the displacement filter
        // and throttle purely on minIntervalS (default 15s) instead. The time
        // throttle bounds battery; an in-ring stationary user still emits a fix
        // every ~minIntervalS. (See report "contract friction".)
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, minIntervalMs)
                .setMinUpdateIntervalMillis(minIntervalMs)
                .build();

        streamStartedAtMs = System.currentTimeMillis();
        lastConfirmingFixAtMs = 0L;
        callback = new LocationCallback() {
            @Override
            public void onLocationResult(@NonNull LocationResult result) {
                Location loc = result.getLastLocation();
                if (loc == null) return;
                if (System.currentTimeMillis() - loc.getTime() > GeofenceStore.MAX_FIX_AGE_MS) {
                    return; // stale fix — don't stream it (WS2 parity with the wake path)
                }
                long now = System.currentTimeMillis();
                // Stray-stream bound: a fresh in-fence fix re-confirms the stream;
                // a reactive stream that goes maxStrayStreamMs without one stops
                // itself (fences gone/disarmed ⇒ no EXIT broadcast will ever stop
                // it). Runs BEFORE the post throttle so throttled fixes still
                // confirm, and the stray fix that trips the cap is NOT posted.
                Float accForFence = loc.hasAccuracy() ? loc.getAccuracy() : null;
                if (GeofenceStore.fixInsideAnyFence(getApplicationContext(), loc.getLatitude(), loc.getLongitude(), accForFence)) {
                    lastConfirmingFixAtMs = now;
                } else if (!GeofenceStore.shouldStreamProactively(getApplicationContext())) {
                    long anchor = Math.max(streamStartedAtMs, lastConfirmingFixAtMs);
                    if (anchor > 0 && now - anchor > maxStrayStreamMs) {
                        stopStrayStream(loc, now - anchor);
                        return;
                    }
                }
                if (now - lastPostedAtMs < minIntervalMs - 500) {
                    // App-level throttle backstop (slack for jitter in OS delivery).
                    return;
                }
                lastPostedAtMs = now;
                final double lat = loc.getLatitude();
                final double lng = loc.getLongitude();
                final Float acc = loc.hasAccuracy() ? loc.getAccuracy() : null;
                final Float speed = loc.hasSpeed() ? loc.getSpeed() : null;       // m/s
                final Float heading = loc.hasBearing() ? loc.getBearing() : null; // degrees
                final long capturedAtMs = loc.getTime(); // fix time, not POST time (iOS parity)
                final Context app = getApplicationContext();
                new Thread(() -> GeofenceStore.postPing(app, lat, lng, acc, speed, heading, capturedAtMs, "stream", "continuous_stream")).start();
            }
        };

        try {
            fused.requestLocationUpdates(request, callback, Looper.getMainLooper());
            RUNNING = true;
            Log.i(GeofenceStore.TAG, "ContinuousLocationService: streaming STARTED (interval=" + minIntervalMs + "ms, displacement=10m)");
        } catch (SecurityException se) {
            Log.e(GeofenceStore.TAG, "ContinuousLocationService: SecurityException on requestLocationUpdates", se);
            stopStreamingAndSelf();
        }
    }

    /**
     * Stop a stream the cap judged stray: persist the stop for diagnostics, emit
     * a diagnosable `stray_stream_stopped` event to a live in-process listener
     * (no-op when the app is dead — the server-side reaper covers that path),
     * then tear the service down. The triggering fix is NOT posted — the whole
     * point is to stop recording off-site positions the fence lifecycle can no
     * longer bound.
     */
    private void stopStrayStream(Location lastFix, long strayForMs) {
        Context app = getApplicationContext();
        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        String stoppedAt = iso.format(new Date());
        GeofenceStore.setLastStrayStreamStopAt(app, stoppedAt);
        Log.w(GeofenceStore.TAG, "ContinuousLocationService: STRAY STREAM self-stop — no in-fence fix for "
                + (strayForMs / 1000) + "s (cap " + (maxStrayStreamMs / 1000) + "s, "
                + GeofenceStore.fenceIds(app).size() + " persisted fence(s)) — stopping");
        GeofenceStore.emitRegionEvent(
                "stray_stream_stopped", "",
                lastFix.getLatitude(), lastFix.getLongitude(),
                lastFix.hasAccuracy() ? lastFix.getAccuracy() : -1d,
                stoppedAt);
        stopStreamingAndSelf();
    }

    private void stopStreamingAndSelf() {
        if (fused != null && callback != null) {
            try {
                fused.removeLocationUpdates(callback);
            } catch (Exception ignored) {}
        }
        RUNNING = false;
        callback = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(Service.STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Exception ignored) {}
        stopSelf();
        Log.i(GeofenceStore.TAG, "ContinuousLocationService: streaming STOPPED");
    }

    @Override
    public void onDestroy() {
        // Ensure updates are released even if we're killed without a stop intent.
        if (fused != null && callback != null) {
            try {
                fused.removeLocationUpdates(callback);
            } catch (Exception ignored) {}
        }
        RUNNING = false;
        super.onDestroy();
    }

    private boolean hasFineLocation() {
        return ContextCompat.checkSelfPermission(getApplicationContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Location tracking", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Checkpoint IRL")
                .setContentText("Tracking your location for this shift")
                .setSmallIcon(android.R.drawable.ic_dialog_map)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
