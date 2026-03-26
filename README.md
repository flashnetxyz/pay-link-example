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
- A Flashnet API key — get one at [app.flashnet.xyz](https://app.flashnet.xyz)

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

The `/api/proxy` route injects your `FLASHNET_API_KEY` server-side so it never reaches the browser.

## Project structure

```
src/
├── app/
│   ├── layout.tsx          # Root layout with Tailwind
│   ├── globals.css         # Tailwind theme + animations
│   ├── page.tsx            # The onramp page (all-in-one)
│   └── api/proxy/[...path]/
│       └── route.ts        # API proxy (injects API key)
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
| `FLASHNET_API_KEY` | Yes | Your Flashnet partner API key |
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
