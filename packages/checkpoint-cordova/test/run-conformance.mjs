#!/usr/bin/env node
// Executes test/conformance.spec.ts under Node (the spec's assertEqual calls run
// at module top level and throw on drift — including the canonical-JSON parity
// checks against @geoseal/capacitor/contract/checkpoint-contract.json).
// cordova/exec is aliased to a recording stub; everything else (including the
// bundled '@geoseal/capacitor/core') resolves normally from node_modules.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "checkpoint-cordova-conformance-"));
const outfile = path.join(outDir, "conformance.spec.mjs");

try {
  await build({
    entryPoints: [path.join(pkgDir, "test/conformance.spec.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    alias: { "cordova/exec": path.join(pkgDir, "test/cordova-exec-stub.mjs") },
    logLevel: "silent",
  });
  await import(pathToFileURL(outfile).href);
  console.log("conformance runtime assertions: ALL PASSED");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
