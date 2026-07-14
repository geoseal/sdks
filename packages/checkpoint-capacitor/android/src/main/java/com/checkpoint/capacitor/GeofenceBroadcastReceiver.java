package com.checkpoint.capacitor;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofenceStatusCodes;
import com.google.android.gms.location.GeofencingEvent;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Receives geofence transitions from the system (delivered even when the app
 * process is killed), fires a local "Arrived/Left" notification, and hands the
 * crossing to GeofencePostService to POST to /v1/ingest — the Android equivalent
 * of the iOS region-wake path in GeofenceManager.
 *
 * The actual network POST is delegated to a foreground service rather than done
 * inline: when the process is cold-started for this broadcast, the system can
 * kill it as soon as onReceive returns, and goAsync()'s grace window is not
 * guaranteed to outlive a network round-trip. A foreground service keeps the
 * process alive until the write completes (see GeofencePostService).
 */
public class GeofenceBroadcastReceiver extends BroadcastReceiver {
    private static final String CHANNEL_ID = "checkpoint_geofence";

    @Override
    public void onReceive(Context context, Intent intent) {
        // First line of the wake path — if this never logs on a real crossing, the
        // broadcast isn't being delivered (fence not background-armed, app
        // force-stopped, or battery-optimized). That's the thing to diagnose first.
        Log.i(GeofenceStore.TAG, "GeofenceBroadcastReceiver.onReceive: broadcast received");
        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null) {
            Log.e(GeofenceStore.TAG, "onReceive: GeofencingEvent.fromIntent returned null");
            return;
        }
        if (event.hasError()) {
            Log.e(GeofenceStore.TAG, "onReceive: geofencing error code="
                    + event.getErrorCode() + " (" + GeofenceStatusCodes.getStatusCodeString(event.getErrorCode()) + ")");
            return;
        }

        int transition = event.getGeofenceTransition();
        final String type;
        if (transition == Geofence.GEOFENCE_TRANSITION_ENTER) type = "enter";
        else if (transition == Geofence.GEOFENCE_TRANSITION_EXIT) type = "exit";
        else {
            Log.i(GeofenceStore.TAG, "onReceive: ignoring transition=" + transition);
            return;
        }

        List<Geofence> triggering = event.getTriggeringGeofences();
        final String regionId = (triggering != null && !triggering.isEmpty()) ? triggering.get(0).getRequestId() : "";
        final Location loc = event.getTriggeringLocation();
        final boolean staleFix = loc != null
                && System.currentTimeMillis() - loc.getTime() > GeofenceStore.MAX_FIX_AGE_MS;
        final Context app = context.getApplicationContext();
        Log.i(GeofenceStore.TAG, "onReceive: " + type + " region=" + regionId
                + " loc=" + (loc != null ? (loc.getLatitude() + "," + loc.getLongitude()) : "null"));

