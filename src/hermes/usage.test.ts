// Reading Hermes's usage counters and stored totals, measuring a reply, and how costs are labelled (usage.ts).
import { describe, expect, it } from "vitest";
import { chatUsageOf, costLabel, countersOf, newerChatUsage, replyUsage, replyUsageOf, tokens, totalTokens, usd, ZERO_COUNTERS } from "./usage";

/** A stored session row read from the deployed server's `state.db` on 2026-11-02 (three model calls on OpenRouter). */
const STORED = {
  id: "20261102_145145_b4c652",
  source: "hermes-chat",
  model: "z-ai/glm-5.3-flash",
  input_tokens: 42298,
  output_tokens: 1006,
  cache_read_tokens: 60160,
  cache_write_tokens: 0,
  reasoning_tokens: 183,
  api_call_count: 3,
  estimated_cost_usd: 0.0030129068,
  actual_cost_usd: null,
  cost_status: "estimated",
  cost_source: "provider_models_api",
  pricing_version: null,
  billing_provider: "openrouter",
};

describe("Hermes's live counters", () => {
  it("reads `_get_usage`, its cache part being prompt less uncached input", () => {
    expect(countersOf({ model: "m", input: 1200, output: 300, reasoning: 50, prompt: 5200, completion: 300, total: 5500, calls: 2 })).toEqual({
      input: 1200,
      cache: 4000,
      output: 300,
      reasoning: 50,
      calls: 2,
      model: "m",
    });
  });

  it("counts an agent not built yet as zero, and anything not an object as unknown", () => {
    expect(countersOf({})).toEqual(ZERO_COUNTERS);
    expect(countersOf(undefined)).toBeUndefined();
    expect(countersOf([1, 2])).toBeUndefined();
    expect(countersOf("lots")).toBeUndefined();
  });

  it("ignores counts that aren't counts", () => {
    expect(countersOf({ input: -5, output: "9", calls: Number.NaN, prompt: 10 })).toEqual({ input: 0, cache: 10, output: 0, reasoning: 0, calls: 0 });
  });
});

describe("A reply's usage", () => {
  const start = { input: 1200, cache: 4000, output: 300, reasoning: 50, calls: 2 };

  it("is how far the counters moved during its turn, with the model of its last call", () => {
    expect(replyUsage(start, { input: 1500, cache: 8000, output: 420, reasoning: 50, calls: 3, model: "b" })).toEqual({
      input: 300,
      cache: 4000,
      output: 120,
      reasoning: 0,
      calls: 1,
      model: "b",
    });
  });

  it("is the end counters when any went down, since a rebuilt agent counts from zero", () => {
    const end = { input: 90, cache: 0, output: 10, reasoning: 0, calls: 1 };
    expect(replyUsage(start, end)).toEqual(end);
  });

  it("is nothing for a turn that made no model call", () => {
    expect(replyUsage(start, { ...start })).toBeUndefined();
  });

  it("comes back from a Saved copy only whole", () => {
    expect(replyUsageOf({ input: 1, cache: 2, output: 3, reasoning: 0, calls: 1, model: "m" })).toEqual({ input: 1, cache: 2, output: 3, reasoning: 0, calls: 1, model: "m" });
    expect(replyUsageOf({ input: 1, cache: 2, output: 3, calls: 1 })).toBeUndefined();
    expect(replyUsageOf(null)).toBeUndefined();
  });
});

