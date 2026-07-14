import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import mapboxgl from "mapbox-gl";
import { DEFAULT_BASE_URL, useEmbedView, type EmbedViewError } from "./useEmbedView";
import type { EmbedCloseout, EmbedPlace, EmbedTrackPoint, EmbedView } from "./types";

// ---------------------------------------------------------------------------
// Presence palette (shared with the console + native SDKs) and theming.
// ---------------------------------------------------------------------------

const PRESENCE = {
  verified: "#22C55E", // emerald — confirmed on-site
  arriving: "#F5A524", // amber   — approaching / entered perimeter
  traveling: "#38BDF8", // sky     — moving / departing
  stale: "#64748B", // slate   — no signal / closed
  alert: "#FB4E6D", // rose    — outage / anomaly
} as const;

const SEAL_TEAL = "#17C99A";

export type GeosealTheme = "dark" | "light";

interface Palette {
  bg: string;
  panel: string;
  panelAlt: string;
  border: string;
  text: string;
  textMuted: string;
  mapStyle: string;
}

const THEMES: Record<GeosealTheme, Palette> = {
  dark: {
    bg: "#0B0F14",
    panel: "#0F151C",
    panelAlt: "#131C26",
    border: "#1E2A36",
    text: "#E6EDF3",
    textMuted: "#8B9AAB",
    mapStyle: "mapbox://styles/mapbox/dark-v11",
  },
  light: {
    bg: "#FFFFFF",
    panel: "#F7FAFC",
    panelAlt: "#EDF2F7",
    border: "#DCE3EA",
    text: "#0F1A24",
    textMuted: "#5A6B7B",
    mapStyle: "mapbox://styles/mapbox/light-v11",
  },
};

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// ---------------------------------------------------------------------------
// Runtime style injection — keeps the package free of a CSS-loader dependency.
// (Mirrors src/styles.css, which consumers may import instead if they prefer.)
// ---------------------------------------------------------------------------

const STYLE_ID = "geoseal-react-views-styles";
const STYLE_TEXT = `
@keyframes gsv-spin { to { transform: rotate(360deg); } }
@keyframes gsv-ping { 0% { transform: scale(0.6); opacity: 0.7; } 80%,100% { transform: scale(2.4); opacity: 0; } }
@keyframes gsv-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.gsv-spin { animation: gsv-spin 0.9s linear infinite; }
.gsv-ping { animation: gsv-ping 2s cubic-bezier(0,0,0.2,1) infinite; }
.gsv-blink { animation: gsv-blink 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .gsv-spin, .gsv-ping, .gsv-blink { animation: none !important; }
}
`;

function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Formatting + presence helpers.
// ---------------------------------------------------------------------------

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function humanizeEvent(type: string): string {
  const leaf = type.includes(".") ? type.slice(type.lastIndexOf(".") + 1) : type;
  const known: Record<string, string> = {
    arrived: "Arrived",
    entered: "Entered",
    dwell: "On-site (verified)",
    present: "On-site (verified)",
    departed: "Departed",
    exited: "Departed",
  };
  if (known[leaf]) return known[leaf];
  const spaced = leaf.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function presenceColor(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("outage") || t.includes("gap") || t.includes("lost") || t.includes("alert")) {
    return PRESENCE.alert;
  }
  if (t.includes("arriv") || t.includes("enter")) return PRESENCE.arriving;
  if (t.includes("dwell") || t.includes("present")) return PRESENCE.verified;
  if (t.includes("depart") || t.includes("exit") || t.includes("left")) return PRESENCE.traveling;
  return PRESENCE.stale;
}

// ---------------------------------------------------------------------------
// Map geometry helpers.
// ---------------------------------------------------------------------------

/** A GeoJSON polygon approximating a circle of `radiusM` metres around a point. */
function circlePolygon(
  lng: number,
  lat: number,
  radiusM: number,
  ring: "inner" | "outer",
  points = 64,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const coords: GeoJSON.Position[] = [];
  const latR = (Math.PI / 180) * lat;
  const dLat = radiusM / 110574; // metres per degree latitude
  const dLng = radiusM / (111320 * Math.cos(latR) || 1); // per degree longitude at this lat
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    coords.push([lng + dLng * Math.cos(theta), lat + dLat * Math.sin(theta)]);
  }
  return {
    type: "Feature",
    properties: { ring },
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}

