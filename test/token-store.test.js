const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { TokenStore } = require("../src/lib/tokenStore");

test("token store issues, reuses, rotates, and revokes tokens", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-store-"));
  const dbPath = path.join(tempDir, "tokens.json");
  const store = new TokenStore({ dbPath, tokenPepper: "pepper-test" });
  await store.init();

  const first = await store.issueOrGetToken({
    discordUserId: "123",
    source: "discord-bot"
  });
  assert.equal(first.reused, false);
  assert.ok(first.token);

  const reused = await store.issueOrGetToken({
    discordUserId: "123",
    source: "discord-bot"
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.token, null);

  const validatedFirst = await store.validateToken(first.token);
  assert.equal(validatedFirst.discordUserId, "123");

  const rotated = await store.issueOrGetToken({
    discordUserId: "123",
    rotate: true,
    source: "discord-bot"
  });
  assert.equal(rotated.reused, false);
  assert.ok(rotated.token);
  assert.notEqual(rotated.token, first.token);

  const oldTokenAfterRotate = await store.validateToken(first.token);
  assert.equal(oldTokenAfterRotate, null);

  const revocation = await store.revokeActiveTokenForUser("123", "manual");
  assert.equal(revocation.revoked, true);

  const status = await store.getStatusForUser("123");
  assert.equal(status.hasActiveToken, false);
});

test("token store persists monthly usage by key", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-usage-"));
  const dbPath = path.join(tempDir, "tokens.json");
  const store = new TokenStore({ dbPath, tokenPepper: "pepper-test" });
  await store.init();

  const month = "2026-06";
  const before = await store.getMonthlyUsage("discord:123", month);
  assert.equal(before.generations, 0);
  assert.equal(before.generatedImages, 0);

  const after = await store.incrementMonthlyUsage("discord:123", month, 2);
  assert.equal(after.generations, 1);
  assert.equal(after.generatedImages, 2);

  const persisted = await store.getMonthlyUsage("discord:123", month);
  assert.equal(persisted.generations, 1);
  assert.equal(persisted.generatedImages, 2);
});

test("token store reserves quota atomically", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-reserve-"));
  const dbPath = path.join(tempDir, "tokens.json");
  const store = new TokenStore({ dbPath, tokenPepper: "pepper-test" });
  await store.init();

  const month = "2026-06";
  const first = await store.tryReserveMonthlyGeneration("discord:123", month, 1);
  assert.equal(first.reserved, true);
  assert.equal(first.usage.generations, 1);

  const second = await store.tryReserveMonthlyGeneration("discord:123", month, 1);
  assert.equal(second.reserved, false);
  assert.equal(second.usage.generations, 1);

  await store.releaseMonthlyGenerationReservation("discord:123", month);
  const afterRelease = await store.getMonthlyUsage("discord:123", month);
  assert.equal(afterRelease.generations, 0);
});

test("one-time link code can only be consumed once", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-code-"));
  const dbPath = path.join(tempDir, "tokens.json");
  const store = new TokenStore({ dbPath, tokenPepper: "pepper-test" });
  await store.init();

  const created = await store.createOneTimeLinkCode({
    payload: { linked: true, token: "tok" },
    ttlSeconds: 120
  });
  const first = await store.consumeOneTimeLinkCode(created.code);
  assert.equal(first.linked, true);
  const second = await store.consumeOneTimeLinkCode(created.code);
  assert.equal(second, null);
});

test("one-time link code expires", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-code-exp-"));
  const dbPath = path.join(tempDir, "tokens.json");
  const store = new TokenStore({ dbPath, tokenPepper: "pepper-test" });
  await store.init();

  const created = await store.createOneTimeLinkCode({
    payload: { linked: true, token: "tok" },
    ttlSeconds: 1
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const consumed = await store.consumeOneTimeLinkCode(created.code);
  assert.equal(consumed, null);
});

test("concurrent one-time code exchange allows only one success", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-code-conc-"));
  const dbPath = path.join(tempDir, "tokens.json");
  const store = new TokenStore({ dbPath, tokenPepper: "pepper-test" });
  await store.init();

  const created = await store.createOneTimeLinkCode({
    payload: { linked: true, token: "tok" },
    ttlSeconds: 120
  });

  const results = await Promise.all(
    Array.from({ length: 6 }).map(() => store.consumeOneTimeLinkCode(created.code))
  );
  const successCount = results.filter((value) => value && value.linked).length;
  assert.equal(successCount, 1);
});

test("oauth state can only be consumed once", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-oauth-state-"));
  const dbPath = path.join(tempDir, "tokens.json");
  const store = new TokenStore({ dbPath, tokenPepper: "pepper-test" });
  await store.init();

  const created = await store.createOAuthState({
    strategy: "hosted",
    returnUrl: "https://world.forge-vtt.com/game",
    ttlSeconds: 120
  });
  const first = await store.consumeOAuthState(created.id);
  assert.equal(first.strategy, "hosted");
  const second = await store.consumeOAuthState(created.id);
  assert.equal(second, null);
});

test("one-time code supports error payload exchange", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-code-error-"));
  const dbPath = path.join(tempDir, "tokens.json");
  const store = new TokenStore({ dbPath, tokenPepper: "pepper-test" });
  await store.init();

  const created = await store.createOneTimeLinkCode({
    payload: {
      linked: false,
      token: "",
      tier: "",
      monthlyGenerationLimit: 0,
      discordUserId: "",
      expiresAt: "",
      error: "not_entitled",
      message: "No tier role"
    },
    ttlSeconds: 120
  });

  const consumed = await store.consumeOneTimeLinkCode(created.code);
  assert.equal(consumed.linked, false);
  assert.equal(consumed.error, "not_entitled");
  assert.equal(consumed.message, "No tier role");
});
