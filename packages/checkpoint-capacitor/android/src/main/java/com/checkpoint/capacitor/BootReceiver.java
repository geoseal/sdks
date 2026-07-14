package com.checkpoint.capacitor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Re-registers geofences AND re-applies the persisted tracking mode after a device
 * reboot or app update (tracking-modes §4 — "survive reboot/force-stop").
 *
 * Play Services drops ALL registered geofences when the device reboots (and when
 * the app is replaced/updated), so without this a rebooted phone would silently
 * stop waking on crossings until the user reopened the app. This re-arms from the
 * geometry persisted in GeofenceStore — the Android analogue of iOS region
 * monitoring automatically surviving a relaunch.
 *
 * On top of re-arming regions, it resumes streaming if the persisted mode warrants
 * it (always + streamNow): the continuous foreground service is restarted so a
 * shift in progress keeps streaming across a reboot WITHOUT waiting for JS to come
 * up. geofence mode stays reactive (regions re-armed; the stream starts on the next
 * ENTER); off mode persisted no geometry, so registerAll is a no-op and nothing
 * streams.
 *
 * Re-registration needs ACCESS_BACKGROUND_LOCATION (there's no foreground at boot);
 * registerAll() is a no-op if it isn't held, and the next foreground open will
 * re-register via the plugin's applyMode path.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            Context app = context.getApplicationContext();
            // addGeofences returns immediately (async Task); a BroadcastReceiver
            // can fire-and-forget it without goAsync since we don't await it.
            Log.i(GeofenceStore.TAG, "BootReceiver: " + action + " — re-registering geofences + resuming mode");
            GeofenceStore.registerAll(app);
            // Resume streaming if the persisted directive calls for it (always +
            // streamNow). geofence/off stay reactive / silent.
            if (GeofenceStore.shouldStreamProactively(app)) {
                Log.i(GeofenceStore.TAG, "BootReceiver: always+streamNow — resuming continuous stream");
                ContinuousLocationService.start(app);
            }
        }
    }
}
