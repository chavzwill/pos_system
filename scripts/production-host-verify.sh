#!/usr/bin/env bash
set -euo pipefail

COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.host.yml)

if [ ! -f .env ]; then
  echo "FAIL: .env is missing" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${POS_DOMAIN:-}" ]; then
  echo "FAIL: POS_DOMAIN is not configured" >&2
  exit 1
fi

app_id="$(docker compose "${COMPOSE_ARGS[@]}" ps -q app)"
caddy_id="$(docker compose "${COMPOSE_ARGS[@]}" ps -q caddy)"

if [ -z "$app_id" ] || [ -z "$caddy_id" ]; then
  echo "FAIL: app and caddy containers must both be running" >&2
  exit 1
fi

app_state="$(docker inspect --format='{{.State.Status}}' "$app_id")"
app_health="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$app_id")"
caddy_state="$(docker inspect --format='{{.State.Status}}' "$caddy_id")"

[ "$app_state" = "running" ] || { echo "FAIL: app container state is $app_state" >&2; exit 1; }
[ "$app_health" = "healthy" ] || { echo "FAIL: app health is $app_health" >&2; exit 1; }
[ "$caddy_state" = "running" ] || { echo "FAIL: caddy container state is $caddy_state" >&2; exit 1; }

echo "PASS: app container is running and healthy"
echo "PASS: caddy container is running"

host_binding="$(docker inspect --format='{{json .HostConfig.PortBindings}}' "$app_id")"
if printf '%s' "$host_binding" | grep -q '3001/tcp'; then
  echo "FAIL: application port 3001 has a host binding: $host_binding" >&2
  exit 1
fi
echo "PASS: application port 3001 is not host-published"

published_ports="$(docker port "$caddy_id")"
printf '%s\n' "$published_ports" | grep -q '80/tcp' || { echo "FAIL: Caddy is not publishing TCP 80" >&2; exit 1; }
printf '%s\n' "$published_ports" | grep -q '443/tcp' || { echo "FAIL: Caddy is not publishing TCP 443" >&2; exit 1; }
echo "PASS: Caddy publishes TCP 80 and 443"

probe_url="$POS_DOMAIN"
if [[ "$probe_url" != http://* ]] && [[ "$probe_url" != https://* ]]; then
  probe_url="https://$probe_url"
fi

for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error --location --max-time 10 "$probe_url/" >/tmp/pos-production-root.html; then
    if grep -qi '<html\|<!doctype' /tmp/pos-production-root.html; then
      echo "PASS: POS shell is reachable through $probe_url"
      break
    fi
  fi
  if [ "$attempt" -eq 20 ]; then
    echo "FAIL: POS shell did not become reachable through $probe_url" >&2
    exit 1
  fi
  sleep 2
done

if [[ "$probe_url" == https://* ]]; then
  headers="$(curl --silent --show-error --head --location --max-time 10 "$probe_url/" | tr -d '\r')"
  printf '%s\n' "$headers" | grep -qi '^strict-transport-security:' || echo "WARN: Strict-Transport-Security header was not observed"
  echo "PASS: HTTPS endpoint responded"
else
  echo "WARN: production verification is using HTTP; real production should use HTTPS"
fi

if [ -f data/pos.db ] && [ -s data/pos.db ]; then
  echo "PASS: persisted SQLite database exists"
else
  echo "FAIL: persisted SQLite database data/pos.db is missing or empty" >&2
  exit 1
fi

if docker exec "$app_id" sh -lc 'test -d /app/uploads && test -w /app/uploads'; then
  echo "PASS: uploads persistence path is writable by the application identity"
else
  echo "FAIL: /app/uploads is missing or not writable by the application identity" >&2
  exit 1
fi

echo "Production host verification passed."
