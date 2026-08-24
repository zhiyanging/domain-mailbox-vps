#!/usr/bin/env node
import net from "node:net";
import tls from "node:tls";
import { createConfig } from "../src/config.js";

const serviceConfig = createConfig();
const origin = String(process.env.WEB_ORIGIN || `https://${serviceConfig.webHost}`).replace(/\/$/, "");
const domain = String(process.env.TEST_MAIL_DOMAIN || serviceConfig.mailDomain).toLowerCase();
const adminToken = String(process.env.ADMIN_API_TOKEN || "");
const adminPassword = String(process.env.ADMIN_PASSWORD || "");
const smtpHost = String(process.env.MX_HOST || serviceConfig.mxHost);

if (!origin || !domain || !adminToken || !adminPassword) {
  throw new Error("ADMIN_API_TOKEN and ADMIN_PASSWORD are required; origin and domain come from config/domains.json");
}

function check(value, message) {
  if (!value) throw new Error(message);
}

async function request(method, route, { token = adminToken, body, cookie, baseOrigin = origin } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${baseOrigin}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}

function responseReader(socket) {
  let buffer = "";
  const lines = [];
  const waiters = [];
  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
    flush();
  };
  const onError = (error) => {
    while (waiters.length) waiters.shift().reject(error);
  };
  function flush() {
    while (waiters.length) {
      const end = lines.findIndex((line) => /^\d{3} /.test(line));
      if (end < 0) break;
      waiters.shift().resolve(lines.splice(0, end + 1));
    }
  }
  socket.on("data", onData);
  socket.on("error", onError);
  return {
    read: () => new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      flush();
    }),
    detach: () => {
      socket.off("data", onData);
      socket.off("error", onError);
    },
  };
}

function code(lines) {
  return Number(String(lines.at(-1) || "").slice(0, 3));
}

