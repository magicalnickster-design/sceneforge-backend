const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const { TokenStore } = require("./lib/tokenStore");
const { verifyDiscordRole } = require("./lib/discordEntitlement");
const {
  parseStaticTokens,
  createBotSecretMiddleware,
  createSubscriptionAuthorizer
} = require("./lib/auth");

dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT || 3000);
const BFL_API_KEY = process.env.BFL_API_KEY || "";
const OWNER_ACCESS_TOKEN = process.env.OWNER_ACCESS_TOKEN || "";
const BOT_SHARED_SECRET = process.env.BOT_SHARED_SECRET || "";
const SUBSCRIPTION_TOKENS = parseStaticTokens(process.env.SUBSCRIPTION_TOKENS || "");
const DEFAULT_IMAGE_COUNT = Math.max(
  1,
  Number(process.env.DEFAULT_IMAGE_COUNT || 1)
);
const MAX_BFL_POLL_ATTEMPTS = Math.max(
  1,
  Number(process.env.MAX_BFL_POLL_ATTEMPTS || 60)
);
const BFL_POLL_INTERVAL_MS = Math.max(
  500,
  Number(process.env.BFL_POLL_INTERVAL_MS || 2000)
);
const ESTIMATED_COST_PER_IMAGE = Number(process.env.ESTIMATED_COST_PER_IMAGE || 0);
const TOKEN_SIGNING_PEPPER = process.env.TOKEN_SIGNING_PEPPER || "";
const DB_PATH =
  process.env.DB_PATH || path.join(process.cwd(), "data", "tokens.json");

const BFL_GENERATE_ENDPOINT = "https://api.bfl.ai/v1/flux-2-flex";
const BFL_RESULT_ENDPOINT = "https://api.bfl.ai/v1/get_result";
const PROVIDER_NAME = "black-forest-labs";
const MODEL_NAME = "flux-2-flex";

