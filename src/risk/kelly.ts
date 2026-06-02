export interface KellyInput {
  win_rate: number;       // 0.0–1.0
  avg_win_pct: number;    // avg gain per winning trade (positive, e.g. 2.5 = 2.5%)
  avg_loss_pct: number;   // avg loss per losing trade (positive magnitude, e.g. 1.2 = 1.2%)
  fraction_cap: number;   // max fraction to bet (default 0.25 — quarter-Kelly safety)
}

export interface KellyResult {
  kelly_fraction: number;         // raw f* from formula
  recommended_pct_equity: number; // capped and scaled to percent (0–100)
  win_rate: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  odds_ratio: number;             // b = avg_win / avg_loss
  edge: number;                   // p*b - q (expected value per unit risked)
  is_positive_edge: boolean;
}

export function calculateKelly(input: KellyInput): KellyResult {
  const { win_rate, avg_win_pct, avg_loss_pct, fraction_cap } = input;
  const lose_rate = 1 - win_rate;

  // b = odds ratio (how much you win relative to what you risk)
  const b = avg_loss_pct > 0 ? avg_win_pct / avg_loss_pct : 0;
  const edge = win_rate * b - lose_rate;

  // f* = (p*b - q) / b
  let kelly_fraction = b > 0 ? edge / b : 0;

  // Negative Kelly means no edge — don't bet
  if (kelly_fraction < 0) kelly_fraction = 0;

  // Cap at fraction_cap to prevent overbetting (never full Kelly in live trading)
  const capped = Math.min(kelly_fraction, fraction_cap);

  return {
    kelly_fraction,
    recommended_pct_equity: Math.round(capped * 100 * 100) / 100, // as % of equity, 2dp
    win_rate,
    avg_win_pct,
    avg_loss_pct,
    odds_ratio: b,
    edge,
    is_positive_edge: edge > 0,
  };
}
