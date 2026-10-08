# Minute / BTC

A one-minute BTC-USD prediction game. Players choose higher or lower, receive +1 for a correct guess or −1 for an incorrect one, and return to their score in the same browser. There are no payments or financial stakes. Your personal round history shows completed calls, prices, timestamps, and points, with older rounds available in pages of twenty.

Live demo: [Minute / BTC](http://ApiLoadBalancer-zsecstnd-701550995.eu-central-1.elb.amazonaws.com/).

## Engineer onboarding

Use the [onboarding guide](docs/ONBOARDING.md) for local setup, the code map, failure behavior, and first contributions. The [shared tldraw engineering board](https://www.tldraw.com/f/fW_iaGZHE_WFKlawnExWh?d=v-452.-507.4774.3291.page) explains architecture, settlement, recovery, and engineering decisions. Edit the diagrams directly in tldraw.

Agent instructions and the verification gate live in [AGENTS.md](AGENTS.md).

## Run locally

Requires Node 24+, pnpm, and Docker Desktop. Start Docker first.

```sh
pnpm install
cp .env.example .env
docker compose up -d db
pnpm dev
```

Open http://localhost:5173. The backend runs on port 3000. The initial connection verifies Coinbase history before enabling guesses. Cookies are HttpOnly and SameSite=Lax. Local HTTP and the current ALB HTTP demo use `COOKIE_SECURE=false`.

Alternatively, `docker compose up --build` starts the database and backend. Start `pnpm dev:web` separately and open port 5173.

### Reset disposable demo data

The challenge schema is consolidated into `server/migrations/001_initial.sql`. Databases created from the earlier migration set need a one-time reset, including `schema_migrations`. Stop the backend first. This removes all players, rounds, prices, and checkpoints.

For the local Docker database:

```sh
docker compose exec -T db psql -U btc -d btc -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
pnpm dev
```

The backend recreates the schema on startup. For an existing deployed demo, stop its backend and run the same SQL against that demo database before starting the new build. Redeploying alone will not reset migration checksums. Future schema changes should add migrations rather than edit this baseline.

## Rules and fairness

At acceptance, the server freezes the direction and its PostgreSQL clock time. The deadline is exactly 60 seconds after acceptance. The round shows “Locking price…” with `startingTrade: null` until verified coverage strictly passes acceptance. The worker then selects the last Coinbase trade at or before acceptance, ordered by canonical exchange timestamp and trade ID descending. It does not lock the potentially stale price shown when the player submits.

Admission still requires heartbeat, verification, and latest trade each no more than five seconds old; that is a feed-health gate, not the starting-price rule. The clock keeps running during price locking. Delayed verification, refresh, retries, and restart cannot change the direction or extend the deadline. If coverage or starting evidence is unavailable, the round stays pending. This uses the last exchange trade before server acceptance, not a universal price at the browser click. Server and exchange UTC clock alignment remains an operational assumption.

The first trade **at or after** the deadline with a price different from the starting price decides the result. Trades are ordered by exchange timestamp, then trade ID. Equal prices keep the round pending. Up wins on a higher price; down wins on a lower price. Scores can become negative. Exchange timestamps retain microseconds as bigint values and prices use PostgreSQL arbitrary-precision numeric; JavaScript floating point is used only for display formatting.

There is one price source. Every round uses the same verified acceptance and first differing trade rules described above. This is a Coinbase Exchange price, not a claim about a universal Bitcoin price. The UI exposes the starting trade, deadline, and settlement trade as evidence.

## Architecture

```text
Coinbase matches + heartbeats ──> collector ──> PostgreSQL trade ledger
Coinbase paginated REST trades ──> recovery ───> verified checkpoint
                                                    │
Browser ──> session / guess / state API              │
                    │                               ▼
                    └────────── PostgreSQL <── settlement worker
```

React/Vite serves a responsive single screen. Fastify owns the HTTP API. A continuously running Node service owns ingestion and settlement. PostgreSQL owns players, guesses, immutable trade evidence, and ingestion progress. The frontend requests authoritative state every two seconds and on focus; it never computes results or schedules settlement.

### Ingestion and recovery

- Subscribe to `matches` and `heartbeat`. `last_match` is historical context, not proof of uninterrupted coverage.
- Keep a bounded WebSocket buffer and compare its IDs/prices with paginated REST history. REST timestamps are canonical for settlement: a live check showed occasional one-microsecond differences across the two transports. Preserve the original WebSocket timestamp separately as `ws_time_us`; never round the canonical timestamp. Persist a complete verified interval and its checkpoint together in one transaction.
- On each advancing heartbeat, reconcile REST history from the saved checkpoint through the heartbeat's `last_trade_id`. This conservative implementation verifies intervals through REST even while connected: it does **not** assume trade IDs are consecutive or that a heartbeat's last ID proves all intervening messages arrived. WebSocket supplies live trades and the boundary used for verification. This is intentionally more REST-intensive than an optimized streaming ingestion system.
- Anchor the initial REST page with the supported `before` cursor immediately below the target trade ID, then use the provider's `CB-AFTER` header to retrieve older pages. This avoids chasing the cached unqualified latest-page response. Retain the same heartbeat target while retrying. Reach the exact saved checkpoint before advancing. Merge duplicates and fail closed on conflicting data or timestamp regression.
- Initial startup anchors at the current heartbeat trade; no rounds can exist before initial verification. Subsequent startup resumes the persisted checkpoint, including outstanding rounds.
- On disconnect or five seconds without heartbeat, invalidate the connection generation and block admission. Reconnect with exponential backoff/jitter, buffer live trades, and replay history before advancing coverage.
- Settlement reads only trades inside verified coverage. A disconnected feed can still settle historical rounds whose complete evidence was already verified. A missing interval cannot be replaced by a later trade.
- REST timeout, 429, truncated history, a repeated cursor, conflicting evidence, or the 200-page recovery cap leaves the checkpoint unchanged. Existing rounds remain pending. Errors are visible and logged; recovery retries automatically.

Provider references: [WebSocket channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels), [trade history](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-trades), [pagination](https://docs.cdp.coinbase.com/exchange/rest-api/pagination).

### Transactions and leadership

A partial unique index enforces one pending guess per player. Submission serializes on the player row, checks idempotency before market health, and uses a locked market snapshot to gate admission. It saves immutable intent/time with empty starting evidence. Retrying an accepted request returns its original round, even when market conditions have since changed. Reusing a key with a different direction is a conflict.

The worker runs every second. It first locks starting prices for pending rounds whose acceptance is covered, then locks eligible guesses, finds the earliest qualifying verified trade, and changes the guess and score in one transaction. Locks and pending status prevent double awards. A crash rolls back unfinished work; persisted pending guesses are found after restart, without a scheduling handoff to lose.

Dedicated PostgreSQL sessions hold advisory locks for collector and settlement leadership. During task overlap only one of each worker runs. Session loss stops that worker; it must acquire leadership again before writing. Migration startup is also serialized with an advisory lock. The API stays healthy during provider failure; its health endpoint checks the database, not Coinbase availability.

## API

| Route                      | Behavior                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /api/session`        | Reuse a valid opaque session or create a zero-score player; sets persistent HttpOnly, SameSite=Lax cookie.       |
| `GET /api/rounds?cursor=…` | Return your completed rounds, newest first, in pages of twenty. The session determines ownership.                |
| `GET /api/state`           | Return one consistent snapshot of server time, market status/freshness, score, pending guess, and latest result. |
| `POST /api/guesses`        | Accept `{ "direction": "up" or "down", "idempotencyKey": "UUID" }`; return accepted/existing guess (starting trade is null while locking).              |
| `GET /healthz`             | Database health for the load balancer.                                                                           |

Errors: 400 invalid input, 401 no valid session, 403 disallowed write origin, 409 existing pending guess or key conflict, 429 rate limit, 503 market not ready. Bodies contain a user-safe `message`. All API responses are uncached. The anonymous token is random and only its SHA-256 hash is stored. No client-supplied player ID, clock, price, score, or outcome is accepted. Clearing the browser cookie loses access to that anonymous identity; cross-device recovery is outside scope.

## Verification

```sh
pnpm build
pnpm test
pnpm lint
docker compose exec -T db createdb -U btc btc_test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

The `createdb` step is needed once. Integration tests destructively reset **only** `btc_test`; never point `TEST_DATABASE_URL` at a real database. Unit tests cover precise rule boundaries and pagination/failure cases. Integration tests exercise real PostgreSQL transactions and API behavior. Browser tests use clearly isolated API fixtures to verify UI states, refresh, tabs, keyboard controls, and mobile layout; they do not claim live Coinbase end-to-end coverage. Live provider validation is a separate explicit check: `pnpm verify:live -- --restart` creates one local points-only round and restarts the watch-mode backend during it. Run it only with `pnpm dev` active. The latest successful evidence is saved in [test/live-verification.json](test/live-verification.json).


## Deploy to AWS (SST v4)

This app is **not** a good fit for API-Gateway + Lambda alone. The process keeps:

- a long-lived Coinbase Exchange WebSocket (`matches` + `heartbeat`)
- REST recovery / verification loops
- a settlement worker on a 1s tick
- PostgreSQL session advisory locks for single-leader collection and settlement

Those need always-on compute and a real Postgres. The SST stack therefore provisions:

| Piece | SST component | Why |
| --- | --- | --- |
| Network + cheap NAT | `sst.aws.Vpc` (`nat: "ec2"`) | Private Fargate/RDS with outbound access to Coinbase |
| Database | `sst.aws.Postgres` (RDS 17, `t4g.micro`) | Durable ledger, locks, migrations |
| API + workers + SPA | `sst.aws.Service` on ECS Fargate (ARM) | Runs the existing Dockerfile (Fastify + workers; serves `web/dist`) |
| Public HTTP | Application Load Balancer on the service | `/healthz` health checks; same-origin `/api` + UI |

Config lives in [`sst.config.ts`](sst.config.ts) using SST v4. Personal stage name: **`reda`**.

### Prerequisites

1. AWS account with permission for VPC, ECS/ECR, RDS, ELB, IAM, CloudWatch, SSM/Secrets.
2. Working credentials (`aws configure`, SSO, or env vars). Empty `~/.aws/credentials` will fail.
3. Docker Desktop running (image build for Fargate).
4. `pnpm install`

### Deploy

```sh
# one-time: confirm identity
aws sts get-caller-identity

pnpm build          # produces web/dist used by the image
pnpm deploy         # → sst deploy --stage reda
```

Reset an older demo schema as described above before deploying the consolidated baseline.

After deploy, SST prints the ALB `url`. Open it, complete a real 60s round, refresh to check persistence, and confirm `/healthz`. The browser creates cryptographically random UUID idempotency keys using `getRandomValues()`, which works on HTTP.

Optional HTTPS: add a custom domain and certificate to the ALB, set `COOKIE_SECURE=true`, and configure `APP_ORIGIN` to the HTTPS origin.

### Tear down

```sh
pnpm deploy:remove  # → sst remove --stage reda
```

RDS and related resources are removed for non-`production` stages (`removal: "remove"`). Expect ongoing cost while deployed (Fargate + RDS + NAT EC2 + ALB + public IPv4) even with no players — tear down when finished.

## Deliberate limits

- Single exchange and a single continuously running service process. Outages pause play rather than risk an unsupported result. Database locks permit safe replacement, not a claim of high availability.
- Coverage relies on Coinbase's paginated trade history being complete and exchange timestamps not regressing. Contradictions halt recovery. Multi-provider switching would change the game's reference market and requires its own explicit rules.
- Conservative REST reconciliation adds rate-limit exposure and recovery lag. An optimized collector would need a provider-supported continuity guarantee or stronger feed protocol, plus equivalent replay tests.
- All trades are retained for this submission. Before long-term operation, add partitioning/retention that preserves unresolved-round coverage, immutable settlement evidence, and a durable recovery anchor. Monitor storage growth; never delete the only recovery boundary for a pending round.
- Recovery is bounded to 200 pages and the WebSocket buffer to 100,000 events. Longer outages may require an operator-assisted historical import; pending rounds remain pending rather than silently changing the rule.
- This demonstrates points-game correctness, not a production money ledger, anti-fraud system, or real-money product.
