// @geoseal/expo — config plugin.
//
// Runs at `expo prebuild` time. Its ONLY job is to inject the native platform
// config the two Checkpoint cores require for background geofencing to work:
//
//   iOS Info.plist
//     - NSLocationWhenInUseUsageDescription
//     - NSLocationAlwaysAndWhenInUseUsageDescription   (Always = background wakes)
//     - NSLocationAlwaysUsageDescription               (iOS < 11 / belt-and-braces)
//     - UIBackgroundModes += "location"                (region wakes a killed app)
//
//   Android AndroidManifest
//     - ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION
//     - ACCESS_BACKGROUND_LOCATION   (API 29+ background geofence triggering)
//     - POST_NOTIFICATIONS           (API 33+ crossing notifications)
//     - FOREGROUND_SERVICE / FOREGROUND_SERVICE_LOCATION
//     - RECEIVE_BOOT_COMPLETED       (re-arm geofences after reboot)
//     - REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (Doze / OEM app-standby exemption)
//
// The receivers/services themselves (GeofenceBroadcastReceiver, GeofencePostService,
// ContinuousLocationService, BootReceiver) ship in the library manifest INSIDE the
// dev.checkpoint:checkpoint-core AAR (frozen FQCNs com.checkpoint.capacitor.*).
// Autolinking links @geoseal/react-native's android library, whose build.gradle
// declares `implementation 'dev.checkpoint:checkpoint-core:0.1.0'`, so the
// manifest-merger folds those components in transitively — this plugin does NOT
// redeclare them (that would double-declare and fail the merger). It only adds the
// host-app-level permissions Expo otherwise strips.
//
// ANDROID VENDORING (`vendorNativeCore`, default true): iOS needs NO injection —
// CheckpointCore resolves from the CocoaPods trunk via the RN podspec's
// `s.dependency 'CheckpointCore', '~> 0.1'`. Android's dev.checkpoint:checkpoint-core
// AAR is NOT on a public Maven registry yet, so prebuilt hosts need one extra line
// this plugin injects —
//   android/build.gradle:   allprojects { repositories { mavenLocal { content { includeGroup "dev.checkpoint" } } } }
// (plus a one-time `./gradlew publishToMavenLocal` inside
// node_modules/@geoseal/capacitor/android-core — see the README). Set
// `vendorNativeCore: false` once dev.checkpoint:checkpoint-core is on Maven Central.
//
// REQUIRED HOST STEP (iOS): the app's package.json MUST carry
//   "expo": { "autolinking": { "exclude": ["@geoseal/capacitor"] } }
// Expo's autolinking scans dependencies RECURSIVELY (unlike the RN CLI) and only
// honors a library's react-native.config.{js,ts} opt-out — @geoseal/capacitor
// ships react-native.config.cjs (its "type":"module" makes a .js config unloadable
// for the RN CLI), which Expo cannot see. Without the exclude, Expo mis-links the
// package's CheckpointIrlCapacitor.podspec, pod install pulls the ancient trunk
// 'Capacitor' 2.x pod, and fails ("Swift pod `Capacitor` depends upon
// `CapacitorCordova`..."). A config plugin cannot edit package.json, so this
// plugin WARNS at prebuild when the exclude is missing (see
// hostNeedsCapacitorAutolinkExclude below). Android is unaffected (the package has
// no ReactPackage class, so Expo's android resolver skips it).
//
// This plugin reimplements NO geofencing logic. Detection runs server-side; the
// device is a sensor. The plugin is pure build-time config.

import {
  AndroidConfig,
  ConfigPlugin,
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withInfoPlist,
  withProjectBuildGradle,
} from "@expo/config-plugins";
import * as fs from "fs";
import * as path from "path";

const pkg = { name: "@geoseal/expo", version: "0.2.0" };

