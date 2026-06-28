const { safeCompare } = require("./security");

function parseBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }
  return token.trim();
}

function parseStaticTokens(value = "") {
  return new Set(
    String(value)
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function createSubscriptionAuthorizer({
  ownerAccessToken,
  staticSubscriptionTokens,
  tokenStore
}) {
  return async function authorizeSubscriptionToken(req, res, next) {
    try {
      const token = parseBearerToken(req);
      if (!token) {
        return res.status(401).json({
          error: "missing_bearer_token",
          message: "Bearer token is required."
        });
      }

      if (ownerAccessToken && safeCompare(token, ownerAccessToken)) {
        req.auth = {
          token,
          isOwner: true,
          unlimited: true,
          source: "owner"
        };
        return next();
      }

      if (staticSubscriptionTokens.has(token)) {
        req.auth = {
          token,
          isOwner: false,
          unlimited: false,
          source: "static"
        };
        return next();
      }

      const record = await tokenStore.validateToken(token);
      if (record) {
        req.auth = {
          token,
          isOwner: false,
          unlimited: false,
          source: "managed-token",
          discordUserId: record.discordUserId,
          recordId: record.id,
          tier: record.tier || "subscriber",
          monthlyGenerationLimit:
            typeof record.monthlyGenerationLimit === "number"
              ? record.monthlyGenerationLimit
              : null,
          expiresAt: record.expiresAt || null
        };
        return next();
      }

      return res.status(403).json({
        error: "invalid_subscription_token",
        message: "Provided token is not active."
      });
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  parseBearerToken,
  parseStaticTokens,
  createSubscriptionAuthorizer
};
