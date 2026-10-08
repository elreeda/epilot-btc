import { z } from "zod";
export const PRODUCT = "BTC-USD";

import type { Direction } from "./contracts.js";

export type { Direction } from "./contracts.js";
export type Trade = {
  id: string;
  timeUs: bigint;
  price: string;
  wsTimeUs?: bigint;
};
const tradeSchema = z.object({
  trade_id: z.union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^\d+$/),
  ]),
  time: z.string(),
  price: z.string().regex(/^\d+(\.\d+)?$/),
});
export function timestampUs(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
    value,
  );
  if (!match) throw new Error("Invalid exchange timestamp");
  const ms = Date.parse(`${match[1]}Z`);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 19) !== match[1]
  )
    throw new Error("Invalid exchange timestamp");
  return BigInt(ms) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
export function isoUs(us: bigint | string): string {
  const n = BigInt(us);
  return `${new Date(Number(n / 1000000n) * 1000).toISOString().slice(0, 19)}.${(n % 1000000n).toString().padStart(6, "0")}Z`;
}
export function normalizeTrade(raw: unknown): Trade {
  const t = tradeSchema.parse(raw);
  if (comparePrice(t.price, "0") <= 0) throw new Error("Invalid price");
  return {
    id: String(t.trade_id),
    timeUs: timestampUs(t.time),
    price: t.price,
  };
}
export function comparePrice(a: string, b: string): number {
  const [ai, af = ""] = a.split("."),
    [bi, bf = ""] = b.split(".");
  const digits = Math.max(af.length, bf.length);
  const av = BigInt(ai + af.padEnd(digits, "0")),
    bv = BigInt(bi + bf.padEnd(digits, "0"));
  return av === bv ? 0 : av > bv ? 1 : -1;
}
export function orderTrades(a: Trade, b: Trade): number {
  if (a.timeUs !== b.timeUs) return a.timeUs < b.timeUs ? -1 : 1;
  return BigInt(a.id) === BigInt(b.id)
    ? 0
    : BigInt(a.id) < BigInt(b.id)
      ? -1
      : 1;
}
export function chooseSettlement(
  trades: Trade[],
  deadlineUs: bigint,
  startPrice: string,
): Trade | undefined {
  return [...trades]
    .sort(orderTrades)
    .find(
      (t) => t.timeUs >= deadlineUs && comparePrice(t.price, startPrice) !== 0,
    );
}
export function scoreDelta(
  direction: Direction,
  start: string,
  end: string,
): number {
  const movement = comparePrice(end, start);
  if (!movement) throw new Error("Equal prices cannot settle");
  return (direction === "up" ? 1 : -1) === movement ? 1 : -1;
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
