import type { D1Client } from "../client";
import { generateId } from "../../../lib/utils";
import type { KellyResult } from "../../../risk/kelly";
import type { SharpeResult } from "../../../risk/sharpe";
import type { VaRResult } from "../../../risk/var";
import type { CorrelationResult } from "../../../risk/correlation";

type SnapshotType = "kelly" | "sharpe" | "var" | "correlation";

// ── Trade journal helpers ────────────────────────────────────────────────────

export async function getJournalReturns(
  db: D1Client,
  symbol?: string,
  limit: number = 200
): Promise<number[]> {
  const rows = await db.execute<{ pnl_pct: number | null }>(
    `SELECT pnl_pct FROM trade_journal
     WHERE pnl_pct IS NOT NULL
     ${symbol ? "AND symbol = ?" : ""}
     ORDER BY created_at DESC LIMIT ?`,
    symbol ? [symbol, limit] : [limit]
  );
  // Return in chronological order (oldest first) for time-series stats
  return rows.map((r) => r.pnl_pct!).reverse();
}

export async function getKellyInputs(
  db: D1Client,
  symbol?: string,
  limit: number = 200
): Promise<{ win_rate: number; avg_win_pct: number; avg_loss_pct: number; n: number } | null> {
  const rows = await db.execute<{ pnl_pct: number | null; outcome: string | null }>(
    `SELECT pnl_pct, outcome FROM trade_journal
     WHERE pnl_pct IS NOT NULL
     ${symbol ? "AND symbol = ?" : ""}
     ORDER BY created_at DESC LIMIT ?`,
    symbol ? [symbol, limit] : [limit]
  );

  if (rows.length < 5) return null;

  const wins = rows.filter((r) => (r.pnl_pct ?? 0) > 0);
  const losses = rows.filter((r) => (r.pnl_pct ?? 0) < 0);

  if (wins.length === 0 || losses.length === 0) return null;

  const win_rate = wins.length / rows.length;
  const avg_win_pct = wins.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / wins.length;
  const avg_loss_pct = Math.abs(losses.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / losses.length);

  return { win_rate, avg_win_pct, avg_loss_pct, n: rows.length };
}

// ── Persist snapshots ────────────────────────────────────────────────────────

export async function insertKellySnapshot(
  db: D1Client,
  result: KellyResult,
  symbol?: string
): Promise<string> {
  const id = generateId();
  await db.run(
    `INSERT INTO risk_metric_snapshots
       (id, snapshot_type, symbol, kelly_fraction, recommended_pct_equity,
        win_rate, avg_win_pct, avg_loss_pct, odds_ratio, edge, raw_json)
     VALUES (?, 'kelly', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, symbol ?? null, result.kelly_fraction, result.recommended_pct_equity,
     result.win_rate, result.avg_win_pct, result.avg_loss_pct, result.odds_ratio,
     result.edge, JSON.stringify(result)]
  );
  return id;
}

export async function insertSharpeSnapshot(
  db: D1Client,
  result: SharpeResult,
  symbol?: string
): Promise<string> {
  const id = generateId();
  await db.run(
    `INSERT INTO risk_metric_snapshots
       (id, snapshot_type, symbol, sharpe_ratio, annualized_return_pct,
        annualized_vol_pct, n_observations, raw_json)
     VALUES (?, 'sharpe', ?, ?, ?, ?, ?, ?)`,
    [id, symbol ?? null, result.sharpe_ratio, result.annualized_return_pct,
     result.annualized_vol_pct, result.n_observations, JSON.stringify(result)]
  );
  return id;
}

export async function insertVaRSnapshot(
  db: D1Client,
  result: VaRResult,
  symbol?: string
): Promise<string> {
  const id = generateId();
  await db.run(
    `INSERT INTO risk_metric_snapshots
       (id, snapshot_type, symbol, var_usd, var_pct, cvar_usd, cvar_pct,
        confidence, n_observations, raw_json)
     VALUES (?, 'var', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, symbol ?? null, result.var_usd, result.var_pct, result.cvar_usd,
     result.cvar_pct, result.confidence, result.n_observations, JSON.stringify(result)]
  );
  return id;
}

export async function insertCorrelationSnapshot(
  db: D1Client,
  result: CorrelationResult
): Promise<string> {
  const id = generateId();
  await db.run(
    `INSERT INTO risk_metric_snapshots
       (id, snapshot_type, symbol, symbol_b, pearson_r, is_over_threshold,
        n_observations, raw_json)
     VALUES (?, 'correlation', ?, ?, ?, ?, ?, ?)`,
    [id, result.symbol_a, result.symbol_b, result.pearson_r,
     result.is_over_threshold ? 1 : 0, result.n_observations, JSON.stringify(result)]
  );
  return id;
}

// ── Retrieve snapshots ───────────────────────────────────────────────────────

export async function getLatestRiskMetric(
  db: D1Client,
  type: SnapshotType,
  symbol?: string
): Promise<{ raw_json: string; computed_at: string } | null> {
  return db.executeOne<{ raw_json: string; computed_at: string }>(
    `SELECT raw_json, computed_at FROM risk_metric_snapshots
     WHERE snapshot_type = ?
     ${symbol ? "AND symbol = ?" : ""}
     ORDER BY computed_at DESC LIMIT 1`,
    symbol ? [type, symbol] : [type]
  );
}

export async function listRiskMetricHistory(
  db: D1Client,
  type: SnapshotType,
  symbol?: string,
  limit: number = 20
): Promise<Array<{ id: string; snapshot_type: string; symbol: string | null; computed_at: string; raw_json: string }>> {
  return db.execute(
    `SELECT id, snapshot_type, symbol, computed_at, raw_json
     FROM risk_metric_snapshots
     WHERE snapshot_type = ?
     ${symbol ? "AND symbol = ?" : ""}
     ORDER BY computed_at DESC LIMIT ?`,
    symbol ? [type, symbol, limit] : [type, limit]
  );
}
