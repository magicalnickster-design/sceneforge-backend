const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { TokenStore } = require("./lib/tokenStore");
const { fetchGuildMember } = require("./lib/discordEntitlement");
const { IdempotencyStore } = require("./lib/idempotencyStore");
const { parseStaticTokens, createSubscriptionAuthorizer } = require("./lib/auth");

dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT || 3000);
const BFL_API_KEY = process.env.BFL_API_KEY || "";
const OWNER_ACCESS_TOKEN = process.env.OWNER_ACCESS_TOKEN || "";
const SUBSCRIPTION_TOKENS = parseStaticTokens(process.env.SUBSCRIPTION_TOKENS || "");
const ALLOW_STATIC_SUBSCRIPTION_TOKENS =
  String(process.env.ALLOW_STATIC_SUBSCRIPTION_TOKENS || "").toLowerCase() === "true";
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
const GENERATE_RATE_LIMIT_PER_MIN = Math.max(
  1,
  Number(process.env.GENERATE_RATE_LIMIT_PER_MIN || 20)
);
const GAMBITS_GENERATE_RATE_LIMIT_PER_MIN = Math.max(
  1,
  Number(process.env.GAMBITS_GENERATE_RATE_LIMIT_PER_MIN || GENERATE_RATE_LIMIT_PER_MIN)
);
const IMAGE_FETCH_RATE_LIMIT_PER_MIN = Math.max(
  1,
  Number(process.env.IMAGE_FETCH_RATE_LIMIT_PER_MIN || 40)
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
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const GAMBITS_JWT_ALGORITHMS = (process.env.GAMBITS_JWT_ALGORITHMS || "HS256")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const GAMBITS_JWT_ISSUER = process.env.GAMBITS_JWT_ISSUER || "";
const GAMBITS_JWT_AUDIENCE = process.env.GAMBITS_JWT_AUDIENCE || "";
const IDEMPOTENCY_DB_PATH =
  process.env.IDEMPOTENCY_DB_PATH || path.join(process.cwd(), "data", "idempotency.sqlite");

const BFL_GENERATE_ENDPOINT = "https://api.bfl.ai/v1/flux-2-flex";
const BFL_RESULT_ENDPOINT = "https://api.bfl.ai/v1/get_result";
const PROVIDER_NAME = "black-forest-labs";
const MODEL_NAME = "flux-2-flex";
const PROVIDER_MAX_ATTEMPTS = 2;
const PROVIDER_RETRY_BASE_MS = Math.max(100, Number(process.env.PROVIDER_RETRY_BASE_MS || 500));
const PROVIDER_TIMEOUT_MS = Math.max(1000, Number(process.env.PROVIDER_TIMEOUT_MS || 45000));
const STRICT_CACHE_CONTRACT = String(process.env.STRICT_CACHE_CONTRACT || "false").toLowerCase() === "true";
const ALLOWED_IMAGE_HOST_SUFFIXES = [".bfl.ai"];
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif"
]);

const mapLibrary = new Map();
const rateLimitBuckets = new Map();
const ALLOWED_CORS_HEADERS = ["Authorization", "Content-Type", "Idempotency-Key"];
const tokenStore = new TokenStore({
  dbPath: DB_PATH,
  tokenPepper: TOKEN_SIGNING_PEPPER
});
const idempotencyStore = new IdempotencyStore({
  dbPath: IDEMPOTENCY_DB_PATH
});
let idempotencyReady = false;
try {
  idempotencyStore.init();
  idempotencyReady = true;
} catch (error) {
  console.error("Failed to initialize idempotency storage:", error.message);
}

const app = express();

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    const hostname = String(parsed.hostname || "").toLowerCase();
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      ["localhost", "127.0.0.1", "::1"].includes(hostname)
    ) {
      return true;
    }
    if (parsed.protocol === "https:") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = isAllowedCorsOrigin(origin);

  if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_CORS_HEADERS.join(", "));

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (origin && !allowed) {
    return res.status(403).json({
      error: "forbidden_origin",
      message: "Origin is not allowed."
    });
  }
  return next();
});
app.use(express.json({ limit: "2mb" }));

