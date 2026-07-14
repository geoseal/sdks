#!/usr/bin/env node
// Regenerate contract/checkpoint-contract.json from the compile-pinned source
// (src/contract.ts → dist/contract.js). Run `npm run build` first (or use
// `npm run generate:contract`, which does). test/contract.test.mjs fails CI when
// the committed JSON is stale relative to dist/contract.js.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CHECKPOINT_CONTRACT } from "../dist/contract.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = new URL("../contract/checkpoint-contract.json", import.meta.url);
mkdirSync(new URL("../contract/", import.meta.url), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      version: pkg.version,
      source:
        "packages/checkpoint-capacitor/src/contract.ts (compile-pinned against definitions.ts + index.ts + api.ts)",
      ...CHECKPOINT_CONTRACT,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${out.pathname}`);
