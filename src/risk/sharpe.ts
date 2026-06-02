export interface SharpeInput {
  returns: number[];            // per-trade or daily returns in % (e.g. 1.5 = 1.5%)
  risk_free_annual_pct: number; // annualized risk-free rate in % (e.g. 5.0 = 5%)
  periods_per_year: number;     // 252 for daily, or use trade count estimate
}

export interface SharpeResult {
  sharpe_ratio: number;
  annualized_return_pct: number;
  annualized_vol_pct: number;
  mean_return_pct: number;
  std_return_pct: number;
  n_observations: number;
  is_statistically_meaningful: boolean; // n >= 30
}

export function calculateSharpe(input: SharpeInput): SharpeResult {
  const { returns, risk_free_annual_pct, periods_per_year } = input;
  const n = returns.length;

  if (n < 2) {
    return {
      sharpe_ratio: 0,
      annualized_return_pct: 0,
      annualized_vol_pct: 0,
      mean_return_pct: 0,
      std_return_pct: 0,
      n_observations: n,
      is_statistically_meaningful: false,
    };
  }

  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  const std = Math.sqrt(variance);

  const rf_per_period = risk_free_annual_pct / periods_per_year;
  const excess_return = mean - rf_per_period;

  const sharpe_ratio = std > 0 ? (excess_return / std) * Math.sqrt(periods_per_year) : 0;

  return {
    sharpe_ratio: Math.round(sharpe_ratio * 1000) / 1000,
    annualized_return_pct: Math.round(mean * periods_per_year * 100) / 100,
    annualized_vol_pct: Math.round(std * Math.sqrt(periods_per_year) * 100) / 100,
    mean_return_pct: Math.round(mean * 100) / 100,
    std_return_pct: Math.round(std * 100) / 100,
    n_observations: n,
    is_statistically_meaningful: n >= 30,
  };
}
