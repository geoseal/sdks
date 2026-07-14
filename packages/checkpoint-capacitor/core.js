// Root proxy stub for resolvers that ignore the package.json "exports" map
// (Metro < 0.82 / RN < 0.79 / Expo SDK 51-52 default config). Exports-aware
// resolvers hit "./core" in the exports map first and never see this file.
export * from "./dist/core.js";
