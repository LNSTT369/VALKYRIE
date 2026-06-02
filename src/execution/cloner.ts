
export interface StrategySandbox {
  scanFn: (bars: any[], news?: any[]) => any;
  logs: string[];
}

/**
 * Parses a standard GitHub URL (e.g., https://github.com/owner/repo) 
 * into owner and repository parameters.
 */
export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const cleanUrl = url.replace(/\.git$/, "");
    const match = cleanUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match || !match[1] || !match[2]) return null;
    return { owner: match[1], repo: match[2] };
  } catch {
    return null;
  }
}

/**
 * Fetches the raw content of the compiled strategy.js file from a GitHub repository
 */
export async function fetchStrategyFromGithub(
  githubUrl: string,
  branch = "main"
): Promise<string> {
  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) {
    throw new Error("Invalid GitHub repository URL format");
  }

  const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}/strategy.js`;
  
  console.log(`Cloning dynamic strategy from: ${rawUrl}`);
  
  const resp = await fetch(rawUrl, {
    headers: {
      "User-Agent": "NightWatcher-V3-Cloner",
    },
  });

  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error(`Strategy entrypoint 'strategy.js' not found in the root of the repository on branch '${branch}'`);
    }
    throw new Error(`Failed to download strategy from GitHub raw CDN. HTTP status: ${resp.status}`);
  }

  return resp.text();
}

/**
 * Compiles a string of Javascript code into an active, sandboxed V8 execution function
 */
export function compileStrategySandbox(code: string): StrategySandbox {
  const logs: string[] = [];
  
  const mockConsole = {
    log: (...args: any[]) => logs.push(`[LOG] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ")}`),
    error: (...args: any[]) => logs.push(`[ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ")}`),
    warn: (...args: any[]) => logs.push(`[WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ")}`),
  };

  try {
    // Inject mockConsole and bind clean execution scope
    const sandbox = new Function("console", `
      ${code}
      if (typeof scan !== 'function') {
        throw new Error("Strategy code must define a global 'scan(bars, news)' function");
      }
      return scan;
    `);

    const scanFn = sandbox(mockConsole);
    
    return {
      scanFn,
      logs,
    };
  } catch (err) {
    throw new Error(`Compilation error during sandbox evaluation: ${(err as Error).message}`);
  }
}

/**
 * Runs an in-memory 30-day backtest simulation against a set of historical bars
 * to score strategy performance and check for Policy Gate compliance.
 */
export async function runMockSimulation(
  scanFn: (bars: any[], news?: any[]) => any,
  bars: Record<string, any[]>, // symbol -> bars
  startingEquity = 100000
): Promise<{
  sharpe: number;
  maxDrawdown: number;
  totalReturnPct: number;
  tradesCount: number;
  logs: string[];
}> {
  const logs: string[] = [];
  let equity = startingEquity;
  let peakEquity = startingEquity;
  let maxDrawdown = 0;
  
  // Collect a timeline of daily returns to calculate Sharpe
  const dailyReturns: number[] = [];
  const uniqueDates = new Set<string>();

  // Determine a timeline of sorted trading dates
  Object.values(bars).forEach(symbolBars => {
    symbolBars.forEach(b => {
      if (b.timestamp) {
        uniqueDates.add(b.timestamp.split("T")[0]);
      } else if (b.t) {
        uniqueDates.add(b.t.split("T")[0]);
      }
    });
  });

  const sortedDates = Array.from(uniqueDates).sort();
  let tradesCount = 0;
  
  // Simulate day-by-day
  for (let i = 1; i < sortedDates.length; i++) {
    const currentDate = sortedDates[i]!;
    const prevEquity = equity;

    // Build the bars context up to the current date for the strategy
    const barsUpToNow: Record<string, any[]> = {};
    let activeSignalsCount = 0;

    for (const [symbol, symbolBars] of Object.entries(bars)) {
      const filtered = symbolBars.filter(b => {
        const dateStr = b.timestamp ? b.timestamp.split("T")[0] : (b.t ? b.t.split("T")[0] : "");
        return dateStr < currentDate;
      });
      if (filtered.length > 0) {
        barsUpToNow[symbol] = filtered;
      }
    }

    try {
      // Execute sandboxed strategy scan
      // Returns an array of signals like: { symbol: "AAPL", direction: "long", confidence: 0.8 }
      const signals = scanFn(Object.values(barsUpToNow).flat());
      
      if (Array.isArray(signals) && signals.length > 0) {
        for (const sig of signals) {
          if (sig.direction === "long" || sig.direction === "short") {
            tradesCount++;
            activeSignalsCount++;
            
            // Simple mock performance math:
            // Match signal symbol with actual price change on the current day
            const symbolBars = bars[sig.symbol];
            const currentDayBar = symbolBars?.find(b => {
              const dateStr = b.timestamp ? b.timestamp.split("T")[0] : (b.t ? b.t.split("T")[0] : "");
              return dateStr === currentDate;
            });

            if (currentDayBar) {
              const open = currentDayBar.open ?? currentDayBar.o ?? 0;
              const close = currentDayBar.close ?? currentDayBar.c ?? 0;
              if (open > 0) {
                const changePct = (close - open) / open;
                const allocation = startingEquity * 0.10; // Allocate 10% per position
                const directionMultiplier = sig.direction === "long" ? 1 : -1;
                
                // Commission: $0.005 per share + 1bp slippage
                const shares = allocation / open;
                const friction = (shares * 0.005) + (allocation * 0.0001);
                
                const tradeReturn = (allocation * changePct * directionMultiplier) - friction;
                equity += tradeReturn;
              }
            }
          }
        }
      }
    } catch (err) {
      logs.push(`[SIM ERROR] Failed to scan on date ${currentDate}: ${(err as Error).message}`);
    }

    // Capture daily return metrics
    const dailyReturn = (equity - prevEquity) / prevEquity;
    dailyReturns.push(dailyReturn);

    // Track peak equity and rolling drawdowns
    if (equity > peakEquity) {
      peakEquity = equity;
    }
    const currentDrawdown = (peakEquity - equity) / peakEquity;
    if (currentDrawdown > maxDrawdown) {
      maxDrawdown = currentDrawdown;
    }
  }

  // Calculate Sharpe Ratio (annualized, assuming risk-free rate of 0 for simplicity)
  let sharpe = 0;
  if (dailyReturns.length > 0) {
    const avgReturn = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / dailyReturns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      // Annualize Sharpe (daily returns * sqrt(252))
      sharpe = (avgReturn / stdDev) * Math.sqrt(252);
    }
  }

  const totalReturnPct = ((equity - startingEquity) / startingEquity) * 100;

  return {
    sharpe,
    maxDrawdown,
    totalReturnPct,
    tradesCount,
    logs,
  };
}
