import { describe, expect, it } from "vitest";
import { BudgetExceededError, MockProvider, createProvider, withBudget, withUsageLog } from "../src/index.ts";
import { req } from "./helpers.ts";

describe("withBudget", () => {
  it("tracks spend and refuses calls once the token cap is exceeded", async () => {
    const b = withBudget(new MockProvider(), { maxTotalTokens: 400 });
    let ok = 0;
    let err: unknown;
    for (let i = 0; i < 20; i++) {
      try {
        await b.complete(req());
        ok++;
      } catch (e) {
        err = e;
        break;
      }
    }
    expect(ok).toBeGreaterThan(0);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).cap).toBe("tokens");
    expect(b.spent().tokens).toBeGreaterThan(0);
    await expect(b.complete(req())).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("enforces the cost cap after spend crosses it", async () => {
    const b = withBudget(new MockProvider(), { maxCostUsd: 0.002 });
    await b.complete(req());
    expect(b.spent().cost_usd).toBeLessThan(0.002);
    await b.complete(req());
    expect(b.spent().cost_usd).toBeGreaterThanOrEqual(0.002);
    const afterTurn = b.spent().cost_usd;
    await b.complete(req({ purpose: "delta_repair" }));
    expect(b.spent().cost_usd).toBeGreaterThan(afterTurn);
    await expect(b.complete(req())).rejects.toMatchObject({ name: "BudgetExceededError", cap: "cost_usd" });
  });

  it("is transparent without caps", async () => {
    const b = withBudget(new MockProvider(), {});
    await b.complete(req());
    expect(b.name).toBe("mock");
    expect(b.spent().tokens).toBeGreaterThan(0);
  });
});

describe("withUsageLog", () => {
  it("collects every usage", async () => {
    const m = withUsageLog(new MockProvider());
    await m.complete(req());
    await m.complete(req({ purpose: "ooc" }));
    expect(m.usages.map((u) => u.purpose)).toEqual(["turn", "ooc"]);
    expect(m.name).toBe("mock");
  });
});

describe("createProvider", () => {
  it("creates mock", () => {
    expect(createProvider("mock", {}).name).toBe("mock");
  });
  it("tells the user to set the key", () => {
    expect(() => createProvider("anthropic", {})).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("creates anthropic with a key", () => {
    expect(createProvider("anthropic", { ANTHROPIC_API_KEY: "k" }).name).toBe("anthropic");
  });
  it("rejects unknown names", () => {
    expect(() => createProvider("x" as never, {})).toThrow(/Unknown provider/);
  });
});
