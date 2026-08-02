#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
runtime_dir=${JENSEN_SEARXNG_RUNTIME_DIR:-/home/magnus/services/jensen-searxng}
port=18888

if ss -ltnH "sport = :${port}" | rg -q . && ! docker ps --format '{{.Names}}' | rg -qx 'jensen-searxng'; then
  echo "Refusing to deploy: 127.0.0.1:${port} is already in use" >&2
  exit 1
fi

mkdir -p "$runtime_dir"
install -m 0644 "$script_dir/compose.yml" "$runtime_dir/compose.yml"
install -m 0644 "$script_dir/settings.yml" "$runtime_dir/settings.yml"

if [[ ! -f "$runtime_dir/.env" ]]; then
  umask 077
  secret=$(openssl rand -hex 32)
  printf 'SEARXNG_SECRET=%s\n' "$secret" > "$runtime_dir/.env"
  unset secret
fi

docker compose --project-directory "$runtime_dir" -f "$runtime_dir/compose.yml" up -d

for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:${port}/healthz >/dev/null; then
    echo "Jensen SearXNG healthy at http://127.0.0.1:${port}"
    exit 0
  fi
  sleep 1
done

docker compose --project-directory "$runtime_dir" -f "$runtime_dir/compose.yml" ps
echo "SearXNG did not become healthy within 30 seconds" >&2
exit 1
