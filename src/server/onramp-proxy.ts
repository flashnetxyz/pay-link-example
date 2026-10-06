/** The public demo has only these capabilities; never forward arbitrary paths. */
interface ProxyConfig {
  apiKey: string;
  baseUrl: string;
}

const PREFIX = "/api/proxy";
const ESTIMATE = "/v1/orchestration/estimate";
const ONRAMP = "/v1/orchestration/onramp";
const STATUS = "/v1/orchestration/status";
const ORDER_ID = /^ord_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SSE = /^\/v1\/sse\/operations\/(ord_[0-9a-f-]+)$/i;
const AMOUNT = /^[1-9][0-9]{0,19}$/;
const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

function validQuery(query: URLSearchParams, keys: readonly string[]): boolean {
  return [...query.keys()].every((key) => keys.includes(key) && query.getAll(key).length === 1);
}

function validReadToken(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= 4096 && /^[A-Za-z0-9_.-]+$/.test(value);
}

async function readJson(body: ReadableStream<Uint8Array> | null, limit: number): Promise<unknown> {
  if (!body) throw new Error("Missing body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Body too large");
      chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => {});
    throw cause;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createOnrampProxy(config: ProxyConfig, fetchUpstream: typeof fetch = fetch) {
  return async function proxyRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(PREFIX + "/") ? url.pathname.slice(PREFIX.length) : "";
    const sseMatch = path.match(SSE);
    const isSSE = sseMatch !== null && ORDER_ID.test(sseMatch[1]);
    const isGet = req.method === "GET" && (path === ESTIMATE || path === STATUS || isSSE);
    const isPost = req.method === "POST" && path === ONRAMP;
    // Match the normalized pathname exactly, before attaching any credential.
    if (!isGet && !isPost) return error(404, "not_found", "Route not available");

    // A full partner key grants admin authority. Fail closed on old deployments' config.
    if (!/^fnp_[A-Za-z0-9_-]+$/.test(config.apiKey)) {
      return error(503, "invalid_proxy_configuration", "Onramp is unavailable");
    }
    let upstream: URL;
    try {
      upstream = new URL(config.baseUrl);
      if (upstream.protocol !== "https:" || upstream.username || upstream.password ||
          upstream.pathname !== "/" || upstream.search || upstream.hash) throw new Error("Invalid base URL");
    } catch {
      return error(503, "invalid_proxy_configuration", "Onramp is unavailable");
    }
    // Construct from the selected route, never from a caller-supplied URL or host.
    upstream.pathname = path;
    const headers = new Headers({ Authorization: `Bearer ${config.apiKey}` });
    let body: string | undefined;

    if (path === ESTIMATE) {
      if (!validQuery(url.searchParams, ["sourceChain", "sourceAsset", "destinationChain", "destinationAsset", "amount"]) ||
          url.searchParams.get("sourceChain") !== "lightning" || url.searchParams.get("sourceAsset") !== "BTC" ||
          url.searchParams.get("destinationChain") !== "solana" || url.searchParams.get("destinationAsset") !== "USDC" ||
          !AMOUNT.test(url.searchParams.get("amount") ?? "")) {
        return error(400, "invalid_request", "Invalid estimate parameters");
      }
      upstream.search = url.search;
    } else if (path === STATUS || isSSE) {
      const allowed = isSSE ? ["readToken"] : ["id", "readToken"];
      const id = isSSE ? sseMatch![1] : url.searchParams.get("id") ?? "";
      const readToken = url.searchParams.get("readToken");
      if (!validQuery(url.searchParams, allowed) || !ORDER_ID.test(id)) {
        return error(400, "invalid_request", "Invalid status parameters");
      }
      if (!validReadToken(readToken)) return error(403, "read_token_required", "A read token is required");
      // Orchestra verifies the signature, expiry, key and order binding before returning data.
      headers.set("X-Read-Token", readToken);
      headers.set("X-Flashnet-Proxy-Read", "1");
      if (isSSE) {
        upstream.searchParams.set("token", config.apiKey);
        upstream.searchParams.set("readToken", readToken);
      } else {
        upstream.searchParams.set("id", id);
      }
    } else {
      if (url.search || req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return error(400, "invalid_request", "Expected a JSON onramp request");
      }
      let input: unknown;
      try { input = await readJson(req.body, 4096); } catch {
        return error(400, "invalid_request", "Invalid onramp body");
      }
      const allowed = ["destinationChain", "destinationAsset", "recipientAddress", "amount", "amountMode", "slippageBps"];
      if (!isRecord(input) || Object.keys(input).some((key) => !allowed.includes(key)) ||
          input.destinationChain !== "solana" || input.destinationAsset !== "USDC" ||
          typeof input.recipientAddress !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.recipientAddress) ||
          typeof input.amount !== "string" || !AMOUNT.test(input.amount) ||
          (input.amountMode !== undefined && input.amountMode !== "exact_out") ||
          (input.slippageBps !== undefined && (!Number.isInteger(input.slippageBps) ||
            Number(input.slippageBps) < 0 || Number(input.slippageBps) > 10000))) {
        return error(400, "invalid_request", "Invalid onramp parameters");
      }
      const idempotencyKey = req.headers.get("x-idempotency-key");
      if (!idempotencyKey || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) {
        return error(400, "invalid_request", "An idempotency key is required");
      }
      headers.set("Content-Type", "application/json");
      headers.set("X-Idempotency-Key", idempotencyKey);
      body = JSON.stringify({ ...input, amountMode: "exact_out" });
    }

    let response: Response;
    try {
      response = await fetchUpstream(upstream, {
        method: req.method, headers, body, signal: req.signal,
        redirect: "manual", cache: "no-store",
      });
    } catch {
      // Fetch errors can contain the upstream SSE URL (and its credential).
      return error(502, "upstream_unavailable", "Onramp service is unavailable");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return error(502, "upstream_unavailable", "Unexpected upstream response");
    }
    if (isSSE && response.ok && response.body &&
        response.headers.get("content-type")?.split(";")[0] === "text/event-stream") {
      return new Response(response.body, { headers: { ...NO_STORE, "Content-Type": "text/event-stream" } });
    }
    if (!response.ok) {
      await response.body?.cancel();
      return error(response.status >= 400 && response.status < 500 ? response.status : 502,
        "upstream_rejected", "The request could not be completed");
    }
    let data: unknown;
    try { data = await readJson(response.body, 65536); } catch {
      return error(502, "invalid_upstream_response", "Unexpected upstream response");
    }
    if (!isRecord(data) || isSSE) return error(502, "invalid_upstream_response", "Unexpected upstream response");
    if (path === STATUS) {
      if (!isRecord(data.order) || typeof data.order.status !== "string") {
        return error(502, "invalid_upstream_response", "Unexpected upstream response");
      }
      return Response.json({ order: { status: data.order.status } }, { headers: NO_STORE });
    }
    if (path === ONRAMP && (typeof data.orderId !== "string" || !ORDER_ID.test(data.orderId) ||
        !validReadToken(typeof data.readToken === "string" ? data.readToken : null))) {
      return error(502, "invalid_upstream_response", "Unexpected upstream response");
    }
    if (path === ONRAMP && response.status === 202) {
      if (typeof data.status !== "string") {
        return error(502, "invalid_upstream_response", "Unexpected upstream response");
      }
      return Response.json({ orderId: data.orderId, readToken: data.readToken, status: data.status },
        { status: 202, headers: NO_STORE });
    }
    const fields = path === ONRAMP
      ? ["orderId", "quoteId", "readToken", "depositAddress", "paymentLinks", "amountIn", "estimatedOut", "feeAmount", "feeBps", "totalFeeAmount", "feeAsset", "route", "expiresAt"]
      : ["estimatedOut", "feeAmount", "feeBps", "feeAsset", "route"];
    return Response.json(Object.fromEntries(fields.filter((field) => field in data).map((field) => [field, data[field]])),
      { headers: NO_STORE });
  };
}
