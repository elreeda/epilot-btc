import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import WebSocket from "ws";
import { normalizeTrade, PRODUCT, type Trade, timestampUs } from "./domain.js";
import { fetchCoinbasePage, type Page, recoverInterval } from "./recovery.js";
import { commitCoverage, settle } from "./store.js";
export const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
  );
export async function leaderLoop(
  pool: pg.Pool,
  key: number,
  signal: AbortSignal,
  work: (c: pg.PoolClient, current: () => boolean) => Promise<void>,
) {
  while (!signal.aborted) {
    let c: pg.PoolClient | undefined,
      valid = true;
    const lost = () => {
      valid = false;
    };
    try {
      c = await pool.connect();
      c.on("error", lost);
      c.on("end", lost);
      const {
        rows: [{ locked }],
      } = await c.query("SELECT pg_try_advisory_lock($1) AS locked", [key]);
      if (locked) await work(c, () => valid && !signal.aborted);
    } catch (e) {
      log("worker_error", { worker: key, error: (e as Error).message });
    } finally {
      valid = false;
      if (c) {
        c.off("error", lost);
        c.off("end", lost);
        c.release(true);
      }
    }
    if (!signal.aborted) await delay(1000);
  }
}
export async function collect(
  c: pg.PoolClient,
  current: () => boolean,
  options: {
    socketUrl?: string;
    fetchPage?: (after?: string, before?: string) => Promise<Page>;
  } = {},
) {
  let socket: WebSocket | undefined,
    generation = 0,
    buffer: Trade[] = [],
    heartbeat: { id: string; timeUs: bigint; receivedAt: Date } | null = null,
    attempt = 0,
    failed = false,
    connectedAt = 0;
  let recoveryTarget: { id: string; timeUs: bigint; receivedAt: Date } | null =
    null;
  const invalidate = () => {
    generation++;
    heartbeat = null;
    recoveryTarget = null;
    buffer = [];
  };
  const connect = () => {
    invalidate();
    connectedAt = Date.now();
    const ownGeneration = generation;
    socket = new WebSocket(
      options.socketUrl ?? "wss://ws-feed.exchange.coinbase.com",
    );
    socket.on("open", () => {
      socket?.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: [PRODUCT],
          channels: ["matches", "heartbeat"],
        }),
      );
    });
    socket.on("message", (raw) => {
      if (!current() || generation !== ownGeneration) return;
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === "error")
          throw new Error("Provider subscription rejected");
        if (m.product_id !== PRODUCT) return;
        if (m.type === "match" || m.type === "last_match") {
          buffer.push(normalizeTrade(m));
          if (buffer.length > 100000)
            throw new Error("Trade buffer limit reached");
        } else if (m.type === "heartbeat") {
          if (!Number.isSafeInteger(m.last_trade_id))
            throw new Error("Invalid heartbeat trade ID");
          const timeUs = timestampUs(m.time);
          if (
            heartbeat &&
            (BigInt(m.last_trade_id) < BigInt(heartbeat.id) ||
              timeUs < heartbeat.timeUs)
          )
            throw new Error("Heartbeat regression");
          heartbeat = {
            id: String(m.last_trade_id),
            timeUs,
            receivedAt: new Date(),
          };
        }
      } catch (e) {
        log("feed_error", { error: (e as Error).message });
        failed = true;
        socket?.terminate();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (ownGeneration === generation) invalidate();
    });
  };
  try {
    await c.query(
      "UPDATE market SET status='recovering',error=NULL WHERE product=$1",
      [PRODUCT],
    );
    connect();
    while (current()) {
      if (socket?.readyState === WebSocket.CLOSED) {
        await c.query(
          "UPDATE market SET status='recovering' WHERE product=$1",
          [PRODUCT],
        );
        await delay(
          Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)) +
            Math.random() * 250,
        );
        if (!current()) break;
        connect();
      }
      const hb = heartbeat as {
        id: string;
        timeUs: bigint;
        receivedAt: Date;
      } | null;
      if (!hb || Date.now() - hb.receivedAt.getTime() > 5000) {
        await c.query("UPDATE market SET status=$2,error=$3 WHERE product=$1", [
          PRODUCT,
          failed ? "error" : "recovering",
          failed ? "Feed validation failed" : null,
        ]);
        if (hb || Date.now() - connectedAt > 5000) socket?.terminate();
        await delay(1000);
        continue;
      }
      const epoch = generation;
      recoveryTarget ??= hb;
      const target = recoveryTarget;
      try {
        const {
          rows: [m],
        } = await c.query("SELECT checkpoint_id FROM market WHERE product=$1", [
          PRODUCT,
        ]);
        // Anchor the first REST page to a supported numeric cursor immediately below the target.
        // This includes the target without assuming adjacent IDs correspond to trades, and
        // avoids the five-second cache on the unqualified latest-history URL.
        const before = (BigInt(target.id) - 1n).toString();
        const trades = await recoverInterval(
          (after) => (options.fetchPage ?? fetchCoinbasePage)(after, before),
          m.checkpoint_id,
          target.id,
          buffer,
          () => delay(250),
          () => current() && epoch === generation,
        );
        if (!current() || epoch !== generation) continue;
        if (trades.some((t) => t.timeUs > target.timeUs))
          throw new Error("Trade occurred beyond heartbeat coverage");
        await commitCoverage(
          c,
          trades,
          target.id,
          target.timeUs,
          hb.receivedAt,
          () => current() && epoch === generation,
        );
        buffer = buffer.filter((t) => BigInt(t.id) > BigInt(target.id));
        attempt = 0;
        failed = false;
        recoveryTarget = null;
      } catch (e) {
        if (!current()) throw e;
        log("recovery_failed", { error: (e as Error).message });
        await c.query(
          "UPDATE market SET status='error',error=$2 WHERE product=$1",
          [PRODUCT, (e as Error).message],
        );
        await delay(2000);
      }
      await delay(1000);
    }
  } finally {
    socket?.terminate();
  }
}
export async function settlementWorker(
  c: pg.PoolClient,
  current: () => boolean,
) {
  while (current()) {
    const count = await settle(c, current);
    if (count) log("rounds_settled", { count });
    const {
      rows: [metrics],
    } = await c.query(
      `SELECT count(*)::int AS overdue FROM guesses WHERE status='pending' AND deadline_us < (extract(epoch FROM clock_timestamp())*1000000)::bigint-15000000`,
    );
    const {
      rows: [market],
    } = await c.query(
      `SELECT status,extract(epoch FROM (clock_timestamp()-verified_at)) AS lag FROM market WHERE product=$1`,
      [PRODUCT],
    );
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "BTCMinute",
              Dimensions: [[]],
              Metrics: [
                { Name: "FeedUnavailable" },
                { Name: "RecoveryLagSeconds" },
                { Name: "OverdueGuesses" },
              ],
            },
          ],
        },
        FeedUnavailable:
          market.status === "live" && Number(market.lag) < 5 ? 0 : 1,
        RecoveryLagSeconds: market.lag === null ? 60 : Number(market.lag),
        OverdueGuesses: metrics.overdue,
      }),
    );
    await delay(1000);
  }
}
