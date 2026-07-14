package com.checkpoint.capacitor;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/**
 * Shared config + armed-fence metadata + native POST for the Android geofence
 * path. Mirrors iOS GeofenceManager's UserDefaults-backed config so the
 * BroadcastReceiver can POST a crossing even when the app process was killed.
 *
 * UNTESTED scaffold (task #8) — written to mirror the verified iOS behaviour;
 * needs an Android device + Google Play Services to validate region monitoring.
 *
 * `public` (class + the wrapper-facing static API) so wrapper SDKs
 * (RN/Flutter/Expo/MAUI) can drive the engine across the module boundary —
 * the access-control change the extraction requires (mirrors iOS R2). No logic
 * changed; only visibility widened.
 */
public final class GeofenceStore {
    private static final String PREFS = "ngf";
    private static final String K_BASE = "base_url";
    private static final String K_ANON = "anon_key";
    private static final String K_PK = "pk";
    private static final String K_SUBJECT = "subject_external_id";
    private static final String K_DEVICE = "device_id";
    private static final String K_GEOM = "fence_geom";   // JSON {id:[lat,lng,radius]}
    private static final String K_NAMES = "fence_names";  // JSON {id:name}
    // Tracking-modes §4: persisted so a background relaunch (region-wake / reboot)
    // resumes the right behavior WITHOUT first waiting for JS to come up.
    private static final String K_MODE = "tracking_mode";            // "geofence" | "always" | "off"
    private static final String K_STREAM_NOW = "stream_now";          // server `stream_now` directive (always-mode gate)
    private static final String K_MIN_INTERVAL_S = "min_interval_s";  // adaptive cadence hint for the continuous stream
    private static final String K_LAST_STREAM_FIX_AT = "last_stream_fix_at"; // ISO of the last continuous_stream fix POSTed
    // Stray-stream bound: max reactive-stream lifetime without an in-fence fix
    // (seconds) + the last self-stop timestamp (diagnostics).
    private static final String K_MAX_STRAY_STREAM_S = "max_stray_stream_s";
    private static final String K_LAST_STRAY_STOP_AT = "last_stray_stop_at";

    public static final String MODE_GEOFENCE = "geofence";
    public static final String MODE_ALWAYS = "always";
    public static final String MODE_OFF = "off";
    public static final int DEFAULT_MIN_INTERVAL_S = 15;
    /** Stray-stream cap default: 10 min without one in-fence fix stops a reactive stream. */
    public static final int DEFAULT_MAX_STRAY_STREAM_S = 600;

    /** Shared engine log tag (hoisted from NativeGeofencePlugin so engine classes don't reference the Capacitor plugin shell). */
    public static final String TAG = "NativeGeofence";

    private GeofenceStore() {}

    public static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void configure(Context c, String baseUrl, String anonKey, String pk, String subjectExternalId, String deviceId) {
        String trimmed = baseUrl != null && baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        prefs(c).edit()
                .putString(K_BASE, trimmed)
                .putString(K_ANON, anonKey)
                .putString(K_PK, pk)
                .putString(K_SUBJECT, subjectExternalId)
                .putString(K_DEVICE, deviceId)
                .apply();
    }

    public static boolean isConfigured(Context c) {
        SharedPreferences p = prefs(c);
        return p.getString(K_BASE, null) != null && p.getString(K_PK, null) != null && p.getString(K_SUBJECT, null) != null;
    }

    public static String baseUrl(Context c) { return prefs(c).getString(K_BASE, null); }
    public static String subjectExternalId(Context c) { return prefs(c).getString(K_SUBJECT, null); }

    // --- tracking mode + stream directive (tracking-modes §4) ---

    /** Persisted effective mode; defaults to geofence (the §2 default for a new device). */
    public static String trackingMode(Context c) {
        return prefs(c).getString(K_MODE, MODE_GEOFENCE);
    }

