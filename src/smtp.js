import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { SMTPServer } from "smtp-server";
import { addressDomain, normalizeAddress, parseMessageMetadata } from "./message-utils.js";

function smtpError(message, responseCode = 451) {
  return Object.assign(new Error(message), { responseCode });
}

function diskState(config) {
  try {
    const stats = fs.statfsSync(config.dataDir);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const used = Math.max(0, total - free);
    const usedPercent = total ? Math.round((used / total) * 10000) / 100 : 0;
    return {
      ok: free >= config.diskMinFreeBytes && usedPercent < config.diskHighWaterPercent,
      warning: usedPercent >= config.diskWarnPercent,
      total,
      free,
      used,
      usedPercent,
    };
  } catch (error) {
    return { ok: false, warning: true, error: error.message, total: 0, free: 0, used: 0, usedPercent: 100 };
  }
}

function fileHash(cert, key) {
  return createHash("sha256").update(cert).update(key).digest("hex");
}

function findRecursively(root, predicate) {
  if (!root || !fs.existsSync(root)) return "";
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (predicate(full, entry.name)) return full;
    }
  }
  return "";
}

function discoverTls(config) {
  let certFile = config.tlsCertFile;
  let keyFile = config.tlsKeyFile;
  if (!certFile || !keyFile) {
    const host = config.mxHost.toLowerCase();
    certFile = findRecursively(config.caddyDataDir, (full, name) => {
      const lower = full.toLowerCase();
      return lower.includes(host) && name.toLowerCase().endsWith(".crt");
    });
    if (certFile) {
      const expected = certFile.replace(/\.crt$/i, ".key");
      keyFile = fs.existsSync(expected)
        ? expected
        : findRecursively(path.dirname(certFile), (_full, name) => name.toLowerCase().endsWith(".key"));
    }
  }
  if (!certFile || !keyFile || !fs.existsSync(certFile) || !fs.existsSync(keyFile)) return null;
  const cert = fs.readFileSync(certFile);
  const key = fs.readFileSync(keyFile);
  return { cert, key, certFile, keyFile, hash: fileHash(cert, key) };
}

export class SmtpService {
  constructor(config, database) {
    this.config = config;
    this.database = database;
    this.server = null;
    this.port = null;
    this.startedAt = "";
    this.lastError = "";
    this.tls = null;
    this.tlsTimer = null;
    this.restarting = false;
  }

  getDiskState() {
    return diskState(this.config);
  }

  health() {
    return {
      ready: Boolean(this.server?.server?.listening),
      port: this.port,
      host: this.config.smtpHost,
      tls: Boolean(this.tls),
      tlsCertificate: this.tls?.certFile || "",
      startedAt: this.startedAt,
      lastError: this.lastError,
      disk: this.getDiskState(),
    };
  }

