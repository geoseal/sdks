import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbedView } from "./types";

/**
 * The live Geoseal functions host. The public read route is
 *   {DEFAULT_BASE_URL}/v1-embed/embed/visits/{token}
 * Override via the `baseUrl` option / prop to target a different deployment.
 */
export const DEFAULT_BASE_URL = "https://ibnwfzwekqyfozquwpff.supabase.co/functions/v1";

export type EmbedViewErrorKind =
  | "expired" // 401/403 — link expired, revoked, or not enabled
  | "not_found" // 404 — no such view for this token
  | "server" // 5xx
  | "network" // fetch failed / offline
  | "unknown"; // anything else (incl. a missing token)

export interface EmbedViewError {
  kind: EmbedViewErrorKind;
  /** HTTP status, or null for a transport-level failure. */
  status: number | null;
  message: string;
}

export interface UseEmbedViewOptions {
  /** Functions host. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Poll for updates while the visit is live. Default: false (fetch once). */
  live?: boolean;
  /** Poll cadence in seconds when `live`. Default: 15. */
  pollIntervalSeconds?: number;
}

export interface UseEmbedViewResult {
  data: EmbedView | null;
  loading: boolean;
  error: EmbedViewError | null;
  /** Force an immediate re-fetch. */
  refetch: () => void;
}

function buildUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/v1-embed/embed/visits/${encodeURIComponent(token)}`;
}

function httpError(status: number): EmbedViewError {
  if (status === 401 || status === 403) {
    return {
      kind: "expired",
      status,
      message: "This view link has expired or been revoked.",
    };
  }
  if (status === 404) {
    return { kind: "not_found", status, message: "This view could not be found." };
  }
  if (status >= 500) {
    return { kind: "server", status, message: "Geoseal is temporarily unavailable." };
  }
  return { kind: "unknown", status, message: `Unexpected response (${status}).` };
}

/**
 * Fetch a Geoseal Views embed payload from the public read route, with
 * loading/error state and optional polling while the visit is live.
 *
 * Polling stops automatically once the payload reports `live: false`.
 */
export function useEmbedView(
  token: string,
  options: UseEmbedViewOptions = {},
): UseEmbedViewResult {
  const { baseUrl = DEFAULT_BASE_URL, live = false, pollIntervalSeconds = 15 } = options;

  const [data, setData] = useState<EmbedView | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<EmbedViewError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);
  const stillLiveRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    if (!token) {
      setLoading(false);
      setError({ kind: "unknown", status: null, message: "A view token is required." });
      return;
    }

    // Cancel any in-flight request; only the newest fetch may write state.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    // Keep any already-rendered view on screen while a poll refresh is in flight.
    if (!hasDataRef.current) setLoading(true);

    try {
      const res = await fetch(buildUrl(baseUrl, token), {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (controller.signal.aborted) return;

      if (!res.ok) {
        setError(httpError(res.status));
        setData(null);
        hasDataRef.current = false;
        stillLiveRef.current = false;
        return;
      }

      const json = (await res.json()) as EmbedView;
      if (controller.signal.aborted) return;
      setData(json);
      setError(null);
      hasDataRef.current = true;
      stillLiveRef.current = json?.live === true;
    } catch (err) {
      if (controller.signal.aborted) return;
      setError({
        kind: "network",
        status: null,
        message: err instanceof Error ? err.message : "Network request failed.",
      });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [token, baseUrl]);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    hasDataRef.current = false;
    stillLiveRef.current = true;
    void load();

    let timer: ReturnType<typeof setInterval> | undefined;
    if (live && pollIntervalSeconds > 0) {
      timer = setInterval(() => {
        // Once the visit closes, there is nothing left to poll for.
        if (!stillLiveRef.current) {
          if (timer) clearInterval(timer);
          return;
        }
        void load();
      }, pollIntervalSeconds * 1000);
    }

    return () => {
      controllerRef.current?.abort();
      if (timer) clearInterval(timer);
    };
  }, [load, live, pollIntervalSeconds, reloadKey]);

  return { data, loading, error, refetch };
}
