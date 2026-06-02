import type { ToolError } from "../lib/errors";

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ToolError;
}

export function success<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function failure(error: ToolError): ToolResult<never> {
  return { ok: false, error };
}

export interface PolicyViolation {
  rule: string;
  message: string;
  current_value: unknown;
  limit_value: unknown;
}

export interface PolicyWarning {
  rule: string;
  message: string;
}

export interface KellySuggestedSize {
  symbol: string;
  recommended_pct_equity: number;
  recommended_notional: number;
  historical_trades_analyzed: number;
  win_rate: number | null;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  skipped_due_to_no_history: boolean;
}

export interface PolicyResult {
  allowed: boolean;
  violations: PolicyViolation[];
  warnings: PolicyWarning[];
  approval_token?: string;
  approval_id?: string;
  expires_at?: string;
  kelly_suggested_size?: KellySuggestedSize;
}

export interface OrderPreview {
  symbol: string;
  side: "buy" | "sell";
  qty?: number;
  notional?: number;
  order_type: "market" | "limit" | "stop" | "stop_limit";
  limit_price?: number;
  stop_price?: number;
  time_in_force: "day" | "gtc" | "ioc" | "fok";
  estimated_price?: number;
  estimated_cost?: number;
  buying_power_impact?: number;
  // Multi-leg fields (present only for mleg orders)
  mleg_legs?: MlegLeg[];
  mleg_order_type?: "market" | "limit" | "debit" | "credit" | "even";
  mleg_limit_price?: number;
  mleg_strategy?: string;
}

export interface OptionsOrderPreview {
  contract_symbol: string;
  underlying: string;
  side: "buy" | "sell";
  qty: number;
  order_type: "market" | "limit";
  limit_price?: number;
  time_in_force: "day" | "gtc";
  expiration: string;
  strike: number;
  option_type: "call" | "put";
  dte: number;
  delta?: number;
  estimated_premium?: number;
  estimated_cost?: number;
  buying_power_impact?: number;
}

export interface OptionsPolicyResult {
  allowed: boolean;
  violations: PolicyViolation[];
  warnings: PolicyWarning[];
  approval_token?: string;
  approval_id?: string;
  expires_at?: string;
}

export interface MlegLeg {
  symbol: string;          // options contract symbol (e.g. AAPL250117C00200000)
  side: "buy" | "sell";
  ratio_qty: number;       // relative quantity (1 = 1x, 2 = 2x)
  position_intent: "buy_to_open" | "buy_to_close" | "sell_to_open" | "sell_to_close";
}

export interface OptionsMlegOrderPreview {
  strategy: string;        // e.g. "iron_condor", "bull_call_spread"
  underlying: string;
  legs: MlegLeg[];
  qty: number;             // number of spreads/contracts
  order_type: "market" | "limit" | "debit" | "credit" | "even";
  limit_price?: number;    // net debit (positive) or credit (negative)
  time_in_force: "day" | "gtc";
  estimated_cost?: number; // net debit × qty × 100 (positive = pay, negative = receive)
}

export type EventType =
  | "earnings_guidance_cut"
  | "earnings_beat"
  | "earnings_miss"
  | "merger"
  | "acquisition"
  | "lawsuit"
  | "sec_filing"
  | "insider_buy"
  | "insider_sell"
  | "analyst_upgrade"
  | "analyst_downgrade"
  | "product_launch"
  | "macro"
  | "rumor"
  | "social_momentum";

export interface StructuredEvent {
  id: string;
  type: EventType;
  symbols: string[];
  summary: string;
  confidence: number;
  source_ids: string[];
  timestamp: string;
  validated: boolean;
  validation_errors?: string[];
}

export type TradeOutcome = "win" | "loss" | "scratch";

export interface TradeJournalEntry {
  id: string;
  trade_id?: string;
  symbol: string;
  side: "buy" | "sell";
  entry_price?: number;
  entry_at?: string;
  exit_price?: number;
  exit_at?: string;
  qty: number;
  pnl_usd?: number;
  pnl_pct?: number;
  hold_duration_mins?: number;
  signals?: Record<string, unknown>;
  technicals?: Record<string, unknown>;
  regime_tags?: string[];
  event_ids?: string[];
  outcome?: TradeOutcome;
  notes?: string;
  lessons_learned?: string;
}
