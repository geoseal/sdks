#!/usr/bin/env node
// Cross-checks every wrapper SDK's conformance fixture against the canonical
// contract (contract/checkpoint-contract.json). The wrapper fixtures are
// deliberately kept in each package's own language/test-runner (they double as
// compile-level pins there); this script is the CI guard that the SETS stay in
// sync with the canonical JSON. It parses the fixture constants textually
// (flat string lists only) and compares as sets, applying the documented
// per-platform idiom mappings:
//   - Flutter: addRegionEventListener ⇔ addListener (listener idiom)
//   - MAUI:    PascalCase + Async suffix; RegionEvent listener is a C# `event`
//              (so addListener is absent from NativeMethods); the facade adds
//              an OpenAppSettingsAsync convenience forward (documented extra)
//   - KMP:     canonical names (its real API uses setRegionEventListener but
//              the fixture pins the canonical addListener slot)
// KMP's OutageReason list lives inline in a test body (not a named constant) —
// covered by its own gradle test, skipped here.
//
// Exit 0 = all fixtures in sync; exit 1 = drift (diff printed).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const contract = JSON.parse(
  readFileSync(
    path.join(repoRoot, "packages/checkpoint-capacitor/contract/checkpoint-contract.json"),
    "utf8",
  ),
);

const identity = (s) => s;
const camel = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const mauiName = (s) => camel(s.replace(/Async$/, ""));
const listenerAlias = (s) =>
  s === "addRegionEventListener" || s === "setRegionEventListener" ? "addListener" : s;

// Per-fixture config: file, and per-contract-key the constant identifier in the
// file, a name normalizer, and any documented allowed deltas.
const fixtures = [
  {
    label: "react-native",
    file: "packages/checkpoint-react-native/test/conformance.spec.ts",
    constants: {
      nativeMethods: { ident: "NATIVE_METHODS" },
      facadeMethods: { ident: "FACADE_METHODS" },
      trackingModeWire: { ident: "TRACKING_MODE_WIRE" },
      regionEventTypes: { ident: "REGION_EVENT_TYPES" },
      regionEventFields: { ident: "REGION_EVENT_FIELDS" },
      nativeDiagnosticsFields: { ident: "NATIVE_DIAGNOSTICS_FIELDS" },
      configureOptionKeys: { ident: "CONFIGURE_OPTION_KEYS" },
      directiveRpcKeys: { ident: "DIRECTIVE_RPC_KEYS" },
    },
  },
  {
    label: "expo",
    file: "packages/checkpoint-expo/test/conformance.spec.ts",
    constants: {
      nativeMethods: { ident: "NATIVE_METHODS" },
      facadeMethods: { ident: "FACADE_METHODS" },
      trackingModeWire: { ident: "TRACKING_MODE_WIRE" },
      regionEventTypes: { ident: "REGION_EVENT_TYPES" },
      regionEventFields: { ident: "REGION_EVENT_FIELDS" },
      nativeDiagnosticsFields: { ident: "NATIVE_DIAGNOSTICS_FIELDS" },
      configureOptionKeys: { ident: "CONFIGURE_OPTION_KEYS" },
      directiveRpcKeys: { ident: "DIRECTIVE_RPC_KEYS" },
    },
  },
  {
    label: "cordova",
    file: "packages/checkpoint-cordova/test/conformance.spec.ts",
    constants: {
      nativeMethods: { ident: "NATIVE_METHODS" },
      facadeMethods: { ident: "FACADE_METHODS" },
      trackingModeWire: { ident: "TRACKING_MODE_WIRE" },
      regionEventTypes: { ident: "REGION_EVENT_TYPES" },
      regionEventFields: { ident: "REGION_EVENT_FIELDS" },
      nativeDiagnosticsFields: { ident: "NATIVE_DIAGNOSTICS_FIELDS" },
      directiveRpcKeys: { ident: "DIRECTIVE_RPC_KEYS" },
    },
  },
  {
    label: "nativescript",
    file: "packages/checkpoint-nativescript/test/conformance.spec.ts",
    constants: {
      nativeMethods: { ident: "NATIVE_METHODS" },
      facadeMethods: { ident: "FACADE_METHODS" },
      trackingModeWire: { ident: "TRACKING_MODE_WIRE" },
      regionEventTypes: { ident: "REGION_EVENT_TYPES" },
      regionEventFields: { ident: "REGION_EVENT_FIELDS" },
      nativeDiagnosticsFields: { ident: "NATIVE_DIAGNOSTICS_FIELDS" },
      directiveRpcKeys: { ident: "DIRECTIVE_RPC_KEYS" },
    },
  },
  {
    label: "flutter",
    file: "packages/checkpoint_flutter/test/conformance_spec_test.dart",
    constants: {
      nativeMethods: { ident: "nativeMethods", map: listenerAlias },
      facadeMethods: { ident: "facadeMethods" },
      trackingModeWire: { ident: "trackingModeWire" },
      regionEventTypes: { ident: "regionEventTypes" },
      regionEventFields: { ident: "regionEventFields" },
      nativeDiagnosticsFields: { ident: "nativeDiagnosticsFields" },
      directiveRpcKeys: { ident: "directiveRpcKeys" },
      outageReasons: { ident: "outageReasonWire" },
    },
  },
  {
    label: "maui",
    file: "packages/checkpoint-maui/test/Checkpoint.Maui.Tests/ConformanceSpecTests.cs",
    constants: {
      // The RegionEvent listener is a C# `event` (not a method) — addListener
      // is legitimately absent from the C# native method set.
      nativeMethods: { ident: "NativeMethods", map: mauiName, allowedMissing: ["addListener"] },
      // OpenAppSettingsAsync is a documented facade convenience forward.
      facadeMethods: { ident: "FacadeMethods", map: mauiName, allowedExtra: ["openAppSettings"] },
      trackingModeWire: { ident: "TrackingModeWire" },
      regionEventTypes: { ident: "RegionEventTypeWire" },
      regionEventFields: { ident: "RegionEventFields", map: camel },
      nativeDiagnosticsFields: { ident: "NativeDiagnosticsFields", map: camel },
      configureOptionKeys: { ident: "ConfigureOptionsFields", map: camel },
      directiveRpcKeys: { ident: "DirectiveRpcKeys" },
      outageReasons: { ident: "OutageReasonWire" },
    },
  },
  {
    label: "kmp",
    file: "packages/checkpoint-kmp/src/commonTest/kotlin/dev/checkpoint/kmp/ConformanceSpecTest.kt",
    constants: {
      nativeMethods: { ident: "NATIVE_METHODS" },
      facadeMethods: { ident: "FACADE_METHODS" },
      trackingModeWire: { ident: "TRACKING_MODE_WIRE" },
      regionEventTypes: { ident: "REGION_EVENT_TYPE_WIRE" },
      regionEventFields: { ident: "REGION_EVENT_FIELDS" },
      nativeDiagnosticsFields: { ident: "NATIVE_DIAGNOSTICS_FIELDS" },
      directiveRpcKeys: { ident: "DIRECTIVE_RPC_KEYS" },
    },
  },
];

