// Unit tests for the config plugin's exported PURE transforms (node --test).
// These are the same functions the registered mods run at `expo prebuild` time;
// the end-to-end proof (real resolver + full prebuild) lives in the task verify,
// but these pin the transform semantics: defaults, prop overrides, `false`
// suppression, de-dupe/idempotence, and the vendorNativeCore gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plugin = require("../plugin/build/index.js");
const {
  applyCheckpointInfoPlist,
  applyCheckpointAndroidManifest,
  applyCheckpointProjectBuildGradle,
  hostNeedsCapacitorAutolinkExclude,
} = plugin;

// ── Info.plist ────────────────────────────────────────────────────────────────

test("infoPlist: defaults + UIBackgroundModes location, deduped", () => {
  const plist = applyCheckpointInfoPlist({ UIBackgroundModes: ["fetch", "location"] });
  assert.match(plist.NSLocationWhenInUseUsageDescription, /arrivals and departures/);
  assert.match(plist.NSLocationAlwaysAndWhenInUseUsageDescription, /background/);
  assert.match(plist.NSLocationAlwaysUsageDescription, /background/);
  assert.deepEqual(plist.UIBackgroundModes, ["fetch", "location"]);
});

test("infoPlist: prop overrides win; `false` suppresses a key", () => {
  const plist = applyCheckpointInfoPlist(
    {},
    { locationWhenInUsePermission: "Custom why", locationAlwaysPermission: false }
  );
  assert.equal(plist.NSLocationWhenInUseUsageDescription, "Custom why");
  assert.equal(plist.NSLocationAlwaysUsageDescription, undefined);
  assert.deepEqual(plist.UIBackgroundModes, ["location"]);
});

// ── AndroidManifest ──────────────────────────────────────────────────────────

const perm = (name) => ({ $: { "android:name": name } });

test("androidManifest: adds the 9 default permissions, deduped", () => {
  const manifest = applyCheckpointAndroidManifest({
    manifest: { "uses-permission": [perm("android.permission.INTERNET")] },
  });
  const names = manifest.manifest["uses-permission"].map((p) => p.$["android:name"]);
  assert.equal(names.filter((n) => n === "android.permission.INTERNET").length, 1);
  for (const required of [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_BACKGROUND_LOCATION",
    "android.permission.FOREGROUND_SERVICE_LOCATION",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  ]) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
  assert.equal(names.length, 9);
});

test("androidManifest: prop gates drop background-location / battery permissions", () => {
  const manifest = applyCheckpointAndroidManifest(
    { manifest: {} },
    { isAndroidBackgroundLocationEnabled: false, isAndroidBatteryExemptionEnabled: false }
  );
  const names = manifest.manifest["uses-permission"].map((p) => p.$["android:name"]);
  assert.ok(!names.includes("android.permission.ACCESS_BACKGROUND_LOCATION"));
  assert.ok(!names.includes("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"));
  assert.equal(names.length, 7);
});

// ── iOS Podfile: NO injection (CheckpointCore resolves from the CocoaPods trunk) ─

test("podfile: plugin no longer exports a Podfile transform (removed in 0.1.1)", () => {
  assert.equal(plugin.applyCheckpointPodfile, undefined);
});

// ── android/build.gradle vendoring (vendorNativeCore) ────────────────────────

const BUILD_GRADLE = `buildscript {
  repositories { google(); mavenCentral() }
}
allprojects {
  repositories {
    google()
    mavenCentral()
  }
}
`;

test("build.gradle: appends the content-filtered mavenLocal block (default on)", () => {
  const out = applyCheckpointProjectBuildGradle(BUILD_GRADLE);
  assert.ok(out.startsWith(BUILD_GRADLE), "original contents preserved");
  assert.match(out, /mavenLocal \{ content \{ includeGroup "dev\.checkpoint" \} \}/);
});

test("build.gradle: idempotent", () => {
  const once = applyCheckpointProjectBuildGradle(BUILD_GRADLE);
  assert.equal(applyCheckpointProjectBuildGradle(once), once);
});

test("build.gradle: vendorNativeCore false ⇒ unchanged", () => {
  assert.equal(
    applyCheckpointProjectBuildGradle(BUILD_GRADLE, { vendorNativeCore: false }),
    BUILD_GRADLE
  );
});

// ── Host autolink-exclude guard (iOS pod-install breaker) ────────────────────

test("autolinkExclude: missing/empty expo.autolinking ⇒ needs exclude (warn)", () => {
  assert.equal(hostNeedsCapacitorAutolinkExclude({}), true);
  assert.equal(hostNeedsCapacitorAutolinkExclude({ expo: {} }), true);
  assert.equal(hostNeedsCapacitorAutolinkExclude({ expo: { autolinking: {} } }), true);
  assert.equal(
    hostNeedsCapacitorAutolinkExclude({ expo: { autolinking: { exclude: ["other-pkg"] } } }),
    true
  );
});

test("autolinkExclude: top-level exclude satisfies", () => {
  assert.equal(
    hostNeedsCapacitorAutolinkExclude({
      expo: { autolinking: { exclude: ["@geoseal/capacitor"] } },
    }),
    false
  );
});

test("autolinkExclude: ios-scoped exclude satisfies AND replaces top-level (expo option semantics)", () => {
  assert.equal(
    hostNeedsCapacitorAutolinkExclude({
      expo: { autolinking: { ios: { exclude: ["@geoseal/capacitor"] } } },
    }),
    false
  );
  // platform-scoped options REPLACE top-level for that platform — a top-level
  // exclude shadowed by an ios exclude without the entry still needs the warn.
  assert.equal(
    hostNeedsCapacitorAutolinkExclude({
      expo: {
        autolinking: {
          exclude: ["@geoseal/capacitor"],
          ios: { exclude: ["other-pkg"] },
        },
      },
    }),
    true
  );
});

// ── Plugin entry (the P0 regression this package shipped broken) ─────────────

test("app.plugin.js: require() returns the config plugin function", () => {
  const entry = require("../app.plugin.js");
  assert.equal(typeof entry.default, "function");
});
