import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2020",
  // The host app supplies these — never bundle them.
  external: ["react", "react-dom", "react/jsx-runtime", "mapbox-gl"],
  // styles.css is shipped verbatim (runtime-injected at mount, or optionally
  // imported by the consumer via `@geoseal/react-views/styles.css`).
  onSuccess: "cp src/styles.css dist/styles.css",
});
