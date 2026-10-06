# Flashnet Onramp Example

A standalone Next.js app demonstrating how to integrate [Flashnet Pay Links](https://docs.flashnet.xyz/products/orchestration/pay-links) to let users buy USDC on Solana using Cash App.

## What this demonstrates

- **Live pricing** — debounced BTC/USDC estimates as the user types an amount
- **Order creation** — calls `POST /v1/orchestration/onramp` to generate a Lightning invoice
- **Cash App payment** — redirects on mobile, shows a QR code on desktop
- **Real-time tracking** — SSE stream + polling fallback for order status updates
- **Pipeline progress** — visual stepper (Confirming → Swapping → Bridging → Done)

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (or [Bun](https://bun.sh/))
- A dedicated Flashnet client key (`fnp_`) in `server` mode with only `orders:onramp`, `orders:read`, and `orders:sse` scopes, created in [app.flashnet.xyz](https://app.flashnet.xyz)

## Quick start

```bash
git clone https://github.com/flashnetxyz/pay-link-example.git
cd pay-link-example
cp .env.example .env.local
# Edit .env.local and add your FLASHNET_API_KEY
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Architecture

```
Browser                          Your Server                     Flashnet API
  │                                  │                               │
  │  GET /api/proxy/v1/.../estimate  │                               │
  │ ──────────────────────────────►  │  + Authorization: Bearer key  │
  │                                  │ ────────────────────────────►  │
  │                                  │  ◄────── JSON response ─────  │
  │  ◄──────── JSON response ──────  │                               │
  │                                  │                               │
  │  POST /api/proxy/v1/.../onramp   │                               │
  │ ──────────────────────────────►  │  + Authorization: Bearer key  │
  │                                  │ ────────────────────────────►  │
  │                                  │  ◄────── order + Cash App URL │
  │  ◄──────── order details ──────  │                               │
  │                                  │                               │
  │  EventSource /api/proxy/v1/sse/… │                               │
  │ ──────────────────────────────►  │  SSE passthrough              │
  │  ◄──── status events (stream) ─  │  ◄──── status events ───────  │
```

The `/api/proxy` route keeps `FLASHNET_API_KEY` on the server and accepts only the four exact method/path pairs below. Full `fn_` keys are rejected, even if configured by mistake. The demo only supports Lightning BTC to Solana USDC; arbitrary paths, extra parameters, privileged fee/refund fields, and upstream redirects are rejected.

Onramp creation returns an order-bound `readToken`. The page keeps it in memory and supplies it for polling and SSE; Orchestra verifies its signature, expiry, key, and order binding. Knowing an order ID alone grants no read access. Screened orders preserve HTTP 202 and remain trackable without showing a payment link. Responses are not cached, and polling returns only order status. The partner key never goes into browser requests, responses, URLs, or public environment variables.

## Project structure

```
src/
├── app/
│   ├── layout.tsx          # Root layout with Tailwind
│   ├── globals.css         # Tailwind theme + animations
│   ├── page.tsx            # The onramp page (all-in-one)
│   └── api/proxy/[...path]/
│       └── route.ts        # API proxy (injects API key)
├── server/
│   └── onramp-proxy.ts     # Restricted proxy and request validation
└── lib/
    ├── api.ts              # Flashnet API client (estimate, onramp, status)
    ├── use-order-sse.ts    # React hook for SSE status updates
    └── amounts.ts          # BigInt amount formatting
```

## API endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/orchestration/estimate` | GET | Get real-time BTC/USDC pricing |
| `/v1/orchestration/onramp` | POST | Create order + get Cash App payment link |
| `/v1/orchestration/status` | GET | Poll order status |
| `/v1/sse/operations/:id` | GET | SSE stream for real-time status |

See the full [API reference](https://docs.flashnet.xyz/api-reference).

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `FLASHNET_API_KEY` | Yes | Server-only scoped client key (`fnp_`, server mode) |
| `FLASHNET_BASE_URL` | No | API base URL (defaults to `https://orchestration.flashnet.xyz`) |

## How it works

1. User enters a USD amount and their Solana address
2. The app fetches a live BTC estimate (debounced, 300ms)
3. On submit, `POST /v1/orchestration/onramp` creates a Lightning invoice
4. Mobile users get redirected to Cash App; desktop users see a QR code
5. After payment, the app tracks the order via SSE until completion
6. The pipeline shows: **Confirming** → **Swapping BTC→USDB** → **Bridging to USDC** → **Done**

## Learn more

- [Pay Links documentation](https://docs.flashnet.xyz/products/orchestration/pay-links)
- [Orchestration API reference](https://docs.flashnet.xyz/api-reference)
- [Flashnet website](https://flashnet.xyz)

## Deployment and credential migration

Before deploying this change, provision a dedicated `fnp_` client key in `server` mode with exactly `orders:onramp`, `orders:read`, and `orders:sse`, then configure it as the server-only `FLASHNET_API_KEY` in Vercel. Do not use `NEXT_PUBLIC_` for this value. Estimate does not require an additional scope. Server mode is appropriate because only this server presents the key to Orchestra; backend client-key rate limits still apply. Requests share the proxy identity and its upstream per-IP quota (10 onramps/minute by default), in addition to the per-key quota. Treat this as an aggregate demo limit; assess capacity and trusted edge admission controls before scaling. Caller-supplied IP headers are never forwarded.

Deploying with the old full key fails closed with HTTP 503. Existing sessions without an order read token cannot poll or stream. A code PR alone does not update a live deployment, rotate a key, or invalidate previously created credentials; handle incident containment and credential review separately with the account owner.

## Verification

Use Node.js 22.6+ to run `npm test` (or `bun run test`). The tests use dummy keys and a mocked upstream and never contact production. They cover forbidden admin/history/key routes, method and URL variants, read-token forwarding, response minimization, credential configuration, redirects, and the allowed onramp flow.
