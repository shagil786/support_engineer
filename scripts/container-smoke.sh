#!/usr/bin/env bash
# Container smoke test: build the image, boot it against a temp data dir,
# and drive the same probe flows the audit ran by hand — health, readiness,
# fail-closed auth, a cited /ask, and a KB-first /utterance.
#
#   npm run smoke:container          (requires a running Docker daemon)
#
# Exits non-zero on the first failed probe. Cleans up the container either way.
set -euo pipefail

IMAGE=support-agent-smoke
PORT=${SMOKE_PORT:-8791}
TOKEN=smoke-token-1
BASE=http://127.0.0.1:${PORT}
NAME=support-agent-smoke-$$

command -v docker >/dev/null || { echo "SKIP: docker CLI not found"; exit 0; }
if ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker daemon not running (start Docker Desktop/OrbStack and re-run)"; exit 0
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== build"
docker build -t "$IMAGE" .

echo "== run"
TMPDATA=$(mktemp -d)
docker run -d --name "$NAME" -p "${PORT}:8787" \
  -e HTTP_TOKEN="${TOKEN}" \
  -e SERVE_KEEP_ALIVE=1 \
  -v "${TMPDATA}:/data" "$IMAGE" >/dev/null

echo "== wait for health"
for i in $(seq 1 30); do
  if curl -sf -m 2 "$BASE/healthz" >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && { echo "FAIL: container never became healthy"; docker logs "$NAME" | tail -20; exit 1; }
  sleep 1
done

probe() { # name, expected, actual
  if [ "$2" = "$3" ]; then echo "  ok: $1"; else echo "  FAIL: $1 (expected '$2', got '$3')"; docker logs "$NAME" | tail -20; exit 1; fi
}

probe "healthz"        "true" "$(curl -sf "$BASE/healthz" | node -pe 'JSON.parse(require("fs").readFileSync(0)).ok')"
probe "readyz"         "true" "$(curl -sf "$BASE/readyz" | node -pe 'JSON.parse(require("fs").readFileSync(0)).ready')"
probe "auth is closed" "401"  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ask" -H 'content-type: application/json' -d '{"question":"x"}')"
probe "bad token 401"  "401"  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ask" -H 'authorization: Bearer wrong' -H 'content-type: application/json' -d '{"question":"x"}')"
probe "cited ask"      "false" "$(curl -sf -X POST "$BASE/ask" -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -d '{"question":"how do I restart the checkout pod"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).refused')"
probe "KB-first utterance" "knowledge" "$(curl -sf -X POST "$BASE/utterance" -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -d '{"speakerId":"u1","text":"hey agent, how do I restart the checkout pod?"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).answerSource')"

echo "== data dir is on the volume"
docker exec "$NAME" ls /data/events >/dev/null || { echo "FAIL: no events dir under /data"; exit 1; }
echo "  ok: /data/events exists in the container"

echo "PASS: all container probes green"