function boundingCorners(
  lng: number,
  lat: number,
  radiusM: number,
): [number, number][] {
  const latR = (Math.PI / 180) * lat;
  const dLat = radiusM / 110574;
  const dLng = radiusM / (111320 * Math.cos(latR) || 1);
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat + dLat],
  ];
}

function markerColorFor(live: boolean, verified: boolean): string {
  if (!live) return PRESENCE.stale;
  return verified ? PRESENCE.verified : PRESENCE.arriving;
}

function buildMarkerEl(color: string, animate: boolean): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.style.position = "relative";
  wrap.style.width = "16px";
  wrap.style.height = "16px";

  if (animate) {
    const ring = document.createElement("div");
    ring.className = "gsv-ping";
    Object.assign(ring.style, {
      position: "absolute",
      inset: "0",
      borderRadius: "50%",
      background: color,
      opacity: "0.6",
    });
    wrap.appendChild(ring);
  }

  const dot = document.createElement("div");
  Object.assign(dot.style, {
    position: "absolute",
    inset: "0",
    borderRadius: "50%",
    background: color,
    border: "2px solid rgba(255,255,255,0.9)",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
  });
  wrap.appendChild(dot);
  return wrap;
}

// ---------------------------------------------------------------------------
// MapView — owns the mapbox-gl lifecycle.
// ---------------------------------------------------------------------------

interface MapViewProps {
  mapboxToken: string;
  place: EmbedPlace | null;
  track: EmbedTrackPoint[];
  live: boolean;
  verified: boolean;
  palette: Palette;
  reducedMotion: boolean;
}