        // Validate the coarse transition against the precise fix + stored geometry
        // (mirrors iOS): suppress a contradicted direction; notify if unknown.
        // A stale fix can't be trusted to validate direction — trust the OS event.
        boolean notify = true;
        if (loc != null && !staleFix) {
            double[] g = GeofenceStore.fenceGeomFor(app, regionId);
            if (g != null) {
                float[] out = new float[1];
                Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), g[0], g[1], out);
                double tolerance = Math.max(loc.hasAccuracy() ? loc.getAccuracy() : 0, 50);
                if (type.equals("enter")) notify = out[0] <= g[2] + tolerance;
                else notify = out[0] >= g[2] - tolerance;
            }
        }
        if (notify) notifyCrossing(app, type, regionId);

        // Tracking-modes §4: on a perimeter ENTER start the continuous fine stream
        // (so the engine can confirm interior + detect exit from the stream); on
        // EXIT stop it. This is ADDITIVE — the one-shot coarse wake ping below still
        // fires on every crossing as the trigger + backstop.
        //   - off       ⇒ never stream.
        //   - geofence  ⇒ ENTER starts, EXIT stops.
        //   - always    ⇒ if streamNow the stream is already up (started proactively
        //                 by the plugin/boot); ENTER is idempotent. We do NOT stop on
        //                 EXIT while streamNow is in force (always = shift-scoped, not
        //                 perimeter-scoped) — only stop if the directive isn't keeping
        //                 it alive.
        String mode = GeofenceStore.trackingMode(app);
        if (!GeofenceStore.MODE_OFF.equals(mode)) {
            if (type.equals("enter")) {
                Log.i(GeofenceStore.TAG, "onReceive: ENTER in mode=" + mode + " — starting continuous stream");
                ContinuousLocationService.start(app);
            } else { // exit
                if (GeofenceStore.shouldStreamProactively(app)) {
                    Log.i(GeofenceStore.TAG, "onReceive: EXIT in mode=" + mode + " but streamNow — keeping continuous stream alive");
                } else {
                    Log.i(GeofenceStore.TAG, "onReceive: EXIT in mode=" + mode + " — stopping continuous stream");
                    ContinuousLocationService.stop(app);
                }
            }
        }

        // ADDITIVE in-process notification (mirrors iOS onRegionEvent): if the app
        // is alive and a wrapper has installed a RegionEventListener, also hand it
        // the crossing so a live `regionEvent`/`addListener` fires on Android. This
        // is purely extra — a no-op when no listener is installed — and does NOT
        // touch the wake/POST path below. We emit only when we have a triggering
        // location (the RegionEvent shape carries lat/lng/accuracy).
        if (loc != null) {
            SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            iso.setTimeZone(TimeZone.getTimeZone("UTC"));
            double accuracy = loc.hasAccuracy() ? loc.getAccuracy() : -1d;
            GeofenceStore.emitRegionEvent(type, regionId, loc.getLatitude(), loc.getLongitude(), accuracy, iso.format(new Date()));
        }

        // Hand the POST to a foreground service so it survives this process being
        // killed the moment onReceive returns (a real risk on a cold geofence
        // wake). The crossing is passed via the Intent — no in-memory state needed.
        if (loc != null && !staleFix) {
            final float acc = loc.hasAccuracy() ? loc.getAccuracy() : -1f;
            final long capturedAtMs = loc.getTime(); // fix time, not POST time (iOS parity)
            Intent svc = GeofencePostService.intentFor(
                    app, loc.getLatitude(), loc.getLongitude(),
                    loc.hasAccuracy() ? acc : null, type, capturedAtMs, regionId);
            try {
                ContextCompat.startForegroundService(app, svc);
                Log.i(GeofenceStore.TAG, "onReceive: started GeofencePostService for the " + type + " POST");
            } catch (Exception e) {
                // startForegroundService can throw (e.g. background-start limits on
                // some OEMs). Fall back to an inline POST guarded by goAsync so we
                // don't drop the crossing entirely.
                Log.w(GeofenceStore.TAG, "onReceive: startForegroundService failed (" + e.getMessage() + ") — falling back to inline POST", e);
                final double lat = loc.getLatitude();
                final double lng = loc.getLongitude();
                final Float accObj = loc.hasAccuracy() ? acc : null;
                final PendingResult pending = goAsync();
                new Thread(() -> {
                    try {
                        GeofenceStore.postPing(app, lat, lng, accObj, null, null, capturedAtMs, type, "native_region_wake", regionId);
                    } finally {
                        pending.finish();
                    }
                }).start();
            }
        } else {
            Log.w(GeofenceStore.TAG, "onReceive: " + (staleFix ? "stale" : "no")
                    + " triggering location — skipping POST this crossing");
        }
    }

    private void notifyCrossing(Context c, String type, String regionId) {
        String name = GeofenceStore.fenceName(c, regionId);
        String body = type.equals("enter") ? "Arrived at " + name : "Left " + name;

        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Checkpoint", NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(ch);
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL_ID)
                .setContentTitle("Checkpoint IRL")
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_map)
                .setAutoCancel(true);
        nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), b.build());
        Log.i(GeofenceStore.TAG, "notifyCrossing: posted \"" + body + "\"");
    }
}
