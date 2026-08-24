import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createConfig } from "../src/config.js";

export async function temporaryConfig(overrides = {}) {
  const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "domain-mailbox-test-"));
  const domainConfig = overrides.domainConfig || {
    schema_version: 1,
    default_domain: "mail.test",
    shared_mx_host: "mx.mail.test",
    control_host: "manage.mail.test",
    landing: {
      title: "Digital Infrastructure",
      headline: "Reliable digital infrastructure for modern teams.",
      description: "Secure, resilient services designed for dependable digital operations.",
    },
    domains: [
      { domain: "mail.test", inbox_host: "inbox.mail.test", public_hosts: ["mail.test", "www.mail.test"], enabled: true },
      { domain: "second.test", inbox_host: "inbox.second.test", public_hosts: ["second.test", "www.second.test"], enabled: true },
      { domain: "disabled.test", inbox_host: "inbox.disabled.test", public_hosts: ["disabled.test", "www.disabled.test"], enabled: false },
    ],
  };
  const config = createConfig({
    nodeEnv: "test",
    domainConfig,
    dataDir,
    dbPath: path.join(dataDir, "mailbox.sqlite3"),
    rawDir: path.join(dataDir, "raw"),
    tempDir: path.join(dataDir, "tmp"),
    caddyDataDir: path.join(dataDir, "caddy"),
    sessionSecret: "test-session-secret-that-is-long-and-stable",
    cookieSecure: false,
    requireSmtpTls: false,
    httpHost: "127.0.0.1",
    httpPort: 0,
    smtpHost: "127.0.0.1",
    smtpPort: 0,
    diskMinFreeBytes: 0,
    diskHighWaterPercent: 99,
    tlsPollSeconds: 3600,
    ...overrides,
    domainConfig,
  });
  return {
    config,
    cleanup: async () => fsPromises.rm(dataDir, { recursive: true, force: true }),
  };
}

export function hostFetch(origin, host, route, options = {}) {
  const target = new URL(route, origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers: { ...(options.headers || {}), Host: host },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: response.headers,
        }));
      });
    });
    request.on("error", reject);
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

export async function listenHttp(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function smtpReader(socket) {
  let buffer = "";
  const lines = [];
  const waiters = [];
  function flush() {
    while (waiters.length) {
      const index = lines.findIndex((line) => /^\d{3} /.test(line));
      if (index < 0) break;
      const result = lines.splice(0, index + 1);
      waiters.shift()(result);
    }
  }
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
    flush();
  });
  return () => new Promise((resolve) => { waiters.push(resolve); flush(); });
}

export async function smtpConversation(port, commands) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const nextResponse = smtpReader(socket);
  const results = [{ command: "CONNECT", lines: await nextResponse() }];
  for (const command of commands) {
    if (command.data) {
      socket.write(`${command.command}\r\n`);
      const preliminary = await nextResponse();
      if (Number(String(preliminary.at(-1) || "").slice(0, 3)) !== 354) {
        results.push({ command: command.command, lines: preliminary });
        continue;
      }
      socket.write(`${command.data}\r\n.\r\n`);
      results.push({ command: command.command, lines: await nextResponse(), preliminary });
    } else {
      socket.write(`${command.command}\r\n`);
      results.push({ command: command.command, lines: await nextResponse() });
    }
  }
  socket.end();
  return results;
}

export function responseCode(result) {
  return Number(String(result.lines.at(-1) || "").slice(0, 3));
}

export function rawFixture({ to, messageId = "fixture-1@mail.test", attachment = false, subject = "Your code is 123456" }) {
  if (!attachment) {
    return [
      "From: Sender <sender@example.net>",
      `To: ${to}`,
      `Message-ID: <${messageId}>`,
      `Subject: ${subject}`,
      "Date: Wed, 20 Aug 2026 01:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "OpenAI verification code: 123456",
    ].join("\r\n");
  }
  return [
    "From: Sender <sender@example.net>",
    `To: ${to}`,
    `Message-ID: <${messageId}>`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=mail-boundary",
    "",
    "--mail-boundary",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Full <strong>message</strong><script>alert(1)</script></p><img src=\"https://tracker.invalid/pixel\">",
    "--mail-boundary",
    "Content-Type: text/plain; name=sample.txt",
    "Content-Disposition: attachment; filename=sample.txt",
    "Content-Transfer-Encoding: base64",
    "",
    "YXR0YWNobWVudC1jb250ZW50",
    "--mail-boundary--",
  ].join("\r\n");
}
