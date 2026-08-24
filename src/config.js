import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { domainConfigPath, loadDomainConfig } from "./domain-config.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(PROJECT_DIR, ".env"));

function integer(name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function boolean(name, fallback) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function absolutePath(value, fallback) {
  return path.resolve(value || fallback);
}

export function createConfig(overrides = {}) {
  const legacyMailDomain = String(overrides.mailDomain || process.env.MAIL_DOMAIN || "example.com").trim().toLowerCase();
  const legacyWebHost = String(overrides.webHost || process.env.WEB_HOST || `inbox.${legacyMailDomain}`).trim().toLowerCase();
  const legacyMxHost = String(overrides.mxHost || process.env.MX_HOST || `mx.${legacyMailDomain}`).trim().toLowerCase();
  const domainsPath = domainConfigPath(
    PROJECT_DIR,
    overrides.domainsConfigPath || process.env.DOMAINS_CONFIG_PATH || "",
  );
  const domains = overrides.domainConfig?.entryForDomain
    ? overrides.domainConfig
    : loadDomainConfig({
      filePath: domainsPath,
      value: overrides.domainConfig,
      legacy: { mailDomain: legacyMailDomain, webHost: legacyWebHost, mxHost: legacyMxHost },
    });
  const mailDomain = domains.defaultDomain;
  const webHost = domains.controlHost;
  const mxHost = domains.sharedMxHost;
  const dataDir = absolutePath(
    overrides.dataDir || process.env.DATA_DIR,
    path.join(PROJECT_DIR, "data"),
  );
  const sessionSecret = String(
    overrides.sessionSecret || process.env.SESSION_SECRET || randomBytes(32).toString("base64url"),
  );
  return {
    projectDir: PROJECT_DIR,
    nodeEnv: String(overrides.nodeEnv || process.env.NODE_ENV || "development"),
    domainsConfigPath: domainsPath,
    domains,
    mailDomains: domains.enabledDomains,
    mailDomain,
    webHost,
    mxHost,
    webOrigin: String(
      overrides.webOrigin || process.env.WEB_ORIGIN || `https://${webHost}`,
    ).replace(/\/$/, ""),
    inboxOrigin(domain) {
      return domains.inboxOrigin(domain);
    },
    domainEntry(domain) {
      return domains.entryForDomain(domain);
    },
    dataDir,
    dbPath: absolutePath(overrides.dbPath || process.env.DB_PATH, path.join(dataDir, "mailbox.sqlite3")),
    rawDir: absolutePath(overrides.rawDir || process.env.RAW_DIR, path.join(dataDir, "raw")),
    tempDir: absolutePath(overrides.tempDir || process.env.TEMP_DIR, path.join(dataDir, "tmp")),
    httpHost: String(overrides.httpHost || process.env.HTTP_HOST || "0.0.0.0"),
    httpPort: Number(overrides.httpPort ?? integer("HTTP_PORT", 3000, 0, 65535)),
    smtpHost: String(overrides.smtpHost || process.env.SMTP_HOST || "0.0.0.0"),
    smtpPort: Number(overrides.smtpPort ?? integer("SMTP_PORT", 2525, 0, 65535)),
    maxMessageBytes: Number(
      overrides.maxMessageBytes ?? integer("MAX_MESSAGE_BYTES", 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    ),
    maxSmtpClients: Number(overrides.maxSmtpClients ?? integer("MAX_SMTP_CLIENTS", 50, 1, 500)),
    maxRecipients: Number(overrides.maxRecipients ?? integer("MAX_RECIPIENTS", 20, 1, 100)),
    diskHighWaterPercent: Number(
      overrides.diskHighWaterPercent ?? integer("DISK_HIGH_WATER_PERCENT", 90, 50, 99),
    ),
    diskWarnPercent: Number(
      overrides.diskWarnPercent ?? integer("DISK_WARN_PERCENT", 80, 40, 98),
    ),
    diskMinFreeBytes: Number(
      overrides.diskMinFreeBytes ?? integer("DISK_MIN_FREE_BYTES", 1024 * 1024 * 1024, 0),
    ),
    sessionSecret,
    cookieSecure: overrides.cookieSecure ?? boolean("COOKIE_SECURE", process.env.NODE_ENV !== "test"),
    adminSessionSeconds: Number(
      overrides.adminSessionSeconds ?? integer("ADMIN_SESSION_SECONDS", 12 * 60 * 60, 300),
    ),
    mailboxSessionSeconds: Number(
      overrides.mailboxSessionSeconds ?? integer("MAILBOX_SESSION_SECONDS", 30 * 24 * 60 * 60, 300),
    ),
    caddyDataDir: absolutePath(
      overrides.caddyDataDir || process.env.CADDY_DATA_DIR,
      path.join(dataDir, "caddy-data"),
    ),
    tlsCertFile: String(overrides.tlsCertFile || process.env.TLS_CERT_FILE || "").trim(),
    tlsKeyFile: String(overrides.tlsKeyFile || process.env.TLS_KEY_FILE || "").trim(),
    tlsPollSeconds: Number(overrides.tlsPollSeconds ?? integer("TLS_POLL_SECONDS", 600, 15, 86400)),
    requireSmtpTls: overrides.requireSmtpTls ?? boolean("REQUIRE_SMTP_TLS", process.env.NODE_ENV === "production"),
    trustProxy: Number(overrides.trustProxy ?? integer("TRUST_PROXY", 1, 0, 10)),
  };
}

export { PROJECT_DIR };
