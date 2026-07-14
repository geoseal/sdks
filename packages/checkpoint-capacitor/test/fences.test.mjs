// Tests for the build-7 transient-empty-pull guard (plan R1/R6) in pullArmedFences.
//   npm run build && node --test test/fences.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { pullArmedFences } from "../dist/presence.js";

const transport = {
  baseUrl: "https://example.test",
  anonKey: "anon",
  publishableKey: "pk_test",
};

function withFetch(fn) {
  return { ...transport, fetchImpl: fn };
}

test("non-OK status => ok:false so the caller KEEPS its armed set (build-7 guard)", async () => {
  const t = withFetch(async () => new Response("err", { status: 401 }));
  const r = await pullArmedFences("sub_abc", t);
  assert.equal(r.ok, false, "a 401 must not be honored as a disarm");
  assert.deepEqual(r.regions, []);
});

test("network throw => ok:false (transient, keep armed set)", async () => {
  const t = withFetch(async () => { throw new Error("offline"); });
  const r = await pullArmedFences("sub_abc", t);
  assert.equal(r.ok, false);
});

test("200 with [] => AUTHORITATIVE disarm (ok:true, empty regions)", async () => {
  const t = withFetch(async () => new Response(JSON.stringify({ regions: [] }), { status: 200 }));
  const r = await pullArmedFences("sub_abc", t);
  assert.equal(r.ok, true, "a 200 empty body IS an authoritative disarm");
  assert.deepEqual(r.regions, []);
  assert.equal(r.directive.effective_mode, "geofence", "directive defaults when absent");
});

test("200 with regions + tracking directive parses both", async () => {
  const body = {
    regions: [{ place_id: "place_1", name: "HQ", geofence_ref: "gf_1", center: { latitude: 40, longitude: -100 }, radius_m: 150 }],
    tracking: { effective_mode: "always", stream_now: true, min_interval_s: 20 },
  };
  const t = withFetch(async () => new Response(JSON.stringify(body), { status: 200 }));
  const r = await pullArmedFences("sub_abc", t);
  assert.equal(r.ok, true);
  assert.equal(r.regions.length, 1);
  assert.equal(r.directive.effective_mode, "always");
  assert.equal(r.directive.stream_now, true);
  assert.equal(r.directive.min_interval_s, 20);
  assert.equal(r.directive.active_window, null, "absent field falls back to default");
});
