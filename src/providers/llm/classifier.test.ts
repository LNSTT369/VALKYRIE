import { describe, it, expect } from "vitest";
import {
  classifyEvent,
  generateTradingDecision,
  generateResearchReport,
  summarizeLearnedRules,
} from "./classifier";
import type { LLMProvider } from "../types";

describe("LLM Classifiers & Reasoning Pipelines", () => {
  // A simple mock LLM provider that returns whatever content we configure
  const createMockLLM = (mockContent: string): LLMProvider => {
    return {
      complete: async (_params) => {
        return {
          content: mockContent,
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
          },
        };
      },
    };
  };

  describe("classifyEvent", () => {
    it("successfully parses valid event classifier JSON", async () => {
      const mockJson = JSON.stringify({
        event_type: "earnings_beat",
        symbols: ["AAPL", "MSFT"],
        summary: "Apple beats earnings by a wide margin.",
        confidence: 0.95,
      });
      const llm = createMockLLM(mockJson);

      const result = await classifyEvent(llm, "Apple reports earnings...");
      expect(result.event_type).toBe("earnings_beat");
      expect(result.symbols).toEqual(["AAPL", "MSFT"]);
      expect(result.summary).toBe("Apple beats earnings by a wide margin.");
      expect(result.confidence).toBe(0.95);
    });

    it("falls back gracefully to rumor when JSON is malformed", async () => {
      const llm = createMockLLM("this is not json");

      const result = await classifyEvent(llm, "Some raw market rumor content...");
      expect(result.event_type).toBe("rumor");
      expect(result.symbols).toEqual([]);
      expect(result.confidence).toBe(0.1);
      expect(result.summary).toBe("Some raw market rumor content...");
    });

    it("clamps confidence score and capitalizes symbols", async () => {
      const mockJson = JSON.stringify({
        event_type: "sec_filing",
        symbols: ["tsla", "nvda"],
        summary: "SEC Filing reported",
        confidence: 1.5, // should be clamped to 1.0
      });
      const llm = createMockLLM(mockJson);

      const result = await classifyEvent(llm, "TSLA filing...");
      expect(result.event_type).toBe("sec_filing");
      expect(result.symbols).toEqual(["TSLA", "NVDA"]);
      expect(result.confidence).toBe(1.0);
    });
  });

  describe("generateTradingDecision", () => {
    it("correctly handles bullish BUY decisions", async () => {
      const mockJson = JSON.stringify({
        verdict: "BUY",
        confidence: 0.85,
        reasoning: "Strong technical breakout above 20-SMA with positive news catalyst.",
      });
      const llm = createMockLLM(mockJson);

      const result = await generateTradingDecision(
        llm,
        "AAPL",
        150.0,
        { rsi_14: 62 },
        [{ headline: "Great news" }]
      );
      expect(result.verdict).toBe("BUY");
      expect(result.confidence).toBe(0.85);
      expect(result.reasoning).toBe("Strong technical breakout above 20-SMA with positive news catalyst.");
    });

    it("gracefully falls back to HOLD on JSON parse failure", async () => {
      const llm = createMockLLM("broken response");

      const result = await generateTradingDecision(
        llm,
        "AAPL",
        150.0,
        { rsi_14: 62 },
        []
      );
      expect(result.verdict).toBe("HOLD");
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toBe("Failed to parse LLM response");
    });
  });

  describe("generateResearchReport", () => {
    it("successfully creates a formatted markdown report", async () => {
      const mockReport = "This is a detailed equity research report content.";
      const llm = createMockLLM(mockReport);

      const result = await generateResearchReport(llm, "AAPL", {
        overview: { price: 150.0 },
        recentNews: [{ headline: "New iPhone launched", date: "2026-05-22" }],
      });

      expect(result).toContain("# Research Report: AAPL");
      expect(result).toContain(mockReport);
    });
  });

  describe("summarizeLearnedRules", () => {
    it("analyzes journal logs and outputs trading guidelines", async () => {
      const mockRules = "1. Avoid trading during high volatility\n2. Buy low RSI";
      const llm = createMockLLM(mockRules);

      const journal = [
        {
          symbol: "AAPL",
          side: "buy",
          outcome: "win",
          pnl_pct: 2.5,
          regime_tags: "low_volatility",
          signals: "rsi_oversold",
          notes: "Nice breakout entry",
        },
      ];

      const result = await summarizeLearnedRules(llm, journal);
      expect(result).toBe(mockRules);
    });
  });
});