describe("A chat's stored usage", () => {
  it("reads a real stored row, with Hermes's estimate labelled as one", () => {
    const u = chatUsageOf(STORED, 5)!;
    expect(u).toEqual({
      input: 42298,
      cacheRead: 60160,
      cacheWrite: 0,
      output: 1006,
      reasoning: 183,
      calls: 3,
      cost: { kind: "estimated", usd: 0.0030129068, source: "provider_models_api" },
      readAt: 5,
    });
    expect(totalTokens(u)).toBe(42298 + 60160 + 1006);
    expect(costLabel(u.cost)).toEqual({ short: "~$0.0030", detail: "Estimated by Hermes from the provider's published model prices. Your provider's bill may differ." });
  });

  it("names the pricing version when Hermes recorded one", () => {
    const u = chatUsageOf({ ...STORED, cost_source: "official_docs_snapshot", pricing_version: "anthropic-2026-09" }, 0)!;
    expect(costLabel(u.cost).detail).toBe("Estimated by Hermes from a saved copy of the provider's price list (prices anthropic-2026-09). Your provider's bill may differ.");
  });

  it("calls a cost billed only when the provider's figures are all of it", () => {
    const billed = chatUsageOf({ ...STORED, cost_status: "actual", actual_cost_usd: 0.004, estimated_cost_usd: 0.004 }, 0)!;
    expect(billed.cost).toEqual({ kind: "actual", usd: 0.004 });
    expect(costLabel(billed.cost).short).toBe("$0.0040");
    // Some calls were only estimated: the total is still an estimate.
    const mixed = chatUsageOf({ ...STORED, cost_status: "actual", actual_cost_usd: 0.001, estimated_cost_usd: 0.004 }, 0)!;
    expect(mixed.cost.kind).toBe("estimated");
  });

  it("says a chat cost at least the estimate when its latest call couldn't be priced", () => {
    const u = chatUsageOf({ ...STORED, cost_status: "unknown", estimated_cost_usd: 0.0012 }, 0)!;
    expect(u.cost).toEqual({ kind: "partial", usd: 0.0012, source: "provider_models_api" });
    expect(costLabel(u.cost).short).toBe("~$0.0012+");
  });

  it("says a subscription route costs nothing per token", () => {
    const u = chatUsageOf({ ...STORED, cost_status: "included", cost_source: "none", estimated_cost_usd: 0 }, 0)!;
    expect(u.cost).toEqual({ kind: "included" });
    expect(costLabel(u.cost).short).toBe("Included");
  });

  it("shows no cost when Hermes has no price, or recorded none", () => {
    expect(chatUsageOf({ ...STORED, cost_status: "unknown", cost_source: "none", estimated_cost_usd: null }, 0)!.cost).toEqual({ kind: "unknown", why: "unpriced" });
    // A chat with no model calls yet, as stored: no status and no estimate.
    const empty = chatUsageOf({ input_tokens: 0, output_tokens: 0, cost_status: null, estimated_cost_usd: null }, 0)!;
    expect(empty.cost).toEqual({ kind: "unknown", why: "unrecorded" });
    expect(costLabel(empty.cost)).toEqual({ short: "Cost unknown", detail: "Hermes hasn't recorded a cost for this chat." });
    // An estimate with neither a status nor a source isn't trusted (as `agent/insights.py` treats it).
    expect(chatUsageOf({ input_tokens: 5, output_tokens: 1, estimated_cost_usd: 0.2 }, 0)!.cost.kind).toBe("unknown");
  });

  it("leaves counts Hermes didn't send unknown, and a row without any as no usage", () => {
    const u = chatUsageOf({ input_tokens: 10, output_tokens: 2 }, 0)!;
    expect(u.cacheRead).toBeUndefined();
    expect(totalTokens(u)).toBeUndefined();
    expect(chatUsageOf({ id: "x", title: "no counts" }, 0)).toBeUndefined();
    expect(chatUsageOf(null, 0)).toBeUndefined();
  });

  it("keeps the newer of two reads, as stored counts only grow", () => {
    const older = chatUsageOf({ ...STORED, api_call_count: 2 }, 1);
    const newer = chatUsageOf(STORED, 2);
    expect(newerChatUsage(newer, older)).toBe(newer);
    expect(newerChatUsage(older, newer)).toBe(newer);
    expect(newerChatUsage(newer, undefined)).toBe(newer);
  });
});

describe("Formatting", () => {
  it("shows dollars to two significant digits, and at least cents", () => {
    expect([0, 0.00096, 0.0000228, 0.0258, 0.31, 5.123, 1234.5].map(usd)).toEqual(["$0.00", "$0.00096", "$0.000023", "$0.026", "$0.31", "$5.12", "$1234.50"]);
  });

  it("shows token counts in a few characters", () => {
    expect([0, 950, 1000, 1234, 42_298, 99_999, 145_000, 999_499, 999_500, 1_234_567, 10_500_000].map(tokens)).toEqual([
      "0",
      "950",
      "1k",
      "1.2k",
      "42.3k",
      "100k",
      "145k",
      "999k",
      "1M",
      "1.2M",
      "10.5M",
    ]);
  });
});
