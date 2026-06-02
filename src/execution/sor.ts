// Smart Order Router (SOR) — venue and algo selection.
// Phase 4 stub: always routes to Alpaca. Institutional venue wired in when Richard's firm
// API credentials + REST spec arrive (Phase 1 dependency). Decision logic is complete;
// only the venue assignment changes when institutional is live.

export type Venue = "alpaca" | "institutional";
export type AlgoType = "market" | "limit";

export interface SorInput {
  symbol: string;
  side: "buy" | "sell";
  total_qty: number;
  notional_usd: number;
  urgency: "immediate" | "session" | "swing";
  signal_source?: "llm" | "technical" | "l2_microstructure" | "dark_pool" | "external" | "manual";
  signal_confidence?: number; // 0–1
}

export interface SorDecision {
  venue: Venue;
  algo: AlgoType;
  rationale: string;
  dark_pool_eligible: boolean;
  // True when institutional routing would be preferred but isn't connected yet.
  requires_institutional: boolean;
  routing_notes: string[];
  // Suggested params for the chosen algo
  suggested_duration_minutes?: number;
  suggested_interval_minutes?: number;
}

// Thresholds for routing decisions
const DARK_POOL_THRESHOLD_USD = 25_000;  // orders above this qualify for dark pool routing
const BLOCK_ORDER_THRESHOLD_USD = 100_000; // block orders — strongly prefer institutional when live

export function routeOrder(input: SorInput): SorDecision {
  const notes: string[] = [];
  const isDarkPoolEligible = input.notional_usd >= DARK_POOL_THRESHOLD_USD;
  const isBlockOrder = input.notional_usd >= BLOCK_ORDER_THRESHOLD_USD;

  if (isBlockOrder) {
    notes.push(`Block order (≥$${(BLOCK_ORDER_THRESHOLD_USD / 1000).toFixed(0)}k) — institutional dark pool preferred when connected`);
  } else if (isDarkPoolEligible) {
    notes.push(`Large order (≥$${(DARK_POOL_THRESHOLD_USD / 1000).toFixed(0)}k) — qualifies for dark pool routing`);
  }

  // Dark pool signal from upstream (Richard's firm L2/dark pool feed)
  if (input.signal_source === "dark_pool") {
    notes.push("Dark pool signal source — routing for minimal market footprint");
  }

  // Immediate urgency: speed > cost, always market order
  if (input.urgency === "immediate") {
    notes.push("Immediate urgency — no slicing, market order for fastest fill");
    return {
      venue: "alpaca",
      algo: "market",
      rationale: "Immediate urgency: speed prioritized over market impact cost",
      dark_pool_eligible: isDarkPoolEligible,
      requires_institutional: false,
      routing_notes: notes,
    };
  }

  // Large notional + session/swing → Limit order with notes
  if (isDarkPoolEligible) {
    notes.push(`Large order (≥$${(DARK_POOL_THRESHOLD_USD / 1000).toFixed(0)}k) — limit order recommended to prevent market impact`);
    notes.push(`Advanced VWAP/TWAP order slicing is deferred to the institutional execution venue layer when live`);
    if (isBlockOrder) {
      notes.push("Institutional dark pool would reduce cost further — connect when API is live");
    }
    return {
      venue: "alpaca",
      algo: "limit",
      rationale: isBlockOrder
        ? "Block order: Limit order via Alpaca to avoid slippage (institutional dark pool preferred when available)"
        : "Large position: Limit order recommended. Execution slicing deferred to venue layer to minimize information leakage",
      dark_pool_eligible: isDarkPoolEligible,
      requires_institutional: isBlockOrder,
      routing_notes: notes,
    };
  }

  // Swing urgency + smaller size → Limit order with notes
  if (input.urgency === "swing") {
    notes.push("Swing trade: Limit order recommended for price protection during entry");
    notes.push("Advanced execution scheduling (e.g., TWAP) deferred to venue layer");
    return {
      venue: "alpaca",
      algo: "limit",
      rationale: "Swing trade: Limit order recommended for predictable execution boundaries",
      dark_pool_eligible: false,
      requires_institutional: false,
      routing_notes: notes,
    };
  }

  // Default: standard market order
  notes.push("Standard size and urgency — no slicing needed");
  return {
    venue: "alpaca",
    algo: "market",
    rationale: "Standard order: size and urgency do not require algorithmic execution",
    dark_pool_eligible: false,
    requires_institutional: false,
    routing_notes: notes,
  };
}
