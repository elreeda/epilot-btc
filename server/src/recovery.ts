import { comparePrice, normalizeTrade, type Trade } from "./domain.js";
export type Page = { trades: Trade[]; after: string | null };
export type FetchPage = (after?: string) => Promise<Page>;
export async function fetchCoinbasePage(
  after?: string,
  before?: string,
): Promise<Page> {
  const url = new URL(
    "https://api.exchange.coinbase.com/products/BTC-USD/trades",
  );
  url.searchParams.set("limit", "1000");
  if (after) url.searchParams.set("after", after);
  else if (before) url.searchParams.set("before", before);
  const res = await fetch(url, {
    headers: { "User-Agent": "BTC-Minute/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`REST recovery HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error("Invalid REST trade page");
  return {
    trades: body.map(normalizeTrade),
    after: res.headers.get("cb-after"),
  };
}
export function mergeTrades(trades: Trade[]): Trade[] {
  const map = new Map<string, Trade>();
  for (const t of trades) {
    const previous = map.get(t.id);
    if (
      previous &&
      (previous.timeUs !== t.timeUs ||
        comparePrice(previous.price, t.price) !== 0)
    )
      throw new Error(
        `Conflicting trade evidence for ${t.id}: ${previous.timeUs}/${previous.price} versus ${t.timeUs}/${t.price}`,
      );
    map.set(t.id, t);
  }
  return [...map.values()].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  );
}
/** REST pages establish coverage; a last_trade_id alone does not establish completeness. */
export async function recoverInterval(
  fetchPage: FetchPage,
  checkpoint: string | null,
  target: string,
  buffer: Trade[] = [],
  pause = async () => {},
  isCurrent = () => true,
): Promise<Trade[]> {
  if (checkpoint && BigInt(target) < BigInt(checkpoint))
    throw new Error("Heartbeat checkpoint regression");
  if (checkpoint === target) return [];
  const collected: Trade[] = [],
    seen = new Set<string>();
  let after: string | undefined,
    found = false,
    targetFound = false;
  for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
    if (!isCurrent()) throw new Error("Recovery generation changed");
    const page = await fetchPage(after);
    if (!page.trades.length)
      throw new Error("Trade history unavailable before checkpoint");
    collected.push(...page.trades);
    targetFound ||= page.trades.some((t) => t.id === target);
    found = checkpoint
      ? page.trades.some((t) => t.id === checkpoint)
      : targetFound;
    if (found) break;
    if (
      checkpoint &&
      page.trades.some((t) => BigInt(t.id) < BigInt(checkpoint))
    )
      throw new Error("Saved checkpoint missing from trade history");
    if (!page.after || seen.has(page.after))
      throw new Error("Recovery pagination did not reach checkpoint");
    seen.add(page.after);
    after = page.after;
    await pause();
  }
  if (!found || !targetFound)
    throw new Error("Recovery could not prove the complete interval");
  const rest = mergeTrades(collected);
  // Include checkpoint for immutability checks; on first boot anchor at target.
  const lower = BigInt(checkpoint ?? target),
    upper = BigInt(target);
  const interval = rest.filter(
    (t) => BigInt(t.id) >= lower && BigInt(t.id) <= upper,
  );
  // Compare WS evidence but never use it to silently fill incomplete REST coverage.
  const observations = new Map(buffer.map((t) => [t.id, t]));
  for (const trade of interval) {
    const observed = observations.get(trade.id);
    if (observed) {
      if (comparePrice(observed.price, trade.price) !== 0)
        throw new Error(`Conflicting trade price for ${trade.id}`);
      // Coinbase WS and REST occasionally represent the same timestamp a microsecond apart.
      // REST history is the canonical settlement clock; preserve both rather than round.
      trade.wsTimeUs = observed.timeUs;
    }
  }
  for (let i = 1; i < interval.length; i++)
    if (interval[i].timeUs < interval[i - 1].timeUs)
      throw new Error("Exchange timestamps regressed; settlement paused");
  return interval;
}