const mapLibrary = new Map();
const monthlyUsageCounters = {};
const tokenStore = new TokenStore({
  dbPath: DB_PATH,
  tokenPepper: TOKEN_SIGNING_PEPPER
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const requireBotSecret = createBotSecretMiddleware(BOT_SHARED_SECRET);
const authorizeSubscriptionToken = createSubscriptionAuthorizer({
  ownerAccessToken: OWNER_ACCESS_TOKEN,
  staticSubscriptionTokens: SUBSCRIPTION_TOKENS,
  tokenStore
});

function monthKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getOrCreateTokenUsage(token) {
  const currentMonth = monthKey();
  if (!monthlyUsageCounters[currentMonth]) {
    monthlyUsageCounters[currentMonth] = {};
  }
  if (!monthlyUsageCounters[currentMonth][token]) {
    monthlyUsageCounters[currentMonth][token] = {
      generatedImages: 0,
      generations: 0,
      lastUsedAt: null
    };
  }
  return monthlyUsageCounters[currentMonth][token];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      (payload && (payload.error || payload.message)) ||
      `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = payload;
    throw error;
  }
  return payload;
}

function selectImageUrl(resultPayload) {
  const candidates = [
    resultPayload?.image_url,
    resultPayload?.url,
    resultPayload?.result?.image_url,
    resultPayload?.result?.url,
    resultPayload?.result?.sample,
    resultPayload?.sample
  ];

  if (Array.isArray(resultPayload?.result?.images) && resultPayload.result.images[0]) {
    const first = resultPayload.result.images[0];
    candidates.push(first.url, first.image_url, first.path);
  }

  if (Array.isArray(resultPayload?.images) && resultPayload.images[0]) {
    const first = resultPayload.images[0];
    candidates.push(first.url, first.image_url, first.path);
  }

  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0) || null;
}

async function pollBflResult(initialPayload) {
  if (initialPayload && selectImageUrl(initialPayload)) {
    return initialPayload;
  }

  const pollingUrl =
    initialPayload?.polling_url ||
    initialPayload?.result?.polling_url ||
    (initialPayload?.id ? `${BFL_RESULT_ENDPOINT}?id=${encodeURIComponent(initialPayload.id)}` : null);

  if (!pollingUrl) {
    throw new Error("BFL response did not include polling_url or id.");
  }

  for (let attempt = 1; attempt <= MAX_BFL_POLL_ATTEMPTS; attempt += 1) {
    const resultPayload = await fetchJson(pollingUrl, {
      method: "GET",
      headers: {
        "x-key": BFL_API_KEY,
        Authorization: `Bearer ${BFL_API_KEY}`
      }
    });

    const status = String(resultPayload?.status || resultPayload?.result?.status || "").toLowerCase();
    if (status === "failed" || resultPayload?.error) {
      throw new Error(resultPayload?.error || "BFL reported generation failure.");
    }

    if (selectImageUrl(resultPayload)) {
      return resultPayload;
    }

    if (status === "ready" || status === "succeeded" || status === "complete") {
      return resultPayload;
    }

    await sleep(BFL_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out while polling BFL generation result.");
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "sceneforge-backend",
    timestamp: new Date().toISOString()
  });
});

app.post("/api/tokens/issue-or-get", requireBotSecret, async (req, res) => {
  const discordUserId = String(req.body?.discordUserId || "").trim();
  const rotate = Boolean(req.body?.rotate);
  const reason = String(req.body?.reason || "").trim();

  if (!discordUserId) {
    return res.status(400).json({
      error: "invalid_discord_user_id",
      message: "Field 'discordUserId' is required."
    });
  }

  try {
    const entitlement = await verifyDiscordRole({ discordUserId });
    if (!entitlement.ok) {
      return res.status(entitlement.statusCode).json({
        error: entitlement.error,
        message: entitlement.message
      });
    }

    const issued = await tokenStore.issueOrGetToken({
      discordUserId,
      rotate,
      source: "discord-bot",
      notes: reason
    });

    return res.json({
      ok: true,
      discordUserId,
      token: issued.token,
      reused: issued.reused,
      status: issued.record.status,
      issuedAt: issued.record.issuedAt
    });
  } catch (error) {
    return res.status(500).json({
      error: "token_issue_failed",
      message: error.message || "Failed to issue token."
    });
  }
});

app.post("/api/tokens/revoke", requireBotSecret, async (req, res) => {
  const discordUserId = String(req.body?.discordUserId || "").trim();
  const reason = String(req.body?.reason || "").trim();
  if (!discordUserId) {
    return res.status(400).json({
      error: "invalid_discord_user_id",
      message: "Field 'discordUserId' is required."
    });
  }
  try {
    const result = await tokenStore.revokeActiveTokenForUser(discordUserId, reason);
    return res.json({
      ok: true,
      revoked: result.revoked,
      discordUserId
    });
  } catch (error) {
    return res.status(500).json({
      error: "token_revoke_failed",
      message: error.message || "Failed to revoke token."
    });
  }
});

app.get("/api/tokens/status/:discordUserId", requireBotSecret, async (req, res) => {
  const discordUserId = String(req.params?.discordUserId || "").trim();
  if (!discordUserId) {
    return res.status(400).json({
      error: "invalid_discord_user_id",
      message: "discordUserId path param is required."
    });
  }
  try {
    const status = await tokenStore.getStatusForUser(discordUserId);
    return res.json({
      ok: true,
      discordUserId,
      ...status
    });
  } catch (error) {
    return res.status(500).json({
      error: "token_status_failed",
      message: error.message || "Failed to fetch token status."
    });
  }
});

app.post("/api/tokens/validate", requireBotSecret, async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) {
    return res.status(400).json({
      error: "invalid_token",
      message: "Field 'token' is required."
    });
  }
  try {
    const record = await tokenStore.validateToken(token);
    return res.json({
      valid: Boolean(record),
      discordUserId: record?.discordUserId || null,
      status: record?.status || "none"
    });
  } catch (error) {
    return res.status(500).json({
      error: "token_validate_failed",
      message: error.message || "Failed to validate token."
    });
  }
});

app.get("/api/subscription/status", authorizeSubscriptionToken, (req, res) => {
  const usage = getOrCreateTokenUsage(req.auth.token);
  res.json({
    active: true,
    unlimited: req.auth.unlimited,
    tier: req.auth.isOwner ? "owner" : "subscriber",
    month: monthKey(),
    usage
  });
});

app.post("/api/maps/generate", authorizeSubscriptionToken, async (req, res) => {
  if (!BFL_API_KEY) {
    return res.status(500).json({
      error: "backend_not_configured",
      message: "BFL_API_KEY is missing on the server."
    });
  }

  const prompt = String(req.body?.prompt || "").trim();
  const imageCount = Math.max(1, Number(req.body?.imageCount || DEFAULT_IMAGE_COUNT));

  if (!prompt) {
    return res.status(400).json({
      error: "invalid_prompt",
      message: "Field 'prompt' is required."
    });
  }

  const payload = {
    prompt,
    width: Number(req.body?.width) || 1024,
    height: Number(req.body?.height) || 1024,
    num_images: imageCount,
    safety_tolerance: Number(req.body?.safety_tolerance || 2),
    output_format: req.body?.output_format || "png",
    seed: req.body?.seed
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === null || Number.isNaN(payload[key])) {
      delete payload[key];
    }
  });

  try {
    const initialResponse = await fetchJson(BFL_GENERATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-key": BFL_API_KEY,
        Authorization: `Bearer ${BFL_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const result = await pollBflResult(initialResponse);
    const imageUrl = selectImageUrl(result);

    if (!imageUrl) {
      throw new Error("No image URL returned by BFL.");
    }

    const usage = getOrCreateTokenUsage(req.auth.token);
    usage.generations += 1;
    usage.generatedImages += imageCount;
    usage.lastUsedAt = new Date().toISOString();
    if (req.auth.recordId) {
      await tokenStore.touchLastUsedById(req.auth.recordId);
    }

    const generationId =
      result?.id ||
      result?.result?.id ||
      initialResponse?.id ||
      initialResponse?.result?.id ||
      null;

    return res.json({
      imagePath: imageUrl,
      image_url: imageUrl,
      url: imageUrl,
      provider: PROVIDER_NAME,
      model: MODEL_NAME,
      endpoint: BFL_GENERATE_ENDPOINT,
      estimatedCost:
        Number(result?.cost ?? result?.result?.cost ?? imageCount * ESTIMATED_COST_PER_IMAGE) || 0,
      generationId,
      imageCount,
      metadata: {
        provider: PROVIDER_NAME,
        model: MODEL_NAME,
        endpoint: BFL_GENERATE_ENDPOINT,
        estimatedCost:
          Number(result?.cost ?? result?.result?.cost ?? imageCount * ESTIMATED_COST_PER_IMAGE) || 0,
        generationId,
        imageCount
      }
    });
  } catch (error) {
    const statusCode = Number(error.status) || 500;
    return res.status(statusCode).json({
      error: "generation_failed",
      message: error.message || "Failed to generate map image.",
      details: error.details || null
    });
  }
});

app.get("/api/auth/patreon/connect", (req, res) => {
  const returnUrl = String(req.query.returnUrl || "").trim();
  const clientId = process.env.PATREON_CLIENT_ID || "";
  const redirectUri = process.env.PATREON_REDIRECT_URI || "";
  const scope = process.env.PATREON_SCOPE || "identity identity.memberships campaigns";
  const statePayload = Buffer.from(
    JSON.stringify({
      returnUrl,
      ts: Date.now()
    })
  ).toString("base64url");

  if (!clientId || !redirectUri) {
    return res.status(400).json({
      error: "patreon_not_configured",
      message: "PATREON_CLIENT_ID and PATREON_REDIRECT_URI are required.",
      returnUrl
    });
  }

  const connectUrl = new URL("https://www.patreon.com/oauth2/authorize");
  connectUrl.searchParams.set("response_type", "code");
  connectUrl.searchParams.set("client_id", clientId);
  connectUrl.searchParams.set("redirect_uri", redirectUri);
  connectUrl.searchParams.set("scope", scope);
  connectUrl.searchParams.set("state", statePayload);

  res.json({
    connectUrl: connectUrl.toString(),
    returnUrl
  });
});

app.post("/api/maps/reuse/exact", (req, res) => {
  const key = String(req.body?.key || req.body?.mapKey || req.body?.fingerprint || "").trim();
  if (!key) {
    return res.status(400).json({
      error: "missing_key",
      message: "Provide key, mapKey, or fingerprint."
    });
  }
  const match = mapLibrary.get(key) || null;
  return res.json({
    found: Boolean(match),
    key,
    map: match
  });
});

app.post("/api/maps/library/upsert", (req, res) => {
  const key = String(req.body?.key || req.body?.mapKey || req.body?.fingerprint || "").trim();
  const imageUrl = String(req.body?.image_url || req.body?.url || req.body?.imagePath || "").trim();
  if (!key || !imageUrl) {
    return res.status(400).json({
      error: "invalid_payload",
      message: "Fields key/mapKey/fingerprint and image_url/url/imagePath are required."
    });
  }

  const now = new Date().toISOString();
  const existing = mapLibrary.get(key) || {};
  const next = {
    ...existing,
    ...req.body,
    key,
    image_url: imageUrl,
    updatedAt: now,
    createdAt: existing.createdAt || now,
    usageCount: Number(existing.usageCount || 0),
    votesUp: Number(existing.votesUp || 0),
    votesDown: Number(existing.votesDown || 0),
    score: Number(existing.score || 0)
  };
  mapLibrary.set(key, next);

  return res.json({
    ok: true,
    key,
    map: next
  });
});

app.post("/api/maps/library/mark-used", (req, res) => {
  const key = String(req.body?.key || req.body?.mapKey || req.body?.fingerprint || "").trim();
  if (!key || !mapLibrary.has(key)) {
    return res.status(404).json({
      error: "map_not_found",
      message: "No map found for the provided key."
    });
  }

  const map = mapLibrary.get(key);
  map.usageCount = Number(map.usageCount || 0) + 1;
  map.lastUsedAt = new Date().toISOString();
  mapLibrary.set(key, map);

  return res.json({
    ok: true,
    key,
    usageCount: map.usageCount,
    map
  });
});

app.post("/api/maps/library/vote", (req, res) => {
  const key = String(req.body?.key || req.body?.mapKey || req.body?.fingerprint || "").trim();
  const vote = String(req.body?.vote || "").trim().toLowerCase();
  if (!key || !mapLibrary.has(key)) {
    return res.status(404).json({
      error: "map_not_found",
      message: "No map found for the provided key."
    });
  }
  if (vote !== "up" && vote !== "down") {
    return res.status(400).json({
      error: "invalid_vote",
      message: "Vote must be either 'up' or 'down'."
    });
  }

  const map = mapLibrary.get(key);
  map.votesUp = Number(map.votesUp || 0);
  map.votesDown = Number(map.votesDown || 0);
  if (vote === "up") {
    map.votesUp += 1;
  } else {
    map.votesDown += 1;
  }
  map.score = map.votesUp - map.votesDown;
  map.updatedAt = new Date().toISOString();
  mapLibrary.set(key, map);

  return res.json({
    ok: true,
    key,
    votesUp: map.votesUp,
    votesDown: map.votesDown,
    score: map.score,
    map
  });
});

app.use((err, _req, res, _next) => {
  res.status(500).json({
    error: "internal_server_error",
    message: err.message || "Unexpected error."
  });
});

async function start() {
  await tokenStore.init();
  app.listen(PORT, () => {
    console.log(`SceneForge backend listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to initialize server:", error.message);
  process.exit(1);
});
