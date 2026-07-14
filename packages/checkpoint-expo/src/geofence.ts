// @geoseal/expo/geofence — the geofence-only entry point.
//
// EXACT re-export of '@geoseal/react-native/geofence' (which itself mirrors
// '@geoseal/capacitor/geofence'): a STRICT SUBSET of the main barrel — the
// surface a privacy-first, geofence-only integration needs. `initGeofence`, the
// raw NativeGeofence plugin + frozen types, the armed-fence pull + pure geometry
// helpers, device-token minting, outage telemetry, and the subject-id codec.
//
// It DELIBERATELY omits the streaming ingest path (`ingestFix`), the self-serve
// discovery/drop/join calls, the tracking-directive RPCs, and local mode storage
// — those belong to the full SDK surface (the "." entry), not a geofence-only
// embed. Expo adds nothing: the config plugin (app.plugin.js) is build-time only
// and orthogonal to which JS entry point the app imports.
export * from "@geoseal/react-native/geofence";
