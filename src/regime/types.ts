export type MarketRegime =
  | "trending_bull"
  | "trending_bear"
  | "range_bound"
  | "high_volatility"
  | "low_volatility"
  | "crisis";

export interface RegimeState {
  regime: MarketRegime;
  confidence: number;       // 0.0 → 1.0
  detected_at: string;      // ISO timestamp
  expires_at: string;       // ISO — regime is stale after this

  // Raw inputs used for classification (for auditability)
  spy_return_20d: number | null;   // % return over 20 trading days
  adx: number | null;              // Average Directional Index (trend strength)
  atr_pct: number | null;          // ATR as % of price (volatility proxy)
  realized_vol_20d: number | null; // Rolling 20-day annualized realized vol

  // Regime-level risk overrides applied to signal aggregation
  confidence_threshold_override: number | null;  // min confidence to act on signals
  position_size_multiplier: number;              // 1.0 = normal, 0.5 = half size
  signal_ttl_override_seconds: number | null;    // null = use signal's own TTL
}

// Regime-level parameters applied to order sizing and signal routing
export const REGIME_PARAMS: Record<MarketRegime, {
  confidence_threshold: number;
  position_size_multiplier: number;
  signal_ttl_override_seconds: number | null;
}> = {
  trending_bull:   { confidence_threshold: 0.55, position_size_multiplier: 1.0,  signal_ttl_override_seconds: null },
  trending_bear:   { confidence_threshold: 0.60, position_size_multiplier: 0.75, signal_ttl_override_seconds: null },
  range_bound:     { confidence_threshold: 0.65, position_size_multiplier: 0.50, signal_ttl_override_seconds: null },
  high_volatility: { confidence_threshold: 0.70, position_size_multiplier: 0.60, signal_ttl_override_seconds: 120  },
  low_volatility:  { confidence_threshold: 0.50, position_size_multiplier: 1.0,  signal_ttl_override_seconds: null },
  crisis:          { confidence_threshold: 0.85, position_size_multiplier: 0.25, signal_ttl_override_seconds: 30   },
};
