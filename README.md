# SceneForge Backend

SceneForge backend for subscription-gated map generation with BFL FLUX.2 Flex and Discord OAuth linking.

## Architecture (text diagram)

1. User clicks "Link Discord" in module
2. Module opens backend `/api/auth/discord/connect?returnUrl=...`
3. User authorizes Discord account
4. Backend callback checks guild membership + tier role (`Tier 1`, `Tier 2`, `Founder`)
5. Backend issues a 30-day per-user token (stored as hash only)
6. Module receives token in callback URL fragment and saves it
7. Module calls `/api/maps/generate` with `Authorization: Bearer <token>`

## API Endpoints

### Public and module endpoints

- `GET /health`
- `GET /api/subscription/status` (Bearer token required)
- `POST /api/maps/generate` (Bearer token required)
- `GET /api/auth/discord/connect?returnUrl=<url>`
- `GET /api/auth/discord/callback`
- `POST /api/maps/reuse/exact`
- `POST /api/maps/library/upsert`
- `POST /api/maps/library/mark-used`
- `POST /api/maps/library/vote`

## Quick Start

```bash
npm install
cp .env.example .env
npm run init-storage
npm run dev
```

## Environment Variables

Required:

- `BFL_API_KEY`
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_GUILD_ID`
- `DISCORD_REDIRECT_URI`
- `DISCORD_ROLE_PATREON_TIER1_ID`
- `DISCORD_ROLE_PATREON_TIER2_ID`
- `DISCORD_ROLE_PATREON_FOUNDER_ID`
- `TOKEN_SIGNING_PEPPER`

Recommended:

- `OWNER_ACCESS_TOKEN` (owner unlimited mode)
- `SUBSCRIPTION_TOKENS` (legacy fallback/manual tokens)
- `DB_PATH` (default: `./data/tokens.json`)
- `TOKEN_TTL_DAYS` (default: 30)
- `MONTHLY_GENERATION_LIMIT_TIER1`
- `MONTHLY_GENERATION_LIMIT_TIER2`
- `MONTHLY_GENERATION_LIMIT_FOUNDER`
- `PORT` (default: `3000`)

Optional generation tuning:

- `DEFAULT_IMAGE_COUNT`
- `MAX_BFL_POLL_ATTEMPTS`
- `BFL_POLL_INTERVAL_MS`
- `ESTIMATED_COST_PER_IMAGE`

## Security Notes

- BFL keys stay server-side in env vars only.
- Issued tokens are stored as hashes; plaintext is returned only when newly issued.
- Existing static `SUBSCRIPTION_TOKENS` remain supported for migration/fallback.
- OAuth state is signed with `DISCORD_OAUTH_STATE_SECRET` (or fallback secret).

## Curl Examples

Get Discord connect URL:

```bash
curl "http://localhost:3000/api/auth/discord/connect?returnUrl=http://localhost:30000"
```

Check subscription status:

```bash
curl "http://localhost:3000/api/subscription/status" \
  -H "Authorization: Bearer USER_TOKEN"
```

Generate map:

```bash
curl -X POST "http://localhost:3000/api/maps/generate" \
  -H "Authorization: Bearer USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"top-down tavern battle map","imageCount":1}'
```

## Deploy (Render / Railway)

- Build command: `npm install`
- Start command: `npm start`
- Node version: `18+`

Render environment variables are read from `process.env` directly. A missing `.env` file in production is expected.
