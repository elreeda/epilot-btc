import { describe, expect, it } from "vitest";
import { chooseSettlement, type Trade } from "../src/domain.js";
import {
  type FetchPage,
  mergeTrades,
  recoverInterval,
} from "../src/recovery.js";

const t = (id: string, timeUs = BigInt(id), price = "100"): Trade => ({
  id,
  timeUs,
  price,
});
describe("REST verification and recovery", () => {
  it("uses canonical REST time and preserves differing WebSocket timestamp evidence", async () => {
    const recovered = await recoverInterval(
      async () => ({
        trades: [t("11", 60n, "101"), t("10", 59n)],
        after: null,
      }),
      "10",
      "11",
      [t("11", 61n, "101")],
    );
    expect(recovered[1].timeUs).toBe(60n);
    expect(recovered[1].wsTimeUs).toBe(61n);
  });
  it("rejects a price disagreement between WebSocket and REST", async () =>
    expect(
      recoverInterval(
        async () => ({
          trades: [t("11", 60n, "101"), t("10", 59n)],
          after: null,
        }),
        "10",
        "11",
        [t("11", 60n, "99")],
      ),
    ).rejects.toThrow("Conflicting trade price"));

  it("uses provider older-page cursors and deduplicates overlap", async () => {
    const calls: (string | undefined)[] = [];
    const page: FetchPage = async (after) => {
      calls.push(after);
      return after
        ? { trades: [t("11"), t("10")], after: null }
        : { trades: [t("14"), t("13"), t("11")], after: "older-cursor" };
    };
    const result = await recoverInterval(page, "10", "13", [t("13"), t("11")]);
    expect(calls).toEqual([undefined, "older-cursor"]);
    expect(result.map((t) => t.id)).toEqual(["10", "11", "13"]);
  });
  it("does not infer missing trades from nonconsecutive trade IDs", async () =>
    expect(
      (
        await recoverInterval(
          async () => ({ trades: [t("20"), t("12"), t("10")], after: null }),
          "10",
          "20",
        )
      ).map((t) => t.id),
    ).toEqual(["10", "12", "20"]));
  it("anchors first boot at the heartbeat trade", async () =>
    expect(
      (
        await recoverInterval(
          async () => ({ trades: [t("12"), t("11")], after: null }),
          null,
          "11",
        )
      ).map((t) => t.id),
    ).toEqual(["11"]));
  it("refuses absent saved checkpoints", async () =>
    expect(
      recoverInterval(
        async () => ({ trades: [t("20"), t("9")], after: null }),
        "10",
        "20",
      ),
    ).rejects.toThrow("checkpoint missing"));
  it("refuses repeated cursors and truncated history", async () => {
    await expect(
      recoverInterval(
        async () => ({ trades: [t("20")], after: "same" }),
        "10",
        "20",
      ),
    ).rejects.toThrow("pagination");
    await expect(
      recoverInterval(async () => ({ trades: [], after: null }), "10", "20"),
    ).rejects.toThrow("unavailable");
  });
  it("does not silently fill missing REST evidence with WebSocket trades", async () =>
    expect(
      recoverInterval(
        async () => ({ trades: [t("10")], after: null }),
        "10",
        "11",
        [t("11")],
      ),
    ).rejects.toThrow("complete interval"));
  it("detects conflicting evidence", () =>
    expect(() => mergeTrades([t("1", 1n, "100"), t("1", 1n, "101")])).toThrow(
      "Conflicting",
    ));
  it("rejects exchange timestamp regressions", async () =>
    expect(
      recoverInterval(
        async () => ({ trades: [t("11", 9n), t("10", 10n)], after: null }),
        "10",
        "11",
      ),
    ).rejects.toThrow("regressed"));
  it("aborts a superseded connection generation", async () =>
    expect(
      recoverInterval(
        async () => ({ trades: [t("10")], after: null }),
        "9",
        "10",
        [],
        async () => {},
        () => false,
      ),
    ).rejects.toThrow("generation"));
  it("propagates rate limits without advancing any checkpoint", async () =>
    expect(
      recoverInterval(
        async () => {
          throw new Error("HTTP 429");
        },
        "10",
        "11",
      ),
    ).rejects.toThrow("429"));
  it("recovery produces the uninterrupted result after missing the first qualifying trade", async () => {
    const all = [t("10", 59n), t("11", 60n, "99"), t("12", 61n, "101")];
    const recovered = await recoverInterval(
      async () => ({ trades: [...all].reverse(), after: null }),
      "10",
      "12",
      [all[2]],
    );
    expect(chooseSettlement(recovered, 60n, "100")).toEqual(
      chooseSettlement(all, 60n, "100"),
    );
  });
});
