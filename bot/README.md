# SceneForge Discord Bot Starter

This bot issues SceneForge API keys to entitled members through slash commands.

## Commands

- `/getkey` - issue a key if none exists, or inform user to rotate if one already exists
- `/rotatekey` - revoke active key and issue a new one

## Setup

1. Create a Discord bot and invite it to your server with:
   - `bot` scope
   - `applications.commands` scope
   - permissions to read members and send DMs
2. Copy `.env.example` to `.env` and set values.
3. Install dependencies:

   ```bash
   cd bot
   npm install
   ```

4. Start bot:

   ```bash
   npm run start
   ```

The bot calls backend token endpoints with `X-Bot-Secret`. Keep `BOT_SHARED_SECRET` private.
