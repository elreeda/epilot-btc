/** Public API: exact prices and exchange timestamps travel as strings. */
export type Direction = "up" | "down";
export type MarketStatus = "live" | "stale" | "recovering" | "error";
export interface TradeEvidence {
  id: string;
  price: string;
  time: string;
}
export interface Guess {
  id: string;
  direction: Direction;
  status: "pending" | "resolved";
  submittedAt: string;
  deadline: string;
  startingTrade: TradeEvidence | null;
  settlementTrade: TradeEvidence | null;
  scoreDelta: number | null;
}
export type ResolvedGuess = Guess & {
  status: "resolved";
  startingTrade: TradeEvidence;
  settlementTrade: TradeEvidence;
  scoreDelta: number;
};
export interface GameState {
  serverTime: string;
  score: number;
  market: {
    product: string;
    provider: string;
    status: MarketStatus;
    price: string | null;
    tradeId: string | null;
    time: string | null;
    coverageThrough: string | null;
    history: { time: string; price: string }[];
    message: string | null;
  };
  activeGuess: Guess | null;
  latestResult: ResolvedGuess | null;
}
export interface SubmitGuess {
  direction: Direction;
  idempotencyKey: string;
}

export interface RoundHistory {
  rounds: ResolvedGuess[];
  nextCursor: string | null;
}
