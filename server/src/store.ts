import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Guess, ResolvedGuess } from "./contracts.js";
import { transaction } from "./db.js";
import {
  type Direction,
  HttpError,
  isoUs,
  PRODUCT,
  scoreDelta,
  type Trade,
} from "./domain.js";

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function session(pool: pg.Pool, token?: string) {
  if (token) {
    const { rows } = await pool.query(
      "SELECT id FROM players WHERE token_hash=$1",
      [tokenHash(token)],
    );
    if (rows[0]) return { id: rows[0].id, token };
  }
  const fresh = randomBytes(32).toString("base64url"),
    id = randomUUID();
  await pool.query("INSERT INTO players(id,token_hash) VALUES ($1,$2)", [
    id,
    tokenHash(fresh),
  ]);
  return { id, token: fresh };
}
export async function playerFor(
  pool: pg.Pool,
  token?: string,
): Promise<string> {
  if (!token) throw new HttpError(401, "Start a session first.");
  const { rows } = await pool.query(
    "SELECT id FROM players WHERE token_hash=$1",
    [tokenHash(token)],
  );
  if (!rows[0]) throw new HttpError(401, "Your session has expired.");
  return rows[0].id;
}
interface GuessRecord {
  id: string;
  player_id: string;
  idempotency_key: string;
  direction: Direction;
  status: "pending" | "resolved";
  submitted_us: string;
  deadline_us: string;
  start_trade_id: string | null;
  start_time_us: string | null;
  start_price: string | null;
  settlement_trade_id: string | null;
  settlement_time_us: string | null;
  settlement_price: string | null;
  score_delta: number | null;
}
function publicGuess(row: GuessRecord | undefined): Guess | null {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    status: row.status,
    submittedAt: isoUs(row.submitted_us),
    deadline: isoUs(row.deadline_us),
    startingTrade:
      row.start_trade_id !== null
        ? {
            id: row.start_trade_id,
            time: isoUs(row.start_time_us!),
            price: row.start_price!,
          }
        : null,
    settlementTrade: row.settlement_trade_id
      ? {
          id: row.settlement_trade_id,
          time: isoUs(row.settlement_time_us!),
          price: row.settlement_price!,
        }
      : null,
    scoreDelta: row.score_delta,
  };
}
function resolvedGuess(row: GuessRecord): ResolvedGuess {
  const guess = publicGuess(row)!;
  if (
    guess.status !== "resolved" ||
    !guess.startingTrade ||
    !guess.settlementTrade ||
    guess.scoreDelta === null
  )
    throw new Error("Resolved round has incomplete evidence");
  return {
    ...guess,
    status: "resolved",
    startingTrade: guess.startingTrade,
    settlementTrade: guess.settlementTrade,
    scoreDelta: guess.scoreDelta,
  };
}
export async function state(pool: pg.Pool, id: string) {
  // One snapshot prevents a settled guess and an old score appearing together.
  return transaction(pool, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const {
      rows: [player],
    } = await c.query("SELECT score FROM players WHERE id=$1", [id]);
    const {
      rows: [m],
    } = await c.query(
      `SELECT m.*,t.price,t.time_us,clock_timestamp() AS server_time FROM market m LEFT JOIN trades t ON t.product=m.product AND t.trade_id=m.latest_trade_id WHERE m.product=$1`,
      [PRODUCT],
    );
    const { rows: guesses } = await c.query<GuessRecord>(
      "SELECT * FROM guesses WHERE player_id=$1 ORDER BY submitted_us DESC LIMIT 2",
      [id],
    );
    // Display-only five-second closing samples. Never use these for settlement.
    const { rows: history } = await c.query<{ time_us: string; price: string }>(
      `SELECT time_us,price FROM (
        SELECT DISTINCT ON (time_us/5000000) time_us,price FROM trades
        WHERE product=$1 AND trade_id<=$2 AND time_us<=$3 AND time_us>=$4
        ORDER BY time_us/5000000,time_us DESC,trade_id DESC
      ) samples ORDER BY time_us`,
      [
        PRODUCT,
        m.checkpoint_id,
        m.coverage_us,
        ((BigInt(m.server_time.getTime()) - 600000n) * 1000n).toString(),
      ],
    );
    const now = m.server_time.getTime(),
      heartbeatAge = m.heartbeat_at ? now - m.heartbeat_at.getTime() : Infinity;
    const priceAge = m.time_us
      ? now - Number(BigInt(m.time_us) / 1000n)
      : Infinity;
    const verificationAge = m.verified_at
      ? now - m.verified_at.getTime()
      : Infinity;
    const status =
      m.status === "live" &&
      (heartbeatAge > 5000 || verificationAge > 5000 || priceAge > 5000)
        ? "stale"
        : m.status;
    const result = guesses.find((g) => g.status === "resolved");
    return {
      serverTime: m.server_time.toISOString(),
      score: player.score,
      market: {
        product: PRODUCT,
        provider: "Coinbase Exchange",
        status,
        price: m.price ?? null,
        tradeId: m.latest_trade_id ?? null,
        time: m.time_us ? isoUs(m.time_us) : null,
        coverageThrough: m.coverage_us ? isoUs(m.coverage_us) : null,
        history: history.map((point) => ({
          time: isoUs(point.time_us),
          price: point.price,
        })),
        message:
          status === "error"
            ? "Market history recovery needs attention."
            : status === "recovering"
              ? "Verifying market history."
              : status === "stale"
                ? "Waiting for fresh, verified market data."
                : null,
      },
      activeGuess: publicGuess(guesses.find((g) => g.status === "pending")),
      latestResult: result ? resolvedGuess(result) : null,
    };
  });
}
export async function submitGuess(
  pool: pg.Pool,
  playerId: string,
  direction: Direction,
  key: string,
) {
  return transaction(pool, async (c) => {
    await c.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
    const {
      rows: [existing],
    } = await c.query(
      "SELECT * FROM guesses WHERE player_id=$1 AND idempotency_key=$2",
      [playerId, key],
    );
    if (existing) {
      if (existing.direction !== direction)
        throw new HttpError(
          409,
          "This request key was already used for another direction.",
        );
      return publicGuess(existing);
    }
    const { rowCount } = await c.query(
      "SELECT id FROM guesses WHERE player_id=$1 AND status='pending'",
      [playerId],
    );
    if (rowCount) throw new HttpError(409, "You already have a pending guess.");
    // A fresh verified snapshot gates admission, but its price is not the starting price.
    const {
      rows: [m],
    } = await c.query(
      `SELECT m.*,t.price,t.time_us FROM market m LEFT JOIN trades t ON t.product=m.product AND t.trade_id=m.latest_trade_id WHERE m.product=$1 FOR SHARE OF m`,
      [PRODUCT],
    );
    const {
      rows: [{ now_us }],
    } = await c.query(
      "SELECT (extract(epoch FROM clock_timestamp())*1000000)::bigint AS now_us",
    );
    const submitted = BigInt(now_us),
      now = Number(submitted / 1000n);
    if (
      m.status !== "live" ||
      !m.heartbeat_at ||
      !m.verified_at ||
      !m.time_us ||
      now - m.heartbeat_at.getTime() > 5000 ||
      now - m.verified_at.getTime() > 5000 ||
      submitted - BigInt(m.time_us) > 5000000n ||
      BigInt(m.time_us) > submitted
    )
      throw new HttpError(
        503,
        "Market data is not ready. Your guess was not accepted.",
      );
    const {
      rows: [guess],
    } = await c.query(
      `INSERT INTO guesses(id,player_id,idempotency_key,direction,submitted_us,deadline_us)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        randomUUID(),
        playerId,
        key,
        direction,
        submitted.toString(),
        (submitted + 60000000n).toString(),
      ],
    );
    return publicGuess(guess);
  });
}
export async function commitCoverage(
  c: pg.PoolClient,
  trades: Trade[],
  checkpoint: string,
  coverageUs: bigint,
  heartbeatAt: Date,
  stillLeader: () => boolean,
) {
  if (!stillLeader()) throw new Error("Collector leadership lost");
  await c.query("BEGIN");
  try {
    const {
      rows: [old],
    } = await c.query("SELECT * FROM market WHERE product=$1 FOR UPDATE", [
      PRODUCT,
    ]);
    if (old.checkpoint_id && BigInt(checkpoint) < BigInt(old.checkpoint_id))
      throw new Error("Checkpoint regression");
    if (old.coverage_us && coverageUs < BigInt(old.coverage_us))
      throw new Error("Coverage regression");
    if (trades.length) {
      // JSON avoids parameter-count limits while retaining exact decimal and timestamp strings.
      await c.query(
        `INSERT INTO trades(product,trade_id,time_us,price,ws_time_us)
        SELECT $1,x.id::bigint,x.time_us::bigint,x.price::numeric,x.ws_time_us::bigint FROM jsonb_to_recordset($2::jsonb) AS x(id text,time_us text,price text,ws_time_us text)
        ON CONFLICT(product,trade_id) DO UPDATE SET ws_time_us=coalesce(trades.ws_time_us,excluded.ws_time_us)`,
        [
          PRODUCT,
          JSON.stringify(
            trades.map((t) => ({
              id: t.id,
              time_us: t.timeUs.toString(),
              price: t.price,
              ws_time_us: t.wsTimeUs?.toString() ?? null,
            })),
          ),
        ],
      );
      const {
        rows: [{ conflict }],
      } = await c.query(
        `SELECT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS x(id text,time_us text,price text)
        JOIN trades t ON t.product=$1 AND t.trade_id=x.id::bigint WHERE t.time_us<>x.time_us::bigint OR t.price<>x.price::numeric) AS conflict`,
        [
          PRODUCT,
          JSON.stringify(
            trades.map((t) => ({
              id: t.id,
              time_us: t.timeUs.toString(),
              price: t.price,
              ws_time_us: t.wsTimeUs?.toString() ?? null,
            })),
          ),
        ],
      );
      if (conflict)
        throw new Error("Provider returned conflicting trade evidence");
    }
    const {
      rows: [latest],
    } = await c.query(
      "SELECT trade_id FROM trades WHERE product=$1 AND trade_id<=$2 AND time_us<=$3 ORDER BY time_us DESC,trade_id DESC LIMIT 1",
      [PRODUCT, checkpoint, coverageUs.toString()],
    );
    if (!latest) throw new Error("No verified trade at coverage boundary");
    await c.query(
      `UPDATE market SET checkpoint_id=$2,coverage_us=$3,latest_trade_id=$4,heartbeat_at=$5,verified_at=clock_timestamp(),status='live',error=NULL WHERE product=$1`,
      [
        PRODUCT,
        checkpoint,
        coverageUs.toString(),
        latest.trade_id,
        heartbeatAt,
      ],
    );
    if (!stillLeader()) throw new Error("Collector leadership lost");
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
export async function settle(c: pg.PoolClient, stillLeader: () => boolean) {
  if (!stillLeader()) throw new Error("Settlement leadership lost");
  await c.query("BEGIN");
  try {
    const {
      rows: [m],
    } = await c.query("SELECT * FROM market WHERE product=$1 FOR SHARE", [
      PRODUCT,
    ]);
    if (!m.coverage_us) {
      await c.query("COMMIT");
      return 0;
    }
    // Verified historical coverage remains usable even if the current socket is disconnected.
    // Freeze the last trade at/before acceptance only after complete coverage passes that time.
    // These separate locking rows cannot be starved by older equal-price rounds awaiting settlement.
    const { rows: locking } = await c.query<GuessRecord>(
      `SELECT * FROM guesses WHERE status='pending' AND start_trade_id IS NULL AND submitted_us<$1
      ORDER BY submitted_us LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [m.coverage_us],
    );
    for (const g of locking) {
      const {
        rows: [start],
      } = await c.query(
        `SELECT * FROM trades WHERE product=$1 AND time_us<=$2 AND trade_id<=$3
        ORDER BY time_us DESC,trade_id DESC LIMIT 1`,
        [PRODUCT, g.submitted_us, m.checkpoint_id],
      );
      if (!start) continue; // Missing evidence must leave the round pending.
      await c.query(
        "UPDATE guesses SET start_trade_id=$2,start_time_us=$3,start_price=$4 WHERE id=$1",
        [g.id, start.trade_id, start.time_us, start.price],
      );
    }
    const { rows } = await c.query(
      `SELECT * FROM guesses WHERE status='pending' AND start_trade_id IS NOT NULL AND deadline_us<=$1
      AND deadline_us <= (extract(epoch FROM clock_timestamp())*1000000)::bigint ORDER BY deadline_us LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [m.coverage_us],
    );
    let count = 0;
    for (const g of rows) {
      const {
        rows: [trade],
      } = await c.query(
        `SELECT * FROM trades WHERE product=$1 AND time_us>=$2 AND time_us<=$3 AND price<>$4
        AND trade_id<=$5 ORDER BY time_us,trade_id LIMIT 1`,
        [PRODUCT, g.deadline_us, m.coverage_us, g.start_price, m.checkpoint_id],
      );
      if (!trade) continue;
      const delta = scoreDelta(g.direction, g.start_price, trade.price);
      await c.query(
        `UPDATE guesses SET status='resolved',settlement_trade_id=$2,settlement_time_us=$3,settlement_price=$4,score_delta=$5,resolved_at=clock_timestamp() WHERE id=$1 AND status='pending'`,
        [g.id, trade.trade_id, trade.time_us, trade.price, delta],
      );
      await c.query("UPDATE players SET score=score+$2 WHERE id=$1", [
        g.player_id,
        delta,
      ]);
      count++;
    }
    if (!stillLeader()) throw new Error("Settlement leadership lost");
    await c.query("COMMIT");
    return count;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

export async function roundHistory(
  pool: pg.Pool,
  playerId: string,
  cursor?: string,
) {
  let beforeTime: string | null = null,
    beforeId: string | null = null;
  if (cursor) {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match =
      /^(\d{1,18})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
        decoded,
      );
    if (!match) throw new HttpError(400, "Invalid history cursor.");
    [beforeTime, beforeId] = [match[1], match[2]];
  }
  const { rows } = await pool.query<GuessRecord>(
    `SELECT * FROM guesses WHERE player_id=$1 AND status='resolved'
    AND ($2::bigint IS NULL OR (submitted_us,id)<($2::bigint,$3::uuid))
    ORDER BY submitted_us DESC,id DESC LIMIT 21`,
    [playerId, beforeTime, beforeId],
  );
  const visible = rows.slice(0, 20),
    last = visible.at(-1);
  return {
    rounds: visible.map(resolvedGuess),
    nextCursor:
      rows.length > 20 && last
        ? Buffer.from(`${last.submitted_us}|${last.id}`).toString("base64url")
        : null,
  };
}
