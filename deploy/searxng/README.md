# Private Jensen SearXNG

This template deploys a private, account-free search backend for Jensen. It binds only to `127.0.0.1:18888`, does not use host networking, Squid, DIPP, paid APIs, or privileged containers, and enables the JSON search API. The image is pinned to SearXNG `2026.8.1-8892414dc` by multi-platform digest; Bucephalus resolves it to amd64 image `sha256:039ed6c4d2457623e7acd060e05485e5d10d7f58e728da7019c00c359820198b`.

The configured keyless engines are Bing, Brave, DuckDuckGo, GitHub, Stack Overflow, and Wikipedia. Individual upstream engines can rate-limit or temporarily reject automated traffic; Jensen falls back to DuckDuckGo Lite when the local service fails operationally.

## Bucephalus operations

Start or update the isolated runtime under `/home/magnus/services/jensen-searxng`:

```bash
cd /home/magnus/software/jensen-code
./deploy/searxng/install.sh
```

Health and search checks:

```bash
curl --fail http://127.0.0.1:18888/healthz
curl --get http://127.0.0.1:18888/search \
  --data-urlencode 'q=TypeScript release notes' \
  --data 'format=json'
```

Stop without deleting configuration:

```bash
docker compose \
  --project-directory /home/magnus/services/jensen-searxng \
  -f /home/magnus/services/jensen-searxng/compose.yml down
```

Restart:

```bash
docker compose \
  --project-directory /home/magnus/services/jensen-searxng \
  -f /home/magnus/services/jensen-searxng/compose.yml up -d
```

Rollback means stopping the container, restoring the previous `compose.yml` and `settings.yml` from the operator's backup if one exists, and starting again. The service has no database or Docker volume. The `.env` file contains the local SearXNG session secret, is created mode `0600`, remains outside Git, and must not be printed or copied into diagnostics.

Set `JENSEN_SEARXNG_URL=http://127.0.0.1:18888` for an explicit endpoint; this is also Jensen's default target. Do not expose this port publicly.
