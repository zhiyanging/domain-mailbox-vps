import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { MailboxDatabase } from "../src/database.js";
import { verifyPassword } from "../src/security.js";
import { temporaryConfig } from "./helpers.js";

test("database bootstraps one admin and permanently indexes raw messages", async (t) => {
  const { config, cleanup } = await temporaryConfig();
  const database = new MailboxDatabase(config);
  t.after(async () => {
    database.close();
    await cleanup();
  });
  await database.bootstrapAdmin({ username: "admin", password: "a-password-long-enough", apiToken: "admin-api-token" });
  const admin = database.getAdmin();
  assert.equal(admin.username, "admin");
  assert.equal(await verifyPassword("a-password-long-enough", admin.password_hash), true);
  await assert.rejects(
    database.bootstrapAdmin({ username: "second", password: "another-password-long", apiToken: "another-token" }),
    /admin_already_initialized/,
  );

  database.createMailboxes([{ address: "alpha@mail.test", token: "mailbox-token" }]);
  const mailbox = database.mailboxByToken("mailbox-token");
  assert.equal(mailbox.address, "alpha@mail.test");
  assert.equal(mailbox.domain, "mail.test");
  database.createMailboxes([{ address: "alpha@second.test", domain: "second.test", token: "second-token" }]);
  assert.equal(database.listMailboxes({ domain: "second.test" }).count, 1);
  assert.equal(database.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, "2");
  const rawPath = path.join("2026", "08", "message.eml");
  await fs.mkdir(path.join(config.rawDir, "2026", "08"), { recursive: true });
  await fs.writeFile(path.join(config.rawDir, rawPath), "Subject: Test\r\n\r\nBody");
  database.storeMessage({
    id: "message-1",
    messageId: "same@example.net",
    envelopeFrom: "sender@example.net",
    subject: "Test",
    fromText: "Sender",
    receivedAt: new Date().toISOString(),
    rawPath,
    rawSize: 21,
    recipients: ["alpha@mail.test"],
  });
  database.storeMessage({
    id: "message-2",
    messageId: "same@example.net",
    envelopeFrom: "sender@example.net",
    subject: "Duplicate ID accepted",
    fromText: "Sender",
    receivedAt: new Date().toISOString(),
    rawPath: "2026/08/message-2.eml",
    rawSize: 1,
    recipients: ["alpha@mail.test"],
  });
  const page = database.listMessagesForMailbox(mailbox.id);
  assert.equal(page.count, 2);
  assert.equal(database.setMailboxEnabled(mailbox.address, false).enabled, 0);
  assert.equal(database.mailboxByToken("mailbox-token").enabled, 0);
});

test("schema v1 mailboxes are backfilled with their domain", async (t) => {
  const { config, cleanup } = await temporaryConfig();
  const legacy = new Database(config.dbPath);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schema_version', '1');
    CREATE TABLE mailboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO mailboxes (address, token_hash, enabled, session_version, created_at, updated_at)
    VALUES ('legacy@second.test', 'legacy-hash', 1, 1, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
  `);
  legacy.close();
  const database = new MailboxDatabase(config);
  t.after(async () => { database.close(); await cleanup(); });
  assert.equal(database.mailboxByAddress("legacy@second.test").domain, "second.test");
  assert.equal(database.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, "2");
});
