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

test("image proxy requires Gambits bearer token", async () => {
  setupEnv();
  const app = loadApp();
  const response = await request(app)
    .post("/api/maps/image/proxy")
    .send({ imageUrl: "https://delivery.us3.bfl.ai/file.png" });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "AUTH_REQUIRED");
});

test("image proxy rejects invalid Gambits token", async () => {
  setupEnv();
  const app = loadApp();
  const invalidToken = jwt.sign({ sub: "user-123", email_verified: true }, "wrong-secret", {
    algorithm: "HS256",
    issuer: "gambits",
    audience: "sceneforge",
    expiresIn: "15m"
  });
  const response = await request(app)
    .post("/api/maps/image/proxy")
    .set("Authorization", `Bearer ${invalidToken}`)
    .send({ imageUrl: "https://delivery.us3.bfl.ai/file.png" });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "AUTH_REQUIRED");
});

test("image proxy succeeds with Gambits token and allowed image mime", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  global.fetch = async () => ({
    ok: true,
    headers: {
      get: (name) => {
        if (String(name).toLowerCase() === "content-type") return "image/png";
        if (String(name).toLowerCase() === "content-length") return "4";
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from([1, 2, 3, 4])
  });

  const response = await request(app)
    .post("/api/maps/image/proxy")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageUrl: "https://delivery.us3.bfl.ai/file.png" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.contentType, "image/png");
  assert.equal(typeof response.body.base64, "string");
  assert.match(response.body.dataUrl, /^data:image\/png;base64,/);
});

test("image fetch succeeds with Gambits token and allowed image mime", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  global.fetch = async () => ({
    ok: true,
    headers: {
      get: (name) => {
        if (String(name).toLowerCase() === "content-type") return "image/webp";
        if (String(name).toLowerCase() === "content-length") return "4";
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from([1, 2, 3, 4])
  });

  const response = await request(app)
    .post("/api/maps/image/fetch")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageUrl: "https://delivery.us3.bfl.ai/file.webp" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.contentType, "image/webp");
  assert.equal(response.body.extension, "webp");
  assert.equal(typeof response.body.filename, "string");
  assert.equal(typeof response.body.base64, "string");
  assert.match(response.body.dataUrl, /^data:image\/webp;base64,/);
});

test("image proxy rejects disallowed host", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  const response = await request(app)
    .post("/api/maps/image/proxy")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageUrl: "https://example.com/file.png" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "invalid_image_url");
  assert.equal(response.body.reason, "disallowed_image_host");
});

test("image proxy rejects disallowed content type", async () => {
  setupEnv();
  const app = loadApp();
  const token = createToken();
  global.fetch = async () => ({
    ok: true,
    headers: {
      get: (name) => {
        if (String(name).toLowerCase() === "content-type") return "text/html";
        if (String(name).toLowerCase() === "content-length") return "4";
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from([1, 2, 3, 4])
  });

  const response = await request(app)
    .post("/api/maps/image/proxy")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageUrl: "https://delivery.us3.bfl.ai/file.png" });

  assert.equal(response.status, 415);
  assert.equal(response.body.error, "generation_failed");
  assert.equal(response.body.reason, "invalid_image_content_type");
});

test("image proxy rejects oversized response payload", async () => {
  setupEnv();
  process.env.MAX_PROXY_IMAGE_BYTES = "1048576";
  const app = loadApp();
  const token = createToken();
  global.fetch = async () => ({
    ok: true,
    headers: {
      get: (name) => {
        if (String(name).toLowerCase() === "content-type") return "image/png";
        if (String(name).toLowerCase() === "content-length") return "2097152";
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from([1, 2, 3, 4])
  });

  const response = await request(app)
    .post("/api/maps/image/proxy")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageUrl: "https://delivery.us3.bfl.ai/file.png" });

  assert.equal(response.status, 413);
  assert.equal(response.body.error, "generation_failed");
  assert.equal(response.body.reason, "image_too_large");
});
