import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { hashPassword, tokenHash } from "./security.js";
import { normalizeAddress } from "./message-utils.js";
import { addressDomainValue } from "./domain-config.js";

function nowIso() {
  return new Date().toISOString();
}

export class MailboxDatabase {
  constructor(config) {
    this.config = config;
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    fs.mkdirSync(config.rawDir, { recursive: true });
    fs.mkdirSync(config.tempDir, { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.#migrate();
    this.statements = this.#prepare();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        api_token_hash TEXT NOT NULL UNIQUE,
        session_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL UNIQUE,
        domain TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        session_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        envelope_from TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        from_text TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL,
        raw_path TEXT NOT NULL UNIQUE,
        raw_size INTEGER NOT NULL CHECK (raw_size >= 0)
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        message_id TEXT NOT NULL,
        mailbox_id INTEGER NOT NULL,
        recipient TEXT NOT NULL,
        PRIMARY KEY (message_id, mailbox_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT,
        FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_mailboxes_enabled ON mailboxes(enabled, id DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_mailbox ON deliveries(mailbox_id, message_id);
    `);
    const columns = this.db.prepare("PRAGMA table_info(mailboxes)").all();
    if (!columns.some((column) => column.name === "domain")) {
      this.db.exec("ALTER TABLE mailboxes ADD COLUMN domain TEXT NOT NULL DEFAULT ''");
    }
    const missingDomains = this.db.prepare("SELECT id, address FROM mailboxes WHERE domain = '' OR domain IS NULL").all();
    const updateDomain = this.db.prepare("UPDATE mailboxes SET domain = ? WHERE id = ?");
    const backfill = this.db.transaction((rows) => {
      for (const row of rows) updateDomain.run(addressDomainValue(row.address), row.id);
    });
    backfill(missingDomains);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mailboxes_domain_enabled ON mailboxes(domain, enabled, id DESC)");
    this.db.prepare("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'").run();
  }

  #prepare() {
    return {
      admin: this.db.prepare("SELECT * FROM admin WHERE id = 1"),
      mailboxByAddress: this.db.prepare("SELECT * FROM mailboxes WHERE address = ?"),
      mailboxByToken: this.db.prepare("SELECT * FROM mailboxes WHERE token_hash = ?"),
      insertMailbox: this.db.prepare(
        `INSERT INTO mailboxes (address, domain, token_hash, enabled, session_version, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?)`,
      ),
      updateEnabled: this.db.prepare(
        `UPDATE mailboxes SET enabled = ?, session_version = session_version + 1, updated_at = ?
         WHERE address = ?`,
      ),
      rotateToken: this.db.prepare(
        `UPDATE mailboxes SET token_hash = ?, session_version = session_version + 1, updated_at = ?
         WHERE address = ?`,
      ),
      insertMessage: this.db.prepare(
        `INSERT INTO messages
         (id, message_id, envelope_from, subject, from_text, received_at, raw_path, raw_size)
         VALUES (@id, @messageId, @envelopeFrom, @subject, @fromText, @receivedAt, @rawPath, @rawSize)`,
      ),
      insertDelivery: this.db.prepare(
        "INSERT INTO deliveries (message_id, mailbox_id, recipient) VALUES (?, ?, ?)",
      ),
    };
  }

  close() {
    this.db.close();
  }

  adminExists() {
    return Boolean(this.statements.admin.get());
  }

  getAdmin() {
    return this.statements.admin.get() || null;
  }

  async bootstrapAdmin({ username = "admin", password, apiToken, replace = false }) {
    const existing = this.getAdmin();
    if (existing && !replace) throw new Error("admin_already_initialized");
    const passwordHash = await hashPassword(password);
    const apiTokenHash = tokenHash(apiToken);
    const timestamp = nowIso();
    if (existing) {
      this.db.prepare(
        `UPDATE admin SET username = ?, password_hash = ?, api_token_hash = ?,
         session_version = session_version + 1, updated_at = ? WHERE id = 1`,
      ).run(String(username || "admin"), passwordHash, apiTokenHash, timestamp);
    } else {
      this.db.prepare(
        `INSERT INTO admin
         (id, username, password_hash, api_token_hash, session_version, created_at, updated_at)
         VALUES (1, ?, ?, ?, 1, ?, ?)`,
      ).run(String(username || "admin"), passwordHash, apiTokenHash, timestamp, timestamp);
    }
    return this.getAdmin();
  }

  mailboxByAddress(address) {
    return this.statements.mailboxByAddress.get(normalizeAddress(address)) || null;
  }

  mailboxByToken(token) {
    if (!token) return null;
    return this.statements.mailboxByToken.get(tokenHash(token)) || null;
  }

  createMailboxes(items) {
    const insertMany = this.db.transaction((values) => {
      const timestamp = nowIso();
      return values.map((item) => {
        const result = this.statements.insertMailbox.run(
          normalizeAddress(item.address),
          String(item.domain || addressDomainValue(item.address)).trim().toLowerCase(),
          tokenHash(item.token),
          timestamp,
          timestamp,
        );
        return this.mailboxByAddress(item.address) || { id: Number(result.lastInsertRowid) };
      });
    });
    return insertMany(items);
  }

  listMailboxes({ limit = 100, offset = 0, search = "", domain = "" } = {}) {
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const query = String(search || "").trim().toLowerCase();
    const targetDomain = String(domain || "").trim().toLowerCase();
    const conditions = [];
    const values = [];
    if (query) { conditions.push("m.address LIKE ?"); values.push(`%${query}%`); }
    if (targetDomain) { conditions.push("m.domain = ?"); values.push(targetDomain); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const args = [...values, safeLimit, safeOffset];
    const items = this.db.prepare(
      `SELECT m.id, m.address, m.domain, m.enabled, m.created_at, m.updated_at,
              count(d.message_id) AS message_count,
              max(msg.received_at) AS latest_message_at,
              coalesce(sum(msg.raw_size), 0) AS stored_bytes
         FROM mailboxes m
         LEFT JOIN deliveries d ON d.mailbox_id = m.id
         LEFT JOIN messages msg ON msg.id = d.message_id
         ${where}
        GROUP BY m.id
        ORDER BY m.id DESC
        LIMIT ? OFFSET ?`,
    ).all(...args);
    const count = this.db.prepare(`SELECT count(*) AS count FROM mailboxes m ${where}`).get(...values).count;
    return { items, count: Number(count || 0), limit: safeLimit, offset: safeOffset };
  }

  setMailboxEnabled(address, enabled) {
    const normalized = normalizeAddress(address);
    const result = this.statements.updateEnabled.run(enabled ? 1 : 0, nowIso(), normalized);
    return result.changes ? this.mailboxByAddress(normalized) : null;
  }

  rotateMailboxToken(address, newToken) {
    const normalized = normalizeAddress(address);
    const result = this.statements.rotateToken.run(tokenHash(newToken), nowIso(), normalized);
    return result.changes ? this.mailboxByAddress(normalized) : null;
  }

  storeMessage(message) {
    const insert = this.db.transaction((value) => {
      this.statements.insertMessage.run(value);
      const delivered = [];
      for (const recipient of value.recipients) {
        const mailbox = this.mailboxByAddress(recipient);
        if (!mailbox || Number(mailbox.enabled) !== 1) continue;
        this.statements.insertDelivery.run(value.id, mailbox.id, normalizeAddress(recipient));
        delivered.push(mailbox);
      }
      if (!delivered.length) throw new Error("no_active_recipients");
      return delivered;
    });
    return insert(message);
  }

  listMessagesForMailbox(mailboxId, { limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const items = this.db.prepare(
      `SELECT msg.id, msg.message_id, msg.envelope_from AS source, d.recipient AS address,
              msg.subject, msg.from_text, msg.received_at AS created_at,
              msg.raw_path, msg.raw_size
         FROM deliveries d
         JOIN messages msg ON msg.id = d.message_id
        WHERE d.mailbox_id = ?
        ORDER BY msg.received_at DESC, msg.id DESC
        LIMIT ? OFFSET ?`,
    ).all(mailboxId, safeLimit, safeOffset);
    const count = this.db.prepare(
      "SELECT count(*) AS count FROM deliveries WHERE mailbox_id = ?",
    ).get(mailboxId).count;
    return { items, count: Number(count || 0), limit: safeLimit, offset: safeOffset };
  }

  messageForMailbox(messageId, mailboxId) {
    return this.db.prepare(
      `SELECT msg.*, d.recipient
         FROM deliveries d
         JOIN messages msg ON msg.id = d.message_id
        WHERE msg.id = ? AND d.mailbox_id = ?`,
    ).get(String(messageId || ""), Number(mailboxId)) || null;
  }

  messageForAdmin(messageId) {
    return this.db.prepare(
      `SELECT msg.*, group_concat(d.recipient) AS recipients
         FROM messages msg
         JOIN deliveries d ON d.message_id = msg.id
        WHERE msg.id = ?
        GROUP BY msg.id`,
    ).get(String(messageId || "")) || null;
  }

  listMessagesForAdmin({ limit = 50, offset = 0, address = "", domain = "" } = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const normalized = normalizeAddress(address);
    const targetDomain = String(domain || "").trim().toLowerCase();
    const conditions = [];
    const values = [];
    if (normalized) { conditions.push("m.address = ?"); values.push(normalized); }
    if (targetDomain) { conditions.push("m.domain = ?"); values.push(targetDomain); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const args = [...values, safeLimit, safeOffset];
    const items = this.db.prepare(
      `SELECT msg.id, msg.message_id, msg.envelope_from, msg.subject, msg.from_text,
              msg.received_at, msg.raw_size, group_concat(d.recipient) AS recipients
         FROM messages msg
         JOIN deliveries d ON d.message_id = msg.id
         JOIN mailboxes m ON m.id = d.mailbox_id
         ${where}
        GROUP BY msg.id
        ORDER BY msg.received_at DESC, msg.id DESC
        LIMIT ? OFFSET ?`,
    ).all(...args);
    return { items, limit: safeLimit, offset: safeOffset };
  }

  statistics() {
    const mailbox = this.db.prepare(
      `SELECT count(*) AS total,
              sum(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
         FROM mailboxes`,
    ).get();
    const messages = this.db.prepare(
      "SELECT count(*) AS total, coalesce(sum(raw_size), 0) AS stored_bytes FROM messages",
    ).get();
    return {
      mailboxes: { total: Number(mailbox.total || 0), enabled: Number(mailbox.enabled || 0) },
      messages: { total: Number(messages.total || 0), storedBytes: Number(messages.stored_bytes || 0) },
      domains: this.db.prepare(
        `SELECT domain, count(*) AS total,
                sum(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
           FROM mailboxes GROUP BY domain ORDER BY domain`,
      ).all().map((row) => ({
        domain: row.domain,
        total: Number(row.total || 0),
        enabled: Number(row.enabled || 0),
      })),
    };
  }
}
