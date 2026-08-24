#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: $0 BACKUP.tar.gz" >&2
  exit 1
fi
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="$(readlink -f "$1")"
cd "$ROOT_DIR"
umask 077
timestamp="$(date -u +%Y%m%d-%H%M%S)"
docker compose stop app caddy || true
if [[ -d data ]]; then mv data "data.before-restore-${timestamp}"; fi
mkdir -p data
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$ARCHIVE" -C "$stage"
cp -f "$stage/.env" .env
if [[ ! -f "$stage/config/domains.json" || ! -f "$stage/config/cloudflare-ips.json" ]]; then
  echo "Domain configuration is missing from the backup." >&2
  exit 1
fi
install -d -m 750 -o root -g 1000 config
install -m 640 -o root -g 1000 "$stage/config/domains.json" config/domains.json
install -m 640 -o root -g 1000 "$stage/config/cloudflare-ips.json" config/cloudflare-ips.json
snapshot="$(find "$stage" -maxdepth 1 -type f -name '.mailbox-*.sqlite3' -print -quit)"
if [[ -z "$snapshot" ]]; then echo "Database snapshot is missing." >&2; exit 1; fi
mv "$snapshot" data/mailbox.sqlite3
if [[ -d "$stage/raw" ]]; then mv "$stage/raw" data/raw; else mkdir -p data/raw; fi
mkdir -p data/tmp
chown -R 1000:1000 data
chmod 700 data
./scripts/domainctl.sh render
docker compose up -d
echo "Restored from $ARCHIVE; previous data is in data.before-restore-${timestamp}"
