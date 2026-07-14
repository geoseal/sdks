// Pure-function tests for the extracted SDK core (plan Phase A step 5).
// Run against the built dist/ with the stdlib test runner — no extra deps:
//   npm run build && node --test test/pure.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { encodeSubjectPublicId, decodeSubjectPublicId } from "../dist/ids.js";
import { metersBetween, fenceSignature, zoneFor, DEFAULT_DIRECTIVE } from "../dist/presence.js";

test("encode/decode subject public id round-trips", () => {
  const uuid = "11223344-5566-7788-99aa-bbccddeeff00";
  const pub = encodeSubjectPublicId(uuid);
  assert.equal(pub, "sub_112233445566778899aabbccddeeff00");
  assert.equal(decodeSubjectPublicId(pub), uuid);
});

test("decodeSubjectPublicId rejects malformed ids", () => {
  assert.equal(decodeSubjectPublicId("nope_123"), null);
  assert.equal(decodeSubjectPublicId("sub_short"), null);
  assert.equal(decodeSubjectPublicId("sub_zzzz3344556677889aabbccddeeff00"), null);
});

test("metersBetween: zero distance + a known ~111km/deg latitude step", () => {
  assert.equal(metersBetween(40, -100, 40, -100), 0);
  const d = metersBetween(40, -100, 41, -100); // ~1 deg latitude
  assert.ok(Math.abs(d - 111195) < 500, `expected ~111km, got ${d}`);
});

test("fenceSignature is stable + sensitive to geometry, prefers geofence_ref", () => {
  const a = [{ place_id: "place_1", geofence_ref: "gf_1", center: { latitude: 40.123456, longitude: -100.654321 }, radius_m: 150 }];
  const b = [{ place_id: "place_1", geofence_ref: "gf_1", center: { latitude: 40.123459, longitude: -100.654321 }, radius_m: 150 }]; // <5dp change
  const c = [{ place_id: "place_1", geofence_ref: "gf_1", center: { latitude: 40.124000, longitude: -100.654321 }, radius_m: 150 }]; // >5dp change
  assert.equal(fenceSignature(a), fenceSignature(b), "sub-5dp jitter must not churn the signature");
  assert.notEqual(fenceSignature(a), fenceSignature(c), "a real move must change the signature");
  assert.ok(fenceSignature(a).startsWith("gf_1@"), "must key on geofence_ref when present");
});

test("zoneFor: AT PLACE <=50m, IN PERIMETER <=radius, OUTSIDE beyond, null fence => OUTSIDE", () => {
  const fence = { place_id: "p", geofence_ref: null, name: null, center: { latitude: 40, longitude: -100 }, radius_m: 150 };
  assert.equal(zoneFor({ lat: 40, lng: -100, accuracy: null, at: 0 }, fence), "AT PLACE");
  // ~100m north (between 50 and 150) => IN PERIMETER
  assert.equal(zoneFor({ lat: 40.0009, lng: -100, accuracy: null, at: 0 }, fence), "IN PERIMETER");
  // ~300m north => OUTSIDE
  assert.equal(zoneFor({ lat: 40.0027, lng: -100, accuracy: null, at: 0 }, fence), "OUTSIDE");
  assert.equal(zoneFor({ lat: 40, lng: -100, accuracy: null, at: 0 }, null), "OUTSIDE");
});

test("DEFAULT_DIRECTIVE matches the build-7 fallback (geofence, no stream, 15s)", () => {
  assert.deepEqual(DEFAULT_DIRECTIVE, {
    effective_mode: "geofence",
    stream_now: false,
    active_window: null,
    min_interval_s: 15,
  });
});
