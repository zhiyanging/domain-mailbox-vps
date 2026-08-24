import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import express from "express";
import swaggerUiDist from "swagger-ui-dist";
import {
  constantTimeEqual,
  createSession,
  csrfForSession,
  randomToken,
  tokenHash,
  verifyCsrf,
  verifyPassword,
  verifySession,
} from "./security.js";
import {
  normalizeAddress,
  addressDomain,
  parseFullMessage,
  randomLocalPart,
  readAttachment,
  validateLocalPart,
} from "./message-utils.js";

const ADMIN_COOKIE = "domain_mail_admin";
const MAILBOX_COOKIE = "domain_mail_inbox";

function bearerToken(req) {
  const value = String(req.headers.authorization || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : "";
}

function parseCookies(req) {
  const result = {};
  for (const segment of String(req.headers.cookie || "").split(";")) {
    const index = segment.indexOf("=");
    if (index <= 0) continue;
    const key = segment.slice(0, index).trim();
    try {
      result[key] = decodeURIComponent(segment.slice(index + 1).trim());
    } catch {
      result[key] = "";
    }
  }
  return result;
}

function setCookie(res, name, value, config, maxAgeSeconds, sameSite = "Strict") {
  const secure = config.cookieSecure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; SameSite=${sameSite}${secure}`,
  );
}

function clearCookie(res, name, config) {
  const secure = config.cookieSecure ? "; Secure" : "";
  res.appendHeader(
    "Set-Cookie",
    `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
  );
}

