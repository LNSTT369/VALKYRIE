import { describe, it, expect } from "vitest";
import { aggregateSignals } from "./aggregator";
import type { AlphaSignal, SignalSource } from "./types";
import { generateId } from "../lib/utils";

describe("Phase B Stress Test - Multi-Agent Aggregation", () => {
  const createSignal = (source: SignalSource, direction: "long" | "short", confidence: number): AlphaSignal => {
    return {
      signal_id: generateId(),
      source,
      generated_at: new Date().toISOString(),
      ttl_seconds: 600,
      symbol: "BTC/USD",
      asset_class: "equity",
      direction,
      confidence,
      urgency: "session",
      horizon: 60,
      rationale: `Agent ${source} signal`,
      regime_tags: [],
      supporting_data: {},
    };
  };

  it("handles 100 concurrent agents with conflicting signals", () => {
    const signals: AlphaSignal[] = [];
    
    // Simulate 40 Bullish Technical Agents
    for (let i = 0; i < 40; i++) {
      signals.push(createSignal("technical", "long", 0.6 + Math.random() * 0.4));
    }
    
    // Simulate 30 Bearish LLM Agents
    for (let i = 0; i < 30; i++) {
      signals.push(createSignal("llm", "short", 0.5 + Math.random() * 0.5));
    }
    
    // Simulate 10 Bullish Dark Pool Agents (High Weight)
    for (let i = 0; i < 10; i++) {
      signals.push(createSignal("dark_pool", "long", 0.8 + Math.random() * 0.2));
    }
    
    // Simulate 20 Bearish External Agents
    for (let i = 0; i < 20; i++) {
      signals.push(createSignal("external", "short", 0.4 + Math.random() * 0.6));
    }

    const startTime = performance.now();
    const result = aggregateSignals(signals);
    const endTime = performance.now();

    console.log(`Aggregated 100 signals in ${(endTime - startTime).toFixed(4)}ms`);
    console.log(`Final Direction: ${result.final_direction}, Confidence: ${result.final_confidence.toFixed(4)}`);
    
    expect(result.source_count).toBe(100);
    expect(result.conflict_detected).toBe(true);
    // Since technical (40) and dark pool (10) are mostly long, and dark pool has higher weight, 
    // it should likely be long, but let's see if the logic holds up.
  });

  it("verifies deterministic belief aggregation under high conflict", () => {
    const signals = [
        createSignal("manual", "short", 0.95), // Weight 0.95, Total -0.9025
        createSignal("technical", "long", 0.9), // Weight 0.60, Total +0.54
        createSignal("dark_pool", "long", 0.9), // Weight 0.90, Total +0.81
        createSignal("llm", "short", 0.9),      // Weight 0.40, Total -0.36
    ];

    // Total weight = 0.95 + 0.60 + 0.90 + 0.40 = 2.85
    // Total conviction = -0.9025 + 0.54 + 0.81 - 0.36 = 0.0875
    // Net certainty = 0.0875 / 2.85 = 0.0307
    // Threshold is 0.15, so result should be neutral.

    const result = aggregateSignals(signals);
    expect(result.final_direction).toBe("neutral");
    expect(result.final_confidence).toBeLessThan(0.1);
  });
});
