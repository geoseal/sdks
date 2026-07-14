// RN hosts must NOT autolink the Capacitor bridge in this package (the podspec /
// android module here are the Capacitor plugin faces). They consume CheckpointCore
// via @geoseal/react-native's own podspec/gradle deps.
// .cjs, not .js: this package is "type":"module", so a .js config would load as
// ESM and the RN CLI's cosmiconfig loader would read {} — silently disabling the
// guard and autolinking the Capacitor pods into RN hosts.
module.exports = { dependency: { platforms: { ios: null, android: null } } };
