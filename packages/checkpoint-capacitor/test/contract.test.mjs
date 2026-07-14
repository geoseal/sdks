// Validator for the canonical machine-readable contract fixture.
//
// contract/checkpoint-contract.json is what wrapper SDK test suites consume; it
// is GENERATED from src/contract.ts (scripts/generate-contract.mjs), which is
// compile-pinned against definitions.ts/index.ts/api.ts. This test asserts the
// committed JSON is fresh (byte-equal to what dist/contract.js would generate)
// and pins the counts the contract promises (11 native methods, 6 facade
// methods, 17 diagnostics fields, 12 outage reasons, 9 configure keys).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHECKPOINT_CONTRACT } from "../dist/contract.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const json = JSON.parse(
  readFileSync(new URL("../contract/checkpoint-contract.json", import.meta.url), "utf8"),
);

test("contract JSON is version-stamped with the package version", () => {
  assert.equal(json.version, pkg.version);
});

test("contract JSON matches the compile-pinned source (no staleness)", () => {
  for (const [key, value] of Object.entries(CHECKPOINT_CONTRACT)) {
    assert.deepEqual(json[key], [...value], `contract key ${key} drifted — rerun npm run generate:contract`);
  }
  const expectedKeys = ["version", "source", ...Object.keys(CHECKPOINT_CONTRACT)];
  assert.deepEqual(Object.keys(json), expectedKeys, "contract JSON key set");
});

test("contract set sizes match the frozen surface", () => {
  assert.equal(json.nativeMethods.length, 11);
  assert.equal(json.facadeMethods.length, 6);
  assert.equal(json.trackingModeWire.length, 3);
  assert.equal(json.regionEventTypes.length, 4);
  assert.equal(json.regionEventFields.length, 6);
  assert.equal(json.nativeDiagnosticsFields.length, 17);
  assert.equal(json.configureOptionKeys.length, 9);
  assert.equal(json.directiveRpcKeys.length, 3);
  assert.equal(json.outageReasons.length, 12);
  assert.equal(json.ingestSources.length, 3);
});
