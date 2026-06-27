# SceneForge Backend (Bootstrap)

Production-ready Node/Express backend for SceneForge map generation with:

- Subscription token checks (Patreon-style bearer access tokens)
- Owner unlimited mode
- BFL FLUX.2 Flex generation with polling
- Reuse/library endpoints for map caching and voting

## Endpoints

- `GET /health`
- `GET /api/subscription/status` (Bearer token required)
- `POST /api/maps/generate` (Bearer token required)
- `GET /api/auth/patreon/connect?returnUrl=<url>`
- `POST /api/maps/reuse/exact`
- `POST /api/maps/library/upsert`
- `POST /api/maps/library/mark-used`
- `POST /api/maps/library/vote`

## Quick Start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy env template and fill values:

   ```bash
   cp .env.example .env
   ```

3. Run locally:

   ```bash
   npm run dev
   ```

## Environment Variables

Required:

- `BFL_API_KEY`: API key used server-side only for calls to `https://api.bfl.ai/v1/flux-2-flex`

Recommended:

- `OWNER_ACCESS_TOKEN`: token that bypasses limits (`unlimited: true`)
- `SUBSCRIPTION_TOKENS`: comma-separated active subscriber tokens
- `PORT`: defaults to `3000`

Optional Patreon connect configuration:

- `PATREON_CLIENT_ID`
- `PATREON_REDIRECT_URI`
- `PATREON_SCOPE` (default: `identity identity.memberships campaigns`)

Optional generation/polling tuning:

- `DEFAULT_IMAGE_COUNT`
- `MAX_BFL_POLL_ATTEMPTS`
- `BFL_POLL_INTERVAL_MS`
- `ESTIMATED_COST_PER_IMAGE`

## Deploy (Render / Railway)

- Build command: `npm install`
- Start command: `npm start`
- Node version: `18+`

The backend does **not** expose provider API keys to clients. Keep all secrets in deployment environment variables only.

Note: Render environment variables are read from `process.env` directly. A missing `.env` file in production is expected.
sceneforge-backend
