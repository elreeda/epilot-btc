# Onboarding to Minute / BTC

This guide is for two engineers joining the project. Start with the player experience, then follow one round through the system. Use the [shared tldraw engineering board](https://www.tldraw.com/f/fW_iaGZHE_WFKlawnExWh?d=v-452.-507.4774.3291.page) to discuss the diagrams; use this guide to find the code and run it. The board covers architecture, the round lifecycle, recovery, and decisions tied to failure cases and tests. Edit the diagrams directly in tldraw. The [exported `.tldr` snapshot](presentation/engineer-architecture.tldr) remains as a portable backup.

## What we are building

A player predicts whether Coinbase's BTC-USD price will go higher or lower after one minute. A correct call adds one point; an incorrect call subtracts one. The player can leave and return in the same browser without losing their score or pending round.

Our product priority is **a result the player can trust and understand**. A responsive screen, recent price context, clear waiting states, and personal round history support that priority. This is a points game, not a money-backed product.

We explored a global scoreboard and removed it. Anonymous browser identities made competition easy to manipulate, and ranking added work to the frequently polled state request. Personal history offers more direct value: players can understand their own decisions and inspect their results.

### The rules we must preserve

1. At most one pending guess per player, including across tabs.
2. A resolved round changes the score exactly once, even under retries or restart.
3. A result uses verified market history; a later observed price cannot stand in for missing earlier trades.

The server captures acceptance time and the latest verified persisted trade. The deadline is acceptance + 60 seconds. The earliest trade at or after that deadline with a different price decides the result; equal prices leave it pending. Ordering uses canonical REST exchange timestamps, then trade ID. Prices are exact decimals and timestamps retain microseconds.

The starting price is the latest **known verified trade**, not a trade guaranteed to have occurred at the exact button-click instant. Admission requires fresh heartbeat, verification, and price data within five seconds. The browser's countdown is feedback, not the settlement clock.

## Start here

Follow [the README's local setup](../README.md#run-locally).

```sh
pnpm install
cp .env.example .env
docker compose up -d db
pnpm dev
```

Open http://localhost:5173. Use a real round to demonstrate submitting, waiting, resolution, and the trade evidence. Open a second tab while a round is pending. Refresh and return to show continuity. A real round takes at least one minute; demonstrate the rest of the system while it runs.

Run the checks separately:

```sh
pnpm build
pnpm test
docker compose exec -T db createdb -U btc btc_test # once
pnpm test:integration
pnpm exec playwright install chromium # once
pnpm test:e2e
```

Integration tests reset only `btc_test`. Browser tests use isolated API fixtures: they demonstrate UI behavior, not live-provider correctness. [Live verification evidence](../test/live-verification.json) records a successful real round checked against the persisted trade ledger while a local backend restart was requested. You can reproduce that explicit check with `pnpm verify:live -- --restart` while watch-mode development is running.

## Follow one round

| Step                  | Owner                  | What happens                                                                                                                                                                      |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return to the game    | API + PostgreSQL       | An opaque cookie identifies the player. Only its hash is stored; the client cannot choose another player's ID.                                                                    |
| Submit Up/Down        | API + PostgreSQL       | Validate direction/key, serialize on the player, return an existing idempotent submission or create one pending round. Capture server time and a locked verified market snapshot. |
| Wait                  | Browser                | Poll authoritative state every two seconds. Show the countdown and pending feedback; do not compute the result.                                                                   |
| Verify market history | Collector + PostgreSQL | Receive WebSocket matches/heartbeats, reconcile the target interval through REST, persist canonical trades and checkpoint atomically.                                             |
| Settle                | Worker + PostgreSQL    | Every second, lock eligible pending guesses. Select the earliest qualifying verified trade. Save the result and increment the score in the same transaction.                      |
| Explain the outcome   | Browser + history API  | Show the last result immediately. Fetch personal history separately and expose starting trade, deadline, settlement trade, and points.                                            |

### Code map

| Area                        | Start reading                                                                                    | Why                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Screen and state refresh    | [web/src/main.tsx](../web/src/main.tsx)                                                          | The player journey, request retry key, and server-adjusted countdown.                                     |
| Chart and personal history  | [price-chart.tsx](../web/src/price-chart.tsx), [round-history.tsx](../web/src/round-history.tsx) | Chart samples are display-only. History has its own loading, pagination, and error states.                |
| HTTP boundary               | [server/src/app.ts](../server/src/app.ts), [contracts.ts](../server/src/contracts.ts)            | Session ownership, validation, errors, and shared public types.                                           |
| Domain and database changes | [domain.ts](../server/src/domain.ts), [store.ts](../server/src/store.ts)                         | Exact comparison, acceptance transaction, actual SQL settlement selection, and private cursor pagination. |
| Feed and recovery           | [workers.ts](../server/src/workers.ts), [recovery.ts](../server/src/recovery.ts)                 | Leadership, connection generations, coverage verification, and provider pagination.                       |
| Persistence lifecycle       | [db.ts](../server/src/db.ts), [migrations](../server/migrations)                                 | Checksum-recorded migrations, transactions, schema constraints, and indexes.                              |

The `players` table owns identity and score. `guesses` owns the round and its result evidence. `trades` stores canonical price/time and optional original WebSocket time. `market` stores verified coverage, checkpoint, latest trade, and feed health. `schema_migrations` records applied migrations. Add a migration rather than editing one already applied.

## Failure behavior is part of the product

| Situation                              | Player experience                                        | Engineering guarantee                                                                                           |
| -------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Two tabs submit                        | One round is accepted; the other conflicts.              | Player-row serialization and a partial unique index enforce one pending guess.                                  |
| Submission response is lost            | Retry the same call.                                     | The idempotency key returns the original guess; a new key is not silently substituted.                          |
| Price is unchanged after 60 seconds    | “Waiting for the first trade at a different price.”      | No tie is turned into a win or loss.                                                                            |
| WebSocket disconnects or goes quiet    | New guesses are blocked; accepted rounds remain visible. | Invalidate the connection generation, reconnect, and verify history before advancing coverage.                  |
| Earlier trade is missing               | Result may be delayed.                                   | REST recovery restores the actual interval; settlement cannot jump over the gap.                                |
| Backend restarts                       | Round resumes from persisted state.                      | Database session locks elect new workers; pending guesses need no in-memory timer or scheduled-message handoff. |
| Database write fails during settlement | Round remains pending.                                   | Result and score roll back together.                                                                            |
| History cannot load                    | Game remains usable; history can retry.                  | The private history request is independent of the core state request.                                           |

Previously verified historical rounds can still settle while the current feed is disconnected. “Feed unhealthy” does not invalidate evidence we already persisted and verified.

## Decisions to understand, not just repeat

- **Continuously running Node service:** a natural home for the exchange connection and workers. PostgreSQL session advisory locks prevent competing leaders during overlap. This supports recovery, not a claim of high availability.
- **Conservative REST verification:** WebSocket supplies trades and the heartbeat boundary; advancing intervals are verified through REST even when connected. This avoids assuming that the last trade ID proves every intervening event arrived. It costs requests and can add lag.
- **Canonical REST timestamps:** a live check found occasional one-microsecond differences across transports. Preserve both timestamps; use one consistent clock for all settlements. Price contradictions still halt verification.
- **Bounded recovery:** 200 REST pages and 100,000 buffered WebSocket events. A long outage can require operator intervention. The safe result is pending, not a fabricated outcome.
- **Anonymous returning identity:** low signup friction; clearing the cookie loses access and different browsers count as different players. It is not strong person-level identity.
- **Personal history:** server-scoped to the current session, newest first, pages of twenty. Keyset pagination uses submission time and ID to avoid skipping tied timestamps.

## Known limits and next priorities

Local application behavior is implemented and checked.

Before public hosting, tighten `trustProxy`, validate security configuration at startup, strengthen session-creation limits, and separate runtime database privileges from migrations. The current in-memory rate limiter is per process. These are known gaps, not protections we claim already exist.

Before longer operation, establish ledger retention that preserves pending-round coverage and result evidence. Before greater traffic, measure state/history query latency and provider verification lag, then optimize against those measurements. Do not add caching that weakens result correctness without an explicit consistency policy.

## First contributions for the two engineers

**Engineer A — player feedback and history continuity.** Preserve already loaded older rounds when a newly resolved round arrives, and improve offline/retry feedback. Acceptance: no duplicates, newest-first order, older rows stay visible, failure does not hide known results, and keyboard/mobile flows work. Start in `round-history.tsx`; agree on the history contract before changing the API.

**Engineer B — HTTP boundary hardening.** Replace blanket proxy trust with an explicit deployment-aware policy and validate required production security settings on startup. Acceptance: forged forwarding headers cannot change the client identity outside the configured trusted chain; invalid production configuration fails clearly; local development remains usable. Start in `app.ts`; add focused request-level tests.

Both engineers review the three invariants and run the relevant tests before merging. Changes to public types or settlement semantics should be discussed together; UI-only changes should not touch scoring.

## Suggested interview walkthrough (20 minutes)

| Time      | Discussion                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–3 min   | Ask what each engineer knows, explain the player job, and start a real round.                                                                 |
| 3–7 min   | Use the product and architecture diagrams. Ask who owns the score and what happens when the browser closes.                                   |
| 7–12 min  | Trace acceptance, verified coverage, and atomic settlement. Invite predictions about retries and missing trades.                              |
| 12–16 min | Show the live result/evidence and one meaningful recovery or concurrency test. Distinguish live checks from fixtures.                         |
| 16–20 min | Explain one deliberate tradeoff, assign the first contributions, and ask each engineer to summarize their change and its acceptance criteria. |

Use the guide as a reference, not a script. Leave room for questions and let the engineers reason about a failure before revealing the implementation. Ownership shows in clear priorities, honest limits, and making their first contribution safe.