function cleanFilename(value) {
  return String(value || "attachment.bin").replace(/[\r\n"\\/<>:*?|\x00-\x1f]+/g, "_").slice(0, 180) || "attachment.bin";
}

function resolvedRawPath(config, relativePath) {
  const root = path.resolve(config.rawDir);
  const candidate = path.resolve(root, String(relativePath || ""));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return "";
  return candidate;
}

function inboxUrl(config, token, address) {
  const origin = config.inboxOrigin(addressDomain(address));
  if (!origin) throw new Error("invalid_domain");
  return `${origin}/cf-inbox/${encodeURIComponent(token)}/${encodeURIComponent(address)}`;
}

function formatMailboxCreation(config, address, token) {
  return { address, token, inbox_url: inboxUrl(config, token, address) };
}

function loginLimiter() {
  const entries = new Map();
  return {
    allowed(key) {
      const now = Date.now();
      const row = entries.get(key);
      if (!row || row.resetAt <= now) {
        entries.set(key, { count: 0, resetAt: now + 15 * 60_000 });
        return true;
      }
      return row.count < 5;
    },
    fail(key) {
      const now = Date.now();
      const row = entries.get(key) || { count: 0, resetAt: now + 15 * 60_000 };
      row.count += 1;
      entries.set(key, row);
    },
    clear(key) {
      entries.delete(key);
    },
  };
}

export function createHttpApp({ config, database, smtpService }) {
  const app = express();
  const publicDir = path.join(config.projectDir, "public");
  const swaggerDir = swaggerUiDist.getAbsoluteFSPath();
  const limiter = loginLimiter();
  const isControlRole = (role) => role === "control" || role === "control-inbox";
  const isInboxRole = (role) => role === "inbox" || role === "control-inbox";
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = String(req.headers.host || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    const route = config.domains.hostRole(host);
    if (!route) return res.status(421).json({ error: "unknown_host" });
    req.mailHost = { host, ...route };
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    );
    if (config.cookieSecure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });

  function requireControlHost(req, res, next) {
    if (!isControlRole(req.mailHost?.role)) return res.status(404).json({ error: "not_found" });
    next();
  }

  function requireInboxHost(req, res, next) {
    if (!isInboxRole(req.mailHost?.role)) return res.status(404).json({ error: "not_found" });
    next();
  }

  function mailboxMatchesHost(mailbox, req) {
    const entry = config.domainEntry(mailbox?.domain || addressDomain(mailbox?.address));
    return Boolean(entry?.enabled && isInboxRole(req.mailHost?.role) && req.mailHost.host === entry.inboxHost);
  }

  function adminAuthentication(req) {
    const admin = database.getAdmin();
    if (!admin) return null;
    const bearer = bearerToken(req);
    if (bearer && constantTimeEqual(tokenHash(bearer), admin.api_token_hash)) {
      return { mode: "bearer", admin, session: null };
    }
    const session = verifySession(parseCookies(req)[ADMIN_COOKIE], config.sessionSecret);
    if (
      session?.kind === "admin" &&
      String(session.id) === String(admin.id) &&
      Number(session.version) === Number(admin.session_version)
    ) {
      return { mode: "cookie", admin, session };
    }
    return null;
  }

  function mailboxAuthentication(req, expectedAddress = "") {
    const adminAuth = adminAuthentication(req);
    if (adminAuth) return { ...adminAuth, mailbox: null, isAdmin: true };
    const expected = normalizeAddress(expectedAddress);
    const bearer = bearerToken(req);
    if (bearer) {
      const mailbox = database.mailboxByToken(bearer);
      if (
        mailbox &&
        Number(mailbox.enabled) === 1 &&
        config.domainEntry(mailbox.domain || addressDomain(mailbox.address))?.enabled &&
        (!expected || mailbox.address === expected)
      ) {
        return { mode: "bearer", mailbox, isAdmin: false, session: null };
      }
    }
    const session = verifySession(parseCookies(req)[MAILBOX_COOKIE], config.sessionSecret);
    if (session?.kind !== "mailbox") return null;
    const mailbox = database.mailboxByAddress(session.address);
    if (
      !mailbox ||
      Number(mailbox.enabled) !== 1 ||
      !config.domainEntry(mailbox.domain || addressDomain(mailbox.address))?.enabled ||
      String(mailbox.id) !== String(session.id) ||
      Number(mailbox.session_version) !== Number(session.version) ||
      (expected && mailbox.address !== expected)
    ) {
      return null;
    }
    return { mode: "cookie", mailbox, isAdmin: false, session };
  }

  function requireAdmin(req, res, next) {
    const auth = adminAuthentication(req);
    if (!auth) return res.status(401).json({ ok: false, error: "unauthorized" });
    req.adminAuth = auth;
    next();
  }

  function requireAdminBearer(req, res, next) {
    const auth = adminAuthentication(req);
    if (!auth || auth.mode !== "bearer") return res.status(401).json({ ok: false, error: "unauthorized" });
    req.adminAuth = auth;
    next();
  }

  function requireAdminMutation(req, res, next) {
    const auth = adminAuthentication(req);
    if (!auth) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (auth.mode === "cookie" && !verifyCsrf(auth.session, req.headers["x-csrf-token"], config.sessionSecret)) {
      return res.status(403).json({ ok: false, error: "csrf_failed" });
    }
    req.adminAuth = auth;
    next();
  }

  function messageForAuth(auth, messageId) {
    if (auth?.isAdmin || auth?.admin) return database.messageForAdmin(messageId);
    return auth?.mailbox ? database.messageForMailbox(messageId, auth.mailbox.id) : null;
  }

  async function sendRaw(res, row) {
    const filePath = resolvedRawPath(config, row?.raw_path);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "raw_not_found" });
    res.setHeader("Content-Type", "message/rfc822");
    res.setHeader("Content-Disposition", `attachment; filename="${cleanFilename(`${row.id}.eml`)}"`);
    return res.sendFile(filePath);
  }

  async function sendAttachment(res, row, index) {
    const filePath = resolvedRawPath(config, row?.raw_path);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "raw_not_found" });
    const attachment = await readAttachment(filePath, index);
    if (!attachment) return res.status(404).json({ error: "attachment_not_found" });
    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${cleanFilename(attachment.filename)}"`);
    return res.send(attachment.content);
  }

  function createMailboxItems({ count = 1, localPart = "", domain = config.mailDomain }) {
    const targetDomain = String(domain || config.mailDomain).trim().toLowerCase();
    const domainEntry = config.domainEntry(targetDomain);
    if (!domainEntry?.enabled) {
      const error = new Error("invalid_domain");
      error.status = 400;
      throw error;
    }
    const total = Math.min(500, Math.max(1, Number.parseInt(count, 10) || 1));
    const exact = localPart ? validateLocalPart(localPart) : "";
    if (exact && total !== 1) {
      const error = new Error("local_part_requires_count_1");
      error.status = 400;
      throw error;
    }
    const generated = [];
    const addresses = new Set();
    while (generated.length < total) {
      const local = exact || randomLocalPart(12);
      const address = `${local}@${targetDomain}`;
      if (addresses.has(address) || database.mailboxByAddress(address)) {
        if (exact) {
          const error = new Error("address_exists");
          error.status = 409;
          throw error;
        }
        continue;
      }
      addresses.add(address);
      generated.push({ address, domain: targetDomain, token: randomToken(32) });
    }
    try {
      database.createMailboxes(generated);
    } catch (error) {
      if (String(error.code || "").startsWith("SQLITE_CONSTRAINT")) {
        error.status = 409;
        error.message = "address_exists";
      }
      throw error;
    }
    return generated.map((item) => formatMailboxCreation(config, item.address, item.token));
  }

  app.use("/api/admin", requireControlHost);
  app.use("/v1", requireControlHost);
  app.use("/api/inbox", requireInboxHost);

  app.get("/health", requireControlHost, (_req, res) => {
    const smtp = smtpService?.health?.() || { ready: false, tls: false, disk: null };
    const adminReady = database.adminExists();
    const ok = adminReady && smtp.ready && smtp.disk?.ok !== false;
    res.status(ok ? 200 : 503).json({
      ok,
      service: "domain-mailbox-vps",
      domain: config.mailDomain,
      domain_count: config.domains.domains.length,
      storage: "sqlite+eml",
      receiveOnly: true,
      adminReady,
      smtp: { ready: smtp.ready, tls: smtp.tls },
      disk: smtp.disk,
    });
  });

  app.get("/site-config.json", (req, res) => {
    if (req.mailHost.role === "mx") return res.status(404).json({ error: "not_found" });
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(config.domains.landing);
  });

  app.get("/api/public-config", (req, res) => {
    if (!isControlRole(req.mailHost.role)) return res.status(404).json({ error: "not_found" });
    res.json({ domain: config.mailDomain, webHost: config.webHost, receiveOnly: true });
  });

  app.post("/api/admin/login", async (req, res) => {
    const key = String(req.ip || req.socket.remoteAddress || "unknown");
    if (!limiter.allowed(key)) return res.status(429).json({ ok: false, error: "too_many_attempts" });
    const admin = database.getAdmin();
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!admin || username !== admin.username || !(await verifyPassword(password, admin.password_hash))) {
      limiter.fail(key);
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }
    limiter.clear(key);
    const sessionToken = createSession(
      { kind: "admin", id: String(admin.id), version: admin.session_version },
      config.sessionSecret,
      config.adminSessionSeconds,
    );
    setCookie(res, ADMIN_COOKIE, sessionToken, config, config.adminSessionSeconds);
    const session = verifySession(sessionToken, config.sessionSecret);
    res.json({ ok: true, username: admin.username, csrf: csrfForSession(session, config.sessionSecret) });
  });

  app.post("/api/admin/logout", requireAdminMutation, (req, res) => {
    clearCookie(res, ADMIN_COOKIE, config);
    res.json({ ok: true });
  });

  app.get("/api/admin/session", requireAdmin, (req, res) => {
    res.json({
      ok: true,
      username: req.adminAuth.admin.username,
      mode: req.adminAuth.mode,
      csrf: req.adminAuth.session ? csrfForSession(req.adminAuth.session, config.sessionSecret) : "",
    });
  });

  app.get("/api/admin/config", requireAdmin, (_req, res) => {
    res.json({
      default_domain: config.domains.defaultDomain,
      control_host: config.domains.controlHost,
      shared_mx_host: config.domains.sharedMxHost,
      domains: config.domains.domains.map((entry) => ({
        domain: entry.domain,
        inbox_host: entry.inboxHost,
        enabled: entry.enabled,
        default: entry.domain === config.domains.defaultDomain,
      })),
    });
  });

  app.get("/api/admin/dashboard", requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      statistics: database.statistics(),
      disk: smtpService?.getDiskState?.() || null,
      smtp: smtpService?.health?.() || null,
    });
  });

  app.get("/api/admin/mailboxes", requireAdmin, (req, res) => {
    res.json(database.listMailboxes(req.query));
  });

  app.post("/api/admin/mailboxes/batch", requireAdminMutation, (req, res, next) => {
    try {
      const items = createMailboxItems({ count: req.body?.count, domain: req.body?.domain });
      res.status(201).json({ items, count: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/mailboxes", requireAdminMutation, (req, res, next) => {
    try {
      const items = createMailboxItems({ count: 1, localPart: req.body?.local_part, domain: req.body?.domain });
      res.status(201).json(items[0]);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/admin/mailboxes/:address", requireAdminMutation, (req, res) => {
    const mailbox = database.setMailboxEnabled(req.params.address, Boolean(req.body?.enabled));
    if (!mailbox) return res.status(404).json({ error: "mailbox_not_found" });
    res.json({ address: mailbox.address, enabled: Boolean(mailbox.enabled), updated_at: mailbox.updated_at });
  });

  app.post("/api/admin/mailboxes/:address/rotate-token", requireAdminMutation, (req, res) => {
    const token = randomToken(32);
    const mailbox = database.rotateMailboxToken(req.params.address, token);
    if (!mailbox) return res.status(404).json({ error: "mailbox_not_found" });
    res.json(formatMailboxCreation(config, mailbox.address, token));
  });

  app.get("/api/admin/messages", requireAdmin, (req, res) => {
    res.json(database.listMessagesForAdmin(req.query));
  });

  app.get("/api/admin/messages/:id", requireAdmin, async (req, res) => {
    const row = database.messageForAdmin(req.params.id);
    if (!row) return res.status(404).json({ error: "message_not_found" });
    const filePath = resolvedRawPath(config, row.raw_path);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "raw_not_found" });
    res.json({ id: row.id, recipients: String(row.recipients || "").split(",").filter(Boolean), ...(await parseFullMessage(filePath)) });
  });

  app.get("/api/admin/messages/:id/raw", requireAdmin, async (req, res) => sendRaw(res, database.messageForAdmin(req.params.id)));
  app.get("/api/admin/messages/:id/attachments/:index", requireAdmin, async (req, res) => sendAttachment(res, database.messageForAdmin(req.params.id), req.params.index));

  app.get("/v1/domains", requireAdminBearer, (_req, res) => {
    const items = config.domains.domains.map((entry) => ({
      domain: entry.domain,
      inbox_host: entry.inboxHost,
      enabled: entry.enabled,
      default: entry.domain === config.domains.defaultDomain,
    }));
    res.json({ items, count: items.length });
  });

  app.post("/v1/mailboxes/batch", requireAdminMutation, (req, res, next) => {
    try {
      const items = createMailboxItems({ count: req.body?.count, localPart: req.body?.local_part, domain: req.body?.domain });
      res.status(201).json({ items, count: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/mailboxes", requireAdminMutation, (req, res, next) => {
    try {
      const items = createMailboxItems({ count: 1, localPart: req.body?.local_part, domain: req.body?.domain });
      res.status(201).json(items[0]);
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/mailboxes", requireAdmin, (req, res) => res.json(database.listMailboxes(req.query)));

  app.patch("/v1/mailboxes/:address", requireAdminMutation, (req, res) => {
    const mailbox = database.setMailboxEnabled(req.params.address, Boolean(req.body?.enabled));
    if (!mailbox) return res.status(404).json({ error: "mailbox_not_found" });
    res.json({ address: mailbox.address, enabled: Boolean(mailbox.enabled), updated_at: mailbox.updated_at });
  });

  app.post("/v1/mailboxes/:address/rotate-token", requireAdminMutation, (req, res) => {
    const token = randomToken(32);
    const mailbox = database.rotateMailboxToken(req.params.address, token);
    if (!mailbox) return res.status(404).json({ error: "mailbox_not_found" });
    res.json(formatMailboxCreation(config, mailbox.address, token));
  });

  app.get("/v1/messages", async (req, res) => {
    const address = normalizeAddress(req.query.address);
    if (!address) return res.status(400).json({ error: "invalid_address" });
    const auth = mailboxAuthentication(req, address);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const mailbox = auth.isAdmin ? database.mailboxByAddress(address) : auth.mailbox;
    if (!mailbox) return res.status(404).json({ error: "mailbox_not_found" });
    const page = database.listMessagesForMailbox(mailbox.id, req.query);
    const results = await Promise.all(page.items.map(async (item) => {
      const filePath = resolvedRawPath(config, item.raw_path);
      const raw = filePath && fs.existsSync(filePath) ? await fsPromises.readFile(filePath, "utf8") : "";
      return {
        id: item.id,
        message_id: item.message_id,
        source: item.source,
        address: item.address,
        raw,
        raw_size: item.raw_size,
        truncated: 0,
        created_at: item.created_at,
      };
    }));
    res.json({ results, count: page.count, limit: page.limit, offset: page.offset });
  });

  app.get("/v1/messages/:id/raw", async (req, res) => {
    const auth = mailboxAuthentication(req, req.query.address || "");
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    return sendRaw(res, messageForAuth(auth, req.params.id));
  });

  app.get("/v1/messages/:id/attachments/:index", async (req, res) => {
    const auth = mailboxAuthentication(req, req.query.address || "");
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    return sendAttachment(res, messageForAuth(auth, req.params.id), req.params.index);
  });

  app.get("/cf-inbox/:token/:address", requireInboxHost, (req, res) => {
    const address = normalizeAddress(req.params.address);
    const mailbox = database.mailboxByToken(req.params.token);
    if (!mailbox || Number(mailbox.enabled) !== 1 || mailbox.address !== address || !mailboxMatchesHost(mailbox, req)) {
      return res.status(401).send("Inbox link is invalid or disabled.");
    }
    const session = createSession(
      { kind: "mailbox", id: String(mailbox.id), address: mailbox.address, version: mailbox.session_version },
      config.sessionSecret,
      config.mailboxSessionSeconds,
    );
    setCookie(res, MAILBOX_COOKIE, session, config, config.mailboxSessionSeconds, "Lax");
    res.redirect(303, `/inbox/${encodeURIComponent(mailbox.address)}`);
  });

  app.get("/api/inbox/session", (req, res) => {
    const auth = mailboxAuthentication(req, req.query.address || "");
    if (!auth || auth.isAdmin || !mailboxMatchesHost(auth.mailbox, req)) return res.status(401).json({ error: "unauthorized" });
    res.json({ ok: true, address: auth.mailbox.address });
  });

  app.get("/api/inbox/messages", (req, res) => {
    const auth = mailboxAuthentication(req, req.query.address || "");
    if (!auth || auth.isAdmin || !mailboxMatchesHost(auth.mailbox, req)) return res.status(401).json({ error: "unauthorized" });
    const page = database.listMessagesForMailbox(auth.mailbox.id, req.query);
    res.json({
      ...page,
      items: page.items.map(({ raw_path: _rawPath, ...item }) => item),
    });
  });

  app.get("/api/inbox/messages/:id", async (req, res) => {
    const auth = mailboxAuthentication(req, req.query.address || "");
    if (!auth || auth.isAdmin || !mailboxMatchesHost(auth.mailbox, req)) return res.status(401).json({ error: "unauthorized" });
    const row = database.messageForMailbox(req.params.id, auth.mailbox.id);
    if (!row) return res.status(404).json({ error: "message_not_found" });
    const filePath = resolvedRawPath(config, row.raw_path);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "raw_not_found" });
    res.json({ id: row.id, recipient: row.recipient, ...(await parseFullMessage(filePath)) });
  });

  app.get("/api/inbox/messages/:id/raw", async (req, res) => {
    const auth = mailboxAuthentication(req, req.query.address || "");
    if (!auth || auth.isAdmin || !mailboxMatchesHost(auth.mailbox, req)) return res.status(401).json({ error: "unauthorized" });
    return sendRaw(res, database.messageForMailbox(req.params.id, auth.mailbox.id));
  });

  app.get("/api/inbox/messages/:id/attachments/:index", async (req, res) => {
    const auth = mailboxAuthentication(req, req.query.address || "");
    if (!auth || auth.isAdmin || !mailboxMatchesHost(auth.mailbox, req)) return res.status(401).json({ error: "unauthorized" });
    return sendAttachment(res, database.messageForMailbox(req.params.id, auth.mailbox.id), req.params.index);
  });

  app.get("/assets/:file", (req, res) => {
    const file = String(req.params.file || "");
    const common = new Set(["styles.css", "landing.js"]);
    const allowed = common.has(file)
      || (isControlRole(req.mailHost.role) && ["admin.js", "docs.js", "docs.css"].includes(file))
      || (isInboxRole(req.mailHost.role) && file === "inbox.js");
    if (!allowed) return res.status(404).json({ error: "not_found" });
    const fullPath = path.join(publicDir, file);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "not_found" });
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.sendFile(fullPath);
  });
  app.use("/docs-assets", requireControlHost, express.static(swaggerDir, { fallthrough: false, maxAge: "1h" }));
  app.get(["/admin", "/admin.html"], requireControlHost, (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));
  app.get("/docs", requireControlHost, (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:");
    res.sendFile(path.join(publicDir, "docs.html"));
  });
  app.get("/openapi.json", requireControlHost, (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(publicDir, "openapi.json"));
  });
  app.get("/inbox/:address", requireInboxHost, (req, res) => {
    const auth = mailboxAuthentication(req, req.params.address);
    if (!auth || auth.isAdmin || !mailboxMatchesHost(auth.mailbox, req)) return res.status(401).send("Open the dedicated inbox link again.");
    return res.sendFile(path.join(publicDir, "inbox.html"));
  });
  app.get("/", (req, res) => {
    if (req.mailHost.role === "mx") return res.status(404).send("not found");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.sendFile(path.join(publicDir, "landing.html"));
  });

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  app.use((error, _req, res, _next) => {
    const status = Number(error.status || 500);
    if (status >= 500) console.error(`HTTP error: ${error.stack || error.message}`);
    res.status(status).json({ error: status >= 500 ? "internal_error" : String(error.message || "request_failed") });
  });

  return app;
}

export { ADMIN_COOKIE, MAILBOX_COOKIE };
