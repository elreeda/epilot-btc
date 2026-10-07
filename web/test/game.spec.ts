import { type BrowserContext, expect, test } from "@playwright/test";

const trade = { id: "100", price: "60000", time: new Date().toISOString() };
const base = () => ({
  serverTime: new Date().toISOString(),
  score: 0,
  market: {
    status: "live",
    price: trade.price,
    time: new Date().toISOString(),
    provider: "Coinbase Exchange",
    message: null,
    history: [
      { time: new Date(Date.now() - 590000).toISOString(), price: "59950" },
      { time: new Date().toISOString(), price: "60000" },
    ],
  },
  activeGuess: null as any,
  latestResult: null as any,
});
async function fixture(context: BrowserContext) {
  const state = base();
  let submissions = 0;
  await context.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/session"))
      return route.fulfill({
        json: { ready: true },
        headers: {
          "Set-Cookie": "btc_session=test; Path=/; HttpOnly; SameSite=Lax",
        },
      });
    if (new URL(url).pathname === "/api/rounds")
      return route.fulfill({
        json: {
          rounds: state.latestResult ? [state.latestResult] : [],
          nextCursor: null,
        },
      });
    if (url.endsWith("/guesses")) {
      submissions++;
      if (state.activeGuess)
        return route.fulfill({
          status: 409,
          json: { message: "You already have a pending guess." },
        });
      const { direction } = route.request().postDataJSON();
      state.activeGuess = {
        id: "guess",
        direction,
        status: "pending",
        deadline: new Date(Date.now() + 60000).toISOString(),
        startingTrade: trade,
        settlementTrade: null,
        scoreDelta: null,
        ruleVersion: "first-differing-trade-v1",
      };
      return route.fulfill({ status: 201, json: state.activeGuess });
    }
    state.serverTime = new Date().toISOString();
    return route.fulfill({ json: state });
  });
  return {
    get state() {
      return state;
    },
    get submissions() {
      return submissions;
    },
  };
}
test("call survives refresh, settles, and allows another round", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Bitcoin", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Bitcoin price over the last ten minutes/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Higher" }).click();
  await expect(page.getByText("Your call is in.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Your call is in.")).toBeVisible();
  expect(f.submissions).toBe(1);
  f.state.latestResult = {
    ...f.state.activeGuess,
    status: "resolved",
    settlementTrade: { ...trade, id: "101", price: "60001" },
    scoreDelta: 1,
  };
  f.state.activeGuess = null;
  f.state.score = 1;
  await expect(page.getByText("Good call.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lower" })).toBeEnabled();
  await page.getByText("View settlement evidence").click();
  await expect(
    page.getByRole("complementary").getByText(/Settlement trade #101/),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Your rounds" }).getByText("Won"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Your rounds" }).getByText("Won"),
  ).toBeVisible();
});
test("two tabs and closing the browser page keep the pending round", async ({
  page,
  context,
}) => {
  await fixture(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Lower" }).click();
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByText("Your call is in.")).toBeVisible();
  await page.close();
  await second.reload();
  await expect(second.getByText("Your call is in.")).toBeVisible();
});
test("stale feed blocks controls and layout fits viewport", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  f.state.market.status = "stale";
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Higher" })).toBeDisabled();
  await expect(page.getByText("Price delayed")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("keyboard can submit and recovery keeps accepted round visible", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  await page.goto("/");
  const higher = page.getByRole("button", { name: "Higher" });
  await expect(higher).toBeEnabled();
  await higher.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Your call is in.")).toBeVisible();
  f.state.market.status = "recovering";
  f.state.activeGuess.deadline = new Date(Date.now() - 1000).toISOString();
  await expect(
    page.getByText("Verifying trades before deciding your result."),
  ).toBeVisible();
});
