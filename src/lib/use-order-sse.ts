"use client";

import { useEffect, useRef, useState } from "react";

const TERMINAL_STATUSES = new Set(["completed", "failed", "refunded"]);

interface UseOrderSSEParams {
  orderId: string;
  readToken: string;
  onStatus: (status: string) => void;
  enabled?: boolean;
}

/**
 * Connects to the Flashnet SSE stream for real-time order status updates.
 * Uses the /api/proxy route so the API key stays server-side.
 */
export function useOrderSSE({
  orderId,
  readToken,
  onStatus,
  enabled = true,
}: UseOrderSSEParams): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!enabled || !orderId || !readToken) return;

    const url = `/api/proxy/v1/sse/operations/${encodeURIComponent(orderId)}?${new URLSearchParams({ readToken })}`;
    const es = new EventSource(url);

    es.addEventListener("status", (e) => {
      try {
        const data = JSON.parse(e.data) as { status: string };
        onStatusRef.current(data.status);
        if (TERMINAL_STATUSES.has(data.status)) {
          es.close();
          setConnected(false);
        }
      } catch {
        // ignore malformed events
      }
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      setConnected(false);
    };
  }, [orderId, readToken, enabled]);

  return { connected };
}
