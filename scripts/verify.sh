#!/usr/bin/env bash
# Local verification gate for BTC-minute. Kitchen checklist, not a CI farm.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INTEGRATION=0
E2E=0
for arg in "$@"; do
  case "$arg" in
    --integration) INTEGRATION=1 ;;
    --e2e) E2E=1 ;;
    -h|--help)
      echo "Usage: pnpm verify [-- --integration] [-- --e2e]"
      echo "  default: build + unit tests + lint"
      echo "  --integration  also pnpm test:integration (needs btc_test DB)"
      echo "  --e2e          also pnpm test:e2e (Playwright / Chromium)"
      exit 0
      ;;
  esac
done

echo "==> build (typecheck + vite)"
pnpm build

echo "==> unit tests"
pnpm test

echo "==> lint"
pnpm lint

if [[ "$INTEGRATION" -eq 1 ]]; then
  echo "==> integration tests"
  pnpm test:integration
fi

if [[ "$E2E" -eq 1 ]]; then
  echo "==> e2e (Playwright)"
  pnpm test:e2e
fi

echo "OK: verify passed (integration=$INTEGRATION e2e=$E2E)"
