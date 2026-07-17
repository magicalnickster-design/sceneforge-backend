const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const Database = require("better-sqlite3");

function setupEnv() {
  process.env.BFL_API_KEY = "test-bfl-key";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.GAMBITS_JWT_ALGORITHMS = "HS256";
  process.env.GAMBITS_JWT_ISSUER = "gambits";
  process.env.GAMBITS_JWT_AUDIENCE = "sceneforge";
  process.env.IDEMPOTENCY_DB_PATH = path.join(
    os.tmpdir(),
    `sceneforge-idem-${crypto.randomUUID()}.sqlite`
  );
}

function loadApp() {
  delete require.cache[require.resolve("../src/server")];
  return require("../src/server").app;
}

function createToken(overrides = {}, options = {}) {
  const payload = {
    sub: "user-123",
    email_verified: true,
    ...overrides
  };
  return jwt.sign(payload, process.env.SESSION_SECRET, {
    algorithm: "HS256",
    issuer: "gambits",
    audience: "sceneforge",
    expiresIn: "15m",
    ...options
  });
}

function setFetchSuccess(imageUrl = "https://images.example/result.png") {
  global.fetch = async (url) => {
    if (String(url).includes("flux-2-flex")) {
      return {
        ok: true,
        json: async () => ({ id: "gen_123", polling_url: "https://polling.example/result" }),
        headers: {
          get: () => null
        }
      };
    }
    return {
      ok: true,
      json: async () => ({ id: "gen_123", status: "complete", image_url: imageUrl }),
      headers: {
        get: () => null
      }
    };
  };
}

test("missing Bearer token", async () => {
  setupEnv();
  const app = loadApp();
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Idempotency-Key", crypto.randomUUID())
    .send({ prompt: "forest map" });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "AUTH_REQUIRED");
});

test("invalid JWT", async () => {
  setupEnv();
  const app = loadApp();
  const invalidToken = jwt.sign({ sub: "user-123", email_verified: true }, "wrong-secret", {
    algorithm: "HS256",
    issuer: "gambits",
    audience: "sceneforge",
    expiresIn: "15m"
  });
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${invalidToken}`)
    .set("Idempotency-Key", crypto.randomUUID())
    .send({ prompt: "forest map" });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "AUTH_REQUIRED");
});

test("expired JWT", async () => {
  setupEnv();
  const app = loadApp();
  const expiredToken = createToken({}, { expiresIn: -1 });
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${expiredToken}`)
    .set("Idempotency-Key", crypto.randomUUID())
    .send({ prompt: "forest map" });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "SESSION_EXPIRED");
});

test("unverified email JWT", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken({ email_verified: false });
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", crypto.randomUUID())
    .send({ prompt: "forest map" });
  assert.equal(response.status, 403);
  assert.equal(response.body.error, "EMAIL_NOT_VERIFIED");
});

test("missing idempotency key", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .send({ prompt: "forest map" });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "INVALID_IDEMPOTENCY_KEY");
});

test("invalid idempotency key", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", "not-a-uuid")
    .send({ prompt: "forest map" });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "INVALID_IDEMPOTENCY_KEY");
});

test("duplicate in-progress request returns GENERATION_IN_PROGRESS", async () => {
  setupEnv();
  const idempotencyKey = crypto.randomUUID();
  const db = new Database(process.env.IDEMPOTENCY_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_requests (
      user_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT,
      error_code TEXT,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, idempotency_key)
    );
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO generation_requests
      (user_id, idempotency_key, status, created_at, updated_at, attempt_count)
     VALUES (?, ?, 'processing', ?, ?, 1)`
  ).run("user-123", idempotencyKey, now, now);
  db.close();

  const app = loadApp();
  const token = createToken();
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", idempotencyKey)
    .send({ prompt: "forest map" });

  assert.equal(response.status, 409);
  assert.equal(response.body.error, "GENERATION_IN_PROGRESS");
});

test("duplicate completed request replays original result", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  const idempotencyKey = crypto.randomUUID();
  let fetchCount = 0;

  global.fetch = async (url) => {
    fetchCount += 1;
    if (String(url).includes("flux-2-flex")) {
      return {
        ok: true,
        json: async () => ({ id: "gen_123", polling_url: "https://polling.example/result" }),
        headers: {
          get: () => null
        }
      };
    }
    return {
      ok: true,
      json: async () => ({ id: "gen_123", status: "complete", image_url: "https://images.example/a.png" }),
      headers: {
        get: () => null
      }
    };
  };

  const first = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", idempotencyKey)
    .send({ prompt: "forest map", imageCount: 1 });
  const second = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", idempotencyKey)
    .send({ prompt: "forest map", imageCount: 1 });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(fetchCount, 2);
});

test("same idempotency key by different users is isolated", async () => {
  setupEnv();
  const app = loadApp();
  const key = crypto.randomUUID();
  const tokenA = createToken({ sub: "user-a" });
  const tokenB = createToken({ sub: "user-b" });
  let fetchCount = 0;
  setFetchSuccess();
  const originalFetch = global.fetch;
  global.fetch = async (...args) => {
    fetchCount += 1;
    return originalFetch(...args);
  };

  const first = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${tokenA}`)
    .set("Idempotency-Key", key)
    .send({ prompt: "map A" });
  const second = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${tokenB}`)
    .set("Idempotency-Key", key)
    .send({ prompt: "map B" });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(fetchCount, 4);
});

test("generation failure returns normalized code", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: "provider down" }),
    headers: {
      get: () => null
    }
  });
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", crypto.randomUUID())
    .send({ prompt: "forest map" });

  assert.equal(response.status, 502);
  assert.equal(response.body.error, "GENERATION_FAILED");
});

test("successful generation preserves response shape", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  setFetchSuccess("https://images.example/success.png");
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", crypto.randomUUID())
    .send({ prompt: "forest map", imageCount: 2 });

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    "endpoint",
    "estimatedCost",
    "generationId",
    "imageCount",
    "imagePath",
    "image_url",
    "metadata",
    "model",
    "provider",
    "url"
  ]);
  assert.equal(response.body.imagePath, "https://images.example/success.png");
});

test("Forge-style CORS preflight is allowed", async () => {
  setupEnv();
  const app = loadApp();
  const response = await request(app)
    .options("/api/maps/generate")
    .set("Origin", "https://myworld.forge-vtt.com")
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "authorization,content-type,idempotency-key");

  assert.equal(response.status, 204);
  assert.equal(response.headers["access-control-allow-origin"], "https://myworld.forge-vtt.com");
  assert.match(response.headers["access-control-allow-headers"], /idempotency-key/i);
});

test("No-Origin desktop request succeeds", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  setFetchSuccess();
  const response = await request(app)
    .post("/api/maps/generate")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", crypto.randomUUID())
    .send({ prompt: "desktop map" });

  assert.equal(response.status, 200);
});
