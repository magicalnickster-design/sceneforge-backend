# SceneForge Backend

SceneForge backend for subscription-gated map generation with BFL FLUX.2 Flex plus Discord-role key issuance for Patreon communities.

## Architecture (text diagram)

1. Patreon subscriber receives Discord role in your server
2. User runs `/getkey` in Discord
3. Discord bot calls backend `/api/tokens/issue-or-get` with `X-Bot-Secret`
4. Backend verifies user membership + required role via Discord API
5. Backend issues per-user token (stored as hash only) and returns plaintext once
6. Bot DMs key to user
7. Foundry module calls `/api/maps/generate` with `Authorization: Bearer <token>`

## API Endpoints

### Public and module endpoints

- `GET /health`
- `GET /api/subscription/status` (Bearer token required)
- `POST /api/maps/generate` (Bearer token required)
- `GET /api/auth/patreon/connect?returnUrl=<url>`
- `POST /api/maps/reuse/exact`
- `POST /api/maps/library/upsert`
- `POST /api/maps/library/mark-used`
- `POST /api/maps/library/vote`

### Bot/admin endpoints (`X-Bot-Secret` required)

- `POST /api/tokens/issue-or-get`
- `POST /api/tokens/revoke`
- `GET /api/tokens/status/:discordUserId`
- `POST /api/tokens/validate`

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
- `BOT_SHARED_SECRET`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_REQUIRED_ROLE_ID`
- `TOKEN_SIGNING_PEPPER`

Recommended:

- `OWNER_ACCESS_TOKEN` (owner unlimited mode)
- `SUBSCRIPTION_TOKENS` (legacy fallback/manual tokens)
- `DB_PATH` (default: `./data/tokens.json`)
- `PORT` (default: `3000`)

Optional Patreon connect values:

- `PATREON_CLIENT_ID`
- `PATREON_REDIRECT_URI`
- `PATREON_SCOPE` (default: `identity identity.memberships campaigns`)

Optional generation tuning:

- `DEFAULT_IMAGE_COUNT`
- `MAX_BFL_POLL_ATTEMPTS`
- `BFL_POLL_INTERVAL_MS`
- `ESTIMATED_COST_PER_IMAGE`

## Security Notes

- BFL keys stay server-side in env vars only.
- Bot admin routes use constant-time shared-secret checks.
- Issued tokens are stored as hashes; plaintext is returned only when newly issued.
- Existing static `SUBSCRIPTION_TOKENS` remain supported for migration.

## Curl Examples

Issue or get token:

```bash
curl -X POST "http://localhost:3000/api/tokens/issue-or-get" \
  -H "Content-Type: application/json" \
  -H "X-Bot-Secret: BOT_SECRET" \
  -d '{"discordUserId":"123456789012345678","rotate":false}'
```

Check token status:

```bash
curl "http://localhost:3000/api/tokens/status/123456789012345678" \
  -H "X-Bot-Secret: BOT_SECRET"
```

Generate map:

```bash
curl -X POST "http://localhost:3000/api/maps/generate" \
  -H "Authorization: Bearer USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"top-down tavern battle map","imageCount":1}'
```

## Discord Bot Starter

See [`bot/README.md`](bot/README.md) for `/getkey` and `/rotatekey` starter setup.

## Deploy (Render / Railway)

- Build command: `npm install`
- Start command: `npm start`
- Node version: `18+`

Render environment variables are read from `process.env` directly. A missing `.env` file in production is expected.
