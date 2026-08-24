import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateDomainConfig } from "../src/domain-config.js";
import { runDomainctl } from "../scripts/domainctl.mjs";

function example(overrides = {}) {
  return {
    schema_version: 1,
    default_domain: "alpha.test",
    shared_mx_host: "mx.primary.test",
    control_host: "manage.primary.test",
    landing: {
      title: "Digital Infrastructure",
      headline: "Reliable infrastructure.",
      description: "A local static landing page.",
    },
    domains: [
      { domain: "alpha.test", inbox_host: "inbox.alpha.test", public_hosts: ["alpha.test", "www.alpha.test"], enabled: true },
      { domain: "beta.test", inbox_host: "inbox.beta.test", public_hosts: ["beta.test", "www.beta.test"], enabled: true },
    ],
    ...overrides,
  };
}

test("domain config validates names, defaults, conflicts, and host roles", () => {
  const config = validateDomainConfig(example());
  assert.equal(config.defaultDomain, "alpha.test");
  assert.deepEqual(config.enabledDomains, ["alpha.test", "beta.test"]);
  assert.deepEqual(config.hostRole("MANAGE.PRIMARY.TEST:443"), { role: "control", domain: "alpha.test" });
  assert.deepEqual(config.hostRole("inbox.beta.test"), { role: "inbox", domain: "beta.test" });
  assert.deepEqual(config.hostRole("beta.test"), { role: "public", domain: "beta.test" });
  assert.deepEqual(config.hostRole("mx.primary.test"), { role: "mx", domain: "alpha.test" });
  assert.equal(config.hostRole("unknown.test"), null);
  assert.equal(config.inboxOrigin("beta.test"), "https://inbox.beta.test");

  assert.throws(() => validateDomainConfig(example({ default_domain: "missing.test" })), /default_domain_not_registered/);
  assert.throws(() => validateDomainConfig(example({ domains: [
    { domain: "alpha.test", enabled: false },
    { domain: "beta.test", enabled: true },
  ] })), /default_domain_disabled/);
  assert.throws(() => validateDomainConfig(example({ domains: [
    { domain: "alpha.test", enabled: true },
    { domain: "alpha.test", inbox_host: "inbox.other.test", enabled: true },
  ] })), /duplicate_domain/);
  assert.throws(() => validateDomainConfig(example({ domains: [
    { domain: "alpha.test", inbox_host: "inbox.alpha.test", enabled: true },
    { domain: "beta.test", inbox_host: "inbox.alpha.test", enabled: true },
  ] })), /duplicate_web_host/);
  assert.throws(() => validateDomainConfig(example({ shared_mx_host: "inbox.alpha.test" })), /web_host_conflicts_with_mx/);
  assert.throws(() => validateDomainConfig(example({ control_host: "not a dns host" })), /invalid_control_host/);
});

test("domainctl renders Caddy and an IPv4 MX-to-hostname DNS plan", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "domainctl-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "domains.json");
  const rangesPath = path.join(root, "cloudflare-ips.json");
  const generatedDir = path.join(root, "generated");
  await fs.writeFile(configPath, `${JSON.stringify(example(), null, 2)}\n`);
  await fs.writeFile(rangesPath, JSON.stringify({ ipv4: ["192.0.2.0/24"], ipv6: ["2001:db8::/32"] }));

  const output = runDomainctl({
    command: "render",
    configPath,
    cloudflarePath: rangesPath,
    generatedDir,
    vpsIp: "198.51.100.25",
  });
  assert.equal(output.ok, true);
  const caddy = await fs.readFile(path.join(generatedDir, "Caddyfile"), "utf8");
  assert.match(caddy, /manage\.primary\.test/);
  assert.match(caddy, /inbox\.alpha\.test/);
  assert.match(caddy, /remote_ip 192\.0\.2\.0\/24 2001:db8::\/32/);
  assert.match(caddy, /mx\.primary\.test \{/);

  const plan = JSON.parse(await fs.readFile(path.join(generatedDir, "dns-plan.json"), "utf8"));
  assert.equal(plan.ipv4_only, true);
  assert.equal(plan.shared_mx_chain.mx_target, "mx.primary.test");
  assert.equal(plan.shared_mx_chain.a_target, "198.51.100.25");
  assert.equal(plan.shared_mx_chain.cname_for_mx, false);
  assert.equal(plan.records.some((record) => record.type === "AAAA"), false);
  assert.equal(plan.records.some((record) => record.type === "CNAME" && record.name === "mx.primary.test"), false);
  assert.ok(plan.web_proxy.cache_bypass_paths.includes("/v1*"));
  assert.equal(plan.web_proxy.origin_ingress, "cloudflare_ip_ranges_only");
  assert.ok(plan.records.find((record) => record.type === "A" && record.name === "mx.primary.test" && record.proxied === false));
  assert.ok(plan.records.find((record) => record.type === "MX" && record.name === "beta.test" && record.content === "mx.primary.test"));
  assert.throws(() => runDomainctl({
    command: "dns-plan",
    configPath,
    cloudflarePath: rangesPath,
    generatedDir,
    vpsIp: "2001:db8::25",
  }), /invalid_vps_ipv4/);
});
