const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseStaticTokens,
  createBotSecretMiddleware,
  createSubscriptionAuthorizer
} = require("../src/lib/auth");

test("bot secret middleware rejects invalid secrets", async () => {
  const middleware = createBotSecretMiddleware("shared-secret");
  const req = { headers: { "x-bot-secret": "wrong" } };
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
  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.error, "unauthorized_bot");
});

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
