package com.checkpoint.capacitor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Short-lived foreground service that performs the Checkpoint ingest POST after a
 * geofence transition.
 *
 * Why a foreground service (not just goAsync()/WorkManager): when a geofence fires
 * with the app process killed, the system cold-starts the process to deliver the
 * broadcast. BroadcastReceiver.goAsync() only keeps the receiver record alive
 * (~10s) and does NOT guarantee the freshly-started process survives long enough
 * to finish a network call — the system may kill it the instant onReceive returns.
 * Promoting to a foreground service (type=location, since the work is driven by a
 * location transition) for the duration of the POST is the documented, reliable
 * way to keep the process alive until the write completes — the Android analogue
 * of iOS's beginBackgroundTask() guard around its URLSession POST. The crossing
 * payload is passed via the start Intent so no in-memory state is required.
 */
public class GeofencePostService extends Service {
    private static final String CHANNEL_ID = "checkpoint_geofence_sync";
    private static final int NOTIF_ID = 0x6F70; // "op"

    static final String EXTRA_LAT = "lat";
    static final String EXTRA_LNG = "lng";
    static final String EXTRA_ACC = "acc";       // float; absent => no accuracy
    static final String EXTRA_HAS_ACC = "hasAcc";
    static final String EXTRA_TYPE = "type";     // "enter" | "exit"
    static final String EXTRA_CAPTURED_AT = "capturedAtMs"; // fix time (epoch ms); <=0 => absent
    static final String EXTRA_REGION_REF = "regionRef";    // armed native region id (fnc_…), for authoritative crossings

    /** Build the Intent the receiver uses to hand a crossing to this service. */
    static Intent intentFor(Context c, double lat, double lng, Float acc, String type, long capturedAtMs, String regionRef) {
        Intent i = new Intent(c, GeofencePostService.class);
        i.putExtra(EXTRA_LAT, lat);
        i.putExtra(EXTRA_LNG, lng);
        i.putExtra(EXTRA_HAS_ACC, acc != null);
        if (acc != null) i.putExtra(EXTRA_ACC, acc.floatValue());
        i.putExtra(EXTRA_TYPE, type);
        i.putExtra(EXTRA_CAPTURED_AT, capturedAtMs);
        if (regionRef != null) i.putExtra(EXTRA_REGION_REF, regionRef);
        return i;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Promote to foreground IMMEDIATELY (must happen within a few seconds of
        // startForegroundService or the system throws). type=location ties the
        // foreground window to the location transition that triggered us.
        try {
            startForegroundCompat();
            Log.i(GeofenceStore.TAG, "GeofencePostService: promoted to foreground");
        } catch (Exception e) {
            // If startForeground itself throws (e.g. missing FGS permission/type on
            // a strict OEM), do NOT crash — fall through to the POST on a thread.
            Log.e(GeofenceStore.TAG, "GeofencePostService: startForeground failed — " + e.getMessage(), e);
        }

        if (intent == null) {
            Log.w(GeofenceStore.TAG, "GeofencePostService: null intent (system restart) — nothing to POST");
            stopSelfResultSafely(startId);
            return START_NOT_STICKY;
        }

        final double lat = intent.getDoubleExtra(EXTRA_LAT, 0);
        final double lng = intent.getDoubleExtra(EXTRA_LNG, 0);
        final boolean hasAcc = intent.getBooleanExtra(EXTRA_HAS_ACC, false);
        final Float acc = hasAcc ? intent.getFloatExtra(EXTRA_ACC, 0f) : null;
        final String type = intent.getStringExtra(EXTRA_TYPE);
        final String regionRef = intent.getStringExtra(EXTRA_REGION_REF);
        final long capturedAtRaw = intent.getLongExtra(EXTRA_CAPTURED_AT, 0L);
        final Long capturedAtMs = capturedAtRaw > 0 ? capturedAtRaw : null; // fix time; null => POST time
        final Context app = getApplicationContext();
        Log.i(GeofenceStore.TAG, "GeofencePostService: posting " + type + " ping");

        // POST off the main thread; stop the service (drop the foreground notif)
        // as soon as the write completes or fails.
        new Thread(() -> {
            try {
                GeofenceStore.postPing(app, lat, lng, acc, null, null, capturedAtMs, type != null ? type : "enter", "native_region_wake", regionRef);
            } finally {
                stopSelfResultSafely(startId);
            }
        }).start();

        // Don't restart with a null intent if the system kills us mid-POST: the
        // ingest is best-effort + idempotent (client_ping_id), and a stale restart
        // has no crossing to send.
        return START_NOT_STICKY;
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Location sync", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Checkpoint IRL")
                .setContentText("Recording a location update…")
                .setSmallIcon(android.R.drawable.ic_dialog_map)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        // The location foreground-service type exists since API 29 (Q); on API 34+
        // declaring it is mandatory and is enforced against the manifest's
        // foregroundServiceType + the FOREGROUND_SERVICE_LOCATION permission.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void stopSelfResultSafely(int startId) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(Service.STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Exception ignored) {}
        stopSelf(startId);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
