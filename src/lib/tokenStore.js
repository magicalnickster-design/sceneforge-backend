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
      await this._writeState({ version: 1, tokens: [] });
    }
  }

  async issueOrGetToken({
    discordUserId,
    rotate = false,
    source = "discord-bot",
    notes = ""
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
        notes: notes || ""
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
      lastUsedAt: active.lastUsedAt
    };
  }

  async validateToken(token) {
    const state = await this._readState();
    const tokenHash = hashToken(token, this.tokenPepper);
    const active = state.tokens.find(
      (tokenRecord) =>
        tokenRecord.tokenHash === tokenHash && tokenRecord.status === "active"
    );
    return active || null;
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

  async _readState() {
    const raw = await fs.readFile(this.dbPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.tokens || !Array.isArray(parsed.tokens)) {
      return { version: 1, tokens: [] };
    }
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
