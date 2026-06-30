const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require("crypto");
const { TokenStore } = require("./lib/tokenStore");
const { fetchGuildMember } = require("./lib/discordEntitlement");
const { parseStaticTokens, createSubscriptionAuthorizer } = require("./lib/auth");

dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT || 3000);
const BFL_API_KEY = process.env.BFL_API_KEY || "";
const OWNER_ACCESS_TOKEN = process.env.OWNER_ACCESS_TOKEN || "";
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
const MAX_PROXY_IMAGE_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.MAX_PROXY_IMAGE_BYTES || 15 * 1024 * 1024)
);
const TOKEN_SIGNING_PEPPER = process.env.TOKEN_SIGNING_PEPPER || "";
const DB_PATH =
  process.env.DB_PATH || path.join(process.cwd(), "data", "tokens.json");
const TOKEN_TTL_DAYS = Math.max(1, Number(process.env.TOKEN_TTL_DAYS || 30));
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || "";
const DISCORD_OAUTH_STATE_SECRET =
  process.env.DISCORD_OAUTH_STATE_SECRET ||
  TOKEN_SIGNING_PEPPER ||
  OWNER_ACCESS_TOKEN ||
  "sceneforge-state";
const DISCORD_ROLE_PATREON_TIER1_ID = process.env.DISCORD_ROLE_PATREON_TIER1_ID || "";
const DISCORD_ROLE_PATREON_TIER2_ID = process.env.DISCORD_ROLE_PATREON_TIER2_ID || "";
const DISCORD_ROLE_PATREON_FOUNDER_ID =
  process.env.DISCORD_ROLE_PATREON_FOUNDER_ID || "";
const MONTHLY_GENERATION_LIMIT_TIER1 = Math.max(
  1,
  Number(process.env.MONTHLY_GENERATION_LIMIT_TIER1 || 200)
);
const MONTHLY_GENERATION_LIMIT_TIER2 = Math.max(
  1,
  Number(process.env.MONTHLY_GENERATION_LIMIT_TIER2 || 600)
);
const MONTHLY_GENERATION_LIMIT_FOUNDER = Math.max(
  1,
  Number(process.env.MONTHLY_GENERATION_LIMIT_FOUNDER || 2000)
);

const BFL_GENERATE_ENDPOINT = "https://api.bfl.ai/v1/flux-2-flex";
const BFL_RESULT_ENDPOINT = "https://api.bfl.ai/v1/get_result";
const PROVIDER_NAME = "black-forest-labs";
const MODEL_NAME = "flux-2-flex";
const ALLOWED_IMAGE_HOST_SUFFIXES = [".bfl.ai"];

const mapLibrary = new Map();
const tokenStore = new TokenStore({
  dbPath: DB_PATH,
  tokenPepper: TOKEN_SIGNING_PEPPER
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

function getUsageKey(auth) {
  return auth.discordUserId || auth.token;
}

function getTierFromRoles(roles = []) {
  if (DISCORD_ROLE_PATREON_FOUNDER_ID && roles.includes(DISCORD_ROLE_PATREON_FOUNDER_ID)) {
    return {
      tier: "founder",
      monthlyGenerationLimit: MONTHLY_GENERATION_LIMIT_FOUNDER
    };
  }
  if (DISCORD_ROLE_PATREON_TIER2_ID && roles.includes(DISCORD_ROLE_PATREON_TIER2_ID)) {
    return {
      tier: "tier2",
      monthlyGenerationLimit: MONTHLY_GENERATION_LIMIT_TIER2
    };
  }
  if (DISCORD_ROLE_PATREON_TIER1_ID && roles.includes(DISCORD_ROLE_PATREON_TIER1_ID)) {
    return {
      tier: "tier1",
      monthlyGenerationLimit: MONTHLY_GENERATION_LIMIT_TIER1
    };
  }
  return null;
}

function encodeState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", DISCORD_OAUTH_STATE_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function decodeState(state) {
  const [body, signature] = String(state || "").split(".");
  if (!body || !signature) {
    return null;
  }
  const expected = crypto
    .createHmac("sha256", DISCORD_OAUTH_STATE_SECRET)
    .update(body)
    .digest("base64url");
  if (expected !== signature) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return parsed;
  } catch {
    return null;
  }
}

