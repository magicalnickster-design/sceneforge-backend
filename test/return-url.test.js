const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAllowedOrigins,
  validateFoundryReturnUrl,
  appendQueryParam,
  appendHashParams,
  isApprovedExchangeOrigin
} = require("../src/lib/returnUrl");

test("valid forge return URL accepted", () => {
  const result = validateFoundryReturnUrl("https://myworld.forge-vtt.com/game", {
    allowedOrigins: []
  });
  assert.equal(result.ok, true);
});

test("valid custom hosted return URL from allowlist accepted", () => {
  const allowlist = parseAllowedOrigins("https://table.example.com");
  const result = validateFoundryReturnUrl("https://table.example.com/foundry/game", {
    allowedOrigins: allowlist
  });
  assert.equal(result.ok, true);
});

test("localhost return URL accepted for development", () => {
  const result = validateFoundryReturnUrl("http://localhost:30000/game", {
    allowedOrigins: []
  });
  assert.equal(result.ok, true);
});

test("invalid protocol rejected", () => {
  const result = validateFoundryReturnUrl("javascript:alert(1)", {
    allowedOrigins: []
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_protocol");
});

test("credentials in URL rejected", () => {
  const result = validateFoundryReturnUrl("https://user:pass@forge-vtt.com/game", {
    allowedOrigins: []
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_credentials");
});

test("open redirect/unapproved origin rejected", () => {
  const result = validateFoundryReturnUrl("https://evil.example.com/game", {
    allowedOrigins: parseAllowedOrigins("https://safe.example.com")
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unapproved_origin");
});

test("existing query parameters and route prefixes are preserved", () => {
  const output = appendQueryParam(
    "https://table.example.com/foundry/route/game?foo=bar&x=1",
    "sceneforgeLinkCode",
    "abc123"
  );
  const parsed = new URL(output);
  assert.equal(parsed.pathname, "/foundry/route/game");
  assert.equal(parsed.searchParams.get("foo"), "bar");
  assert.equal(parsed.searchParams.get("x"), "1");
  assert.equal(parsed.searchParams.get("sceneforgeLinkCode"), "abc123");
});

test("desktop relay style hash payload is preserved", () => {
  const output = appendHashParams("http://localhost:30000/game?foo=bar", {
    linked: "true",
    token: "abc"
  });
  const parsed = new URL(output);
  assert.equal(parsed.searchParams.get("foo"), "bar");
  assert.equal(parsed.hash.includes("linked=true"), true);
  assert.equal(parsed.hash.includes("token=abc"), true);
});

test("exchange CORS origin allow/reject helper", () => {
  const allowedOrigins = parseAllowedOrigins("https://safe.example.com");
  const allowed = isApprovedExchangeOrigin("https://safe.example.com", {
    allowedOrigins
  });
  const rejected = isApprovedExchangeOrigin("https://evil.example.com", {
    allowedOrigins
  });
  assert.equal(allowed, true);
  assert.equal(rejected, false);
});
