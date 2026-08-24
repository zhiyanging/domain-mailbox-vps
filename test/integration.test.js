import test from "node:test";
import assert from "node:assert/strict";
import { createHttpApp } from "../src/app.js";
import { MailboxDatabase } from "../src/database.js";
import { SmtpService } from "../src/smtp.js";
import {
  hostFetch,
  listenHttp,
  rawFixture,
  responseCode,
  smtpConversation,
  temporaryConfig,
} from "./helpers.js";

const ADMIN_TOKEN = "test-admin-api-token-that-is-not-a-production-secret";

function bearer(token = ADMIN_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

function cookieValue(response) {
  return String(response.headers.get("set-cookie") || "").split(";", 1)[0];
}

test("multi-domain HTTP, SMTP, host isolation, and permanent inbox flow", async (t) => {
  const { config, cleanup } = await temporaryConfig();
  const database = new MailboxDatabase(config);
  await database.bootstrapAdmin({
    username: "admin",
    password: "test-admin-password-long-enough",
    apiToken: ADMIN_TOKEN,
  });
  const smtpService = new SmtpService(config, database);
  await smtpService.start();
  const http = await listenHttp(createHttpApp({ config, database, smtpService }));
  t.after(async () => {
    await http.close();
    await smtpService.stop();
    database.close();
    await cleanup();
  });

  const controlHost = config.domains.controlHost;
  const defaultDomain = config.domains.defaultDomain;
  const defaultInboxHost = config.domainEntry(defaultDomain).inboxHost;
  const secondInboxHost = config.domainEntry("second.test").inboxHost;
  const publicHost = config.domainEntry(defaultDomain).publicHosts[0];
  const request = (host, route, options = {}) => hostFetch(http.origin, host, route, options);

  for (const host of [controlHost, publicHost, defaultInboxHost]) {
    const response = await request(host, "/", { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.has("location"), false);
    const html = await response.text();
    assert.match(html, /Digital Infrastructure/i);
    assert.doesNotMatch(html, /\/admin|mailbox|inbox|email|api/i);
  }
  assert.equal((await request("unknown.test", "/")).status, 421);

  for (const route of ["/admin", "/docs", "/openapi.json", "/v1/domains", "/health"]) {
    assert.equal((await request(defaultInboxHost, route)).status, 404, `${route} must be isolated from inbox hosts`);
  }
  assert.equal((await request(publicHost, "/v1/domains")).status, 404);

  const docs = await request(controlHost, "/docs");
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /swagger-ui/i);
  const docsScript = await request(controlHost, "/assets/docs.js");
  assert.equal(docsScript.status, 200);
  assert.match(await docsScript.text(), /supportedSubmitMethods:\s*\[\]/);
  const openapiResponse = await request(controlHost, "/openapi.json");
  assert.equal(openapiResponse.status, 200);
  const openapi = await openapiResponse.json();
  assert.equal(openapi.openapi, "3.1.0");
  assert.deepEqual(Object.keys(openapi.paths).filter((route) => route.startsWith("/api/")), []);
  assert.ok(openapi.paths["/health"]);
  assert.ok(openapi.paths["/v1/domains"]);

  const health = await request(controlHost, "/health");
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.domain, defaultDomain);
  assert.equal(healthBody.domain_count, 3);
  assert.equal(healthBody.receiveOnly, true);

  assert.equal((await request(controlHost, "/v1/domains")).status, 401);
  const loginResponse = await request(controlHost, "/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-admin-password-long-enough" }),
  });
  assert.equal(loginResponse.status, 200);
  const adminSetCookie = String(loginResponse.headers.get("set-cookie") || "");
  assert.match(adminSetCookie, /HttpOnly/i);
  assert.doesNotMatch(adminSetCookie, /(?:^|;)\s*Domain=/i);
  assert.equal((await request(controlHost, "/v1/domains", {
    headers: { Cookie: cookieValue(loginResponse) },
  })).status, 401);
  const domainsResponse = await request(controlHost, "/v1/domains", { headers: bearer() });
  assert.equal(domainsResponse.status, 200);
  const domains = await domainsResponse.json();
  assert.equal(domains.count, 3);
  assert.equal(domains.items.find((item) => item.domain === defaultDomain).default, true);
  assert.equal(domains.items.find((item) => item.domain === "disabled.test").enabled, false);

  async function createMailbox(domain, localPart) {
    const response = await request(controlHost, "/v1/mailboxes", {
      method: "POST",
      headers: { ...bearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ domain, local_part: localPart }),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body);
  }

  const first = await createMailbox(defaultDomain, "shared");
  const second = await createMailbox("second.test", "shared");
  assert.equal(first.address, "shared@mail.test");
  assert.equal(second.address, "shared@second.test");
  assert.equal(new URL(first.inbox_url).host, defaultInboxHost);
  assert.equal(new URL(second.inbox_url).host, secondInboxHost);

  const defaultBatchResponse = await request(controlHost, "/v1/mailboxes/batch", {
    method: "POST",
    headers: { ...bearer(), "Content-Type": "application/json" },
    body: JSON.stringify({ count: 4 }),
  });
  assert.equal(defaultBatchResponse.status, 201);
  const defaultBatch = await defaultBatchResponse.json();
  assert.equal(defaultBatch.count, 4);
  for (const item of defaultBatch.items) {
    const local = item.address.split("@", 1)[0];
    assert.equal(item.address.endsWith(`@${defaultDomain}`), true);
    assert.equal(local.length, 12);
    assert.match(local, /[a-z]/);
    assert.match(local, /[0-9]/);
  }

  const disabledCreate = await request(controlHost, "/v1/mailboxes", {
    method: "POST",
    headers: { ...bearer(), "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "disabled.test", local_part: "blocked" }),
  });
  assert.equal(disabledCreate.status, 400);
  assert.equal((await disabledCreate.json()).error, "invalid_domain");

  const filteredResponse = await request(controlHost, "/v1/mailboxes?domain=second.test", { headers: bearer() });
  assert.equal(filteredResponse.status, 200);
  const filtered = await filteredResponse.json();
  assert.equal(filtered.count, 1);
  assert.deepEqual(filtered.items.map((item) => item.address), [second.address]);
  assert.deepEqual(filtered.items.map((item) => item.domain), ["second.test"]);

  database.createMailboxes([{ address: "saved@disabled.test", domain: "disabled.test", token: "disabled-token" }]);
  const invalidDomainSmtp = await smtpConversation(smtpService.port, [
    { command: "EHLO sender.test" },
    { command: "MAIL FROM:<sender@example.net>" },
    { command: "RCPT TO:<saved@disabled.test>" },
    { command: "QUIT" },
  ]);
  assert.equal(responseCode(invalidDomainSmtp[3]), 550);

  const relayAttempt = await smtpConversation(smtpService.port, [
    { command: "EHLO sender.test" },
    { command: "MAIL FROM:<sender@example.net>" },
    { command: "RCPT TO:<outside@example.org>" },
    { command: "QUIT" },
  ]);
  assert.equal(responseCode(relayAttempt[3]), 550);

  const unknownMailbox = await smtpConversation(smtpService.port, [
    { command: "EHLO sender.test" },
    { command: "MAIL FROM:<sender@example.net>" },
    { command: "RCPT TO:<missing@mail.test>" },
    { command: "QUIT" },
  ]);
  assert.equal(responseCode(unknownMailbox[3]), 550);

  const delivered = await smtpConversation(smtpService.port, [
    { command: "EHLO sender.test" },
    { command: "MAIL FROM:<sender@example.net>" },
    { command: `RCPT TO:<${first.address}>` },
    { command: `RCPT TO:<${second.address}>` },
    {
      command: "DATA",
      data: rawFixture({ to: `${first.address}, ${second.address}`, messageId: "cross-domain@mail.test", attachment: true }),
    },
    { command: "QUIT" },
  ]);
  assert.equal(responseCode(delivered[3]), 250);
  assert.equal(responseCode(delivered[4]), 250);
  assert.equal(responseCode(delivered[5]), 250);

  for (const mailbox of [first, second]) {
    const response = await request(controlHost, `/v1/messages?address=${encodeURIComponent(mailbox.address)}`, {
      headers: bearer(),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.count, 1);
    assert.match(body.results[0].raw, /cross-domain@mail\.test/);
  }

  const firstMessagesResponse = await request(controlHost, `/v1/messages?address=${encodeURIComponent(first.address)}`, {
    headers: bearer(),
  });
  const firstMessages = await firstMessagesResponse.json();
  const messageId = firstMessages.results[0].id;
  const rawResponse = await request(controlHost, `/v1/messages/${messageId}/raw?address=${encodeURIComponent(first.address)}`, {
    headers: bearer(),
  });
  assert.equal(rawResponse.status, 200);
  assert.match(rawResponse.headers.get("content-type"), /message\/rfc822/);
  assert.match(await rawResponse.text(), /attachment; filename=sample\.txt/i);
  const attachmentResponse = await request(
    controlHost,
    `/v1/messages/${messageId}/attachments/0?address=${encodeURIComponent(first.address)}`,
    { headers: bearer() },
  );
  assert.equal(attachmentResponse.status, 200);
  assert.equal(await attachmentResponse.text(), "attachment-content");

  const firstLinkPath = new URL(first.inbox_url).pathname;
  const wrongHostLink = await request(secondInboxHost, firstLinkPath, { redirect: "manual" });
  assert.equal(wrongHostLink.status, 401);
  const openLink = await request(defaultInboxHost, firstLinkPath, { redirect: "manual" });
  assert.equal(openLink.status, 303);
  assert.equal(openLink.headers.get("location"), `/inbox/${encodeURIComponent(first.address)}`);
  const setCookie = String(openLink.headers.get("set-cookie") || "");
  assert.match(setCookie, /HttpOnly/i);
  assert.doesNotMatch(setCookie, /(?:^|;)\s*Domain=/i);
  const inboxCookie = cookieValue(openLink);

  const inboxSession = await request(defaultInboxHost, `/api/inbox/session?address=${encodeURIComponent(first.address)}`, {
    headers: { Cookie: inboxCookie },
  });
  assert.equal(inboxSession.status, 200);
  const crossHostSession = await request(secondInboxHost, `/api/inbox/session?address=${encodeURIComponent(first.address)}`, {
    headers: { Cookie: inboxCookie },
  });
  assert.equal(crossHostSession.status, 401);

  const detailResponse = await request(
    defaultInboxHost,
    `/api/inbox/messages/${messageId}?address=${encodeURIComponent(first.address)}`,
    { headers: { Cookie: inboxCookie } },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.attachments.length, 1);
  assert.doesNotMatch(detail.html, /<script|tracker\.invalid/i);
  assert.match(detail.html, /Full <strong>message<\/strong>/i);

  const rotateResponse = await request(controlHost, `/v1/mailboxes/${encodeURIComponent(first.address)}/rotate-token`, {
    method: "POST",
    headers: bearer(),
  });
  assert.equal(rotateResponse.status, 200);
  const rotated = await rotateResponse.json();
  assert.equal(new URL(rotated.inbox_url).host, defaultInboxHost);
  assert.notEqual(rotated.token, first.token);
  assert.equal((await request(defaultInboxHost, firstLinkPath, { redirect: "manual" })).status, 401);
  assert.equal((await request(defaultInboxHost, new URL(rotated.inbox_url).pathname, { redirect: "manual" })).status, 303);
  assert.equal((await request(defaultInboxHost, `/api/inbox/session?address=${encodeURIComponent(first.address)}`, {
    headers: { Cookie: inboxCookie },
  })).status, 401);

  const disableResponse = await request(controlHost, `/v1/mailboxes/${encodeURIComponent(first.address)}`, {
    method: "PATCH",
    headers: { ...bearer(), "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableResponse.status, 200);
  const disabledSmtp = await smtpConversation(smtpService.port, [
    { command: "EHLO sender.test" },
    { command: "MAIL FROM:<sender@example.net>" },
    { command: `RCPT TO:<${first.address}>` },
    { command: "QUIT" },
  ]);
  assert.equal(responseCode(disabledSmtp[3]), 550);

  assert.equal((await request(controlHost, `/v1/messages/${messageId}`, {
    method: "DELETE",
    headers: bearer(),
  })).status, 404);
  assert.ok(database.messageForAdmin(messageId));
});