function buildRedirectUrl(returnUrl, params) {
  try {
    const url = new URL(returnUrl);
    const hashParams = new URLSearchParams(params);
    url.hash = hashParams.toString();
    return url.toString();
  } catch {
    return null;
  }
}

async function syncManagedDiscordEntitlement(req, res) {
  if (req.auth.source !== "managed-token" || !req.auth.discordUserId) {
    return true;
  }

  const membership = await fetchGuildMember({ discordUserId: req.auth.discordUserId });
  if (!membership.ok) {
    res.status(membership.statusCode).json({
      error: membership.error,
      message: membership.message
    });
    return false;
  }

  const tierConfig = getTierFromRoles(membership.roles);
  if (!tierConfig) {
    await tokenStore.revokeActiveTokenForUser(req.auth.discordUserId, "role_removed");
    res.status(403).json({
      error: "not_entitled",
      message: "Discord role entitlement not found."
    });
    return false;
  }

  req.auth.tier = tierConfig.tier;
  req.auth.monthlyGenerationLimit = tierConfig.monthlyGenerationLimit;
  await tokenStore.updateManagedTokenEntitlementById(req.auth.recordId, tierConfig);
  return true;
}

async function exchangeDiscordCodeForUser(code) {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
    const error = new Error(
      "DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI are required."
    );
    error.status = 503;
    throw error;
  }

  const tokenBody = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: DISCORD_REDIRECT_URI
  });
  const tokenResponse = await fetchJson("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: tokenBody.toString()
  });

  const accessToken = tokenResponse?.access_token;
  if (!accessToken) {
    const error = new Error("Discord OAuth token response did not include access_token.");
    error.status = 502;
    throw error;
  }

  const user = await fetchJson("https://discord.com/api/v10/users/@me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  return user;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const requestId =
    response.headers.get("x-request-id") ||
    response.headers.get("request-id") ||
    response.headers.get("cf-ray") ||
    null;
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = extractProviderDetail(payload) || `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.detail = message;
    error.details = payload;
    error.requestId = requestId;
    error.endpoint = url;
    throw error;
  }
  if (payload && typeof payload === "object" && requestId && !payload.requestId) {
    payload.requestId = requestId;
  }
  return payload;
}

function flattenProviderMessages(value, context = {}) {
  const messages = [];
  if (value === null || value === undefined) {
    return messages;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      messages.push(trimmed);
    }
    return messages;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    messages.push(String(value));
    return messages;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      messages.push(...flattenProviderMessages(entry, context));
    });
    return messages;
  }

  if (typeof value === "object") {
    const location = Array.isArray(value.loc) ? value.loc.join(".") : "";
    const msg = typeof value.msg === "string" ? value.msg.trim() : "";
    if (msg) {
      messages.push(location ? `${location}: ${msg}` : msg);
    }
    if (typeof value.message === "string" && value.message.trim()) {
      messages.push(value.message.trim());
    }
    if (typeof value.error === "string" && value.error.trim()) {
      messages.push(value.error.trim());
    }
    if (value.detail !== undefined) {
      messages.push(...flattenProviderMessages(value.detail, context));
    }

    Object.entries(value).forEach(([key, nested]) => {
      if (["loc", "msg", "message", "error", "detail"].includes(key)) {
        return;
      }
      messages.push(...flattenProviderMessages(nested, context));
    });
  }

  return messages;
}

function extractProviderDetail(payload) {
  const messages = flattenProviderMessages(payload);
  const deduped = [...new Set(messages.map((m) => m.trim()).filter(Boolean))];
  if (deduped.length > 0) {
    return deduped.join(" | ");
  }
  return null;
}

function redactSensitive(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/(token|secret|authorization|api[_-]?key|password|credential)/i.test(key)) {
        next[key] = "[REDACTED]";
      } else {
        next[key] = redactSensitive(nested);
      }
    }
    return next;
  }
  return value;
}

function extractGenerationId(payload) {
  return payload?.id || payload?.result?.id || null;
}

function createGenerationError(reason, detail, meta = {}) {
  const error = new Error(detail);
  error.reason = reason;
  error.detail = detail;
  if (typeof meta.status === "number") {
    error.status = meta.status;
  }
  if (typeof meta.upstreamStatus === "number") {
    error.upstreamStatus = meta.upstreamStatus;
  }
  if (meta.endpoint) {
    error.endpoint = meta.endpoint;
  }
  if (meta.generationId) {
    error.generationId = meta.generationId;
  }
  if (meta.requestId) {
    error.requestId = meta.requestId;
  }
  if (meta.upstream) {
    error.upstream = redactSensitive(meta.upstream);
  }
  return error;
}

function classifyGenerationReason(error) {
  const detail = String(error?.detail || error?.message || "").toLowerCase();
  if (detail.includes("timeout")) {
    return "provider_timeout";
  }
  if (detail.includes("credit") || detail.includes("insufficient")) {
    return "insufficient_credits";
  }
  const upstreamStatus = Number(error?.upstreamStatus || error?.status);
  if (upstreamStatus >= 400) {
    return `upstream_${upstreamStatus}`;
  }
  if (detail.includes("prompt")) {
    return "invalid_prompt";
  }
  return "provider_error";
}

function buildGenerationFailure(error) {
  const upstreamStatus = Number(error?.upstreamStatus || error?.status) || null;
  const detail =
    error?.detail ||
    extractProviderDetail(error?.upstream || error?.details) ||
    error?.message ||
    "Failed to generate map image.";
  return {
    statusCode: upstreamStatus && upstreamStatus >= 400 ? upstreamStatus : 500,
    payload: {
      error: "generation_failed",
      reason: error?.reason || classifyGenerationReason(error),
      detail,
      provider: PROVIDER_NAME,
      model: MODEL_NAME,
      endpoint: error?.endpoint || BFL_GENERATE_ENDPOINT,
      upstreamStatus,
      generationId: error?.generationId || null,
      requestId: error?.requestId || null,
      upstream: redactSensitive(error?.upstream || error?.details || null)
    }
  };
}

function isAllowedImageHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return ALLOWED_IMAGE_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix)
  );
}

function isAllowedImageUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return parsed.protocol === "https:" && isAllowedImageHost(parsed.hostname);
  } catch {
    return false;
  }
}

function extensionFromContentType(contentType = "") {
  const normalized = String(contentType).toLowerCase();
  if (normalized.includes("png")) {
    return "png";
  }
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  if (normalized.includes("gif")) {
    return "gif";
  }
  return "bin";
}

async function fetchImageAsBase64(imageUrl) {
  const response = await fetch(imageUrl, {
    method: "GET"
  });
  if (!response.ok) {
    throw createGenerationError("upstream_image_fetch_failed", `Image fetch failed with status ${response.status}`, {
      status: response.status,
      upstreamStatus: response.status,
      endpoint: imageUrl,
      requestId:
        response.headers.get("x-request-id") ||
        response.headers.get("request-id") ||
        response.headers.get("cf-ray") ||
        null
    });
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = Number(contentLengthHeader || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_IMAGE_BYTES) {
    throw createGenerationError(
      "image_too_large",
      `Image exceeds max proxy size of ${MAX_PROXY_IMAGE_BYTES} bytes.`,
      {
        status: 413,
        upstreamStatus: 413,
        endpoint: imageUrl
      }
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_PROXY_IMAGE_BYTES) {
    throw createGenerationError(
      "image_too_large",
      `Image exceeds max proxy size of ${MAX_PROXY_IMAGE_BYTES} bytes.`,
      {
        status: 413,
        upstreamStatus: 413,
        endpoint: imageUrl
      }
    );
  }

  const base64 = buffer.toString("base64");
  return {
    contentType,
    bytes: buffer.length,
    base64,
    dataUrl: `data:${contentType};base64,${base64}`
  };
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

async function pollBflResult(initialPayload, generationId = null) {
  if (initialPayload && selectImageUrl(initialPayload)) {
    return initialPayload;
  }

  const pollingUrl =
    initialPayload?.polling_url ||
    initialPayload?.result?.polling_url ||
    (initialPayload?.id ? `${BFL_RESULT_ENDPOINT}?id=${encodeURIComponent(initialPayload.id)}` : null);

  if (!pollingUrl) {
    throw createGenerationError(
      "provider_response_invalid",
      "BFL response did not include polling_url or id.",
      {
        generationId,
        endpoint: BFL_GENERATE_ENDPOINT,
        upstream: initialPayload
      }
    );
  }

  let lastStatus = "";
  let lastPayload = null;
  for (let attempt = 1; attempt <= MAX_BFL_POLL_ATTEMPTS; attempt += 1) {
    let resultPayload;
    try {
      resultPayload = await fetchJson(pollingUrl, {
        method: "GET",
        headers: {
          "x-key": BFL_API_KEY,
          Authorization: `Bearer ${BFL_API_KEY}`
        }
      });
    } catch (error) {
      throw createGenerationError(
        classifyGenerationReason(error),
        error.message || "Polling request failed at provider.",
        {
          status: Number(error.status) || undefined,
          upstreamStatus: Number(error.status) || undefined,
          generationId,
          endpoint: pollingUrl,
          requestId: error?.requestId,
          upstream: error?.details
        }
      );
    }
    lastPayload = resultPayload;

    const status = String(resultPayload?.status || resultPayload?.result?.status || "").toLowerCase();
    lastStatus = status;
    if (status === "failed" || resultPayload?.error) {
      const providerDetail = extractProviderDetail(resultPayload);
      throw createGenerationError(
        classifyGenerationReason({
          status: 422,
          detail: providerDetail || "BFL reported generation failure."
        }),
        providerDetail || "BFL reported generation failure.",
        {
          status: 422,
          upstreamStatus: 422,
          generationId,
          endpoint: pollingUrl,
          upstream: resultPayload
        }
      );
    }

    if (selectImageUrl(resultPayload)) {
      return resultPayload;
    }

    if (status === "ready" || status === "succeeded" || status === "complete") {
      return resultPayload;
    }

    await sleep(BFL_POLL_INTERVAL_MS);
  }

  throw createGenerationError(
    "provider_timeout",
    `Timed out while polling BFL generation result after ${MAX_BFL_POLL_ATTEMPTS} attempts.`,
    {
      status: 504,
      upstreamStatus: 504,
      generationId,
      endpoint: pollingUrl,
      upstream: {
        lastStatus,
        lastPayload
      }
    }
  );
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "sceneforge-backend",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/auth/discord/connect", (req, res) => {
  const returnUrl = String(req.query.returnUrl || "").trim();
  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
    return res.status(503).json({
      error: "discord_oauth_not_configured",
      message: "DISCORD_CLIENT_ID and DISCORD_REDIRECT_URI are required."
    });
  }
  const state = encodeState({
    returnUrl,
    ts: Date.now(),
    nonce: crypto.randomBytes(12).toString("hex")
  });
  const connectUrl = new URL("https://discord.com/api/oauth2/authorize");
  connectUrl.searchParams.set("client_id", DISCORD_CLIENT_ID);
  connectUrl.searchParams.set("response_type", "code");
  connectUrl.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
  connectUrl.searchParams.set("scope", "identify");
  connectUrl.searchParams.set("state", state);
  res.json({
    connectUrl: connectUrl.toString(),
    returnUrl
  });
});

app.get("/api/auth/discord/callback", async (req, res) => {
  const code = String(req.query.code || "").trim();
  const state = decodeState(String(req.query.state || ""));
  const returnUrl = state?.returnUrl || "";
  const fail = (error, message, statusCode = 400) => {
    const redirect = returnUrl
      ? buildRedirectUrl(returnUrl, { linked: "false", error, message })
      : null;
    if (redirect) {
      return res.redirect(302, redirect);
    }
    return res.status(statusCode).json({ error, message });
  };

  if (!state) {
    return fail("invalid_state", "OAuth state was invalid or expired.");
  }
  if (!code) {
    return fail("missing_code", "Discord callback did not include code.");
  }

  try {
    const user = await exchangeDiscordCodeForUser(code);
    const discordUserId = String(user?.id || "").trim();
    if (!discordUserId) {
      return fail("discord_identity_failed", "Unable to read Discord user identity.", 502);
    }

    const membership = await fetchGuildMember({ discordUserId });
    if (!membership.ok) {
      return fail(membership.error, membership.message, membership.statusCode);
    }

    const tierConfig = getTierFromRoles(membership.roles);
    if (!tierConfig) {
      return fail(
        "not_entitled",
        "No entitled Discord tier role found (Patreon Tier 1/2/Founder).",
        403
      );
    }

    const issued = await tokenStore.issueOrGetToken({
      discordUserId,
      rotate: true,
      source: "discord-oauth",
      notes: "module_discord_link",
      tier: tierConfig.tier,
      monthlyGenerationLimit: tierConfig.monthlyGenerationLimit,
      ttlDays: TOKEN_TTL_DAYS
    });

    const payload = {
      linked: "true",
      token: issued.token,
      tier: tierConfig.tier,
      monthlyGenerationLimit: String(tierConfig.monthlyGenerationLimit),
      discordUserId,
      expiresAt: issued.record.expiresAt || ""
    };
    const redirect = returnUrl ? buildRedirectUrl(returnUrl, payload) : null;
    if (redirect) {
      return res.redirect(302, redirect);
    }

    return res.json({
      ok: true,
      ...payload
    });
  } catch (error) {
    return fail(
      "discord_link_failed",
      error.message || "Failed to complete Discord linking.",
      Number(error.status) || 500
    );
  }
});

app.get("/api/subscription/status", authorizeSubscriptionToken, async (req, res) => {
  const entitled = await syncManagedDiscordEntitlement(req, res);
  if (!entitled) {
    return;
  }
  const usage = await tokenStore.getMonthlyUsage(getUsageKey(req.auth), monthKey());
  const monthlyGenerationLimit =
    typeof req.auth.monthlyGenerationLimit === "number"
      ? req.auth.monthlyGenerationLimit
      : null;
  const remainingGenerations =
    req.auth.unlimited || monthlyGenerationLimit === null
      ? null
      : Math.max(0, monthlyGenerationLimit - usage.generations);
  res.json({
    active: true,
    unlimited: req.auth.unlimited,
    tier: req.auth.isOwner ? "owner" : req.auth.tier || "subscriber",
    month: monthKey(),
    usage,
    monthlyGenerationLimit,
    remainingGenerations,
    expiresAt: req.auth.expiresAt || null
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
  const rawSeed = req.body?.seed;
  let normalizedSeed;
  if (rawSeed !== undefined && rawSeed !== null && String(rawSeed).trim() !== "") {
    const parsedSeed = Number.parseInt(String(rawSeed), 10);
    if (Number.isFinite(parsedSeed)) {
      normalizedSeed = parsedSeed;
    } else {
      console.warn(
        JSON.stringify({
          event: "maps_generate_invalid_seed_ignored",
          provider: PROVIDER_NAME,
          model: MODEL_NAME,
          endpoint: BFL_GENERATE_ENDPOINT
        })
      );
    }
  }

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
    seed: normalizedSeed
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === null || Number.isNaN(payload[key])) {
      delete payload[key];
    }
  });

  try {
    const entitled = await syncManagedDiscordEntitlement(req, res);
    if (!entitled) {
      return;
    }
    const usageMonth = monthKey();
    const usage = await tokenStore.getMonthlyUsage(getUsageKey(req.auth), usageMonth);
    if (
      !req.auth.unlimited &&
      typeof req.auth.monthlyGenerationLimit === "number" &&
      usage.generations >= req.auth.monthlyGenerationLimit
    ) {
      return res.status(429).json({
        error: "quota_exceeded",
        message: "Monthly generation quota reached for your subscription tier.",
        monthlyGenerationLimit: req.auth.monthlyGenerationLimit,
        month: usageMonth,
        usage
      });
    }

    const initialResponse = await fetchJson(BFL_GENERATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-key": BFL_API_KEY,
        Authorization: `Bearer ${BFL_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const generationId = extractGenerationId(initialResponse);

    const result = await pollBflResult(initialResponse, generationId);
    const imageUrl = selectImageUrl(result);

    if (!imageUrl) {
      throw createGenerationError("provider_response_invalid", "No image URL returned by BFL.", {
        status: 502,
        upstreamStatus: 502,
        generationId: extractGenerationId(result) || generationId,
        endpoint: BFL_RESULT_ENDPOINT,
        upstream: result
      });
    }
    await tokenStore.incrementMonthlyUsage(getUsageKey(req.auth), usageMonth, imageCount);
    if (req.auth.recordId) {
      await tokenStore.touchLastUsedById(req.auth.recordId);
    }

    const finalGenerationId = extractGenerationId(result) || generationId;

    return res.json({
      imagePath: imageUrl,
      image_url: imageUrl,
      url: imageUrl,
      provider: PROVIDER_NAME,
      model: MODEL_NAME,
      endpoint: BFL_GENERATE_ENDPOINT,
      estimatedCost:
        Number(result?.cost ?? result?.result?.cost ?? imageCount * ESTIMATED_COST_PER_IMAGE) || 0,
      generationId: finalGenerationId,
      imageCount,
      metadata: {
        provider: PROVIDER_NAME,
        model: MODEL_NAME,
        endpoint: BFL_GENERATE_ENDPOINT,
        estimatedCost:
          Number(result?.cost ?? result?.result?.cost ?? imageCount * ESTIMATED_COST_PER_IMAGE) || 0,
        generationId: finalGenerationId,
        imageCount
      }
    });
  } catch (error) {
    const failure = buildGenerationFailure(error);
    console.error(
      JSON.stringify({
        event: "maps_generate_failed",
        endpoint: failure.payload.endpoint,
        upstreamStatus: failure.payload.upstreamStatus,
        reason: failure.payload.reason,
        detail: failure.payload.detail,
        generationId: failure.payload.generationId,
        requestId: failure.payload.requestId,
        upstream: failure.payload.upstream
      })
    );
    return res.status(failure.statusCode).json(failure.payload);
  }
});

