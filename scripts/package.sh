#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
output="${1:-domain-mailbox-vps-$(date -u +%Y%m%d-%H%M%S).tar.gz}"
tar --exclude='./.env' --exclude='./config/domains.json' --exclude='./config/cloudflare-ips.json' --exclude='./generated' --exclude='./data' --exclude='./backups' --exclude='./caddy-data' --exclude='./caddy-config' --exclude='./node_modules' --exclude='./.npm-cache' --exclude='./.git' -czf "$output" .
echo "$output"
