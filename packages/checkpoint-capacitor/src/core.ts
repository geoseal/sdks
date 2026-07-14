// '@geoseal/capacitor/core' — the Capacitor-free JS entry for wrapper SDKs
// (RN / Expo / Flutter hosts). Everything EXCEPT plugin.ts and index.ts, so
// importing this subpath never reaches @capacitor/core at runtime (which is an
// optional peer). The native engine is consumed separately via the CheckpointCore
// pod / dev.checkpoint:checkpoint-core AAR.
export * from "./api.js";
export * from "./presence.js";
export * from "./transport.js";
export * from "./ids.js";
export * from "./modeStorage.js";
export type * from "./definitions.js";
// TrackingMode exists in both api.ts and definitions.ts (identical literal
// union); explicit re-export resolves the star-export ambiguity.
export type { TrackingMode } from "./definitions.js";
