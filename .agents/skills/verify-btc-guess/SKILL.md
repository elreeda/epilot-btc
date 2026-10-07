---
name: verify-btc-guess
description: >-
  Verification playbook for the BTC-minute app: unit, integration, e2e, lint,
  and optional live/API checks. Use before claiming a change is done or when
  asked to verify local or deployed behavior.
---

# Verify BTC guess

Do not claim “done” on vibe alone. Run the smallest sufficient suite and record what passed.

## Standard local gate

Prefer the repo script:

```sh
pnpm verify
```

That runs `scripts/verify.sh`: typecheck/build, unit tests, and lint. Integration and e2e are opt-in flags (see below) because they need Docker DB / Playwright browsers.

### Manual equivalents

```sh
pnpm build          # typecheck + Vite build
pnpm test           # Vitest unit: server/test/*.test.ts (excludes *.integration.test.ts)
pnpm lint           # Biome
```

### Integration (PostgreSQL)

One-time (or if `btc_test` missing):

```sh
docker compose up -d db
docker compose exec -T db createdb -U btc btc_test || true
pnpm test:integration
```

Destructive reset targets **only** `btc_test`. Never point `TEST_DATABASE_URL` at a real database.

### Browser e2e

```sh
pnpm exec playwright install chromium   # once
pnpm test:e2e
```

Playwright starts `pnpm dev:web` and uses API fixtures in `web/test/game.spec.ts`. It does **not** prove live Coinbase settlement end-to-end.

### Full script with optionals

```sh
pnpm verify -- --integration --e2e
```

## What counts as success

| Check | Evidence |
| --- | --- |
| Unit | `pnpm test` exit 0 |
| Lint / types | `pnpm lint` and `pnpm build` exit 0 |
| Integration | `pnpm test:integration` exit 0 against `btc_test` |
| E2E | `pnpm test:e2e` exit 0 |
| Live local round | `pnpm verify:live` (with `pnpm dev` up); writes `test/live-verification.json` |
| Deployed health | `GET /healthz` → 200 on the stage ALB printed by `sst deploy` (stage `reda`) |

## Optional API round-trip checklist

Against **local** (`http://localhost:5173` with `pnpm dev`, or API on `:3000`):

1. `POST /api/session` — Set-Cookie `btc_session`.
2. `GET /api/state` — market status, server time, score; when live+fresh, guesses allowed.
3. `POST /api/guesses` with `{ "direction": "up"|"down", "idempotencyKey": "<uuid>" }` — 200 accepted or existing; 503 if market not ready; 409 if pending/conflict.
4. Poll `GET /api/state` until pending clears after ~60s+ (needs real feed + workers).
5. `GET /api/rounds` — completed round shows start/settlement evidence and `score_delta`.

Against **deployed** stage `reda`: use the ALB URL from SST output (documented after deploy in the README Deploy section). Same paths; cookie must be same-site with the ALB origin. Prefer `/healthz` first.

## Gaps to name honestly

- E2E does not cover live Coinbase; use `verify:live` or a manual deployed round for that.
- Integration requires Docker DB; skip and say so if unavailable.
- Do not invent deploy URLs; use SST-printed output or an already documented URL.