const authorizeSubscriptionToken = createSubscriptionAuthorizer({
  ownerAccessToken: OWNER_ACCESS_TOKEN,
  staticSubscriptionTokens: SUBSCRIPTION_TOKENS,
  allowStaticSubscriptionTokens: ALLOW_STATIC_SUBSCRIPTION_TOKENS,
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

function applyRateLimit({ key, limit, windowMs, bucketPrefix }) {
  const now = Date.now();
  const bucketKey = `${bucketPrefix}:${key}`;
  const existing = rateLimitBuckets.get(bucketKey);
  if (!existing || now > existing.resetAt) {
    rateLimitBuckets.set(bucketKey, {
      count: 1,
      resetAt: now + windowMs
    });
    return { allowed: true };
  }
  if (existing.count >= limit) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, existing.resetAt - now)
    };
  }
  existing.count += 1;
  rateLimitBuckets.set(bucketKey, existing);
  return { allowed: true };
}

function parseImageSize(rawSize) {
  const match = String(rawSize || "")
    .trim()
    .match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) {
    return null;
  }
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

function normalizeOrientation(rawOrientation) {
  const normalized = String(rawOrientation || "").trim().toLowerCase();
  if (["portrait", "landscape", "square"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function normalizeDimensions({ width, height, imageSize, orientation }) {
  const imageSizeDimensions = parseImageSize(imageSize);
  let nextWidth = Number(width) || imageSizeDimensions?.width || 1024;
  let nextHeight = Number(height) || imageSizeDimensions?.height || 1024;
  const normalizedOrientation = normalizeOrientation(orientation);

  if (normalizedOrientation === "portrait") {
    if (nextWidth >= nextHeight) {
      const shortSide = Math.min(nextWidth, nextHeight);
      const longSide = Math.max(nextWidth, nextHeight);
      nextWidth = shortSide;
      nextHeight = longSide === shortSide ? shortSide + 1 : longSide;
    }
  } else if (normalizedOrientation === "landscape") {
    if (nextWidth <= nextHeight) {
      const shortSide = Math.min(nextWidth, nextHeight);
      const longSide = Math.max(nextWidth, nextHeight);
      nextWidth = longSide === shortSide ? longSide + 1 : longSide;
      nextHeight = shortSide;
    }
  } else if (normalizedOrientation === "square") {
    const side = Math.max(nextWidth, nextHeight);
    nextWidth = side;
    nextHeight = side;
  }

  return {
    width: Math.max(256, Math.floor(nextWidth)),
    height: Math.max(256, Math.floor(nextHeight)),
    orientation: normalizedOrientation
  };
}

function orientationMatches(orientation, width, height) {
  if (!orientation) {
    return true;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return false;
  }
  if (orientation === "portrait") {
    return height > width;
  }
  if (orientation === "landscape") {
    return width > height;
  }
  if (orientation === "square") {
    return width === height;
  }
  return true;
}

function applyOrientationPrompt(prompt, orientation, strengthen = false) {
  if (!orientation) {
    return prompt;
  }
  const baseInstruction =
    orientation === "portrait"
      ? "Output must be portrait orientation (height greater than width)."
      : orientation === "landscape"
        ? "Output must be landscape orientation (width greater than height)."
        : "Output must be square orientation (equal width and height).";
  const strongerInstruction = strengthen
    ? ` CRITICAL: Strictly enforce ${orientation} orientation. Reject wrong orientation.`
    : "";
  return `${String(prompt || "").trim()} ${baseInstruction}${strongerInstruction}`.trim();
}

function extractProviderDimensions(payload) {
  const candidates = [
    payload?.width && payload?.height ? { width: payload.width, height: payload.height } : null,
    payload?.result?.width && payload?.result?.height
      ? { width: payload.result.width, height: payload.result.height }
      : null,
    payload?.result?.image?.width && payload?.result?.image?.height
      ? { width: payload.result.image.width, height: payload.result.image.height }
      : null
  ].filter(Boolean);

  if (Array.isArray(payload?.result?.images) && payload.result.images[0]) {
    const first = payload.result.images[0];
    if (first?.width && first?.height) {
      candidates.push({ width: first.width, height: first.height });
    }
  }

  if (Array.isArray(payload?.images) && payload.images[0]) {
    const first = payload.images[0];
    if (first?.width && first?.height) {
      candidates.push({ width: first.width, height: first.height });
    }
  }

  for (const candidate of candidates) {
    const width = Number(candidate.width);
    const height = Number(candidate.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return {
        width: Math.floor(width),
        height: Math.floor(height),
        source: "provider-payload"
      };
    }
  }

  return null;
}

function parseImageDimensionsFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    return null;
  }

  // PNG
  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 12, 16) === "IHDR") {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      source: "png-bytes"
    };
  }

  // GIF
  if (buffer.toString("ascii", 0, 3) === "GIF") {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
      source: "gif-bytes"
    };
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker) &&
        offset + 8 < buffer.length
      ) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
          source: "jpeg-bytes"
        };
      }
      if (!size || size < 2) {
        break;
      }
      offset += size + 2;
    }
  }

  // WEBP (VP8X)
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    if (buffer.toString("ascii", 12, 16) === "VP8X" && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height, source: "webp-bytes" };
    }
  }

  return null;
}

