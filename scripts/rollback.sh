#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
docker compose down
echo "Services stopped. The data directory and Caddy volumes were preserved."
echo "Restore the saved DNS snapshot separately to stop new SMTP delivery."
