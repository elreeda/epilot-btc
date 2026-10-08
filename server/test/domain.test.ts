import { describe, expect, it } from "vitest";
import {
  chooseSettlement,
  comparePrice,
  isoUs,
  normalizeTrade,
  scoreDelta,
  timestampUs,
} from "../src/domain.js";

describe("precise settlement rules", () => {
  it("preserves microseconds round trip", () => {
    const t = "2026-10-07T12:00:00.123456Z";

    expect(isoUs(timestampUs(t))).toBe(t);
  });
  it("compares exact decimals without floating point rounding", () => {
    expect(comparePrice("60000.0000000000000001", "60000")).toBe(1);
    expect(comparePrice("60.00", "60")).toBe(0);
  });
  it("ignores early and equal trades; uses time then ID, not arrival order", () => {
    const trades = [
      { id: "4", timeUs: 61n, price: "101" },
      { id: "3", timeUs: 60n, price: "99" },
      { id: "1", timeUs: 59n, price: "102" },
      { id: "2", timeUs: 60n, price: "100" },
    ];

    expect(chooseSettlement(trades, 60n, "100")?.id).toBe("3");
  });
  it("breaks exact timestamp ties by trade ID", () =>
    expect(
      chooseSettlement(
        [
          { id: "22", timeUs: 60n, price: "99" },
          { id: "21", timeUs: 60n, price: "101" },
        ],
        60n,
        "100",
      )?.id,
    ).toBe("21"));
  it.each([
    ["up", "101", 1],
    ["up", "99", -1],
    ["down", "99", 1],
    ["down", "101", -1],
  ] as const)("%s at %s returns %s", (d, end, delta) =>
    expect(scoreDelta(d, "100", end)).toBe(delta),
  );
  it("keeps an equal price pending", () =>
    expect(
      chooseSettlement([{ id: "2", timeUs: 60n, price: "100.00" }], 60n, "100"),
    ).toBeUndefined());
  it("rejects malformed prices and timestamps", () => {
    expect(() =>
      normalizeTrade({ trade_id: 1, time: "bad", price: "123" }),
    ).toThrow();
    expect(() =>
      normalizeTrade({ trade_id: 1, time: "2026-10-07T12:00:00Z", price: "0" }),
    ).toThrow();
  });
});
