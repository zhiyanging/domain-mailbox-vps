#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const skippedDirectories = new Set([
  ".git", ".npm-cache", "node_modules", "generated", "data", "backups", "caddy-data", "caddy-config",
]);
const forbiddenRelativeFiles = new Set([
  ".env", "config/domains.json", "config/cloudflare-ips.json",
]);
const forbiddenExtensions = new Set([".sqlite", ".sqlite3", ".db", ".eml", ".key", ".pem", ".p12", ".pfx"]);
const textExtensions = new Set([
  "", ".caddyfile", ".css", ".csv", ".dockerignore", ".example", ".gitignore", ".html", ".js", ".json",
  ".md", ".mjs", ".sh", ".txt", ".yaml", ".yml",
]);
let explicitValues = [];
try {
  const parsed = JSON.parse(process.env.RELEASE_FORBIDDEN_JSON || "[]");
  if (Array.isArray(parsed)) explicitValues = parsed.map(String).filter((value) => value.length >= 4);
} catch {
  throw new Error("invalid_RELEASE_FORBIDDEN_JSON");
}

const findings = [];
let scanned = 0;

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function visit(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    const rel = relative(full);
    if (entry.isDirectory()) {
      visit(full);
      continue;
    }
    if (forbiddenRelativeFiles.has(rel) || forbiddenExtensions.has(path.extname(entry.name).toLowerCase())) {
      findings.push({ file: rel, rule: "forbidden_release_file" });
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(extension) || fs.statSync(full).size > 10 * 1024 * 1024) continue;
    const content = fs.readFileSync(full, "utf8");
    scanned += 1;
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
      findings.push({ file: rel, rule: "private_key_material" });
    }
    explicitValues.forEach((value, index) => {
      if (content.includes(value)) findings.push({ file: rel, rule: `explicit_forbidden_value_${index + 1}` });
    });
  }
}

visit(root);
if (findings.length) {
  console.error(JSON.stringify({ ok: false, root, scanned, findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, root, scanned, findings: 0 }, null, 2));
}
