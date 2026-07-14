package com.checkpoint.reactnative;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;

// org.json → React Native Writable* conversion for the diagnostics payload (the
// only place we hand a JSONObject built by the core's GeofenceStore.diagnostics()
// back to JS). Handles the nested `fences` array + `monitoredIds`.
final class JsonConvert {

  private JsonConvert() {}

  static WritableMap toWritableMap(JSONObject json) {
    WritableMap map = Arguments.createMap();
    Iterator<String> keys = json.keys();
    while (keys.hasNext()) {
      String key = keys.next();
      Object value = json.opt(key);
      if (value == null || value == JSONObject.NULL) {
        map.putNull(key);
      } else if (value instanceof JSONObject) {
        map.putMap(key, toWritableMap((JSONObject) value));
      } else if (value instanceof JSONArray) {
        map.putArray(key, toWritableArray((JSONArray) value));
      } else if (value instanceof Boolean) {
        map.putBoolean(key, (Boolean) value);
      } else if (value instanceof Integer) {
        map.putInt(key, (Integer) value);
      } else if (value instanceof Number) {
        map.putDouble(key, ((Number) value).doubleValue());
      } else {
        map.putString(key, value.toString());
      }
    }
    return map;
  }

  static WritableArray toWritableArray(JSONArray array) {
    WritableArray out = Arguments.createArray();
    for (int i = 0; i < array.length(); i++) {
      Object value = array.opt(i);
      if (value == null || value == JSONObject.NULL) {
        out.pushNull();
      } else if (value instanceof JSONObject) {
        out.pushMap(toWritableMap((JSONObject) value));
      } else if (value instanceof JSONArray) {
        out.pushArray(toWritableArray((JSONArray) value));
      } else if (value instanceof Boolean) {
        out.pushBoolean((Boolean) value);
      } else if (value instanceof Integer) {
        out.pushInt((Integer) value);
      } else if (value instanceof Number) {
        out.pushDouble(((Number) value).doubleValue());
      } else {
        out.pushString(value.toString());
      }
    }
    return out;
  }
}