app.post("/api/maps/image/fetch", authorizeSubscriptionToken, async (req, res) => {
  const imageUrl = String(
    req.body?.imageUrl || req.body?.url || req.body?.image_url || req.body?.imagePath || ""
  ).trim();
  if (!imageUrl) {
    return res.status(400).json({
      error: "invalid_image_url",
      reason: "missing_image_url",
      detail: "Provide imageUrl/url/image_url/imagePath."
    });
  }
  if (!isAllowedImageUrl(imageUrl)) {
    return res.status(400).json({
      error: "invalid_image_url",
      reason: "disallowed_image_host",
      detail: "Image URL must be https and hosted on an allowed BFL domain."
    });
  }

  try {
    const fetched = await fetchImageAsBase64(imageUrl);
    const extension = extensionFromContentType(fetched.contentType);
    return res.json({
      ok: true,
      provider: PROVIDER_NAME,
      model: MODEL_NAME,
      sourceUrl: imageUrl,
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      extension,
      filename: `sceneforge-${Date.now()}.${extension}`,
      base64: fetched.base64,
      dataUrl: fetched.dataUrl
    });
  } catch (error) {
    const failure = buildGenerationFailure(error);
    console.error(
      JSON.stringify({
        event: "maps_image_fetch_failed",
        endpoint: imageUrl,
        upstreamStatus: failure.payload.upstreamStatus,
        reason: failure.payload.reason,
        detail: failure.payload.detail,
        requestId: failure.payload.requestId
      })
    );
    return res.status(failure.statusCode).json(failure.payload);
  }
});

