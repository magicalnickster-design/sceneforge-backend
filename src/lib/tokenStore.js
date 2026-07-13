const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { generateApiToken, hashToken, tokenPreview } = require("./security");

class TokenStore {
  constructor(options = {}) {
    this.dbPath =
      options.dbPath || path.join(process.cwd(), "data", "tokens.json");
    this.tokenPepper = options.tokenPepper || "";
    this.clock = options.clock || (() => new Date().toISOString());
    this.writeQueue = Promise.resolve();
  }

  async init() {
    const directory = path.dirname(this.dbPath);
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.access(this.dbPath);
    } catch {
      await this._writeState({
        version: 3,
        tokens: [],
        usageByMonth: {},
        oauthStates: [],
        oneTimeLinkCodes: []
      });
    }
  }

  async issueOrGetToken({
    discordUserId,
    rotate = false,
    source = "discord-oauth",
    notes = "",
    tier = "subscriber",
    monthlyGenerationLimit = null,
    ttlDays = null
  }) {
    const now = this.clock();
    return this._withLock(async () => {
      const state = await this._readState();
      const active = state.tokens.find(
        (tokenRecord) =>
          tokenRecord.discordUserId === discordUserId &&
          tokenRecord.status === "active"
      );

      if (active && !rotate) {
        return {
          token: null,
          record: active,
          reused: true
        };
      }

      if (active && rotate) {
        active.status = "revoked";
        active.revokedAt = now;
        active.notes = notes || active.notes || "";
      }

      const plainToken = generateApiToken();
      const expiresAt =
        typeof ttlDays === "number" && ttlDays > 0
          ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
          : null;
      const record = {
        id: crypto.randomUUID(),
        discordUserId,
        tokenHash: hashToken(plainToken, this.tokenPepper),
        tokenPreview: tokenPreview(plainToken),
        status: "active",
        issuedAt: now,
        revokedAt: null,
        lastUsedAt: null,
        source,
        notes: notes || "",
        tier,
        monthlyGenerationLimit:
          typeof monthlyGenerationLimit === "number"
            ? monthlyGenerationLimit
            : null,
        expiresAt
      };

      state.tokens.push(record);
      await this._writeState(state);
      return {
        token: plainToken,
        record,
        reused: false
      };
    });
  }

  async revokeActiveTokenForUser(discordUserId, reason = "") {
    const now = this.clock();
    return this._withLock(async () => {
      const state = await this._readState();
      const active = state.tokens.find(
        (tokenRecord) =>
          tokenRecord.discordUserId === discordUserId &&
          tokenRecord.status === "active"
      );

      if (!active) {
        return { revoked: false };
      }

      active.status = "revoked";
      active.revokedAt = now;
      if (reason) {
        active.notes = reason;
      }

      await this._writeState(state);
      return { revoked: true, record: active };
    });
  }

  async getStatusForUser(discordUserId) {
    const state = await this._readState();
    const active = state.tokens.find(
      (tokenRecord) =>
        tokenRecord.discordUserId === discordUserId &&
        tokenRecord.status === "active"
    );
    if (!active) {
      return {
        hasActiveToken: false,
        status: "none",
        tokenPreview: null,
        issuedAt: null,
        lastUsedAt: null
      };
    }
    return {
      hasActiveToken: true,
      status: active.status,
      tokenPreview: active.tokenPreview,
      issuedAt: active.issuedAt,
      lastUsedAt: active.lastUsedAt,
      tier: active.tier || "subscriber",
      monthlyGenerationLimit:
        typeof active.monthlyGenerationLimit === "number"
          ? active.monthlyGenerationLimit
          : null,
      expiresAt: active.expiresAt || null
    };
  }

  async validateToken(token) {
    const now = new Date().toISOString();
    return this._withLock(async () => {
      const state = await this._readState();
      const tokenHash = hashToken(token, this.tokenPepper);
      const active = state.tokens.find(
        (tokenRecord) =>
          tokenRecord.tokenHash === tokenHash && tokenRecord.status === "active"
      );
      if (!active) {
        return null;
      }
      if (active.expiresAt && new Date(active.expiresAt).getTime() <= Date.now()) {
        active.status = "revoked";
        active.revokedAt = now;
        active.notes = active.notes || "expired";
        await this._writeState(state);
        return null;
      }
      return active;
    });
  }

  async touchLastUsedById(id) {
    const now = this.clock();
    return this._withLock(async () => {
      const state = await this._readState();
      const record = state.tokens.find((tokenRecord) => tokenRecord.id === id);
      if (!record) {
        return false;
      }
      record.lastUsedAt = now;
      await this._writeState(state);
      return true;
    });
  }

  async updateManagedTokenEntitlementById(id, { tier, monthlyGenerationLimit }) {
    return this._withLock(async () => {
      const state = await this._readState();
      const record = state.tokens.find(
        (tokenRecord) => tokenRecord.id === id && tokenRecord.status === "active"
      );
      if (!record) {
        return null;
      }
      if (tier) {
        record.tier = tier;
      }
      if (typeof monthlyGenerationLimit === "number") {
        record.monthlyGenerationLimit = monthlyGenerationLimit;
      }
      await this._writeState(state);
      return record;
    });
  }

  async getMonthlyUsage(usageKey, month) {
    const state = await this._readState();
    const monthBucket = state.usageByMonth[month] || {};
    const usage = monthBucket[usageKey] || {
      generatedImages: 0,
      generations: 0,
      lastUsedAt: null
    };
    return {
      generatedImages: Number(usage.generatedImages || 0),
      generations: Number(usage.generations || 0),
      lastUsedAt: usage.lastUsedAt || null
    };
  }

  async incrementMonthlyUsage(usageKey, month, imageCount) {
    const now = this.clock();
    return this._withLock(async () => {
      const state = await this._readState();
      if (!state.usageByMonth[month]) {
        state.usageByMonth[month] = {};
      }
      if (!state.usageByMonth[month][usageKey]) {
        state.usageByMonth[month][usageKey] = {
          generatedImages: 0,
          generations: 0,
          lastUsedAt: null
        };
      }
      const usage = state.usageByMonth[month][usageKey];
      usage.generations = Number(usage.generations || 0) + 1;
      usage.generatedImages = Number(usage.generatedImages || 0) + Number(imageCount || 0);
      usage.lastUsedAt = now;
      await this._writeState(state);
      return {
        generatedImages: usage.generatedImages,
        generations: usage.generations,
        lastUsedAt: usage.lastUsedAt
      };
    });
  }

  async tryReserveMonthlyGeneration(usageKey, month, limit) {
    const now = this.clock();
    return this._withLock(async () => {
      const state = await this._readState();
      if (!state.usageByMonth[month]) {
        state.usageByMonth[month] = {};
      }
      if (!state.usageByMonth[month][usageKey]) {
        state.usageByMonth[month][usageKey] = {
          generatedImages: 0,
          generations: 0,
          lastUsedAt: null
        };
      }
      const usage = state.usageByMonth[month][usageKey];
      const currentGenerations = Number(usage.generations || 0);
      if (typeof limit === "number" && currentGenerations >= limit) {
        return {
          reserved: false,
          usage: {
            generatedImages: Number(usage.generatedImages || 0),
            generations: currentGenerations,
            lastUsedAt: usage.lastUsedAt || null
          }
        };
      }
      usage.generations = currentGenerations + 1;
      usage.lastUsedAt = now;
      await this._writeState(state);
      return {
        reserved: true,
        usage: {
          generatedImages: Number(usage.generatedImages || 0),
          generations: Number(usage.generations || 0),
          lastUsedAt: usage.lastUsedAt || null
        }
      };
    });
  }

  async releaseMonthlyGenerationReservation(usageKey, month) {
    return this._withLock(async () => {
      const state = await this._readState();
      const usage = state.usageByMonth?.[month]?.[usageKey];
      if (!usage) {
        return;
      }
      usage.generations = Math.max(0, Number(usage.generations || 0) - 1);
      await this._writeState(state);
    });
  }

  async finalizeMonthlyGenerationImages(usageKey, month, imageCount) {
    return this._withLock(async () => {
      const state = await this._readState();
      if (!state.usageByMonth[month]) {
        state.usageByMonth[month] = {};
      }
      if (!state.usageByMonth[month][usageKey]) {
        state.usageByMonth[month][usageKey] = {
          generatedImages: 0,
          generations: 0,
          lastUsedAt: null
        };
      }
      const usage = state.usageByMonth[month][usageKey];
      usage.generatedImages = Number(usage.generatedImages || 0) + Number(imageCount || 0);
      usage.lastUsedAt = this.clock();
      await this._writeState(state);
      return {
        generatedImages: Number(usage.generatedImages || 0),
        generations: Number(usage.generations || 0),
        lastUsedAt: usage.lastUsedAt || null
      };
    });
  }

  async createOAuthState({ strategy, returnUrl = "", ttlSeconds = 600, metadata = {} }) {
    const id = crypto.randomUUID();
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
    return this._withLock(async () => {
      const state = await this._readState();
      state.oauthStates.push({
        id,
        strategy,
        returnUrl,
        metadata,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt,
        consumedAt: null
      });
      await this._writeState(state);
      return { id, expiresAt };
    });
  }

  async consumeOAuthState(id) {
    const nowMs = Date.now();
    return this._withLock(async () => {
      const state = await this._readState();
      const record = state.oauthStates.find((entry) => entry.id === id);
      if (!record) {
        return null;
      }
      if (record.consumedAt) {
        return null;
      }
      if (new Date(record.expiresAt).getTime() <= nowMs) {
        return null;
      }
      record.consumedAt = new Date(nowMs).toISOString();
      await this._writeState(state);
      return record;
    });
  }

  async createOneTimeLinkCode({ payload, ttlSeconds = 120, metadata = {} }) {
    const plainCode = crypto.randomBytes(24).toString("base64url");
    const codeHash = hashToken(plainCode, this.tokenPepper);
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
    return this._withLock(async () => {
      const state = await this._readState();
      state.oneTimeLinkCodes.push({
        id: crypto.randomUUID(),
        codeHash,
        payload,
        metadata,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt,
        consumedAt: null
      });
      await this._writeState(state);
      return {
        code: plainCode,
        expiresAt
      };
    });
  }

  async consumeOneTimeLinkCode(code) {
    const codeHash = hashToken(code, this.tokenPepper);
    const nowMs = Date.now();
    return this._withLock(async () => {
      const state = await this._readState();
      const record = state.oneTimeLinkCodes.find((entry) => entry.codeHash === codeHash);
      if (!record) {
        return null;
      }
      if (record.consumedAt) {
        return null;
      }
      if (new Date(record.expiresAt).getTime() <= nowMs) {
        return null;
      }
      record.consumedAt = new Date(nowMs).toISOString();
      await this._writeState(state);
      return record.payload || null;
    });
  }

  async _readState() {
    const raw = await fs.readFile(this.dbPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.tokens || !Array.isArray(parsed.tokens)) {
      return { version: 3, tokens: [], usageByMonth: {}, oauthStates: [], oneTimeLinkCodes: [] };
    }
    if (!parsed.usageByMonth || typeof parsed.usageByMonth !== "object") {
      parsed.usageByMonth = {};
    }
    if (!Array.isArray(parsed.oauthStates)) {
      parsed.oauthStates = [];
    }
    if (!Array.isArray(parsed.oneTimeLinkCodes)) {
      parsed.oneTimeLinkCodes = [];
    }
    parsed.version = Number(parsed.version || 3);
    return parsed;
  }

  async _writeState(state) {
    const tempPath = `${this.dbPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tempPath, this.dbPath);
  }

  async _withLock(work) {
    this.writeQueue = this.writeQueue.then(work, work);
    return this.writeQueue;
  }
}

module.exports = {
  TokenStore
};
