#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="${1:-validate}"
IMAGE="${DOMAINCTL_IMAGE:-domain-mailbox-vps:local}"
mkdir -p "$ROOT/config" "$ROOT/generated"

run_ctl() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e DOMAINS_CONFIG_PATH=/app/config/domains.json \
    -e CLOUDFLARE_IPS_PATH=/app/config/cloudflare-ips.json \
    -e GENERATED_DIR=/app/generated \
    -e VPS_IP="${VPS_IP:-NEW_VPS_IP}" \
    -v "$ROOT/config:/app/config" \
    -v "$ROOT/generated:/app/generated" \
    "$IMAGE" node scripts/domainctl.mjs "$1"
}

compose_up_wait() {
  local wait_timeout="${DOMAINCTL_WAIT_TIMEOUT:-120}"
  docker compose -f "$ROOT/docker-compose.yml" up -d --build --wait \
    --wait-timeout "$wait_timeout"
  # generated/Caddyfile is a bind mount and Caddy's admin API is disabled;
  # recreate only the proxy so it loads the newly rendered host configuration.
  docker compose -f "$ROOT/docker-compose.yml" up -d --force-recreate --no-deps \
    --wait --wait-timeout "$wait_timeout" caddy
}

if [[ ! -f "$ROOT/config/domains.json" ]]; then
  echo "config/domains.json is required" >&2
  exit 1
fi
if [[ ! -f "$ROOT/config/cloudflare-ips.json" ]]; then
  cp "$ROOT/config/cloudflare-ips.example.json" "$ROOT/config/cloudflare-ips.json"
  chown root:1000 "$ROOT/config/cloudflare-ips.json"
  chmod 640 "$ROOT/config/cloudflare-ips.json"
fi

docker compose -f "$ROOT/docker-compose.yml" build app

backup_config() {
  mkdir -p "$ROOT/generated/config-backups"
  backup="$ROOT/generated/config-backups/domains-$(date -u +%Y%m%d-%H%M%S).json"
  cp "$ROOT/config/domains.json" "$backup"
  chmod 600 "$backup"
  echo "$backup"
}

case "$COMMAND" in
  validate)
    run_ctl validate
    ;;
  render|dns-plan)
    run_ctl "$COMMAND"
    [[ ! -f "$ROOT/generated/Caddyfile" ]] || { chown 1000:1000 "$ROOT/generated/Caddyfile"; chmod 640 "$ROOT/generated/Caddyfile"; }
    ;;
  backup)
    run_ctl validate >/dev/null
    backup_config
    ;;
  apply)
    previous="$ROOT/generated/last-applied-domains.json"
    if [[ -f "$previous" ]]; then
      mkdir -p "$ROOT/generated/config-backups"
      prior_backup="$ROOT/generated/config-backups/domains-active-$(date -u +%Y%m%d-%H%M%S).json"
      cp "$previous" "$prior_backup"
      chmod 600 "$prior_backup"
    else
      backup_config >/dev/null
    fi
    rollback() {
      status=$?
      if [[ -f "$previous" ]]; then
        cp "$previous" "$ROOT/config/domains.json"
        run_ctl render || true
        compose_up_wait || true
      fi
      exit "$status"
    }
    trap rollback ERR
    run_ctl render
    chown 1000:1000 "$ROOT/generated/Caddyfile"
    chmod 640 "$ROOT/generated/Caddyfile"
    docker run --rm -e ACME_EMAIL="${ACME_EMAIL:-admin@example.com}" \
      -v "$ROOT/generated/Caddyfile:/etc/caddy/Caddyfile:ro" \
      caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
    compose_up_wait
    docker compose -f "$ROOT/docker-compose.yml" exec -T app \
      node scripts/internal-healthcheck.mjs
    cp "$ROOT/config/domains.json" "$previous"
    chmod 600 "$previous"
    trap - ERR
    ;;
  *)
    echo "usage: $0 {validate|render|dns-plan|backup|apply}" >&2
    exit 2
    ;;
esac