app.post("/api/maps/image/proxy", authorizeSubscriptionToken, async (req, res) => {
  const imageUrl = String(
    req.body?.imageUrl || req.body?.url || req.body?.image_url || req.body?.imagePath || ""
  ).trim();
  if (!imageUrl) {
    return res.status(400).json({
      error: "invalid_image_url",
      reason: "missing_image_url",
      detail: "Provide imageUrl/url/image_url/imagePath."
    });
  }
  if (!isAllowedImageUrl(imageUrl)) {
    return res.status(400).json({
      error: "invalid_image_url",
      reason: "disallowed_image_host",
      detail: "Image URL must be https and hosted on an allowed BFL domain."
    });
  }

  try {
    const fetched = await fetchImageAsBase64(imageUrl);
    return res.json({
      ok: true,
      provider: PROVIDER_NAME,
      model: MODEL_NAME,
      sourceUrl: imageUrl,
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      base64: fetched.base64,
      dataUrl: fetched.dataUrl
    });
  } catch (error) {
    const failure = buildGenerationFailure(error);
    console.error(
      JSON.stringify({
        event: "maps_image_proxy_failed",
        endpoint: imageUrl,
        upstreamStatus: failure.payload.upstreamStatus,
        reason: failure.payload.reason,
        detail: failure.payload.detail,
        requestId: failure.payload.requestId
      })
    );
    return res.status(failure.statusCode).json(failure.payload);
  }
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