function isRetryableProviderError(error) {
  const status = Number(error?.upstreamStatus || error?.status || 0);
  if (!status) {
    return true;
  }
  return status === 502 || status === 503 || status === 504;
}

function parseBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = String(authHeader).split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }
  return token.trim();
}

function normalizeGenerateError(error, message) {
  return { error, message };
}

function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function requireGambitsJwt(req, res, next) {
  if (!SESSION_SECRET) {
    return res
      .status(503)
      .json(normalizeGenerateError("BACKEND_UNAVAILABLE", "Session validation is not configured."));
  }

  const token = parseBearerToken(req);
  if (!token) {
    return res.status(401).json(normalizeGenerateError("AUTH_REQUIRED", "Bearer token is required."));
  }

  try {
    const verifyOptions = { algorithms: GAMBITS_JWT_ALGORITHMS };
    if (GAMBITS_JWT_ISSUER) {
      verifyOptions.issuer = GAMBITS_JWT_ISSUER;
    }
    if (GAMBITS_JWT_AUDIENCE) {
      verifyOptions.audience = GAMBITS_JWT_AUDIENCE;
    }
    const payload = jwt.verify(token, SESSION_SECRET, verifyOptions);
    const userId = String(payload?.sub || payload?.userId || "").trim();
    if (!userId) {
      return res.status(401).json(normalizeGenerateError("AUTH_REQUIRED", "Invalid session token."));
    }
    const emailVerified = payload?.email_verified === true || payload?.emailVerified === true;
    if (!emailVerified) {
      return res
        .status(403)
        .json(normalizeGenerateError("EMAIL_NOT_VERIFIED", "Verified email is required."));
    }
    req.gambitsAuth = { userId };
    return next();
  } catch (error) {
    if (error?.name === "TokenExpiredError") {
      return res
        .status(401)
        .json(normalizeGenerateError("SESSION_EXPIRED", "Session token has expired."));
    }
    return res.status(401).json(normalizeGenerateError("AUTH_REQUIRED", "Invalid session token."));
  }
}

