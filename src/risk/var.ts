export interface VaRInput {
  returns_pct: number[];    // historical per-trade returns in % (e.g. -1.5 = -1.5%)
  portfolio_value: number;  // current portfolio equity in USD
  confidence: number;       // 0.95 or 0.99
}

export interface VaRResult {
  var_usd: number;              // Value at Risk in USD (positive = money at risk)
  var_pct: number;              // VaR as % of portfolio
  cvar_usd: number;             // Conditional VaR (expected shortfall beyond VaR threshold)
  cvar_pct: number;
  confidence: number;
  cutoff_return_pct: number;    // the return at the VaR percentile
  n_observations: number;
  is_statistically_meaningful: boolean;
}

export function calculateVaR(input: VaRInput): VaRResult {
  const { returns_pct, portfolio_value, confidence } = input;
  const n = returns_pct.length;

  if (n < 10) {
    return {
      var_usd: 0,
      var_pct: 0,
      cvar_usd: 0,
      cvar_pct: 0,
      confidence,
      cutoff_return_pct: 0,
      n_observations: n,
      is_statistically_meaningful: false,
    };
  }

  const sorted = [...returns_pct].sort((a, b) => a - b);

  // VaR: loss at the (1-confidence) percentile of the return distribution
  const cutoffIndex = Math.floor((1 - confidence) * n);
  const cutoff_return_pct = sorted[cutoffIndex] ?? sorted[0]!;

  const var_pct = Math.abs(Math.min(cutoff_return_pct, 0));
  const var_usd = var_pct / 100 * portfolio_value;

  // CVaR (Expected Shortfall): mean of losses beyond the VaR threshold
  const tail = sorted.slice(0, cutoffIndex + 1).filter((r) => r < 0);
  const cvar_pct =
    tail.length > 0
      ? Math.abs(tail.reduce((a, b) => a + b, 0) / tail.length)
      : var_pct;
  const cvar_usd = cvar_pct / 100 * portfolio_value;

  return {
    var_usd: Math.round(var_usd * 100) / 100,
    var_pct: Math.round(var_pct * 10000) / 10000,
    cvar_usd: Math.round(cvar_usd * 100) / 100,
    cvar_pct: Math.round(cvar_pct * 10000) / 10000,
    confidence,
    cutoff_return_pct: Math.round(cutoff_return_pct * 10000) / 10000,
    n_observations: n,
    is_statistically_meaningful: n >= 30,
  };
}
