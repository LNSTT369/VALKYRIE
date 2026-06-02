import type { D1Client } from "../storage/d1/client";
import type { AlpacaProviders } from "../providers/alpaca";

export interface FactorExposure {
  betaMkt: number;
  betaSmb: number;
  betaHml: number;
}

/**
 * Calculates rolling Fama-French factor loadings (Market Beta, SMB, HML)
 * using daily return series via multi-variable linear regression.
 */
export function calculateFactorLoadings(
  assetReturns: number[],
  mktReturns: number[],
  smbReturns: number[],
  hmlReturns: number[]
): FactorExposure {
  const n = assetReturns.length;
  if (n < 5 || n !== mktReturns.length || n !== smbReturns.length || n !== hmlReturns.length) {
    // Fallback default exposures if return data is insufficient
    return { betaMkt: 1.0, betaSmb: 0.0, betaHml: 0.0 };
  }

  // Helper to compute covariance
  const cov = (x: number[], y: number[]) => {
    const meanX = x.reduce((s, v) => s + v, 0) / x.length;
    const meanY = y.reduce((s, v) => s + v, 0) / y.length;
    return x.reduce((s, v, i) => s + (v - meanX) * (y[i]! - meanY), 0) / (x.length - 1);
  };

  // Helper to compute variance
  const varFn = (x: number[]) => {
    const mean = x.reduce((s, v) => s + v, 0) / x.length;
    return x.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (x.length - 1);
  };

  const varMkt = varFn(mktReturns);
  if (varMkt === 0) return { betaMkt: 1.0, betaSmb: 0.0, betaHml: 0.0 };

  // Calculate Market Beta (covariance of asset with market divided by market variance)
  const betaMkt = cov(assetReturns, mktReturns) / varMkt;

  // Estimate SMB loading (Size Tilt) by comparing correlation to the small cap factor
  const varSmb = varFn(smbReturns);
  const betaSmb = varSmb > 0 ? cov(assetReturns, smbReturns) / varSmb : 0;

  // Estimate HML loading (Value/Growth Tilt)
  const varHml = varFn(hmlReturns);
  const betaHml = varHml > 0 ? cov(assetReturns, hmlReturns) / varHml : 0;

  return {
    betaMkt: isNaN(betaMkt) ? 1.0 : betaMkt,
    betaSmb: isNaN(betaSmb) ? 0.0 : betaSmb,
    betaHml: isNaN(betaHml) ? 0.0 : betaHml,
  };
}

/**
 * Runs a daily factor analysis cron job. Downloads daily history for the active watchlist,
 * estimates Fama-French factors, and updates the factor_loadings table.
 */
export async function updateWatchlistFactorLoadings(
  db: D1Client,
  alpaca: AlpacaProviders,
  watchlist: string[]
): Promise<void> {
  if (watchlist.length === 0) return;

  console.log(`Calculating Fama-French loadings for watchlist: ${watchlist.join(", ")}`);

  // Pull past 45 calendar days of daily bars for the watchlist + factor proxy ETFs:
  // - SPY: Market Beta proxy
  // - IWM: Small-Cap proxy (for SMB)
  // - IVE: S&P 500 Value (for HML)
  // - IVW: S&P 500 Growth (for HML)
  const factorsWatchlist = ["SPY", "IWM", "IVE", "IVW"];
  const allSymbols = Array.from(new Set([...watchlist, ...factorsWatchlist]));

  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 45);
  const startStr = d.toISOString().split("T")[0];

  const barsMap = await alpaca.marketData.getMultiBars(allSymbols, "1Day", {
    start: startStr,
    limit: 30,
  });

  // Extract return series
  const getReturns = (symbol: string): number[] => {
    const bars = barsMap[symbol] ?? [];
    const returns: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const prevClose = (bars[i-1]! as any).c ?? (bars[i-1]! as any).close ?? 0;
      const currentClose = (bars[i]! as any).c ?? (bars[i]! as any).close ?? 0;
      if (prevClose > 0) {
        returns.push((currentClose - prevClose) / prevClose);
      }
    }
    return returns;
  };

  const mktReturns = getReturns("SPY");
  const iwmReturns = getReturns("IWM");
  const iveReturns = getReturns("IVE");
  const ivwReturns = getReturns("IVW");

  // Construct SMB returns = IWM returns - SPY returns (Small cap minus Big cap)
  const smbReturns = iwmReturns.map((r, idx) => r - (mktReturns[idx] ?? 0));
  // Construct HML returns = IVE returns - IVW returns (Value minus Growth)
  const hmlReturns = iveReturns.map((r, idx) => r - (ivwReturns[idx] ?? 0));

  const updatedTime = new Date().toISOString();

  // Run rolling regressions and update D1
  for (const symbol of watchlist) {
    if (factorsWatchlist.includes(symbol)) continue;

    const assetReturns = getReturns(symbol);
    const exposure = calculateFactorLoadings(assetReturns, mktReturns, smbReturns, hmlReturns);

    console.log(`Fama-French [${symbol}] -> Beta Market: ${exposure.betaMkt.toFixed(2)}, SMB: ${exposure.betaSmb.toFixed(2)}, HML: ${exposure.betaHml.toFixed(2)}`);

    await db.run(
      `INSERT INTO factor_loadings (symbol, beta_mkt, beta_smb, beta_hml, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET 
         beta_mkt = excluded.beta_mkt,
         beta_smb = excluded.beta_smb,
         beta_hml = excluded.beta_hml,
         updated_at = excluded.updated_at`,
      [
        symbol.toUpperCase(),
        exposure.betaMkt,
        exposure.betaSmb,
        exposure.betaHml,
        updatedTime
      ]
    );
  }

  console.log("Fama-French factor loadings update successfully complete.");
}

/**
 * Retrieves rolling Fama-French factor loadings for a list of symbols from D1.
 */
export async function getFactorLoadings(
  db: D1Client,
  symbols: string[]
): Promise<Record<string, FactorExposure>> {
  if (symbols.length === 0) return {};

  const placeholders = symbols.map(() => "?").join(", ");
  const query = `SELECT symbol, beta_mkt, beta_smb, beta_hml FROM factor_loadings WHERE symbol IN (${placeholders})`;
  
  try {
    const rows = await db.execute<{ symbol: string; beta_mkt: number; beta_smb: number; beta_hml: number }>(
      query,
      symbols.map(s => s.toUpperCase())
    );

    const map: Record<string, FactorExposure> = {};
    for (const row of rows) {
      map[row.symbol.toUpperCase()] = {
        betaMkt: row.beta_mkt,
        betaSmb: row.beta_smb,
        betaHml: row.beta_hml,
      };
    }
    return map;
  } catch (error) {
    console.error("Failed to query factor loadings from D1:", error);
    return {};
  }
}