function MapView({
  mapboxToken,
  place,
  track,
  live,
  verified,
  palette,
  reducedMotion,
}: MapViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const markerColorRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const fittedRef = useRef(false);
  const latestRef = useRef({ place, track, live, verified });
  latestRef.current = { place, track, live, verified };

  const renderRef = useRef<() => void>(() => {});
  renderRef.current = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const { place: p, track: tr, live: lv, verified: vf } = latestRef.current;

    // Fence rings.
    const fenceFeatures: GeoJSON.Feature[] = [];
    if (p) {
      fenceFeatures.push(circlePolygon(p.lng, p.lat, p.perimeter_radius_m, "outer"));
      fenceFeatures.push(circlePolygon(p.lng, p.lat, p.facility_radius_m, "inner"));
    }
    const fenceData: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: fenceFeatures,
    };
    const fenceSrc = map.getSource("gsv-fences") as mapboxgl.GeoJSONSource | undefined;
    if (fenceSrc) fenceSrc.setData(fenceData);
    else map.addSource("gsv-fences", { type: "geojson", data: fenceData });

    if (!map.getLayer("gsv-fences-fill")) {
      map.addLayer({
        id: "gsv-fences-fill",
        type: "fill",
        source: "gsv-fences",
        paint: {
          "fill-color": ["match", ["get", "ring"], "inner", PRESENCE.verified, SEAL_TEAL] as mapboxgl.Expression,
          "fill-opacity": ["match", ["get", "ring"], "inner", 0.16, 0.07] as mapboxgl.Expression,
        },
      });
    }
    if (!map.getLayer("gsv-fences-line")) {
      map.addLayer({
        id: "gsv-fences-line",
        type: "line",
        source: "gsv-fences",
        paint: {
          "line-color": ["match", ["get", "ring"], "inner", PRESENCE.verified, SEAL_TEAL] as mapboxgl.Expression,
          "line-width": 1.5,
          "line-opacity": 0.85,
        },
      });
    }

    // Track line.
    const coords: GeoJSON.Position[] = tr.map((pt) => [pt.lng, pt.lat]);
    const trackData: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features:
        coords.length >= 2
          ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }]
          : [],
    };
    const trackSrc = map.getSource("gsv-track") as mapboxgl.GeoJSONSource | undefined;
    if (trackSrc) trackSrc.setData(trackData);
    else map.addSource("gsv-track", { type: "geojson", data: trackData });
    if (!map.getLayer("gsv-track-line")) {
      map.addLayer({
        id: "gsv-track-line",
        type: "line",
        source: "gsv-track",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": PRESENCE.traveling, "line-width": 3, "line-opacity": 0.9 },
      });
    }

    // Latest-position marker.
    const last = tr.length > 0 ? tr[tr.length - 1] : null;
    const color = markerColorFor(lv, vf);
    if (last) {
      if (markerRef.current && markerColorRef.current !== color) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      if (!markerRef.current) {
        markerRef.current = new mapboxgl.Marker({
          element: buildMarkerEl(color, lv && !reducedMotion),
        });
        markerColorRef.current = color;
      }
      markerRef.current.setLngLat([last.lng, last.lat]).addTo(map);
    } else if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
      markerColorRef.current = null;
    }

    // Fit to content once.
    if (!fittedRef.current) {
      const bounds = new mapboxgl.LngLatBounds();
      let has = false;
      if (p) {
        for (const corner of boundingCorners(p.lng, p.lat, p.perimeter_radius_m)) {
          bounds.extend(corner);
          has = true;
        }
      }
      for (const c of coords) {
        bounds.extend(c as [number, number]);
        has = true;
      }
      if (has) {
        map.fitBounds(bounds, {
          padding: 44,
          maxZoom: 17,
          animate: !reducedMotion,
          duration: reducedMotion ? 0 : 600,
        });
        fittedRef.current = true;
      }
    }
  };

  // (Re)create the map when the token or basemap style changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    mapboxgl.accessToken = mapboxToken;
    const initial = place
      ? ([place.lng, place.lat] as [number, number])
      : track.length > 0
        ? ([track[0].lng, track[0].lat] as [number, number])
        : ([-122.4194, 37.7749] as [number, number]);

    const map = new mapboxgl.Map({
      container,
      style: palette.mapStyle,
      center: initial,
      zoom: 13,
      attributionControl: true,
    });
    mapRef.current = map;
    loadedRef.current = false;
    fittedRef.current = false;
    markerColorRef.current = null;

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    const onLoad = () => {
      loadedRef.current = true;
      renderRef.current();
    };
    map.on("load", onLoad);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapboxToken, palette.mapStyle]);

  // Push data updates (live polling) into the existing map.
  useEffect(() => {
    renderRef.current();
  }, [place, track, live, verified]);

  return (
    <div
      ref={containerRef}
      aria-label="Map of the worker location and geofence"
      role="img"
      style={{ position: "absolute", inset: 0 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Presentation subcomponents.
// ---------------------------------------------------------------------------

function Badge({ children, color }: { children: ReactNode; color: string }): JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        padding: "3px 8px",
        borderRadius: 999,
        color,
        background: `${color}1F`,
        border: `1px solid ${color}55`,
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
}

interface TimelineItem {
  at: string;
  color: string;
  label: string;
  detail?: string;
}

function buildTimeline(view: EmbedView): TimelineItem[] {
  const items: TimelineItem[] = view.timeline.map((e) => ({
    at: e.at,
    color: presenceColor(e.type),
    label: humanizeEvent(e.type),
  }));
  for (const o of view.outages) {
    const recovered = o.resolved_at ? `recovered ${formatTime(o.resolved_at)}` : "ongoing";
    items.push({
      at: o.started_at,
      color: PRESENCE.alert,
      label: `Signal outage — ${o.reason}`,
      detail: `${o.severity} · ${recovered}`,
    });
  }
  items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return items;
}

function Timeline({ items, palette }: { items: TimelineItem[]; palette: Palette }): JSX.Element {
  if (items.length === 0) {
    return (
      <p style={{ margin: 0, color: palette.textMuted, fontSize: 13 }}>
        No timeline events yet.
      </p>
    );
  }
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}>
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <li key={`${item.at}-${i}`} style={{ display: "flex", gap: 12, position: "relative" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                flex: "0 0 auto",
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: item.color,
                  boxShadow: `0 0 0 3px ${item.color}33`,
                  marginTop: 3,
                }}
              />
              {!isLast && (
                <span
                  style={{
                    width: 2,
                    flex: 1,
                    minHeight: 22,
                    background: palette.border,
                    marginTop: 2,
                  }}
                />
              )}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: palette.text, lineHeight: 1.3 }}>
                {item.label}
              </div>
              <div style={{ fontSize: 12, color: palette.textMuted, marginTop: 1 }}>
                {formatTime(item.at)}
                {item.detail ? ` · ${item.detail}` : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function confidenceChips(confidence: Record<string, unknown>): { k: string; v: string }[] {
  return Object.entries(confidence)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => ({ k, v: String(v) }));
}

