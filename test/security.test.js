import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  csrfForSession,
  hashPassword,
  randomToken,
  tokenHash,
  verifyCsrf,
  verifyPassword,
  verifySession,
} from "../src/security.js";

test("passwords use scrypt and verify without storing plaintext", async () => {
  const encoded = await hashPassword("correct-horse-battery-staple");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes("correct-horse"), false);
  assert.equal(await verifyPassword("correct-horse-battery-staple", encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
});

test("tokens and signed sessions are stable and tamper evident", () => {
  const token = randomToken(32);
  assert.equal(token.length >= 42, true);
  assert.match(tokenHash(token), /^[a-f0-9]{64}$/);
  const signed = createSession({ kind: "mailbox", id: "7", address: "a@mail.test", version: 1 }, "secret", 60);
  const session = verifySession(signed, "secret");
  assert.equal(session.kind, "mailbox");
  const csrf = csrfForSession(session, "secret");
  assert.equal(verifyCsrf(session, csrf, "secret"), true);
  assert.equal(verifyCsrf(session, `${csrf}x`, "secret"), false);
  assert.equal(verifySession(`${signed}x`, "secret"), null);
});
