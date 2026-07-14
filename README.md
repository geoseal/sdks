# Geoseal SDKs

Official mobile SDKs for [Geoseal](https://geoseal.dev) — verified presence as an API.

Geoseal confirms when a worker, patient, or asset actually arrived at and left a place using
server-side double-geofence verification (M-of-N sample agreement, not a single GPS ping),
and delivers confirmed facts as signed webhooks, an embeddable live view, and an MCP server
AI assistants can call directly.

## Packages

| Package | Platform | Install |
|---|---|---|
| [`@geoseal/capacitor`](https://www.npmjs.com/package/@geoseal/capacitor) | Capacitor (iOS + Android) | `npm i @geoseal/capacitor` |
| [`@geoseal/react-native`](https://www.npmjs.com/package/@geoseal/react-native) | React Native | `npm i @geoseal/react-native` |
| [`@geoseal/expo`](https://www.npmjs.com/package/@geoseal/expo) | Expo | `npm i @geoseal/expo` |
| [`@geoseal/cordova`](https://www.npmjs.com/package/@geoseal/cordova) | Cordova | `npm i @geoseal/cordova` |
| [`@geoseal/nativescript`](https://www.npmjs.com/package/@geoseal/nativescript) | NativeScript | `npm i @geoseal/nativescript` |
| [`@geoseal/react-views`](https://www.npmjs.com/package/@geoseal/react-views) | React (embeddable views) | `npm i @geoseal/react-views` |

iOS native core: `CheckpointCore` on CocoaPods — `pod 'CheckpointCore'` (zero-config; the wire protocol keeps its original Checkpoint name for compatibility).

> `@checkpoint-irl/*` packages are the deprecated previous names of the same SDKs — use `@geoseal/*`.

## Start here

- Docs: https://geoseal.dev/docs
- Quickstart: https://geoseal.dev/docs/quickstart
- For AI assistants: https://geoseal.dev/llms.txt · MCP manifest: https://geoseal.dev/server.json
- OpenAPI: https://geoseal.dev/openapi.json

## About this repository

This is the public source mirror for the published SDK packages; development happens in the
Geoseal platform monorepo and released sources are synced here per release. Issues and
questions are welcome here.