    public static void setTrackingMode(Context c, String mode) {
        prefs(c).edit().putString(K_MODE, normalizeMode(mode)).apply();
    }

    /** The last server `stream_now` directive (always-mode gate). Default false. */
    public static boolean streamNow(Context c) {
        return prefs(c).getBoolean(K_STREAM_NOW, false);
    }

    public static void setStreamNow(Context c, boolean streamNow) {
        prefs(c).edit().putBoolean(K_STREAM_NOW, streamNow).apply();
    }

    /** Adaptive cadence hint for the continuous stream; default DEFAULT_MIN_INTERVAL_S. */
    public static int minIntervalS(Context c) {
        int v = prefs(c).getInt(K_MIN_INTERVAL_S, DEFAULT_MIN_INTERVAL_S);
        return v > 0 ? v : DEFAULT_MIN_INTERVAL_S;
    }

    public static void setMinIntervalS(Context c, int minIntervalS) {
        prefs(c).edit().putInt(K_MIN_INTERVAL_S, minIntervalS > 0 ? minIntervalS : DEFAULT_MIN_INTERVAL_S).apply();
    }

    public static String lastStreamFixAt(Context c) {
        return prefs(c).getString(K_LAST_STREAM_FIX_AT, null);
    }

    public static void setLastStreamFixAt(Context c, String iso) {
        prefs(c).edit().putString(K_LAST_STREAM_FIX_AT, iso).apply();
    }

    /** Stray-stream cap (seconds); default DEFAULT_MAX_STRAY_STREAM_S. */
    public static int maxStrayStreamS(Context c) {
        int v = prefs(c).getInt(K_MAX_STRAY_STREAM_S, DEFAULT_MAX_STRAY_STREAM_S);
        return v > 0 ? v : DEFAULT_MAX_STRAY_STREAM_S;
    }

    public static void setMaxStrayStreamS(Context c, int maxStrayStreamS) {
        prefs(c).edit().putInt(K_MAX_STRAY_STREAM_S,
                maxStrayStreamS > 0 ? maxStrayStreamS : DEFAULT_MAX_STRAY_STREAM_S).apply();
    }

    /** ISO timestamp of the last stray-cap self-stop, or null (diagnostics). */
    public static String lastStrayStreamStopAt(Context c) {
        return prefs(c).getString(K_LAST_STRAY_STOP_AT, null);
    }

    public static void setLastStrayStreamStopAt(Context c, String iso) {
        prefs(c).edit().putString(K_LAST_STRAY_STOP_AT, iso).apply();
    }

    /**
     * STRICT in-fence test for the stray-stream cap — the opposite bias of
     * standDownStreamIfClearlyOutside's keep-bias: with NO persisted fence
     * geometry a fix can NOT confirm the stream (that is exactly the
     * no-restored-fences stray case the cap bounds), so an empty set returns
     * false, not true. Tolerance mirrors the crossing validation
     * (max(accuracy, 50m)); accuracyM null ⇒ 50m floor.
     */
    public static boolean fixInsideAnyFence(Context c, double lat, double lng, Float accuracyM) {
        JSONObject geom = readJson(c, K_GEOM);
        if (geom.length() == 0) return false;
        double tolerance = Math.max(accuracyM != null ? accuracyM : 0d, 50d);
        for (Iterator<String> it = geom.keys(); it.hasNext(); ) {
            JSONArray g = geom.optJSONArray(it.next());
            if (g == null || g.length() < 3) continue;
            float[] dist = new float[1];
            android.location.Location.distanceBetween(lat, lng, g.optDouble(0), g.optDouble(1), dist);
            if (dist[0] <= g.optDouble(2) + tolerance) return true;
        }
        return false;
    }

    /** Coerce an unknown/null mode string to the safe default (geofence). */
    public static String normalizeMode(String mode) {
        if (MODE_ALWAYS.equals(mode) || MODE_OFF.equals(mode) || MODE_GEOFENCE.equals(mode)) return mode;
        return MODE_GEOFENCE;
    }