function requireIdempotencyKey(req, res, next) {
  const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
  if (!isUuidV4(idempotencyKey)) {
    return res
      .status(400)
      .json(
        normalizeGenerateError(
          "INVALID_IDEMPOTENCY_KEY",
          "A valid UUID Idempotency-Key header is required."
        )
      );
  }
  req.idempotencyKey = idempotencyKey;
  return next();
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
  const { timeoutMs = PROVIDER_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutHandle =
    timeoutMs > 0
      ? setTimeout(() => {
        controller.abort();
      }, timeoutMs)
      : null;
  let response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
  } catch (cause) {
    const error = new Error(cause?.message || "Provider request failed.");
    error.status = cause?.name === "AbortError" ? 504 : 503;
    error.detail =
      cause?.name === "AbortError"
        ? `Provider request timed out after ${timeoutMs}ms.`
        : cause?.message || "Provider request failed.";
    error.endpoint = url;
    error.requestId = null;
    error.details = null;
    error.isNetworkError = true;
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
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
  const normalizedContentType = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(normalizedContentType)) {
    throw createGenerationError(
      "invalid_image_content_type",
      "Image content type is not allowed for proxying.",
      {
        status: 415,
        upstreamStatus: 415,
        endpoint: imageUrl,
        upstream: {
          contentType
        }
      }
    );
  }
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
    contentType: normalizedContentType,
    bytes: buffer.length,
    base64,
    dataUrl: `data:${normalizedContentType};base64,${base64}`
  };
}