  async start() {
    if (this.server?.server?.listening) return;
    this.tls = discoverTls(this.config);
    if (this.config.requireSmtpTls && !this.tls) {
      throw new Error(`SMTP TLS certificate for ${this.config.mxHost} is not ready`);
    }
    await this.#listen();
    if (!this.tlsTimer) {
      this.tlsTimer = setInterval(() => {
        this.#pollTls().catch((error) => {
          this.lastError = `TLS reload failed: ${error.message}`;
          console.error(this.lastError);
        });
      }, this.config.tlsPollSeconds * 1000);
      this.tlsTimer.unref?.();
    }
  }

  async stop() {
    if (this.tlsTimer) clearInterval(this.tlsTimer);
    this.tlsTimer = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
  }

  async #pollTls() {
    if (this.restarting) return;
    const current = discoverTls(this.config);
    if (!current || current.hash === this.tls?.hash) return;
    this.restarting = true;
    try {
      const previous = this.server;
      this.server = null;
      if (previous) await new Promise((resolve) => previous.close(resolve));
      this.tls = current;
      await this.#listen();
    } finally {
      this.restarting = false;
    }
  }

  async #listen() {
    const disabledCommands = this.tls ? ["AUTH"] : ["AUTH", "STARTTLS"];
    const options = {
      name: this.config.mxHost,
      banner: "receive-only mailbox",
      authOptional: true,
      disabledCommands,
      size: this.config.maxMessageBytes,
      maxClients: this.config.maxSmtpClients,
      socketTimeout: 60_000,
      closeTimeout: 30_000,
      logger: false,
      onConnect: (session, callback) => this.#onConnect(session, callback),
      onRcptTo: (address, session, callback) => this.#onRcptTo(address, session, callback),
      onData: (stream, session, callback) => {
        this.#onData(stream, session).then(
          (messageId) => callback(null, `Message accepted as ${messageId}`),
          (error) => callback(error),
        );
      },
    };
    if (this.tls) {
      options.key = this.tls.key;
      options.cert = this.tls.cert;
      options.minVersion = "TLSv1.2";
    }
    const server = new SMTPServer(options);
    this.server = server;
    server.server.on("error", (error) => {
      this.lastError = error.message;
      console.error(`SMTP server error: ${error.message}`);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.server.off("error", onError);
        resolve();
      };
      server.server.once("error", onError);
      server.server.once("listening", onListening);
      server.listen(this.config.smtpPort, this.config.smtpHost);
    });
    this.port = server.server.address()?.port ?? this.config.smtpPort;
    this.startedAt = new Date().toISOString();
    this.lastError = "";
  }

  #onConnect(_session, callback) {
    const state = this.getDiskState();
    if (!state.ok) return callback(smtpError("Insufficient system storage", 452));
    callback();
  }

  #onRcptTo(address, session, callback) {
    const recipient = normalizeAddress(address?.address);
    const domain = this.config.domainEntry(addressDomain(recipient));
    if (!domain?.enabled) {
      return callback(smtpError("Relay denied", 550));
    }
    const mailbox = this.database.mailboxByAddress(recipient);
    if (!mailbox || Number(mailbox.enabled) !== 1) {
      return callback(smtpError("User unknown", 550));
    }
    if ((session.envelope?.rcptTo?.length || 0) >= this.config.maxRecipients) {
      return callback(smtpError("Too many recipients", 452));
    }
    callback();
  }

  async #onData(stream, session) {
    const state = this.getDiskState();
    if (!state.ok) {
      stream.resume();
      throw smtpError("Insufficient system storage", 452);
    }
    const recipients = [...new Set(
      (session.envelope?.rcptTo || []).map((item) => normalizeAddress(item.address)).filter(Boolean),
    )];
    const active = recipients.filter((recipient) => {
      if (!this.config.domainEntry(addressDomain(recipient))?.enabled) return false;
      const mailbox = this.database.mailboxByAddress(recipient);
      return mailbox && Number(mailbox.enabled) === 1;
    });
    if (!active.length) {
      stream.resume();
      throw smtpError("No active recipients", 550);
    }
    const id = randomUUID();
    const tempPath = path.join(this.config.tempDir, `${id}.eml.tmp`);
    const date = new Date();
    const relativeDir = path.join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"));
    const relativePath = path.join(relativeDir, `${id}.eml`);
    const finalPath = path.join(this.config.rawDir, relativePath);
    await fsPromises.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await pipeline(stream, fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
      if (stream.sizeExceeded) throw smtpError("Message too large", 552);
      const stat = await fsPromises.stat(tempPath);
      if (stat.size > this.config.maxMessageBytes) throw smtpError("Message too large", 552);
      const metadata = await parseMessageMetadata(tempPath);
      await fsPromises.rename(tempPath, finalPath);
      try {
        this.database.storeMessage({
          id,
          messageId: metadata.messageId,
          envelopeFrom: normalizeAddress(session.envelope?.mailFrom?.address),
          subject: metadata.subject,
          fromText: metadata.fromText,
          receivedAt: date.toISOString(),
          rawPath: relativePath.split(path.sep).join("/"),
          rawSize: stat.size,
          recipients: active,
        });
      } catch (error) {
        await fsPromises.rm(finalPath, { force: true });
        throw error;
      }
      return id;
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => {});
      if (error?.responseCode) throw error;
      console.error(`SMTP storage error: ${error.message}`);
      throw smtpError("Temporary storage failure", 451);
    }
  }
}

export { diskState, discoverTls };
