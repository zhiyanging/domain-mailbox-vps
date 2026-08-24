#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/config/cloudflare-ips.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsS --retry 3 --connect-timeout 10 https://www.cloudflare.com/ips-v4 -o "$TMP/ipv4"
curl -fsS --retry 3 --connect-timeout 10 https://www.cloudflare.com/ips-v6 -o "$TMP/ipv6"
grep -Eq '^[0-9]+(\.[0-9]+){3}/[0-9]+$' "$TMP/ipv4"
grep -Eq '^[0-9a-fA-F:]+/[0-9]+$' "$TMP/ipv6"

{
  printf '{\n  "source": "https://www.cloudflare.com/ips/",\n  "updated_at": "%s",\n  "ipv4": [\n' "$(date -u +%FT%TZ)"
  awk 'NF { gsub(/\r/, ""); printf "%s    \"%s\"", (n++ ? ",\n" : ""), $0 } END { print "" }' "$TMP/ipv4"
  printf '  ],\n  "ipv6": [\n'
  awk 'NF { gsub(/\r/, ""); printf "%s    \"%s\"", (n++ ? ",\n" : ""), $0 } END { print "" }' "$TMP/ipv6"
  printf '  ]\n}\n'
} > "$TMP/cloudflare-ips.json"

mkdir -p "$ROOT/config"
install -m 640 -o root -g 1000 "$TMP/cloudflare-ips.json" "$TARGET"
echo "updated $TARGET"
