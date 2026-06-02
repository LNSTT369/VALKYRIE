import { describe, it, expect } from "vitest";
import { parseGithubUrl, compileStrategySandbox, runMockSimulation } from "./cloner";

describe("Dynamic Strategy Sandbox & Cloner", () => {
  
  it("should correctly parse GitHub URLs", () => {
    // Case 1: Standard URL
    let res = parseGithubUrl("https://github.com/QuantCodeAutomata/qca-systematic-literature-review-reproduction--paper-c");
    expect(res).toEqual({
      owner: "QuantCodeAutomata",
      repo: "qca-systematic-literature-review-reproduction--paper-c",
    });

    // Case 2: URL ending in .git
    res = parseGithubUrl("https://github.com/QuantCodeAutomata/paper-c.git");
    expect(res).toEqual({
      owner: "QuantCodeAutomata",
      repo: "paper-c",
    });

    // Case 3: Invalid format
    res = parseGithubUrl("https://invalid-url.com/something");
    expect(res).toBeNull();
  });

  it("should compile valid JavaScript code and capture console logs in the sandbox", () => {
    const strategyCode = `
      function scan(bars, news) {
        console.log("Analyzing " + bars.length + " bars");
        return [
          { symbol: "AAPL", direction: "long" }
        ];
      }
    `;

    const sandbox = compileStrategySandbox(strategyCode);
    expect(sandbox.scanFn).toBeTypeOf("function");
    
    // Execute function
    const mockBars = [
      { symbol: "AAPL", close: 150 },
      { symbol: "TSLA", close: 200 }
    ];
    const signals = sandbox.scanFn(mockBars);
    
    expect(signals).toEqual([{ symbol: "AAPL", direction: "long" }]);
    expect(sandbox.logs).toContain("[LOG] Analyzing 2 bars");
  });

  it("should reject compiling code that does not define a scan function", () => {
    const invalidCode = `
      function wrongName() {}
    `;
    expect(() => compileStrategySandbox(invalidCode)).toThrowError(
      "Strategy code must define a global 'scan(bars, news)' function"
    );
  });

  it("should execute a mock simulation, apply fees, and compute Sharpe/Drawdown metric results", async () => {
    const strategyCode = `
      function scan(bars) {
        // Find if AAPL bar close goes up, buy, else neutral
        return [
          { symbol: "AAPL", direction: "long" }
        ];
      }
    `;
    const sandbox = compileStrategySandbox(strategyCode);

    // Mock 5-day daily bars for AAPL. Each day is 1% up.
    const mockBars = {
      AAPL: [
        { t: "2026-01-01T00:00:00Z", open: 100, close: 101, timestamp: "2026-01-01T00:00:00Z" },
        { t: "2026-01-02T00:00:00Z", open: 101, close: 102, timestamp: "2026-01-02T00:00:00Z" },
        { t: "2026-01-03T00:00:00Z", open: 102, close: 103, timestamp: "2026-01-03T00:00:00Z" },
        { t: "2026-01-04T00:00:00Z", open: 103, close: 104, timestamp: "2026-01-04T00:00:00Z" },
        { t: "2026-01-05T00:00:00Z", open: 104, close: 105, timestamp: "2026-01-05T00:00:00Z" },
      ]
    };

    const sim = await runMockSimulation(sandbox.scanFn, mockBars, 100000);
    
    expect(sim.tradesCount).toBe(4); // Day 2, 3, 4, 5
    expect(sim.totalReturnPct).toBeGreaterThan(0);
    expect(sim.maxDrawdown).toBe(0); // Perfect upward returns, no drawdown
    expect(sim.sharpe).toBeGreaterThan(0);
  });

});