function CloseoutCard({
  closeout,
  palette,
}: {
  closeout: EmbedCloseout;
  palette: Palette;
}): JSX.Element {
  const chips = confidenceChips(closeout.confidence ?? {});
  const redacted = closeout.redacted === true || !closeout.summary;
  return (
    <div
      style={{
        background: palette.panelAlt,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: SEAL_TEAL,
        }}
      >
        <span aria-hidden>✦</span> AI Closeout
      </div>
      {redacted ? (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: palette.textMuted, lineHeight: 1.5 }}>
          Summary withheld — worker names are not enabled for this view. The structured
          confidence signals are shown below.
        </p>
      ) : (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: palette.text, lineHeight: 1.55 }}>
          {closeout.summary}
        </p>
      )}
      {chips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {chips.map((c) => (
            <span
              key={c.k}
              style={{
                fontSize: 11,
                color: palette.textMuted,
                background: palette.panel,
                border: `1px solid ${palette.border}`,
                borderRadius: 6,
                padding: "2px 7px",
              }}
            >
              <strong style={{ color: palette.text, fontWeight: 600 }}>{c.k}</strong> {c.v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Spinner({ palette }: { palette: Palette }): JSX.Element {
  return (
    <span
      className="gsv-spin"
      aria-hidden
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        border: `2.5px solid ${palette.border}`,
        borderTopColor: SEAL_TEAL,
        display: "inline-block",
      }}
    />
  );
}

function Centered({
  palette,
  height,
  children,
}: {
  palette: Palette;
  height: number | string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        height,
        padding: 24,
        textAlign: "center",
        background: palette.bg,
        color: palette.text,
        border: `1px solid ${palette.border}`,
        borderRadius: 14,
        fontFamily: FONT_STACK,
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GeosealVisit — the flagship embeddable component.
// ---------------------------------------------------------------------------

export interface GeosealVisitProps {
  /** The Geoseal Views embed token (etok_...) minted via POST /v1-embed/embed/tokens. */
  token: string;
  /** Functions host. Defaults to the live Geoseal deployment. */
  baseUrl?: string;
  /** Poll for live updates while the visit is open. Default: false. */
  live?: boolean;
  /** Poll cadence in seconds when `live`. Default: 15. */
  pollIntervalSeconds?: number;
  /** Overall height of the view. Default: 520. */
  height?: number | string;
  /** Visual theme. Default: "dark". */
  theme?: GeosealTheme;
  /** Extra class on the root element. */
  className?: string;
  /** Extra inline styles merged onto the root element. */
  style?: CSSProperties;
}

export function GeosealVisit({
  token,
  baseUrl = DEFAULT_BASE_URL,
  live = false,
  pollIntervalSeconds = 15,
  height = 520,
  theme = "dark",
  className,
  style,
}: GeosealVisitProps): JSX.Element {
  useEffect(() => {
    ensureStyles();
  }, []);

  const palette = THEMES[theme] ?? THEMES.dark;
  const reducedMotion = usePrefersReducedMotion();
  const { data, loading, error, refetch } = useEmbedView(token, {
    baseUrl,
    live,
    pollIntervalSeconds,
  });

  const timeline = useMemo(() => (data ? buildTimeline(data) : []), [data]);

  // ---- Loading (first paint, no data yet) ----
  if (loading && !data) {
    return (
      <Centered palette={palette} height={height}>
        <Spinner palette={palette} />
        <span style={{ fontSize: 13, color: palette.textMuted }}>Loading view…</span>
      </Centered>
    );
  }

  // ---- Error ----
  if (error && !data) {
    return <ErrorState error={error} palette={palette} height={height} onRetry={refetch} />;
  }

  if (!data) {
    return (
      <Centered palette={palette} height={height}>
        <span style={{ fontSize: 13, color: palette.textMuted }}>No view data.</span>
      </Centered>
    );
  }

  const { visit, place, subject } = data;
  const hasMap = !!data.mapbox_token && (!!place || data.track.length > 0);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexWrap: "wrap",
        height,
        overflow: "hidden",
        background: palette.bg,
        color: palette.text,
        border: `1px solid ${palette.border}`,
        borderRadius: 14,
        fontFamily: FONT_STACK,
        boxSizing: "border-box",
        ...style,
      }}
    >
      {/* Map region */}
      <div
        style={{
          position: "relative",
          flex: "2 1 320px",
          minWidth: 260,
          minHeight: 240,
          background: palette.panelAlt,
        }}
      >
        {hasMap && data.mapbox_token ? (
          <MapView
            mapboxToken={data.mapbox_token}
            place={place}
            track={data.track}
            live={data.live}
            verified={visit.verified}
            palette={palette}
            reducedMotion={reducedMotion}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
              textAlign: "center",
              fontSize: 13,
              color: palette.textMuted,
            }}
          >
            {data.mapbox_token ? "No location data for this visit yet." : "Map unavailable."}
          </div>
        )}
      </div>

      {/* Side panel */}
      <div
        style={{
          flex: "1 1 280px",
          minWidth: 240,
          display: "flex",
          flexDirection: "column",
          borderLeft: `1px solid ${palette.border}`,
          background: palette.panel,
          overflowY: "auto",
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${palette.border}` }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {data.live && (
              <Badge color={SEAL_TEAL}>
                <span
                  className="gsv-blink"
                  aria-hidden
                  style={{ width: 7, height: 7, borderRadius: "50%", background: SEAL_TEAL }}
                />
                Live
              </Badge>
            )}
            {visit.verified && <Badge color={PRESENCE.verified}>Verified</Badge>}
            <Badge color={visit.status === "open" ? PRESENCE.verified : PRESENCE.stale}>
              {visit.status}
            </Badge>
          </div>
          <div style={{ marginTop: 10, fontSize: 16, fontWeight: 700, color: palette.text }}>
            {place?.name ?? "Location"}
          </div>
          <div style={{ marginTop: 2, fontSize: 13, color: palette.textMuted }}>
            {subject.handle}
            {subject.status ? ` · ${subject.status}` : ""}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: palette.textMuted }}>
            {formatTime(visit.entered_at)} → {formatTime(visit.exited_at)}
            {visit.duration_minutes != null ? ` · ${formatDuration(visit.duration_minutes)}` : ""}
          </div>
        </div>

        {/* Timeline + closeout */}
        <div
          style={{
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            flex: 1,
          }}
        >
          <div>
            <SectionTitle palette={palette}>Timeline</SectionTitle>
            <Timeline items={timeline} palette={palette} />
          </div>
          {data.closeout && <CloseoutCard closeout={data.closeout} palette={palette} />}
        </div>

        <div
          style={{
            padding: "8px 16px",
            borderTop: `1px solid ${palette.border}`,
            fontSize: 10,
            letterSpacing: 0.4,
            color: palette.textMuted,
            textTransform: "uppercase",
          }}
        >
          Secured by Geoseal
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  children,
  palette,
}: {
  children: ReactNode;
  palette: Palette;
}): JSX.Element {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color: palette.textMuted,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function ErrorState({
  error,
  palette,
  height,
  onRetry,
}: {
  error: EmbedViewError;
  palette: Palette;
  height: number | string;
  onRetry: () => void;
}): JSX.Element {
  const expiredOrGone = error.kind === "expired" || error.kind === "not_found";
  const canRetry = error.kind === "network" || error.kind === "server";
  return (
    <Centered palette={palette} height={height}>
      <div
        aria-hidden
        style={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          color: expiredOrGone ? PRESENCE.stale : PRESENCE.alert,
          background: `${expiredOrGone ? PRESENCE.stale : PRESENCE.alert}22`,
        }}
      >
        {expiredOrGone ? "⧗" : "!"}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: palette.text }}>
        {expiredOrGone ? "This view is no longer available" : "Couldn’t load this view"}
      </div>
      <div style={{ fontSize: 13, color: palette.textMuted, maxWidth: 320 }}>{error.message}</div>
      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 4,
            fontSize: 13,
            fontWeight: 600,
            color: "#04120D",
            background: SEAL_TEAL,
            border: "none",
            borderRadius: 8,
            padding: "8px 16px",
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      )}
    </Centered>
  );
}
