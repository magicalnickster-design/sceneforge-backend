const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseStaticTokens,
  createSubscriptionAuthorizer
} = require("../src/lib/auth");

test("subscription authorizer supports static fallback tokens", async () => {
  const middleware = createSubscriptionAuthorizer({
    ownerAccessToken: "owner",
    staticSubscriptionTokens: parseStaticTokens("legacy_a,legacy_b"),
    tokenStore: {
      async validateToken() {
        return null;
      }
    }
  });

  const req = {
    headers: {
      authorization: "Bearer legacy_a"
    }
  };
  const result = { statusCode: 200, body: null };
  const res = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(payload) {
      result.body = payload;
      return this;
    }
  };

  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.auth.source, "static");
});

test("subscription authorizer accepts managed token records", async () => {
  const middleware = createSubscriptionAuthorizer({
    ownerAccessToken: "owner",
    staticSubscriptionTokens: parseStaticTokens(""),
    tokenStore: {
      async validateToken(token) {
        if (token !== "managed") {
          return null;
        }
        return {
          id: "rec-1",
          discordUserId: "12345",
          tier: "tier2",
          monthlyGenerationLimit: 600,
          expiresAt: "2099-01-01T00:00:00.000Z"
        };
      }
    }
  });

  const req = {
    headers: {
      authorization: "Bearer managed"
    }
  };
  const result = { statusCode: 200, body: null };
  const res = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(payload) {
      result.body = payload;
      return this;
    }
  };

  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.auth.source, "managed-token");
  assert.equal(req.auth.discordUserId, "12345");
  assert.equal(req.auth.monthlyGenerationLimit, 600);
});
