import { z } from "zod";
import type { PolicyViolation, PolicyWarning } from "../mcp/types";

export const TradeIntentSchema = z.object({
  symbol: z.string().min(1).max(10),
  side: z.enum(["buy", "sell"]),
  qty: z.number().positive().optional(),
  notional: z.number().positive().optional(),
  order_type: z.enum(["market", "limit", "stop", "stop_limit"]),
  limit_price: z.number().positive().optional(),
  stop_price: z.number().positive().optional(),
  time_in_force: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
  asset_class: z.enum(["equity", "option", "crypto"]).optional(),
  signal_confidence: z.number().min(0).max(1).optional(),
  options: z.object({
    contract_symbol: z.string().min(1),
    underlying: z.string().min(1),
    expiration: z.string(),
    strike: z.number().positive(),
    option_type: z.enum(["call", "put"]),
    dte: z.number().int().nonnegative(),
    delta: z.number().optional(),
  }).optional(),
}).refine(data => data.qty !== undefined || data.notional !== undefined, {
  message: "Either qty or notional must be provided",
  path: ["qty"],
});

export type TradeIntent = z.infer<typeof TradeIntentSchema>;

export interface ApprovedOrderIntent {
  id: string; // generated approval_id
  intent: TradeIntent;
  approval_token: string;
  expires_at: string;
  estimated_price: number;
  estimated_cost: number;
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

export interface PolicyDecision {
  allowed: boolean;
  violations: PolicyViolation[];
  warnings: PolicyWarning[];
  approvedIntent?: ApprovedOrderIntent;
  kelly_suggested_size?: KellySuggestedSize;
}
