package com.checkpoint.core;

/**
 * Flat region-event callback the .NET-for-Android binding projects as
 * {@code Com.Checkpoint.Core.IRegionEventListener} (the binding generator prefixes
 * Java interfaces with "I"). The MAUI wrapper's RegionEventListenerImpl
 * (Platforms/Android/NativeInterop.cs) implements it.
 *
 * TOP-LEVEL (not nested in CheckpointGeofence) on purpose: a top-level Java interface
 * projects to a top-level C# interface {@code Com.Checkpoint.Core.IRegionEventListener},
 * which is exactly the type the wrapper references — no Metadata.xml un-nesting needed.
 *
 * Distinct from the engine's JSONObject-based {@code GeofenceStore.RegionEventListener}:
 * {@link CheckpointGeofence#setRegionEventListener} adapts between the two so the MAUI
 * side receives primitive args it can map without touching org.json. ADDITIVE — only
 * fires while the host process is alive; the background-wake POST path is unaffected.
 */
public interface RegionEventListener {
    void onRegionEvent(String type, String regionId, double latitude, double longitude,
                       double accuracy, String timestamp);
}
