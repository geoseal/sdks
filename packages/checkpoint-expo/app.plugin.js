// Expo resolves a package's config plugin from `<pkg>/app.plugin.js` by
// convention and loads it via require() — this file MUST be CommonJS. The root
// package.json therefore does NOT set "type": "module" (doing so makes this file
// an ES module whose `module.exports` is silently discarded, and the
// @expo/config-plugins resolver dies with 'must export a function'). The plugin
// TypeScript compiles to ./plugin/build/index.js (CommonJS, per plugin/tsconfig.json
// + plugin/package.json's explicit "type": "commonjs").
module.exports = require("./plugin/build");
