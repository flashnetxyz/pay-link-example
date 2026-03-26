/**
 * Minimal Flashnet Orchestration API client.
 *
 * All requests go through /api/proxy which injects the API key server-side,
 * keeping the secret out of the browser.
 */

const PROXY_BASE = "/api/proxy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiCall<T> {
  data: T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function apiCall<T>(opts: {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<ApiCall<T>> {
  let url = `${PROXY_BASE}${opts.path}`;
  if (opts.query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") sp.set(k, v);
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.method === "POST") {
    headers["X-Idempotency-Key"] = crypto.randomUUID();
  }

  const fetchOpts: RequestInit = {
    method: opts.method,
    headers,
    signal: opts.signal ?? null,
  };
  if (opts.body !== undefined) {
    fetchOpts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, fetchOpts);
  const responseBody: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    let code = "unknown";
    let message = `HTTP ${res.status}`;
    if (isRecord(responseBody)) {
      const nested = responseBody.error;
      if (isRecord(nested)) {
        code = typeof nested.code === "string" ? nested.code : code;
        message = typeof nested.message === "string" ? nested.message : message;
      } else {
        code = typeof responseBody.code === "string" ? responseBody.code : code;
        message = typeof responseBody.message === "string" ? responseBody.message : message;
      }
    }
    throw new ApiError(res.status, code, message);
  }

  return { data: responseBody as T };
}

// ---------------------------------------------------------------------------
// Orchestration endpoints
// ---------------------------------------------------------------------------

export function orchestrationEstimate(params: {
  sourceChain: string;
  sourceAsset: string;
  destinationChain: string;
  destinationAsset: string;
  amount: string;
  signal?: AbortSignal;
}) {
  const { signal, ...query } = params;
  return apiCall<{
    estimatedOut: string;
    feeAmount: string;
    feeBps: number;
    feeAsset: string;
    route: string[];
  }>({
    method: "GET",
    path: "/v1/orchestration/estimate",
    query,
    signal,
  });
}

export function orchestrationOnramp(params: {
  destinationChain: string;
  destinationAsset: string;
  recipientAddress: string;
  amount: string;
  amountMode?: "exact_in" | "exact_out";
  slippageBps?: number;
}) {
  return apiCall<{
    orderId: string;
    quoteId: string;
    depositAddress: string;
    paymentLinks: { cashApp: string; shortUrl?: string };
    amountIn: string;
    estimatedOut: string;
    feeAmount: string;
    feeBps: number;
    totalFeeAmount: string;
    feeAsset: string;
    route: string[];
    expiresAt: string;
  }>({
    method: "POST",
    path: "/v1/orchestration/onramp",
    body: params,
  });
}

export function orchestrationStatus(orderId: string) {
  return apiCall<{ order: Record<string, unknown>; stages: unknown[] }>({
    method: "GET",
    path: "/v1/orchestration/status",
    query: { id: orderId },
  });
}