    /**
     * Whether the continuous stream SHOULD be running given the persisted mode +
     * server directive, independent of a region's enter/exit state:
     *   always & streamNow ⇒ stream immediately
     *   else (geofence, or always w/o streamNow, or off) ⇒ stream only reactively
     *     on a region ENTER (handled by the broadcast receiver, not here).
     * The receiver layers the geofence-mode ENTER/EXIT trigger on top of this.
     */
    public static boolean shouldStreamProactively(Context c) {
        return MODE_ALWAYS.equals(trackingMode(c)) && streamNow(c);
    }

    // --- armed fence metadata (mirrors iOS fenceGeom/fenceNames) ---

    public static void putFence(Context c, String id, double lat, double lng, double radius, String name) {
        try {
            JSONObject geom = readJson(c, K_GEOM);
            JSONObject names = readJson(c, K_NAMES);
            geom.put(id, new JSONArray().put(lat).put(lng).put(radius));
            names.put(id, name != null ? name : id);
            prefs(c).edit().putString(K_GEOM, geom.toString()).putString(K_NAMES, names.toString()).apply();
        } catch (Exception ignored) {}
    }

    public static void clearFences(Context c) {
        prefs(c).edit().remove(K_GEOM).remove(K_NAMES).apply();
    }

    public static List<String> fenceIds(Context c) {
        List<String> ids = new ArrayList<>();
        JSONObject geom = readJson(c, K_GEOM);
        for (Iterator<String> it = geom.keys(); it.hasNext(); ) ids.add(it.next());
        return ids;
    }

    public static String fenceName(Context c, String id) {
        return readJson(c, K_NAMES).optString(id, id);
    }

    /** [lat, lng, radius] for a fence id, or null if unknown. */
    public static double[] fenceGeomFor(Context c, String id) {
        JSONArray g = readJson(c, K_GEOM).optJSONArray(id);
        if (g == null || g.length() < 3) return null;
        return new double[]{ g.optDouble(0), g.optDouble(1), g.optDouble(2) };
    }

    public static JSONObject diagnostics(Context c, String authStatus, int monitoredCount) {
        JSONObject out = new JSONObject();
        try {
            JSONObject geom = readJson(c, K_GEOM);
            JSONObject names = readJson(c, K_NAMES);
            JSONArray fences = new JSONArray();
            JSONArray ids = new JSONArray();
            for (Iterator<String> it = geom.keys(); it.hasNext(); ) {
                String id = it.next();
                JSONArray g = geom.optJSONArray(id);
                if (g == null || g.length() < 3) continue;
                ids.put(id);
                fences.put(new JSONObject()
                        .put("id", id)
                        .put("name", names.optString(id, id))
                        .put("latitude", g.getDouble(0))
                        .put("longitude", g.getDouble(1))
                        .put("radius", g.getDouble(2)));
            }
            out.put("authStatus", authStatus);
            out.put("monitoredCount", monitoredCount);
            out.put("monitoredIds", ids);
            out.put("configured", isConfigured(c));
            out.put("subjectExternalId", prefs(c).getString(K_SUBJECT, ""));
            out.put("baseUrl", prefs(c).getString(K_BASE, ""));
            out.put("fences", fences);
            // Tracking-modes §4 diagnostics. `streaming` is the live service state
            // (filled in by the plugin) — defaulted false here in case it's absent.
            out.put("mode", trackingMode(c));
            out.put("streaming", false);
            out.put("lastStreamFixAt", lastStreamFixAt(c) != null ? lastStreamFixAt(c) : JSONObject.NULL);
            out.put("streamNow", streamNow(c));
            // Stray-stream bound: the active cap + the last self-stop (persisted).
            out.put("maxStrayStreamS", maxStrayStreamS(c));
            out.put("lastStrayStreamStopAt", lastStrayStreamStopAt(c) != null ? lastStrayStreamStopAt(c) : JSONObject.NULL);
        } catch (Exception ignored) {}
        return out;
    }

