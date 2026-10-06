import { createOnrampProxy } from "@/server/onramp-proxy";

// These values are read only by the server route, never by the client bundle.
const proxyRequest = createOnrampProxy({
  apiKey: process.env.FLASHNET_API_KEY ?? "",
  baseUrl: process.env.FLASHNET_BASE_URL ?? "https://orchestration.flashnet.xyz",
});

export const GET = proxyRequest;
export const POST = proxyRequest;
