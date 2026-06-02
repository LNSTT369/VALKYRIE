import { describe, it, expect } from "vitest";
import { aggregateSignals } from "./aggregator";
import type { AlphaSignal } from "./types";
import { generateId } from "../lib/utils";

describe("Signal Aggregator - Weighted Belief Aggregation", () => {
  const createSignal = (overrides: Partial<AlphaSignal>): AlphaSignal => {
    return {
      signal_id: generateId(),
      source: "technical",
      generated_at: new Date().toISOString(),
      ttl_seconds: 600,
      symbol: "SPY",
      asset_class: "equity",
      direction: "neutral",
      confidence: 0.5,
      urgency: "session",
      horizon: 60,
      rationale: "test rationale",
      regime_tags: [],
      supporting_data: {},
      ...overrides,
    };
  };

  it("aggregates unanimous bullish signals successfully", () => {
    const signals = [
      createSignal({ source: "technical", direction: "long", confidence: 0.8 }),
      createSignal({ source: "llm", direction: "long", confidence: 0.6 }),
    ];

    const result = aggregateSignals(signals);
    expect(result.final_direction).toBe("long");
    expect(result.final_confidence).toBeGreaterThan(0.5);
    expect(result.conflict_detected).toBe(false);
  });

  it("resolves opposing directional signals based on weight and confidence (not zeroing out)", () => {
    // 0.95-confidence dark pool signal (weight 0.90) vs. 0.3-confidence LLM signal (weight 0.40)
    const signals = [
      createSignal({ source: "dark_pool", direction: "long", confidence: 0.95 }),
      createSignal({ source: "llm", direction: "short", confidence: 0.3 }),
    ];

    const result = aggregateSignals(signals);
    // Dark pool is extremely confident and highly weighted, should override the weak short LLM signal
    expect(result.final_direction).toBe("long");
    expect(result.conflict_detected).toBe(true);
    expect(result.final_confidence).toBeGreaterThan(0.4);
  });

  it("cancels out opposing signals of equal strength and weight into neutral", () => {
    const signals = [
      createSignal({ source: "technical", direction: "long", confidence: 0.8 }),
      createSignal({ source: "technical", direction: "short", confidence: 0.8 }),
    ];

    const result = aggregateSignals(signals);
    expect(result.final_direction).toBe("neutral");
    expect(result.conflict_detected).toBe(true);
    expect(result.final_confidence).toBe(0);
  });

  it("falls back to neutral if the net conviction is below the threshold", () => {
    // Very low confidence/weight signals that don't pass the 0.15 threshold
    const signals = [
      createSignal({ source: "llm", direction: "long", confidence: 0.1 }),
    ];

    const result = aggregateSignals(signals);
    expect(result.final_direction).toBe("neutral");
  });

  it("honors dynamic convictionThresholdOverride when provided", () => {
    // Bullish signal with confidence 0.25 (net certainty will be around 0.25)
    // By default 0.25 >= 0.15, so it would be long.
    // If override is 0.5, then 0.25 < 0.5, so it should resolve to neutral.
    const signals = [
      createSignal({ source: "llm", direction: "long", confidence: 0.25 }),
    ];

    const resultDefault = aggregateSignals(signals);
    expect(resultDefault.final_direction).toBe("long");

    const resultWithOverride = aggregateSignals(signals, { convictionThresholdOverride: 0.5 });
    expect(resultWithOverride.final_direction).toBe("neutral");
  });
});