async function fetchImageDimensions(imageUrl) {
  if (!isAllowedImageUrl(imageUrl)) {
    throw createGenerationError(
      "disallowed_image_host",
      "Generated image host is not allowed for verification.",
      {
        status: 400,
        upstreamStatus: 400,
        endpoint: imageUrl
      }
    );
  }
  const response = await fetch(imageUrl, {
    method: "GET",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw createGenerationError(
      "upstream_image_fetch_failed",
      `Image dimension fetch failed with status ${response.status}.`,
      {
        status: response.status,
        upstreamStatus: response.status,
        endpoint: imageUrl,
        requestId:
          response.headers.get("x-request-id") ||
          response.headers.get("request-id") ||
          response.headers.get("cf-ray") ||
          null
      }
    );
  }
  const contentType = String(response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
    throw createGenerationError(
      "invalid_image_content_type",
      "Generated image content type is not allowed.",
      {
        status: 415,
        upstreamStatus: 415,
        endpoint: imageUrl,
        upstream: { contentType }
      }
    );
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_IMAGE_BYTES) {
    throw createGenerationError(
      "image_too_large",
      `Generated image exceeds max verification size of ${MAX_PROXY_IMAGE_BYTES} bytes.`,
      {
        status: 413,
        upstreamStatus: 413,
        endpoint: imageUrl
      }
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const parsed = parseImageDimensionsFromBuffer(buffer);
  if (!parsed?.width || !parsed?.height) {
    throw createGenerationError(
      "provider_dimension_unavailable",
      "Unable to verify generated image dimensions.",
      {
        status: 502,
        upstreamStatus: 502,
        endpoint: imageUrl
      }
    );
  }
  return parsed;
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

async function runProviderGenerationWithRetries({
  idempotencyKey,
  requestedOrientation,
  requestedDimensions,
  basePayload
}) {
  let payload = { ...basePayload };
  let lastError = null;

  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const initialResponse = await fetchJson(BFL_GENERATE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-key": BFL_API_KEY,
          Authorization: `Bearer ${BFL_API_KEY}`
        },
        body: JSON.stringify(payload),
        timeoutMs: PROVIDER_TIMEOUT_MS
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

      const providerDimensions =
        extractProviderDimensions(result) ||
        extractProviderDimensions(initialResponse) ||
        (await fetchImageDimensions(imageUrl));
      const orientationValid = orientationMatches(
        requestedOrientation,
        providerDimensions?.width,
        providerDimensions?.height
      );

      console.info(
        JSON.stringify({
          event: "maps_generate_orientation_check",
          attempt,
          requestedOrientation: requestedOrientation || null,
          requestedDimensions,
          providerDimensions,
          finalDimensions: providerDimensions,
          idempotencyKey
        })
      );

      if (!orientationValid) {
        throw createGenerationError(
          "orientation_mismatch",
          `Provider returned ${providerDimensions.width}x${providerDimensions.height}, which does not match requested ${requestedOrientation} orientation.`,
          {
            status: 422,
            upstreamStatus: 422,
            generationId: extractGenerationId(result) || generationId,
            endpoint: BFL_RESULT_ENDPOINT,
            upstream: {
              requestedOrientation,
              requestedDimensions,
              providerDimensions
            }
          }
        );
      }

      return {
        initialResponse,
        result,
        imageUrl,
        generationId: extractGenerationId(result) || generationId
      };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableProviderError(error) || error?.reason === "orientation_mismatch";
      const canRetry = attempt < PROVIDER_MAX_ATTEMPTS && retryable;

      console.error(
        JSON.stringify({
          event: "maps_generate_provider_attempt_failed",
          attempt,
          maxAttempts: PROVIDER_MAX_ATTEMPTS,
          retryable,
          canRetry,
          idempotencyKey,
          requestedOrientation: requestedOrientation || null,
          requestedDimensions,
          providerStatus: Number(error?.upstreamStatus || error?.status || 0) || null,
          reason: error?.reason || classifyGenerationReason(error),
          detail: error?.detail || error?.message || "Provider request failed.",
          endpoint: error?.endpoint || BFL_GENERATE_ENDPOINT,
          elapsedMs: Date.now() - attemptStartedAt
        })
      );

      if (!canRetry) {
        break;
      }

      if (error?.reason === "orientation_mismatch") {
        const corrected = normalizeDimensions({
          width: requestedDimensions.width,
          height: requestedDimensions.height,
          orientation: requestedOrientation
        });
        payload = {
          ...basePayload,
          width: corrected.width,
          height: corrected.height,
          prompt: applyOrientationPrompt(basePayload.prompt, requestedOrientation, true)
        };
      }

      const backoffMs = PROVIDER_RETRY_BASE_MS * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }

  const finalError =
    lastError ||
    createGenerationError("provider_retry_exhausted", "Provider retries were exhausted.", {
      status: 502,
      upstreamStatus: 502,
      endpoint: BFL_GENERATE_ENDPOINT
    });
  finalError.finalCode = finalError?.reason || "provider_retry_exhausted";
  throw finalError;
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

app.post("/api/maps/generate", requireGambitsJwt, requireIdempotencyKey, async (req, res) => {
  if (!BFL_API_KEY) {
    return res
      .status(503)
      .json(normalizeGenerateError("BACKEND_UNAVAILABLE", "Generation backend is unavailable."));
  }

  const prompt = String(req.body?.prompt || "").trim();
  const imageCount = Math.max(1, Number(req.body?.imageCount || DEFAULT_IMAGE_COUNT));
  const requestedOrientation = normalizeOrientation(req.body?.imageOrientation || req.body?.orientation);
  const requestedDimensions = normalizeDimensions({
    width: req.body?.width,
    height: req.body?.height,
    imageSize: req.body?.imageSize,
    orientation: requestedOrientation
  });
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
    return res.status(400).json(normalizeGenerateError("GENERATION_FAILED", "Field 'prompt' is required."));
  }

  const payload = {
    prompt: applyOrientationPrompt(prompt, requestedOrientation, false),
    width: requestedDimensions.width,
    height: requestedDimensions.height,
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

  if (!idempotencyReady) {
    return res
      .status(503)
      .json(normalizeGenerateError("BACKEND_UNAVAILABLE", "Idempotency storage is unavailable."));
  }

  const rateLimit = applyRateLimit({
    key: req.gambitsAuth.userId,
    limit: GAMBITS_GENERATE_RATE_LIMIT_PER_MIN,
    windowMs: 60 * 1000,
    bucketPrefix: "gambits-generate"
  });
  if (!rateLimit.allowed) {
    return res.status(429).json(normalizeGenerateError("RATE_LIMITED", "Too many generation requests."));
  }

  let idemState;
  try {
    idemState = idempotencyStore.beginProcessing(req.gambitsAuth.userId, req.idempotencyKey);
  } catch {
    return res
      .status(503)
      .json(normalizeGenerateError("BACKEND_UNAVAILABLE", "Idempotency storage is unavailable."));
  }

  if (idemState.state === "completed" && idemState.response) {
    return res.json(idemState.response);
  }
  if (idemState.state === "in_progress") {
    return res
      .status(409)
      .json(
        normalizeGenerateError(
          "GENERATION_IN_PROGRESS",
          "A generation with this Idempotency-Key is already in progress."
        )
      );
  }

  try {
    const providerResult = await runProviderGenerationWithRetries({
      idempotencyKey: req.idempotencyKey,
      requestedOrientation,
      requestedDimensions: {
        width: requestedDimensions.width,
        height: requestedDimensions.height
      },
      basePayload: payload
    });
    const imageUrl = providerResult.imageUrl;
    const finalGenerationId = providerResult.generationId;
    const providerPayload = providerResult.result || {};
    const responsePayload = {
      imagePath: imageUrl,
      image_url: imageUrl,
      url: imageUrl,
      provider: PROVIDER_NAME,
      model: MODEL_NAME,
      endpoint: BFL_GENERATE_ENDPOINT,
      estimatedCost:
        Number(
          providerPayload?.cost ??
          providerPayload?.result?.cost ??
          imageCount * ESTIMATED_COST_PER_IMAGE
        ) || 0,
      generationId: finalGenerationId,
      imageCount,
      metadata: {
        provider: PROVIDER_NAME,
        model: MODEL_NAME,
        endpoint: BFL_GENERATE_ENDPOINT,
        estimatedCost:
          Number(
            providerPayload?.cost ??
            providerPayload?.result?.cost ??
            imageCount * ESTIMATED_COST_PER_IMAGE
          ) || 0,
        generationId: finalGenerationId,
        imageCount
      }
    };

    idempotencyStore.markCompleted(req.gambitsAuth.userId, req.idempotencyKey, responsePayload);
    return res.json(responsePayload);
  } catch (error) {
    idempotencyStore.markFailed(
      req.gambitsAuth.userId,
      req.idempotencyKey,
      "GENERATION_FAILED",
      "Generation failed. Safe retry allowed with the same Idempotency-Key."
    );
    const finalCode = error?.finalCode || error?.reason || "provider_retry_exhausted";
    return res
      .status(502)
      .json(
        normalizeGenerateError(
          "GENERATION_FAILED",
          `Generation failed (${finalCode}). Retry with the same Idempotency-Key.`
        )
      );
  }
});

app.post("/api/maps/image/fetch", requireGambitsJwt, async (req, res) => {
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
    const rateLimit = applyRateLimit({
      key: req.gambitsAuth.userId,
      limit: IMAGE_FETCH_RATE_LIMIT_PER_MIN,
      windowMs: 60 * 1000,
      bucketPrefix: "image-fetch"
    });
    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: "rate_limited",
        reason: "image_fetch_rate_limited",
        detail: "Too many image fetch requests. Please retry shortly.",
        retryAfterMs: rateLimit.retryAfterMs
      });
    }
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

app.post("/api/maps/image/proxy", requireGambitsJwt, async (req, res) => {
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
    const rateLimit = applyRateLimit({
      key: req.gambitsAuth.userId,
      limit: IMAGE_FETCH_RATE_LIMIT_PER_MIN,
      windowMs: 60 * 1000,
      bucketPrefix: "image-proxy"
    });
    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: "rate_limited",
        reason: "image_fetch_rate_limited",
        detail: "Too many image proxy requests. Please retry shortly.",
        retryAfterMs: rateLimit.retryAfterMs
      });
    }
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
    if (!STRICT_CACHE_CONTRACT) {
      return res.json({
        found: false,
        key: null,
        map: null,
        skipped: true,
        reason: "missing_key"
      });
    }
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
    if (!STRICT_CACHE_CONTRACT) {
      return res.json({
        ok: false,
        skipped: true,
        reason: "invalid_payload",
        message: "Fields key/mapKey/fingerprint and image_url/url/imagePath are required."
      });
    }
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
  if (!idempotencyReady) {
    idempotencyStore.init();
    idempotencyReady = true;
  }
  app.listen(PORT, () => {
    console.log(`SceneForge backend listening on port ${PORT}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Failed to initialize server:", error.message);
    process.exit(1);
  });
}

module.exports = { app, start };