export interface CheckpointPluginProps {
  /**
   * iOS NSLocationWhenInUseUsageDescription. Shown when the app first asks for
   * location. Store review REJECTS background-location apps with a vague string —
   * say WHY (e.g. "Checkpoint records arrivals and departures at your assigned
   * facilities."). See docs/guides/store-submission.md.
   */
  locationWhenInUsePermission?: string | false;
  /**
   * iOS NSLocationAlwaysAndWhenInUseUsageDescription. REQUIRED for background
   * region wakes — without "Always" the OS will not relaunch a killed app on a
   * geofence crossing. Must explain background use prominently.
   */
  locationAlwaysAndWhenInUsePermission?: string | false;
  /** iOS NSLocationAlwaysUsageDescription (legacy, iOS < 11). */
  locationAlwaysPermission?: string | false;
  /**
   * Whether to add ACCESS_BACKGROUND_LOCATION on Android (API 29+). Default true —
   * background geofence triggering does not work without it. Set false only if the
   * app genuinely never needs background crossings.
   */
  isAndroidBackgroundLocationEnabled?: boolean;
  /**
   * Whether to request battery-optimization exemption on Android
   * (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS). Default true. On aggressive OEMs
   * (Samsung One UI especially) an optimized app is force-stopped and its
   * receivers disabled, so geofence broadcasts never wake a killed process. See
   * docs/guides/whitelisting.md.
   */
  isAndroidBatteryExemptionEnabled?: boolean;
  /**
   * ANDROID ONLY (default true). Injects a content-filtered `mavenLocal()`
   * repository (group dev.checkpoint only) into android/build.gradle so
   * `dev.checkpoint:checkpoint-core` resolves from `publishToMavenLocal` output.
   * iOS needs no vendoring — the CheckpointCore pod resolves from the CocoaPods
   * trunk (this prop used to also gate an ios/Podfile :path injection, removed
   * in 0.1.1). Set false once dev.checkpoint:checkpoint-core is on Maven
   * Central.
   */
  vendorNativeCore?: boolean;
}

const DEFAULTS = {
  locationWhenInUse:
    "$(PRODUCT_NAME) uses your location to record arrivals and departures at your assigned facilities.",
  locationAlwaysAndWhenInUse:
    "$(PRODUCT_NAME) uses your location in the background so it can record an arrival or departure even when the app is closed.",
  locationAlways:
    "$(PRODUCT_NAME) uses your location in the background so it can record an arrival or departure even when the app is closed.",
} as const;

// ── iOS ──────────────────────────────────────────────────────────────────────

/** The subset of Info.plist keys this plugin reads/writes. */
interface CheckpointInfoPlist {
  NSLocationWhenInUseUsageDescription?: string;
  NSLocationAlwaysAndWhenInUseUsageDescription?: string;
  NSLocationAlwaysUsageDescription?: string;
  UIBackgroundModes?: string[];
  [key: string]: unknown;
}

/**
 * Pure Info.plist transform — exported so the iOS config can be unit-tested
 * without driving a full `expo prebuild`. Mutates and returns `plist`.
 */
export function applyCheckpointInfoPlist<T extends CheckpointInfoPlist>(
  plist: T,
  props: CheckpointPluginProps = {}
): T {
  if (props.locationWhenInUsePermission !== false) {
    plist.NSLocationWhenInUseUsageDescription =
      props.locationWhenInUsePermission ||
      plist.NSLocationWhenInUseUsageDescription ||
      DEFAULTS.locationWhenInUse;
  }
  if (props.locationAlwaysAndWhenInUsePermission !== false) {
    plist.NSLocationAlwaysAndWhenInUseUsageDescription =
      props.locationAlwaysAndWhenInUsePermission ||
      plist.NSLocationAlwaysAndWhenInUseUsageDescription ||
      DEFAULTS.locationAlwaysAndWhenInUse;
  }
  if (props.locationAlwaysPermission !== false) {
    plist.NSLocationAlwaysUsageDescription =
      props.locationAlwaysPermission ||
      plist.NSLocationAlwaysUsageDescription ||
      DEFAULTS.locationAlways;
  }

  // UIBackgroundModes += "location" — region monitoring relaunches a killed app
  // only if the app declares the background location mode.
  const modes = new Set<string>(
    Array.isArray(plist.UIBackgroundModes) ? plist.UIBackgroundModes : []
  );
  modes.add("location");
  plist.UIBackgroundModes = Array.from(modes);

  return plist;
}

