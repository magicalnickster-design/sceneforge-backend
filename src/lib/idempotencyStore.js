const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

class IdempotencyStore {
  constructor({ dbPath }) {
    this.dbPath = dbPath;
    this.db = null;
  }

  init() {
    if (this.db) {
      return;
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
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
  }

  beginProcessing(userId, idempotencyKey) {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT status, response_json, error_code, error_message, attempt_count
           FROM generation_requests
           WHERE user_id = ? AND idempotency_key = ?`
        )
        .get(userId, idempotencyKey);

      if (!existing) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO generation_requests
              (user_id, idempotency_key, status, created_at, updated_at, attempt_count)
             VALUES (?, ?, 'processing', ?, ?, 1)`
          )
          .run(userId, idempotencyKey, now, now);
        return { state: "started", retry: false };
      }

      if (existing.status === "completed") {
        return {
          state: "completed",
          response: existing.response_json ? JSON.parse(existing.response_json) : null
        };
      }

      if (existing.status === "processing") {
        return { state: "in_progress" };
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE generation_requests
             SET status = 'processing',
                 error_code = NULL,
                 error_message = NULL,
                 response_json = NULL,
                 updated_at = ?,
                 attempt_count = attempt_count + 1
           WHERE user_id = ? AND idempotency_key = ?`
        )
        .run(now, userId, idempotencyKey);
      return { state: "started", retry: true };
    });

    return tx();
  }

  markCompleted(userId, idempotencyKey, responsePayload) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE generation_requests
           SET status = 'completed',
               response_json = ?,
               updated_at = ?
         WHERE user_id = ? AND idempotency_key = ?`
      )
      .run(JSON.stringify(responsePayload), now, userId, idempotencyKey);
  }

  markFailed(userId, idempotencyKey, errorCode, errorMessage) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE generation_requests
           SET status = 'failed',
               error_code = ?,
               error_message = ?,
               updated_at = ?
         WHERE user_id = ? AND idempotency_key = ?`
      )
      .run(errorCode, errorMessage, now, userId, idempotencyKey);
  }
}

module.exports = { IdempotencyStore };
