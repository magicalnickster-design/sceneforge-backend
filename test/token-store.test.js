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
