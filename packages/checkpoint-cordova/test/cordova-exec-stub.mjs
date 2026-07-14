// Node stub for the cordova/exec module — lets test/conformance.spec.ts execute
// off-device (no bridge; calls are recorded and ignored). Used only by
// test/run-conformance.mjs via an esbuild alias.
export default function exec(_success, _error, _service, _action, _args) {}