/** Extract the flat string-list constant `ident` from source text. */
function extractList(source, ident, file) {
  // Strip line comments so commented entries/annotations never parse as values.
  const stripped = source.replace(/\/\/[^\n]*/g, "");
  const at = stripped.search(new RegExp(`\\b${ident}\\b`));
  if (at === -1) throw new Error(`${file}: constant ${ident} not found`);
  const rest = stripped.slice(at);
  const open = rest.search(/[[({]/);
  if (open === -1) throw new Error(`${file}: no list opener after ${ident}`);
  const closer = { "[": "]", "(": ")", "{": "}" }[rest[open]];
  const end = rest.indexOf(closer, open);
  if (end === -1) throw new Error(`${file}: unterminated list for ${ident}`);
  const body = rest.slice(open + 1, end);
  const values = [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  if (values.length === 0) throw new Error(`${file}: empty list for ${ident}`);
  return values;
}

let failures = 0;
for (const fixture of fixtures) {
  const source = readFileSync(path.join(repoRoot, fixture.file), "utf8");
  const problems = [];
  for (const [key, cfg] of Object.entries(fixture.constants)) {
    const canonical = contract[key];
    if (!canonical) throw new Error(`contract key ${key} missing from checkpoint-contract.json`);
    let actual;
    try {
      actual = extractList(source, cfg.ident, fixture.file).map(cfg.map ?? identity);
    } catch (err) {
      problems.push(String(err.message ?? err));
      continue;
    }
    const actualSet = new Set(actual);
    const canonicalSet = new Set(canonical);
    const missing = canonical.filter(
      (v) => !actualSet.has(v) && !(cfg.allowedMissing ?? []).includes(v),
    );
    const extra = actual.filter(
      (v) => !canonicalSet.has(v) && !(cfg.allowedExtra ?? []).includes(v),
    );
    if (missing.length || extra.length) {
      problems.push(
        `${cfg.ident} (${key}): missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]`,
      );
    }
  }
  if (problems.length) {
    failures += 1;
    console.error(`FAIL ${fixture.label} (${fixture.file})`);
    for (const p of problems) console.error(`  - ${p}`);
  } else {
    console.log(`ok   ${fixture.label} — ${Object.keys(fixture.constants).length} sets in sync`);
  }
}

if (failures) {
  console.error(`\ncontract sync: ${failures} fixture(s) drifted from contract/checkpoint-contract.json`);
  process.exit(1);
}
console.log("contract sync: all wrapper fixtures match the canonical contract");
