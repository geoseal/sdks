#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `CheckpointGeofenceModule` (an RCTEventEmitter) to the React
// Native bridge under the frozen JS name "CheckpointGeofence".
// RCT_EXTERN_REMAP_MODULE (not RCT_EXTERN_MODULE) because the CheckpointCore pod
// already ships an ObjC class literally named `CheckpointGeofence` (the
// runtime-agnostic core shim) — the ObjC class name must differ, the JS module
// name must not. RCT_EXTERN_METHOD signatures MUST match the Swift @objc
// selectors. This legacy-bridge declaration is hosted unchanged by the
// New-Architecture interop layer, so the one Swift implementation serves both
// architectures.
//
// The optional numeric args (streamNow / minIntervalS / maxStrayStreamS /
// radius) are `nullable NSNumber *`: the JS contract allows omitting them, and
// the bridge rejects null for params not marked nullable.
@interface RCT_EXTERN_REMAP_MODULE(CheckpointGeofence, CheckpointGeofenceModule, RCTEventEmitter)

RCT_EXTERN_METHOD(configure:(NSString *)baseUrl
                  anonKey:(NSString *)anonKey
                  publishableKey:(NSString *)publishableKey
                  subjectExternalId:(NSString *)subjectExternalId
                  deviceId:(NSString *)deviceId
                  trackingMode:(NSString *)trackingMode
                  streamNow:(nullable NSNumber *)streamNow
                  minIntervalS:(nullable NSNumber *)minIntervalS
                  maxStrayStreamS:(nullable NSNumber *)maxStrayStreamS
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(requestAlwaysAuthorization:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(requestNotificationAuthorization:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(requestBatteryExemption:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(openAppSettings:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(addFence:(NSString *)id
                  latitude:(nonnull NSNumber *)latitude
                  longitude:(nonnull NSNumber *)longitude
                  radius:(nullable NSNumber *)radius
                  name:(NSString *)name
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(clearFences:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setTrackingMode:(NSString *)mode
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getTrackingMode:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
