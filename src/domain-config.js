import fs from "node:fs";
import path from "node:path";

const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const DEFAULT_LANDING = Object.freeze({
  title: "Digital Infrastructure",
  headline: "Reliable digital infrastructure for modern teams.",
  description: "Secure, resilient services designed for dependable digital operations.",
});

function hostname(value, field) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!HOST_PATTERN.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function boolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function cleanLanding(value = {}) {
  const result = {};
  for (const key of ["title", "headline", "description"]) {
    const text = String(value?.[key] || DEFAULT_LANDING[key]).trim();
    if (!text || text.length > 240) throw new Error(`invalid_landing_${key}`);
    result[key] = text;
  }
  return result;
}

export function validateDomainConfig(input, { allowSharedControlHost = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_domains_config");
  const schemaVersion = Number(input.schema_version ?? 1);
  if (schemaVersion !== 1) throw new Error("unsupported_domains_schema");
  const defaultDomain = hostname(input.default_domain, "default_domain");
  const sharedMxHost = hostname(input.shared_mx_host, "shared_mx_host");
  const controlHost = hostname(input.control_host, "control_host");
  if (!Array.isArray(input.domains) || input.domains.length < 1) throw new Error("domains_required");

  const domainNames = new Set();
  const webHosts = new Map([[controlHost, { role: "control", domain: defaultDomain }]]);
  const domains = input.domains.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid_domain_entry_${index}`);
    const domain = hostname(entry.domain, `domain_${index}`);
    const inboxHost = hostname(entry.inbox_host || `inbox.${domain}`, `inbox_host_${index}`);
    const publicValues = Array.isArray(entry.public_hosts) && entry.public_hosts.length
      ? entry.public_hosts
      : [domain, `www.${domain}`];
    const publicHosts = [...new Set(publicValues.map((item) => hostname(item, `public_host_${index}`)))];
    if (domainNames.has(domain)) throw new Error(`duplicate_domain:${domain}`);
    domainNames.add(domain);
    for (const [host, role] of [[inboxHost, "inbox"], ...publicHosts.map((host) => [host, "public"])]) {
      if (host === sharedMxHost) throw new Error(`web_host_conflicts_with_mx:${host}`);
      const existing = webHosts.get(host);
      if (existing) {
        if (allowSharedControlHost && role === "inbox" && existing.role === "control" && domain === defaultDomain) {
          webHosts.set(host, { role: "control-inbox", domain });
          continue;
        }
        throw new Error(`duplicate_web_host:${host}`);
      }
      webHosts.set(host, { role, domain });
    }
    return Object.freeze({
      domain,
      inboxHost,
      publicHosts: Object.freeze(publicHosts),
      enabled: boolean(entry.enabled, true),
    });
  });

  if (!domainNames.has(defaultDomain)) throw new Error("default_domain_not_registered");
  const defaultEntry = domains.find((entry) => entry.domain === defaultDomain);
  if (!defaultEntry?.enabled) throw new Error("default_domain_disabled");
  if (webHosts.has(sharedMxHost)) throw new Error(`mx_host_conflict:${sharedMxHost}`);

  const byDomain = new Map(domains.map((entry) => [entry.domain, entry]));
  return Object.freeze({
    schemaVersion,
    defaultDomain,
    sharedMxHost,
    controlHost,
    landing: Object.freeze(cleanLanding(input.landing)),
    domains: Object.freeze(domains),
    enabledDomains: Object.freeze(domains.filter((entry) => entry.enabled).map((entry) => entry.domain)),
    allWebHosts: Object.freeze([...webHosts.keys()]),
    entryForDomain(domain) {
      return byDomain.get(String(domain || "").trim().toLowerCase()) || null;
    },
    hostRole(host) {
      const normalized = String(host || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
      if (normalized === sharedMxHost) return { role: "mx", domain: defaultDomain };
      return webHosts.get(normalized) || null;
    },
    inboxOrigin(domain) {
      const entry = byDomain.get(String(domain || "").trim().toLowerCase());
      return entry ? `https://${entry.inboxHost}` : "";
    },
  });
}

export function legacyDomainConfig({ mailDomain, webHost, mxHost }) {
  const domain = String(mailDomain || "example.com").trim().toLowerCase();
  return validateDomainConfig({
    schema_version: 1,
    default_domain: domain,
    shared_mx_host: mxHost || `mx.${domain}`,
    control_host: webHost || `inbox.${domain}`,
    landing: DEFAULT_LANDING,
    domains: [{ domain, inbox_host: webHost || `inbox.${domain}`, public_hosts: [domain, `www.${domain}`], enabled: true }],
  }, { allowSharedControlHost: true });
}

export function loadDomainConfig({ filePath, value, legacy } = {}) {
  if (value) return validateDomainConfig(value);
  if (filePath && fs.existsSync(filePath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`domains_config_read_failed:${error.message}`);
    }
    return validateDomainConfig(parsed);
  }
  return legacyDomainConfig(legacy || {});
}

export function domainConfigPath(projectDir, explicit = "") {
  return path.resolve(explicit || path.join(projectDir, "config", "domains.json"));
}

export function addressDomainValue(address) {
  const normalized = String(address || "").trim().toLowerCase();
  const index = normalized.lastIndexOf("@");
  return index > 0 ? normalized.slice(index + 1) : "";
}

export { DEFAULT_LANDING };
