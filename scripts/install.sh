#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
umask 077

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl docker.io
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 || \
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
fi
if ! command -v ufw >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
fi
systemctl enable --now docker

install -d -m 750 -o root -g 1000 config
install -d -m 700 -o 1000 -g 1000 data data/raw data/tmp backups caddy-data caddy-config generated

if [[ ! -f config/domains.json ]]; then
  : "${PRIMARY_DOMAIN:?Provide config/domains.json or set PRIMARY_DOMAIN}"
  if [[ ! "$PRIMARY_DOMAIN" =~ ^([a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+$ ]]; then
    echo "PRIMARY_DOMAIN is invalid" >&2
    exit 1
  fi
  SHARED_MX_HOST="${SHARED_MX_HOST:-mx.${PRIMARY_DOMAIN}}"
  CONTROL_HOST="${CONTROL_HOST:-manage.${PRIMARY_DOMAIN}}"
  MAIL_DOMAINS="${MAIL_DOMAINS:-$PRIMARY_DOMAIN}"
  IFS=',' read -r -a domain_values <<<"$MAIL_DOMAINS"
  found_primary=0
  {
    cat <<EOF
{
  "schema_version": 1,
  "default_domain": "${PRIMARY_DOMAIN,,}",
  "shared_mx_host": "${SHARED_MX_HOST,,}",
  "control_host": "${CONTROL_HOST,,}",
  "landing": {
    "title": "Digital Infrastructure",
    "headline": "Reliable digital infrastructure for modern teams.",
    "description": "Secure, resilient services designed for dependable digital operations."
  },
  "domains": [
EOF
    index=0
    for raw in "${domain_values[@]}"; do
      domain="${raw//[[:space:]]/}"
      domain="${domain,,}"
      [[ "$domain" =~ ^([a-z0-9-]+\.)+[a-z0-9-]+$ ]] || { echo "Invalid MAIL_DOMAINS entry: $domain" >&2; exit 1; }
      [[ "$domain" == "${PRIMARY_DOMAIN,,}" ]] && found_primary=1
      [[ $index -eq 0 ]] || printf ',\n'
      printf '    {"domain":"%s","inbox_host":"inbox.%s","public_hosts":["%s","www.%s"],"enabled":true}' "$domain" "$domain" "$domain" "$domain"
      index=$((index + 1))
    done
    printf '\n  ]\n}\n'
  } > config/domains.json
  [[ $found_primary -eq 1 ]] || { echo "MAIL_DOMAINS must include PRIMARY_DOMAIN" >&2; exit 1; }
fi
chown root:1000 config/domains.json
chmod 640 config/domains.json

if [[ ! -f .env ]]; then
  CONFIG_DEFAULT_DOMAIN="$(sed -n 's/.*"default_domain"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' config/domains.json | head -1)"
  : "${CONFIG_DEFAULT_DOMAIN:?default_domain missing from config/domains.json}"
  ACME_EMAIL="${ACME_EMAIL:-admin@${CONFIG_DEFAULT_DOMAIN}}"
  SESSION_SECRET="$(openssl rand -hex 48)"
  cat > .env <<EOF
NODE_ENV=production
DOMAINS_CONFIG_PATH=/app/config/domains.json
ACME_EMAIL=${ACME_EMAIL}
SESSION_SECRET=${SESSION_SECRET}
HTTP_HOST=0.0.0.0
HTTP_PORT=3000
SMTP_HOST=0.0.0.0
SMTP_PORT=2525
MAX_MESSAGE_BYTES=26214400
MAX_SMTP_CLIENTS=50
MAX_RECIPIENTS=20
DISK_WARN_PERCENT=80
DISK_HIGH_WATER_PERCENT=90
DISK_MIN_FREE_BYTES=1073741824
ADMIN_SESSION_SECONDS=43200
MAILBOX_SESSION_SECONDS=2592000
CADDY_DATA_DIR=/caddy-data
REQUIRE_SMTP_TLS=true
COOKIE_SECURE=true
TRUST_PROXY=1
EOF
fi

set -a
# shellcheck disable=SC1091
source ./.env
set +a
: "${SESSION_SECRET:?SESSION_SECRET is required in .env}"
: "${ACME_EMAIL:?ACME_EMAIL is required in .env}"

./scripts/update-cloudflare-ips.sh
docker compose build app
./scripts/domainctl.sh render

domain_state="$(docker run --rm -v "$ROOT_DIR/config:/app/config:ro" domain-mailbox-vps:local node -e \
  "import('./src/config.js').then(({createConfig})=>{const c=createConfig();console.log(JSON.stringify({mx:c.mxHost,control:c.webHost}))})")"
MX_HOST="$(sed -n 's/.*"mx":"\([^"]*\)".*/\1/p' <<<"$domain_state")"
CONTROL_HOST="$(sed -n 's/.*"control":"\([^"]*\)".*/\1/p' <<<"$domain_state")"
: "${MX_HOST:?shared MX host missing}"
: "${CONTROL_HOST:?control host missing}"

docker compose up -d caddy
echo "Waiting for the public TLS certificate for ${MX_HOST} ..."
certificate_ready=0
for _ in $(seq 1 90); do
  if docker compose exec -T caddy sh -c "find /data/caddy/certificates -type f -name '${MX_HOST}.crt' -print -quit | grep -q ." 2>/dev/null; then
    certificate_ready=1
    break
  fi
  sleep 2
done
if [[ "$certificate_ready" != "1" ]]; then
  echo "TLS certificate was not issued. Verify the shared MX A record and ports 80/443, then rerun." >&2
  exit 1
fi

status_json="$(docker compose run --rm --no-deps -T app node src/cli.js status)"
new_credentials=0
if ! grep -q '"adminReady": true' <<<"$status_json"; then
  ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
  ADMIN_PASSWORD="$(openssl rand -hex 20)"
  ADMIN_API_TOKEN="$(openssl rand -hex 32)"
  printf '{"username":"%s","password":"%s","apiToken":"%s"}\n' \
    "$ADMIN_USERNAME" "$ADMIN_PASSWORD" "$ADMIN_API_TOKEN" | \
    docker compose run --rm --no-deps -T app node src/cli.js bootstrap >/dev/null
  new_credentials=1
fi

docker compose up -d app
for _ in $(seq 1 60); do
  if docker compose exec -T app node scripts/internal-healthcheck.mjs; then
    break
  fi
  sleep 2
done
docker compose exec -T app node scripts/internal-healthcheck.mjs --print

cp config/domains.json generated/last-applied-domains.json
chmod 600 generated/last-applied-domains.json

SSH_PORT="${SSH_PORT:-$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}')}"
SSH_PORT="${SSH_PORT:-22}"
ufw allow "${SSH_PORT}/tcp" comment "SSH"
ufw allow 25/tcp comment "SMTP receive"
ufw allow 80/tcp comment "ACME HTTP"
ufw allow 443/tcp comment "Mailbox HTTPS"
ufw --force enable

echo
echo "Deployment complete: https://${CONTROL_HOST}/admin"
echo "DNS plan: ${ROOT_DIR}/generated/dns-plan.json"
if [[ "$new_credentials" == "1" ]]; then
  echo "The following credentials are displayed once. Store them now:"
  echo "ADMIN_USERNAME=${ADMIN_USERNAME}"
  echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}"
  echo "ADMIN_API_TOKEN=${ADMIN_API_TOKEN}"
else
  echo "Existing administrator credentials were preserved."
fi