async function smtpSession(callback) {
  const socket = net.createConnection({ host: smtpHost, port: 25 });
  socket.setTimeout(30_000, () => socket.destroy(new Error("SMTP timeout")));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let reader = responseReader(socket);
  check(code(await reader.read()) === 220, "SMTP greeting");
  socket.write("EHLO production-verifier.example\r\n");
  const ehlo = await reader.read();
  check(code(ehlo) === 250 && ehlo.some((line) => /STARTTLS/i.test(line)), "STARTTLS advertised");
  check(ehlo.some((line) => /SIZE\s+26214400/i.test(line)), "25 MiB size advertised");
  socket.write("STARTTLS\r\n");
  check(code(await reader.read()) === 220, "STARTTLS accepted");
  reader.detach();
  const secure = tls.connect({ socket, servername: smtpHost, rejectUnauthorized: true });
  secure.setTimeout(30_000, () => secure.destroy(new Error("SMTP TLS timeout")));
  await new Promise((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  check(secure.authorized, "SMTP certificate verified");
  reader = responseReader(secure);
  secure.write("EHLO production-verifier.example\r\n");
  check(code(await reader.read()) === 250, "post-TLS EHLO");
  try {
    return await callback({
      command: async (command) => {
        secure.write(`${command}\r\n`);
        const lines = await reader.read();
        return { code: code(lines), lines };
      },
      data: async (raw) => {
        secure.write("DATA\r\n");
        check(code(await reader.read()) === 354, "DATA accepted");
        secure.write(`${raw}\r\n.\r\n`);
        const lines = await reader.read();
        return { code: code(lines), lines };
      },
      oversizedData: async (bytes) => {
        secure.write("DATA\r\n");
        check(code(await reader.read()) === 354, "oversize DATA accepted for streaming check");
        secure.write("From: size@example.net\r\nTo: size@example.net\r\nSubject: size check\r\n\r\n");
        const block = "x".repeat(64 * 1024);
        let sent = 0;
        while (sent < bytes) {
          const chunk = block.slice(0, Math.min(block.length, bytes - sent));
          if (!secure.write(chunk)) await new Promise((resolve) => secure.once("drain", resolve));
          sent += chunk.length;
        }
        secure.write("\r\n.\r\n");
        const lines = await reader.read();
        return { code: code(lines), lines };
      },
    });
  } finally {
    secure.write("QUIT\r\n");
    await reader.read().catch(() => []);
    secure.end();
  }
}

const suffix = String(Date.now()).slice(-8);
const localPart = `accept${suffix}`;
let response = await request("GET", "/v1/domains");
check(response.status === 200, `domain registry: ${response.status}`);
const domainRegistry = await response.json();
const enabledDomains = (domainRegistry.items || []).filter((item) => item.enabled).map((item) => String(item.domain));
check(enabledDomains.includes(domain), `configured test domain: ${domain}`);
const secondDomain = String(
  process.env.TEST_SECOND_MAIL_DOMAIN
  || enabledDomains.find((item) => item !== domain)
  || domain,
).toLowerCase();
check(enabledDomains.includes(secondDomain), `configured second test domain: ${secondDomain}`);

response = await fetch(`${origin}/`, { redirect: "manual" });
check(response.status === 200 && !response.headers.get("location"), "control root is a non-redirecting landing page");
const landingHtml = await response.text();
check(!/\/admin|mailbox|inbox|email|api/i.test(landingHtml), "landing page hides service entry points");

response = await request("POST", "/v1/mailboxes", {
  body: { local_part: localPart, domain },
});
check(response.status === 201, `custom mailbox create: ${response.status}`);
const primary = await response.json();
response = await request("POST", "/v1/mailboxes", {
  body: { local_part: localPart, domain },
});
check(response.status === 409, `duplicate mailbox status: ${response.status}`);
let secondary;
if (secondDomain === domain) {
  response = await request("POST", "/v1/mailboxes/batch", { body: { count: 1, domain } });
  check(response.status === 201, `batch mailbox create: ${response.status}`);
  secondary = (await response.json()).items[0];
} else {
  response = await request("POST", "/v1/mailboxes", {
    body: { local_part: localPart, domain: secondDomain },
  });
  check(response.status === 201, `second-domain mailbox create: ${response.status}`);
  secondary = await response.json();
  check(secondary.address.split("@", 1)[0] === primary.address.split("@", 1)[0], "same local part across domains");
}

response = await request("GET", `/v1/mailboxes?domain=${encodeURIComponent(secondDomain)}`);
check(response.status === 200 && (await response.json()).items.some((item) => item.address === secondary.address), "domain mailbox filter");

response = await request("POST", "/api/admin/login", {
  token: "",
  body: { username: "admin", password: adminPassword },
});
check(response.status === 200 && (await response.clone().json()).csrf, "admin password login");
const adminCookie = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
check(adminCookie, "admin HttpOnly session cookie");
check((await request("GET", "/api/admin/session", { token: "", cookie: adminCookie })).status === 200, "admin session");

const smtpChecks = await smtpSession(async (smtp) => {
  check((await smtp.command("MAIL FROM:<sender@example.net>")).code === 250, "MAIL FROM");
  const unknown = await smtp.command(`RCPT TO:<unknown@${domain}>`);
  check(unknown.code === 550, `unknown recipient: ${unknown.code}`);
  await smtp.command("RSET");
  await smtp.command("MAIL FROM:<sender@example.net>");
  const relay = await smtp.command("RCPT TO:<outside@example.org>");
  check(relay.code === 550, `relay recipient: ${relay.code}`);
  return { unknown: unknown.code, relay: relay.code };
});

const boundary = `acceptance-${suffix}`;
const rawMessage = [
  "From: Acceptance Sender <sender@example.net>",
  `To: ${primary.address}, ${secondary.address}`,
  `Message-ID: <acceptance-${suffix}@example.net>`,
  "Subject: Production mailbox acceptance 654321",
  "MIME-Version: 1.0",
  `Content-Type: multipart/mixed; boundary=${boundary}`,
  "",
  `--${boundary}`,
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>HTML body <strong>654321</strong></p><script>window.bad=1</script><img src="https://tracker.invalid/pixel">',
  `--${boundary}`,
  "Content-Type: application/octet-stream; name=acceptance.txt",
  "Content-Disposition: attachment; filename=acceptance.txt",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("acceptance-attachment").toString("base64"),
  `--${boundary}--`,
].join("\r\n");

for (let index = 0; index < 2; index += 1) {
  await smtpSession(async (smtp) => {
    await smtp.command("MAIL FROM:<sender@example.net>");
    check((await smtp.command(`RCPT TO:<${primary.address}>`)).code === 250, "primary recipient");
    check((await smtp.command(`RCPT TO:<${secondary.address}>`)).code === 250, "secondary recipient");
    check((await smtp.data(rawMessage)).code === 250, "message accepted");
  });
}

let page;
for (let attempt = 0; attempt < 20; attempt += 1) {
  response = await request("GET", `/v1/messages?address=${encodeURIComponent(primary.address)}&limit=50&offset=0`, { token: primary.token });
  if (response.status === 200) {
    const candidate = await response.json();
    if (candidate.count >= 2) {
      page = candidate;
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check(page?.count === 2, "duplicate Message-ID deliveries retained");
check(page.results.every((item) => item.raw.includes("acceptance.txt")), "raw MIME retained");
const messageId = page.results[0].id;

response = await request("GET", `/v1/messages/${encodeURIComponent(messageId)}/raw`, { token: primary.token });
const rawBytes = (await response.arrayBuffer()).byteLength;
check(response.status === 200 && /message\/rfc822/i.test(response.headers.get("content-type") || ""), "raw download");
response = await request("GET", `/v1/messages/${encodeURIComponent(messageId)}/attachments/0`, { token: primary.token });
const attachment = Buffer.from(await response.arrayBuffer());
check(response.status === 200 && attachment.toString() === "acceptance-attachment", "attachment download");

response = await fetch(primary.inbox_url, { redirect: "manual" });
check(response.status === 303 && !String(response.headers.get("location") || "").includes(primary.token), "dedicated link exchange");
const inboxCookie = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
check(!/(?:^|;)\s*Domain=/i.test(String(response.headers.get("set-cookie") || "")), "inbox cookie is host-only");
const primaryInboxOrigin = new URL(primary.inbox_url).origin;
check((await fetch(`${primaryInboxOrigin}/admin`, { redirect: "manual" })).status === 404, "inbox host hides admin routes");
response = await request("GET", `/api/inbox/messages?address=${encodeURIComponent(primary.address)}`, { token: "", cookie: inboxCookie, baseOrigin: primaryInboxOrigin });
check(response.status === 200 && (await response.json()).count === 2, "dedicated inbox session");
response = await request("GET", `/api/inbox/messages/${encodeURIComponent(messageId)}?address=${encodeURIComponent(primary.address)}`, { token: "", cookie: inboxCookie, baseOrigin: primaryInboxOrigin });
const detail = await response.json();
check(response.status === 200, "message detail");
check(!String(detail.html || "").toLowerCase().includes("<script"), "HTML script removed");
check(!String(detail.html || "").includes("tracker.invalid"), "remote HTML resource removed");

response = await request("POST", `/v1/mailboxes/${encodeURIComponent(primary.address)}/rotate-token`);
check(response.status === 200, "mailbox token rotation");
const rotated = await response.json();
check((await request("GET", `/v1/messages?address=${encodeURIComponent(primary.address)}`, { token: primary.token })).status === 401, "old mailbox token invalidated");
check((await request("GET", `/api/inbox/messages?address=${encodeURIComponent(primary.address)}`, { token: "", cookie: inboxCookie, baseOrigin: primaryInboxOrigin })).status === 401, "old mailbox session invalidated");
check((await request("GET", `/v1/messages?address=${encodeURIComponent(primary.address)}`, { token: rotated.token })).status === 200, "rotated token works");

const oversize = await smtpSession(async (smtp) => {
  await smtp.command("MAIL FROM:<sender@example.net>");
  check((await smtp.command(`RCPT TO:<${primary.address}>`)).code === 250, "oversize recipient");
  return smtp.oversizedData(25 * 1024 * 1024 + 1024);
});
check(oversize.code === 552, `oversize response: ${oversize.code}`);

for (const mailbox of [primary, secondary]) {
  response = await request("PATCH", `/v1/mailboxes/${encodeURIComponent(mailbox.address)}`, { body: { enabled: false } });
  check(response.status === 200, "mailbox disabled");
}
const disabledCode = await smtpSession(async (smtp) => {
  await smtp.command("MAIL FROM:<sender@example.net>");
  return (await smtp.command(`RCPT TO:<${primary.address}>`)).code;
});
check(disabledCode === 550, `disabled recipient: ${disabledCode}`);
check((await request("DELETE", `/v1/messages/${encodeURIComponent(messageId)}`)).status === 404, "no deletion endpoint");

response = await request("GET", "/api/admin/dashboard");
check(response.status === 200, "dashboard");
const dashboard = await response.json();

console.log(JSON.stringify({
  ok: true,
  customAddress: primary.address,
  batchAddress: secondary.address,
  domains: [domain, secondDomain],
  multiDomainVerified: secondDomain !== domain,
  duplicateStatus: 409,
  messageCount: page.count,
  duplicateMessageIdRetained: true,
  rawBytes,
  attachmentBytes: attachment.length,
  starttls: true,
  smtpCertificateVerified: true,
  unknownRecipient: smtpChecks.unknown,
  relayRecipient: smtpChecks.relay,
  oversizeResponse: oversize.code,
  disabledRecipient: disabledCode,
  htmlScriptRemoved: true,
  remoteResourceRemoved: true,
  tokenAndSessionRotated: true,
  mailboxesLeftDisabled: 2,
  totalStoredMessages: dashboard.statistics.messages.total,
}));
