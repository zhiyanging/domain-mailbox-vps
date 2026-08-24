import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDomainConfig } from "../src/domain-config.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cloudflareFallback = path.join(projectDir, "config", "cloudflare-ips.example.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`read_failed:${file}:${error.message}`);
  }
}

export function validateRanges(input) {
  const ipv4 = Array.isArray(input?.ipv4) ? input.ipv4.map(String) : [];
  const ipv6 = Array.isArray(input?.ipv6) ? input.ipv6.map(String) : [];
  if (ipv4.length < 1 || ipv6.length < 1) throw new Error("cloudflare_ip_ranges_required");
  const validCidr = (value, family, maximum) => {
    const [address, prefix, extra] = String(value).split("/");
    const parsedPrefix = Number(prefix);
    return extra === undefined && isIP(address) === family && Number.isInteger(parsedPrefix)
      && parsedPrefix >= 0 && parsedPrefix <= maximum;
  };
  if (ipv4.some((item) => !validCidr(item, 4, 32))) throw new Error("invalid_cloudflare_ipv4_range");
  if (ipv6.some((item) => !validCidr(item, 6, 128))) throw new Error("invalid_cloudflare_ipv6_range");
  return [...new Set([...ipv4, ...ipv6])];
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function renderCaddy(config, ranges) {
  const webHosts = config.allWebHosts.join(", ");
  return `{
\temail {$ACME_EMAIL}
\tadmin off
\thttp_port 8080
\thttps_port 8443
}

${webHosts} {
\tencode zstd gzip
\t@cloudflare remote_ip ${ranges.join(" ")}
\thandle @cloudflare {
\t\treverse_proxy app:3000
\t}
\thandle {
\t\trespond "not found" 404
\t}
\theader {
\t\t-Server
\t\tX-Content-Type-Options nosniff
\t\tReferrer-Policy no-referrer
\t\tX-Frame-Options DENY
\t}
}

${config.sharedMxHost} {
\trespond /health "receive-only smtp endpoint" 200
\trespond "not found" 404
}
`;
}

export function dnsPlan(config, vpsIpValue = process.env.VPS_IP || "NEW_VPS_IP") {
  const vpsIp = String(vpsIpValue).trim();
  if (vpsIp !== "NEW_VPS_IP" && isIP(vpsIp) !== 4) throw new Error("invalid_vps_ipv4");
  const records = [{ type: "A", name: config.sharedMxHost, content: vpsIp, proxied: false, role: "shared_mx" }];
  records.push({ type: "A", name: config.controlHost, content: vpsIp, proxied: true, role: "control" });
  for (const entry of config.domains) {
    for (const host of entry.publicHosts) {
      if (host === entry.domain) records.push({ type: "A", name: host, content: vpsIp, proxied: true, role: "landing" });
      else if (host === `www.${entry.domain}`) records.push({ type: "CNAME", name: host, content: entry.domain, proxied: true, role: "landing_alias" });
      else records.push({ type: "A", name: host, content: vpsIp, proxied: true, role: "landing" });
    }
    records.push({ type: "A", name: entry.inboxHost, content: vpsIp, proxied: true, role: "inbox" });
    records.push({ type: "MX", name: entry.domain, content: config.sharedMxHost, priority: 10, proxied: false, role: "mail_route" });
    records.push({ type: "TXT", name: entry.domain, content: "v=spf1 -all", role: "spf" });
    records.push({ type: "TXT", name: `_dmarc.${entry.domain}`, content: "v=DMARC1; p=reject; adkim=s; aspf=s", role: "dmarc" });
  }
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    const key = `${record.type}|${record.name}|${record.content}`;
    if (!seen.has(key)) { seen.add(key); unique.push(record); }
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    ipv4_only: true,
    email_routing: "disabled",
    shared_mx_chain: { mx_target: config.sharedMxHost, a_target: vpsIp, cname_for_mx: false },
    web_proxy: {
      enabled_after_origin_certificate: true,
      hosts: config.allWebHosts,
      origin_ingress: "cloudflare_ip_ranges_only",
      cache_bypass_paths: ["/admin*", "/api*", "/v1*", "/docs*", "/openapi.json", "/cf-inbox*", "/inbox*", "/health"],
    },
    deployment_order: ["shared_mx_a", "smtp_starttls_external_test", "mail_domain_mx_txt", "web_certificate", "enable_web_proxy"],
    records: unique,
  };
}

export function runDomainctl({
  command = "validate",
  configPath = process.env.DOMAINS_CONFIG_PATH || path.join(projectDir, "config", "domains.json"),
  cloudflarePath = process.env.CLOUDFLARE_IPS_PATH || path.join(projectDir, "config", "cloudflare-ips.json"),
  generatedDir = process.env.GENERATED_DIR || path.join(projectDir, "generated"),
  vpsIp = process.env.VPS_IP || "NEW_VPS_IP",
} = {}) {
  const selectedCommand = String(command).toLowerCase();
  const selectedConfigPath = path.resolve(configPath);
  const selectedCloudflarePath = path.resolve(cloudflarePath);
  const selectedGeneratedDir = path.resolve(generatedDir);
  const rawConfig = readJson(selectedConfigPath);
  const config = validateDomainConfig(rawConfig);
  const cfFile = fs.existsSync(selectedCloudflarePath) ? selectedCloudflarePath : cloudflareFallback;
  const ranges = validateRanges(readJson(cfFile));
  if (!["validate", "render", "dns-plan"].includes(selectedCommand)) {
    throw new Error(`unknown_domainctl_command:${selectedCommand}`);
  }
  if (selectedCommand !== "validate") {
    fs.mkdirSync(selectedGeneratedDir, { recursive: true });
    if (selectedCommand === "render") {
      atomicWrite(path.join(selectedGeneratedDir, "Caddyfile"), renderCaddy(config, ranges));
    }
    atomicWrite(path.join(selectedGeneratedDir, "dns-plan.json"), `${JSON.stringify(dnsPlan(config, vpsIp), null, 2)}\n`);
  }
  return {
    ok: true,
    command: selectedCommand,
    config: selectedConfigPath,
    cloudflare_ranges: cfFile,
    default_domain: config.defaultDomain,
    shared_mx_host: config.sharedMxHost,
    control_host: config.controlHost,
    domains: config.domains.map((entry) => ({ domain: entry.domain, enabled: entry.enabled, inbox_host: entry.inboxHost })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runDomainctl({ command: process.argv[2] || "validate" }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
