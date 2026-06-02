export type SignalDirection = "long" | "short" | "neutral";
export type SignalUrgency = "immediate" | "session" | "swing";
export type SignalSource =
  | "llm"
  | "technical"
  | "l2_microstructure"
  | "dark_pool"
  | "external"
  | "manual";
export type SignalAssetClass = "equity" | "option" | "future";
export type SignalStatus = "pending" | "aggregated" | "expired" | "rejected";

export interface AlphaSignal {
  signal_id: string;
  source: SignalSource;
  generated_at: string;
  ttl_seconds: number;

  symbol: string;
  asset_class: SignalAssetClass;
  direction: SignalDirection;
  confidence: number;        // 0.0 → 1.0
  urgency: SignalUrgency;
  horizon: number;           // expected hold in minutes

  suggested_notional?: number;
  suggested_pct_equity?: number;

  rationale: string;
  regime_tags: string[];
  supporting_data: Record<string, unknown>;
}

export interface AggregatedSignal {
  aggregated_id: string;
  symbol: string;
  final_direction: SignalDirection;
  final_confidence: number;
  source_count: number;
  conflict_detected: boolean;
  contributing_signals: AlphaSignal[];
  created_at: string;
}

// Default confidence weights per source. Higher = more trusted.
// External source weight is a default — override per counterparty in KV/D1.
export const SOURCE_WEIGHTS: Record<SignalSource, number> = {
  dark_pool:        0.90,
  l2_microstructure: 0.80,
  external:         0.70,
  technical:        0.60,
  llm:              0.40,
  manual:           0.95,  // human override, always high but capped at 0.95 in aggregator
};

// TTL defaults per urgency class (seconds)
export const DEFAULT_TTL: Record<SignalUrgency, number> = {
  immediate: 60,
  session:   3600,
  swing:     86400,
};
