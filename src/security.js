import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function hashPassword(password) {
  const value = String(password || "");
  if (value.length < 12) throw new Error("password_must_be_at_least_12_characters");
  const salt = randomBytes(16);
  const derived = await scrypt(value, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nText, rText, pText, saltText, hashText] = parts;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (![N, r, p].every(Number.isFinite)) return false;
  const expected = Buffer.from(hashText, "base64url");
  const derived = await scrypt(String(password || ""), Buffer.from(saltText, "base64url"), expected.length, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function signature(text, secret) {
  return createHmac("sha256", secret).update(text).digest("base64url");
}

export function createSession(payload, secret, ttlSeconds) {
  const body = {
    ...payload,
    nonce: randomToken(12),
    exp: Math.floor(Date.now() / 1000) + Number(ttlSeconds),
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

export function verifySession(value, secret) {
  const [encoded, provided, extra] = String(value || "").split(".");
  if (!encoded || !provided || extra !== undefined) return null;
  if (!constantTimeEqual(provided, signature(encoded, secret))) return null;
  try {
    const body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!body || Number(body.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
    if (!body.kind || !body.id || !body.nonce) return null;
    return body;
  } catch {
    return null;
  }
}

export function csrfForSession(session, secret) {
  if (!session?.nonce) return "";
  return signature(`csrf:${session.kind}:${session.id}:${session.nonce}`, secret);
}

export function verifyCsrf(session, provided, secret) {
  return constantTimeEqual(csrfForSession(session, secret), provided);
}
