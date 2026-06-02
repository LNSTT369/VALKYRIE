import type { D1Client } from "../client";
import { generateId } from "../../../lib/utils";

export interface ExecutionFillInput {
  trade_id?: string;
  alpaca_order_id?: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  fill_price?: number;
  expected_price?: number;
  vwap_at_fill?: number;
  fill_latency_ms?: number;
  partial_fill_pct?: number;
  venue?: string;
  algo_type?: string;
  dark_pool_pct?: number;
  signal_id?: string;
  aggregated_signal_id?: string;
}

export interface ExecutionFill extends ExecutionFillInput {
  id: string;
  slippage_bps?: number;
  created_at: string;
}

function calcSlippageBps(fill?: number, expected?: number): number | null {
  if (!fill || !expected || expected === 0) return null;
  return ((fill - expected) / expected) * 10000;
}

export async function recordExecutionFill(
  db: D1Client,
  fill: ExecutionFillInput
): Promise<string> {
  const id = generateId();
  const slippage = calcSlippageBps(fill.fill_price, fill.expected_price);

  await db.run(
    `INSERT INTO execution_fills
       (id, trade_id, alpaca_order_id, symbol, side, qty, fill_price,
        expected_price, vwap_at_fill, slippage_bps, fill_latency_ms,
        partial_fill_pct, venue, algo_type, dark_pool_pct,
        signal_id, aggregated_signal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fill.trade_id ?? null,
      fill.alpaca_order_id ?? null,
      fill.symbol.toUpperCase(),
      fill.side,
      fill.qty,
      fill.fill_price ?? null,
      fill.expected_price ?? null,
      fill.vwap_at_fill ?? null,
      slippage,
      fill.fill_latency_ms ?? null,
      fill.partial_fill_pct ?? 100,
      fill.venue ?? "alpaca",
      fill.algo_type ?? "market",
      fill.dark_pool_pct ?? 0,
      fill.signal_id ?? null,
      fill.aggregated_signal_id ?? null,
    ]
  );

  return id;
}

export async function getExecutionReport(
  db: D1Client,
  opts: { days?: number; symbol?: string } = {}
): Promise<{
  total_orders: number;
  avg_slippage_bps: number | null;
  avg_fill_latency_ms: number | null;
  avg_partial_fill_pct: number;
  dark_pool_pct: number;
  by_venue: Array<{ venue: string; count: number; avg_slippage_bps: number | null }>;
}> {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400 * 1000).toISOString();
  const symbolClause = opts.symbol ? "AND symbol = ?" : "";
  const baseParams: unknown[] = opts.symbol
    ? [since, opts.symbol.toUpperCase()]
    : [since];

  const [summary] = await db.execute<{
    total_orders: number;
    avg_slippage_bps: number | null;
    avg_fill_latency_ms: number | null;
    avg_partial_fill_pct: number;
    avg_dark_pool_pct: number;
  }>(
    `SELECT
       COUNT(*) as total_orders,
       AVG(slippage_bps) as avg_slippage_bps,
       AVG(fill_latency_ms) as avg_fill_latency_ms,
       AVG(partial_fill_pct) as avg_partial_fill_pct,
       AVG(dark_pool_pct) as avg_dark_pool_pct
     FROM execution_fills
     WHERE created_at >= ? ${symbolClause}`,
    baseParams
  );

  const byVenue = await db.execute<{
    venue: string;
    count: number;
    avg_slippage_bps: number | null;
  }>(
    `SELECT venue, COUNT(*) as count, AVG(slippage_bps) as avg_slippage_bps
     FROM execution_fills
     WHERE created_at >= ? ${symbolClause}
     GROUP BY venue ORDER BY count DESC`,
    baseParams
  );

  return {
    total_orders: summary?.total_orders ?? 0,
    avg_slippage_bps: summary?.avg_slippage_bps ?? null,
    avg_fill_latency_ms: summary?.avg_fill_latency_ms ?? null,
    avg_partial_fill_pct: summary?.avg_partial_fill_pct ?? 100,
    dark_pool_pct: summary?.avg_dark_pool_pct ?? 0,
    by_venue: byVenue,
  };
}
