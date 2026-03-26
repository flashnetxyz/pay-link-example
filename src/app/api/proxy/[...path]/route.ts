/**
 * API proxy — forwards requests to the Flashnet Orchestration API
 * and injects the API key server-side so it never reaches the browser.
 *
 * Supports JSON requests (GET/POST) and SSE streaming (GET /v1/sse/*).
 */

import { type NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.FLASHNET_API_KEY ?? "";
const BASE_URL = process.env.FLASHNET_BASE_URL ?? "https://orchestration.flashnet.xyz";

function buildUpstreamUrl(req: NextRequest): string {
  const url = new URL(req.url);
  // Strip the /api/proxy prefix to get the real API path
  const apiPath = url.pathname.replace(/^\/api\/proxy/, "");
  const upstream = new URL(apiPath, BASE_URL);
  upstream.search = url.search;
  return upstream.toString();
}

async function proxyRequest(req: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json(
      { error: { code: "missing_api_key", message: "FLASHNET_API_KEY is not set" } },
      { status: 500 },
    );
  }

  const upstreamUrl = buildUpstreamUrl(req);
  const isSSE = upstreamUrl.includes("/v1/sse/");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
  };

  // Forward content-type and idempotency key for POST requests
  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  const idempotencyKey = req.headers.get("x-idempotency-key");
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
  };

  if (req.method === "POST") {
    fetchOpts.body = await req.text();
  }

  const upstream = await fetch(upstreamUrl, fetchOpts);

  // SSE: stream the response back as-is
  if (isSSE && upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // JSON: parse and forward
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(req: NextRequest) {
  return proxyRequest(req);
}

export async function POST(req: NextRequest) {
  return proxyRequest(req);
}
