import { useEffect, useRef, useState } from "react";
import type { RoundHistory as History } from "../../server/src/contracts.js";

const money = (value: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(value),
  );

export function RoundHistory({
  ready,
  latestId,
  offline,
}: {
  ready: boolean;
  latestId?: string;
  offline: boolean;
}) {
  const [history, setHistory] = useState<History>({
    rounds: [],
    nextCursor: null,
  });
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const version = useRef(0);
  const retryPage = useRef(false);

  async function load(append = false) {
    const own = ++version.current;

    retryPage.current = append;
    setLoading(true);
    setError("");

    try {
      const url =
        "/api/rounds" +
        (append && history.nextCursor
          ? `?cursor=${encodeURIComponent(history.nextCursor)}`
          : "");
      const response = await fetch(url);
      const next = await response.json();

      if (!response.ok)
        throw new Error(next.message ?? "Could not load your rounds.");

      if (own !== version.current) return;

      setHistory((previous) => ({
        rounds: append
          ? [
              ...previous.rounds,
              ...next.rounds.filter(
                (round: History["rounds"][number]) =>
                  !previous.rounds.some((p) => p.id === round.id),
              ),
            ]
          : next.rounds,
        nextCursor: next.nextCursor,
      }));
    } catch (e) {
      if (own === version.current) setError((e as Error).message);
    } finally {
      if (own === version.current) setLoading(false);
    }
  }

  // Reload when session/ready/latest result/offline changes; load reads latest state via refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load intentionally omitted
  useEffect(() => {
    if (ready) void load();

    return () => {
      version.current++;
    };
  }, [ready, latestId, offline]);

  return (
    <section className="round-history" aria-labelledby="history-title">
      <div className="history-heading">
        <div>
          <span className="eyebrow">YOUR TRACK RECORD</span>
          <h2 id="history-title">Your rounds</h2>
        </div>
        <span>Most recent first</span>
      </div>
      {history.rounds.length > 0 ? (
        <div className="history-list">
          {history.rounds.map((round) => (
            <details className="history-round" key={round.id}>
              <summary>
                <span
                  className={`round-outcome ${round.scoreDelta === 1 ? "won" : "lost"}`}
                >
                  {round.scoreDelta === 1 ? "Won" : "Lost"}
                </span>
                <span className="round-call">
                  {round.direction === "up" ? "↗ Higher" : "↘ Lower"}
                  <time dateTime={round.submittedAt}>
                    {new Date(round.submittedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </span>
                <span className="round-prices">
                  {money(round.startingTrade.price)}
                  <span>→</span>
                  {money(round.settlementTrade.price)}
                </span>
                <span
                  className={`round-points ${round.scoreDelta === 1 ? "won" : "lost"}`}
                >
                  {round.scoreDelta === 1 ? "+1" : "−1"}
                  <small>PT</small>
                </span>
                <span className="round-expand" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="history-evidence">
                <p>
                  <span>Starting trade #{round.startingTrade.id}</span>
                  <strong>{round.startingTrade.time}</strong>
                </p>
                <p>
                  <span>60-second deadline</span>
                  <strong>{round.deadline}</strong>
                </p>
                <p>
                  <span>Settlement trade #{round.settlementTrade.id}</span>
                  <strong>{round.settlementTrade.time}</strong>
                </p>
                <p className="history-rule">
                  First differing trade at or after the deadline
                </p>
              </div>
            </details>
          ))}
        </div>
      ) : (
        <p className="history-empty">
          {!ready || loading
            ? "Loading your rounds…"
            : error
              ? "Your rounds could not be loaded."
              : "A fresh start. Your completed calls will appear here."}
        </p>
      )}
      {offline && history.rounds.length > 0 && (
        <p className="history-message">
          Offline · showing your last loaded rounds.
        </p>
      )}
      {error && (
        <p className="history-error" role="alert">
          {error}{" "}
          <button
            type="button"
            onClick={() => void load(retryPage.current)}
            disabled={loading}
          >
            Retry
          </button>
        </p>
      )}
      {history.nextCursor && (
        <button
          type="button"
          className="history-more"
          disabled={loading || offline}
          onClick={() => void load(true)}
        >
          {loading ? "Loading…" : "Show older rounds"}
        </button>
      )}
    </section>
  );
}
