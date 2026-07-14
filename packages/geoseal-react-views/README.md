# @geoseal/react-views

Drop-in React component for a **live Geoseal shift + location view** — a Mapbox
map with the facility's two geofence rings, the worker's location track, a
verified-presence event timeline, and the AI closeout summary — rendered from a
single [Geoseal Views](https://geoseal.dev) embed token.

This is Geoseal's answer to HyperTrack's `hypertrack-views-react` `LiveView`,
built on Geoseal's signed, single-visit, de-identified embed tokens.

> **New — v0.1.0.** This package is brand new. It renders the payload from the
> live `v1-embed` backend and depends on a **Geoseal Views embed token**
> (`etok_…`) that you mint server-side (see [Mint a token](#mint-a-token)).
> Geoseal Views must be enabled for your App
> (`settings.embed_views_enabled = true`, off by default).

## Install

```bash
npm install @geoseal/react-views mapbox-gl
# react and react-dom (>=18) are peer dependencies you already have
```

`mapbox-gl` is a peer dependency — the component uses the publishable Mapbox
token returned inside the view payload, so you do not configure Mapbox yourself.

## Usage

```tsx
import { GeosealVisit } from "@geoseal/react-views";

export function ShiftPanel({ etok }: { etok: string }) {
  return <GeosealVisit token={etok} live height={520} theme="dark" />;
}
```

That is the whole integration: pass the `etok_…` token, get a live view.

### Props

| Prop                  | Type                    | Default             | Notes                                                        |
| --------------------- | ----------------------- | ------------------- | ------------------------------------------------------------ |
| `token`               | `string`                | —                   | **Required.** The `etok_…` Geoseal Views token.              |
| `baseUrl`             | `string`                | live functions host | Override to target a different Geoseal deployment.           |
| `live`                | `boolean`               | `false`             | Poll for updates while the visit is open.                    |
| `pollIntervalSeconds` | `number`                | `15`                | Poll cadence when `live`. Stops automatically once closed.   |
| `height`              | `number \| string`      | `520`               | Overall height of the view.                                  |
| `theme`               | `'dark' \| 'light'`     | `'dark'`            | Dark-first; both honor `prefers-reduced-motion`.             |
| `className` / `style` | —                       | —                   | Applied to the root element.                                 |

### The `useEmbedView` hook

Render it yourself if you don't want the built-in UI:

```tsx
import { useEmbedView } from "@geoseal/react-views";

const { data, loading, error, refetch } = useEmbedView(etok, { live: true });
// data is a fully-typed EmbedView (or null); error.kind tells you why (expired,
// not_found, network, server).
```

## The iframe alternative

If you don't want a React dependency at all, embed the hosted page directly. It
consumes the exact same payload:

```html
<iframe
  src="https://geoseal.dev/embed/visit/etok_…"
  width="100%"
  height="520"
  style="border:0;border-radius:12px"
  loading="lazy"
  referrerpolicy="no-referrer"
  title="Geoseal — live shift"
></iframe>
```

## Mint a token

A view token authorizes exactly **one visit**, is time-boxed and revocable, and
carries no other account access. Mint it server-side with your **secret key**
(`sk_`, never in the browser):

```bash
curl -X POST https://ibnwfzwekqyfozquwpff.supabase.co/functions/v1/v1-embed/embed/tokens \
  -H "Authorization: Bearer sk_live_…" \
  -H "Content-Type: application/json" \
  -d '{ "visit_id": "vis_…", "ttl_seconds": 3600, "live": true }'
# -> { "token": "etok_…", "embed_url": "https://geoseal.dev/embed/visit/etok_…", "expires_at": "…" }
```

Hand the returned `token` to `<GeosealVisit token={…} />`. To kill a live link,
revoke the token server-side and the next load fails closed.

Full reference: [`docs/embed-views.md`](https://github.com/geoseal/sdks/blob/main/docs/embed-views.md).

## What it renders

The component fetches `GET {baseUrl}/v1-embed/embed/visits/{token}` (public, no
auth) and shows:

- **Map** — the facility with its `facility_radius_m` (inner) and
  `perimeter_radius_m` (outer) geofence rings, the worker's track as a line, and
  a marker at the latest fix (pulsing while live).
- **Timeline** — arrival → dwell → departure using the Geoseal presence colors,
  with any tracking outages folded in.
- **AI closeout** — the closeout summary card when present. When the tenant has
  not opted into names, the narrative is withheld and only the structured
  confidence is shown (`closeout.redacted`).

Graceful **loading**, **error**, and **expired / revoked** states are built in.

## License

Apache-2.0