    private static JSONObject readJson(Context c, String key) {
        try {
            String s = prefs(c).getString(key, null);
            return s != null ? new JSONObject(s) : new JSONObject();
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    // --- live in-process region-event sink (ADDITIVE; mirrors iOS onRegionEvent) ---
    //
    // The background-wake path (GeofenceBroadcastReceiver) ALWAYS POSTs the crossing
    // to /v1/ingest and fires the native "Arrived/Left" notification — that path is
    // unchanged and is the source of truth for visits. This sink is a PURELY
    // ADDITIONAL in-process notification: when the app is alive (so a wrapper has
    // installed a listener), the receiver ALSO hands the crossing to the live
    // listener here so a wrapper SDK can surface a `regionEvent` to JS — the Android
    // analogue of iOS's GeofenceManager.onRegionEvent closure (which Android
    // previously lacked, leaving wrapper `regionEvent`/`addListener` dead on
    // Android). It NEVER replaces the POST; if no listener is installed it is a
    // no-op and the wake path is identical to before.
    //
    // Contract: a wrapper installs a listener with setRegionEventListener(l). On a
    // crossing the receiver calls emitRegionEvent(type, regionId, lat, lng, accuracy,
    // timestamp); the listener receives a JSONObject with EXACTLY the RegionEvent
    // shape (definitions.ts): { type:"enter"|"exit", regionId:String,
    // latitude:double, longitude:double, accuracy:double (meters; -1 if invalid),
    // timestamp:String (ISO-8601 UTC) }. The listener is invoked on the receiver's
    // thread (a binder/main-looper context during the brief broadcast window) — a
    // wrapper that needs the main thread or that bridges to JS must marshal as
    // appropriate. Held in a static so the singleton-equivalent core (GeofenceStore)
    // owns it across the module boundary, exactly as iOS's shared manager owns its
    // closure.

    /** Live in-process region-event listener. Receives the RegionEvent JSON shape. */
    public interface RegionEventListener {
        void onRegionEvent(JSONObject event);
    }

    private static volatile RegionEventListener regionEventListener;

    /** Install (or clear, with null) the live in-process region-event listener. */
    public static void setRegionEventListener(RegionEventListener l) {
        regionEventListener = l;
    }

    /**
     * Hand a crossing to the live listener if one is installed (no-op otherwise).
     * ADDITIVE to — never a replacement for — the background-wake POST. Builds the
     * exact RegionEvent payload (type, regionId, latitude, longitude, accuracy,
     * timestamp). Swallows listener exceptions so a misbehaving wrapper can never
     * disrupt the wake path that calls this.
     */
    static void emitRegionEvent(String type, String regionId, double lat, double lng, double accuracy, String timestamp) {
        RegionEventListener l = regionEventListener;
        if (l == null) return;
        try {
            JSONObject event = new JSONObject()
                    .put("type", type)
                    .put("regionId", regionId != null ? regionId : "")
                    .put("latitude", lat)
                    .put("longitude", lng)
                    .put("accuracy", accuracy)
                    .put("timestamp", timestamp);
            l.onRegionEvent(event);
        } catch (Exception ignored) {}
    }

    // --- Play Services registration (shared by the plugin + BootReceiver) ---

    /**
     * The single PendingIntent → GeofenceBroadcastReceiver that Play Services
     * fires on a transition. MUST be byte-for-byte identical wherever it's built
     * (register vs. remove) or removeGeofences() can't match it, so it lives here.
     */
    public static PendingIntent geofencePendingIntent(Context c) {
        Intent intent = new Intent(c, GeofenceBroadcastReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(c.getApplicationContext(), 0, intent, flags);
    }

    public static boolean hasBackgroundLocation(Context c) {
        if (ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        return ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private static Geofence buildGeofence(String id, double[] g) {
        return new Geofence.Builder()
                .setRequestId(id)
                .setCircularRegion(g[0], g[1], (float) g[2])
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER | Geofence.GEOFENCE_TRANSITION_EXIT)
                .build();
    }

    /**
     * Re-register ALL persisted fences with Play Services. Called from
     * BootReceiver (geofences are dropped on reboot) and after process death, so
     * a cold device still wakes on a crossing — the Android analogue of iOS region
     * monitoring surviving a relaunch. Requires ACCESS_BACKGROUND_LOCATION (the
     * boot path has no foreground); a no-op if it isn't held yet.
     */
    public static boolean registerAll(Context c) {
        if (!hasBackgroundLocation(c)) {
            Log.i(GeofenceStore.TAG, "registerAll: skipped — ACCESS_BACKGROUND_LOCATION not held");
            return false;
        }
        List<Geofence> fences = new ArrayList<>();
        for (String id : fenceIds(c)) {
            double[] g = fenceGeomFor(c, id);
            if (g != null) fences.add(buildGeofence(id, g));
        }
        if (fences.isEmpty()) {
            Log.i(GeofenceStore.TAG, "registerAll: no persisted fences to register");
            return false;
        }
        GeofencingRequest request = new GeofencingRequest.Builder()
                .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
                .addGeofences(fences)
                .build();
        try {
            GeofencingClient client = LocationServices.getGeofencingClient(c.getApplicationContext());
            final int n = fences.size();
            client.addGeofences(request, geofencePendingIntent(c))
                    .addOnSuccessListener(v -> Log.i(GeofenceStore.TAG, "registerAll: addGeofences SUCCESS for " + n + " fence(s) (background-armed)"))
                    .addOnFailureListener(e -> Log.e(GeofenceStore.TAG, "registerAll: addGeofences FAILED — " + e.getMessage(), e));
            return true;
        } catch (SecurityException se) {
            Log.e(GeofenceStore.TAG, "registerAll: SecurityException", se);
            return false;
        }
    }

    /**
     * POST a region-crossing ping to /functions/v1/v1-ingest with the wake source
     * (source:"native_region_wake"). Back-compat overload for the one-shot wake
     * path (GeofenceBroadcastReceiver / GeofencePostService) — unchanged behavior.
     */
    /** Fixes older than this are stale (cached region-trigger location) and are
     *  dropped at source so they don't post as downstream teleports. Mirrors the
     *  iOS guard. (Data-hygiene WS2.) */
    public static final long MAX_FIX_AGE_MS = 30_000L;

    public static int postPing(Context c, double lat, double lng, Float accuracyM, String eventType) {
        return postPing(c, lat, lng, accuracyM, eventType, "native_region_wake");
    }

    /** No device speed/heading available (e.g. one-shot region wakes) → null both. */
    public static int postPing(Context c, double lat, double lng, Float accuracyM, String eventType, String source) {
        return postPing(c, lat, lng, accuracyM, null, null, eventType, source);
    }

    /**
     * POST a ping to /functions/v1/v1-ingest (same contract as iOS) tagging it with
     * an explicit ingest `source`. The continuous foreground stream uses
     * source:"continuous_stream"; region crossings use "native_region_wake".
     * Runs synchronously — call from a background thread (the receiver uses
     * goAsync(); the stream service POSTs on a worker thread). Returns the HTTP
     * status, or -1 on failure. On a successful continuous_stream POST it records
     * lastStreamFixAt for diagnostics.
     */
    public static int postPing(Context c, double lat, double lng, Float accuracyM, Float speedMps, Float headingDeg, String eventType, String source) {
        return postPing(c, lat, lng, accuracyM, speedMps, headingDeg, null, eventType, source, null);
    }

    /**
     * Full overload threading the FIX's own capture time (Location.getTime(), epoch
     * ms UTC) into captured_at, so the ping records when the location was OBSERVED
     * rather than when it was POSTed. iOS already sends location.timestamp; Android
     * used the POST wall-clock (new Date()), which drifts from the fix time under
     * retry / queueing / a slow network and sorts a point next to a fresher one
     * downstream — the replay-teleport bug. capturedAtMs null ⇒ fall back to the
     * POST time (prior behavior) for callers that have no fix time.
     */
    // 9-arg overload (no region ref) — the stream path and any caller without an
    // armed region id. Delegates to the full overload with regionRef=null.
    public static int postPing(Context c, double lat, double lng, Float accuracyM, Float speedMps, Float headingDeg, Long capturedAtMs, String eventType, String source) {
        return postPing(c, lat, lng, accuracyM, speedMps, headingDeg, capturedAtMs, eventType, source, null);
    }

    public static int postPing(Context c, double lat, double lng, Float accuracyM, Float speedMps, Float headingDeg, Long capturedAtMs, String eventType, String source, String regionRef) {
        SharedPreferences p = prefs(c);
        String base = p.getString(K_BASE, null);
        String anon = p.getString(K_ANON, null);
        String pk = p.getString(K_PK, null);
        String subject = p.getString(K_SUBJECT, null);
        String device = p.getString(K_DEVICE, "android-native");
        if (base == null || anon == null || pk == null || subject == null) {
            Log.e(GeofenceStore.TAG, "postPing: NOT configured (base/anon/pk/subject missing) — dropping " + eventType + " ping");
            return -1;
        }

        HttpURLConnection conn = null;
        try {
            SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            iso.setTimeZone(TimeZone.getTimeZone("UTC"));
            // captured_at = the FIX's own time when we have it (iOS parity), else the
            // POST wall-clock as before.
            String capturedAt = iso.format(capturedAtMs != null ? new Date(capturedAtMs) : new Date());

            JSONObject location = new JSONObject().put("latitude", lat).put("longitude", lng);
            JSONObject ping = new JSONObject()
                    .put("client_ping_id", UUID.randomUUID().toString())
                    .put("location", location)
                    .put("captured_at", capturedAt)
                    .put("source", source);
            if (accuracyM != null) ping.put("accuracy_m", (double) accuracyM);
            if (speedMps != null) ping.put("speed_mps", (double) speedMps);
            if (headingDeg != null) ping.put("heading", (double) headingDeg);
            // Carry the device's authoritative crossing so the server can confirm
            // arrivals for geofence-only (sparse) tracking without M-of-N density.
            // Only real crossings (enter/exit), never the in-perimeter stream.
            if ("enter".equals(eventType) || "exit".equals(eventType)) ping.put("region_event", eventType);
            if (regionRef != null) ping.put("region_ref", regionRef);
            JSONObject body = new JSONObject()
                    .put("external_id", subject)
                    .put("device_id", device)
                    .put("pings", new JSONArray().put(ping));

            URL url = new URL(base + "/functions/v1/v1-ingest");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);
            conn.setRequestProperty("apikey", anon);
            conn.setRequestProperty("Authorization", "Bearer " + pk);
            conn.setRequestProperty("Content-Type", "application/json");
            byte[] payload = body.toString().getBytes("UTF-8");
            Log.i(GeofenceStore.TAG, "postPing: POST " + eventType + " (" + source + ") -> " + url + " (lat=" + lat + " lng=" + lng + ")");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
            int code = conn.getResponseCode();
            Log.i(GeofenceStore.TAG, "postPing: " + eventType + " HTTP " + code);
            if (code >= 200 && code < 300 && "continuous_stream".equals(source)) {
                setLastStreamFixAt(c, capturedAt);
            }
            return code;
        } catch (Exception e) {
            Log.e(GeofenceStore.TAG, "postPing: " + eventType + " FAILED — " + e.getMessage(), e);
            return -1;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
