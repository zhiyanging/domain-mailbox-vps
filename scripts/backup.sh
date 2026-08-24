#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
umask 077
mkdir -p backups data
timestamp="$(date -u +%Y%m%d-%H%M%S)"
snapshot="/app/data/.mailbox-${timestamp}.sqlite3"
archive="${1:-backups/domain-mailbox-${timestamp}.tar.gz}"
printf '{"destination":"%s"}\n' "$snapshot" | docker compose exec -T app node src/cli.js backup >/dev/null
tar -czf "$archive" .env config/domains.json config/cloudflare-ips.json \
  -C data ".mailbox-${timestamp}.sqlite3" raw
rm -f "data/.mailbox-${timestamp}.sqlite3"
chmod 600 "$archive"
echo "$archive"