const withCheckpointInfoPlist: ConfigPlugin<CheckpointPluginProps> = (config, props) => {
  return withInfoPlist(config, (cfg) => {
    applyCheckpointInfoPlist(cfg.modResults as CheckpointInfoPlist, props);
    return cfg;
  });
};

// ── Android ──────────────────────────────────────────────────────────────────

// Host-app permissions the cores need. The receivers/services come from the
// com.checkpoint.capacitor library manifest via autolinking; we only add the
// permissions Expo's managed manifest does not include by default.
function androidPermissions(props: CheckpointPluginProps): string[] {
  const perms = [
    "android.permission.INTERNET",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_LOCATION",
    "android.permission.RECEIVE_BOOT_COMPLETED",
  ];
  if (props.isAndroidBackgroundLocationEnabled !== false) {
    perms.push("android.permission.ACCESS_BACKGROUND_LOCATION");
  }
  if (props.isAndroidBatteryExemptionEnabled !== false) {
    perms.push("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS");
  }
  return perms;
}

interface AndroidManifestShape {
  manifest: { "uses-permission"?: Array<{ $: { "android:name"?: string } }> };
}

/**
 * Pure manifest transform — adds the host-app permissions, de-duping against any
 * already present. Exported for unit testing. Mutates and returns `manifest`.
 */
export function applyCheckpointAndroidManifest<T extends AndroidManifestShape>(
  manifest: T,
  props: CheckpointPluginProps = {}
): T {
  const tag = "uses-permission" as const;
  const existing = new Set(
    (manifest.manifest[tag] ?? []).map((p) => p.$?.["android:name"]).filter(Boolean) as string[]
  );
  const toAdd = androidPermissions(props).filter((name) => !existing.has(name));
  manifest.manifest[tag] = [
    ...(manifest.manifest[tag] ?? []),
    ...toAdd.map((name) => ({ $: { "android:name": name } })),
  ];
  return manifest;
}

const withCheckpointAndroidManifest: ConfigPlugin<CheckpointPluginProps> = (config, props) => {
  return withAndroidManifest(config, (cfg) => {
    applyCheckpointAndroidManifest(cfg.modResults as unknown as AndroidManifestShape, props);
    return cfg;
  });
};

// Also use Expo's first-class permission helper so the managed-config
// `android.permissions` list stays consistent with what we inject.
const withCheckpointAndroidPermissionList: ConfigPlugin<CheckpointPluginProps> = (config, props) => {
  return AndroidConfig.Permissions.withPermissions(config, androidPermissions(props));
};

// ── Android native-core vendoring (vendorNativeCore, default true) ───────────
//
// The RN wrapper's own build files declare the REAL core deps
// (CheckpointReactNative.podspec → `s.dependency 'CheckpointCore', '~> 0.1'`,
// which CocoaPods resolves from the trunk — no host-side iOS wiring needed;
// android/build.gradle → `implementation 'dev.checkpoint:checkpoint-core:0.1.0'`).
// Until that AAR is on a public Maven registry, a HOST built from prebuild is
// missing where to RESOLVE the Android dep from — that host-side wiring is what
// this transform injects. It is pure string → string (unit-tested in
// test/plugin-transforms.test.mjs), idempotent, and a no-op when
// `vendorNativeCore: false`.

const GRADLE_VENDOR_BLOCK = `
// @geoseal/expo vendorNativeCore: dev.checkpoint:checkpoint-core
// is not on a public Maven registry yet. Resolve ONLY that group from mavenLocal
// (one-time: \`./gradlew publishToMavenLocal\` in
// node_modules/@geoseal/capacitor/android-core). Remove once published.
allprojects {
  repositories {
    mavenLocal { content { includeGroup "dev.checkpoint" } }
  }
}
`;

