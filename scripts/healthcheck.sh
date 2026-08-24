#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
set -a
# shellcheck disable=SC1091
source ./.env
set +a
domain_state="$(docker compose exec -T app node -e "import('./src/config.js').then(({createConfig})=>{const c=createConfig();console.log(c.webHost+' '+c.mxHost)})")"
read -r CONTROL_HOST MX_HOST <<<"$domain_state"
: "${CONTROL_HOST:?control host missing}"
: "${MX_HOST:?shared MX host missing}"
curl --fail --silent --show-error "https://${CONTROL_HOST}/health"
echo
smtp_probe="$(printf 'QUIT\r\n' | timeout 15 openssl s_client -quiet -starttls smtp -connect "${MX_HOST}:25" -servername "${MX_HOST}" 2>&1)"
printf '%s\n' "$smtp_probe" | sed -n '1,20p'
grep -q '250 SIZE' <<<"$smtp_probe"
docker compose exec -T app node scripts/domainctl.mjs validate
docker compose ps