/**
 * Pure android/build.gradle transform: append a content-filtered mavenLocal()
 * repository so the app resolves dev.checkpoint:checkpoint-core (Gradle resolves
 * a LIBRARY's dependencies against the HOST app's repositories, so this must
 * live host-side). Idempotent; unchanged when vendoring is disabled or applied.
 */
export function applyCheckpointProjectBuildGradle(
  contents: string,
  props: CheckpointPluginProps = {}
): string {
  if (props.vendorNativeCore === false) return contents;
  if (contents.includes('mavenLocal { content { includeGroup "dev.checkpoint" } }'))
    return contents;
  return `${contents}${GRADLE_VENDOR_BLOCK}`;
}

// ── iOS autolink-exclude guard (always on) ───────────────────────────────────

interface HostAutolinkingOptions {
  exclude?: unknown;
  ios?: { exclude?: unknown };
  apple?: { exclude?: unknown };
}

/**
 * Pure predicate — true when the HOST app's package.json is missing the
 * `expo.autolinking.exclude: ["@geoseal/capacitor"]` entry Expo iOS builds
 * require (see the header comment). Mirrors expo-modules-autolinking's option
 * resolution: a platform-scoped options object (`ios`/`apple`) REPLACES the
 * top-level one for that platform (object spread, not list merge). Exported for
 * unit testing.
 */
export function hostNeedsCapacitorAutolinkExclude(hostPackageJson: unknown): boolean {
  const expo = (hostPackageJson as { expo?: { autolinking?: HostAutolinkingOptions } })?.expo;
  const autolinking = expo?.autolinking;
  if (!autolinking || typeof autolinking !== "object") return true;
  const platformScoped = autolinking.ios ?? autolinking.apple;
  const effective =
    platformScoped && typeof platformScoped === "object" && Array.isArray(platformScoped.exclude)
      ? platformScoped.exclude
      : autolinking.exclude;
  return !(Array.isArray(effective) && effective.includes("@geoseal/capacitor"));
}

const AUTOLINK_EXCLUDE_WARNING =
  "[@geoseal/expo] Your package.json is missing the required Expo autolinking exclude. " +
  'Add `"expo": { "autolinking": { "exclude": ["@geoseal/capacitor"] } }` to the app\'s package.json. ' +
  "Without it, Expo's recursive autolinking mis-links @geoseal/capacitor's Capacitor-bridge podspec " +
  "and `pod install` fails pulling the obsolete trunk 'Capacitor' pod. See the @geoseal/expo README.";

// console.warn (not WarningAggregator): the host's prebuild may execute this
// plugin through a NESTED copy of @expo/config-plugins, whose WarningAggregator
// store the host CLI never reads.
const withCheckpointAutolinkExcludeCheck: ConfigPlugin<CheckpointPluginProps> = (config) => {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      try {
        const pkgPath = path.join(cfg.modRequest.projectRoot, "package.json");
        const hostPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (hostNeedsCapacitorAutolinkExclude(hostPkg)) {
          console.warn(AUTOLINK_EXCLUDE_WARNING);
        }
      } catch {
        // Unreadable host package.json — nothing to check.
      }
      return cfg;
    },
  ]);
};

const withCheckpointProjectBuildGradle: ConfigPlugin<CheckpointPluginProps> = (
  config,
  props
) => {
  if (props.vendorNativeCore === false) return config;
  return withProjectBuildGradle(config, (cfg) => {
    cfg.modResults.contents = applyCheckpointProjectBuildGradle(
      cfg.modResults.contents,
      props
    );
    return cfg;
  });
};

// ── Compose ──────────────────────────────────────────────────────────────────

const withCheckpoint: ConfigPlugin<CheckpointPluginProps | void> = (config, props) => {
  const p: CheckpointPluginProps = props ?? {};
  config = withCheckpointInfoPlist(config, p);
  config = withCheckpointAndroidPermissionList(config, p);
  config = withCheckpointAndroidManifest(config, p);
  config = withCheckpointAutolinkExcludeCheck(config, p);
  config = withCheckpointProjectBuildGradle(config, p);
  return config;
};

export default createRunOncePlugin(withCheckpoint, pkg.name, pkg.version);
