import type { D1Client } from "../client";
import type { AlphaSignal, AggregatedSignal } from "../../../signals/types";
import { generateId, nowISO } from "../../../lib/utils";

export async function insertAlphaSignal(
  db: D1Client,
  signal: AlphaSignal
): Promise<string> {
  const id = signal.signal_id || generateId();
  const expiresAt = new Date(
    new Date(signal.generated_at).getTime() + signal.ttl_seconds * 1000
  ).toISOString();

  await db.run(
    `INSERT OR IGNORE INTO alpha_signals
       (id, source, symbol, asset_class, direction, confidence, urgency,
        horizon_mins, suggested_notional, suggested_pct_equity, rationale,
        regime_tags, supporting_data, status, generated_at, ttl_seconds,
        expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      id,
      signal.source,
      signal.symbol.toUpperCase(),
      signal.asset_class,
      signal.direction,
      signal.confidence,
      signal.urgency,
      signal.horizon,
      signal.suggested_notional ?? null,
      signal.suggested_pct_equity ?? null,
      signal.rationale,
      JSON.stringify(signal.regime_tags),
      JSON.stringify(signal.supporting_data),
      signal.generated_at,
      signal.ttl_seconds,
      expiresAt,
    ]
  );

  return id;
}

export async function getPendingSignals(
  db: D1Client,
  symbol: string
): Promise<AlphaSignal[]> {
  const now = nowISO();
  type SignalRow = {
    id: string;
    source: string;
    symbol: string;
    asset_class: string;
    direction: string;
    confidence: number;
    urgency: string;
    horizon_mins: number;
    suggested_notional: number | null;
    suggested_pct_equity: number | null;
    rationale: string;
    regime_tags: string;
    supporting_data: string;
    generated_at: string;
    ttl_seconds: number;
  };

  const rows = await db.execute<SignalRow>(
    `SELECT * FROM alpha_signals
     WHERE symbol = ? AND status = 'pending' AND expires_at > ?
     ORDER BY created_at DESC`,
    [symbol.toUpperCase(), now]
  );

  return rows.map((r: SignalRow) => ({
    signal_id: r.id,
    source: r.source as AlphaSignal["source"],
    symbol: r.symbol,
    asset_class: r.asset_class as AlphaSignal["asset_class"],
    direction: r.direction as AlphaSignal["direction"],
    confidence: r.confidence,
    urgency: r.urgency as AlphaSignal["urgency"],
    horizon: r.horizon_mins,
    suggested_notional: r.suggested_notional ?? undefined,
    suggested_pct_equity: r.suggested_pct_equity ?? undefined,
    rationale: r.rationale,
    regime_tags: JSON.parse(r.regime_tags) as string[],
    supporting_data: JSON.parse(r.supporting_data) as Record<string, unknown>,
    generated_at: r.generated_at,
    ttl_seconds: r.ttl_seconds,
  }));
}

export async function listRecentSignals(
  db: D1Client,
  opts: {
    symbol?: string;
    source?: string;
    direction?: string;
    limit?: number;
  } = {}
): Promise<Array<{ id: string; source: string; symbol: string; direction: string; confidence: number; urgency: string; status: string; created_at: string }>> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.symbol) {
    conditions.push("symbol = ?");
    params.push(opts.symbol.toUpperCase());
  }
  if (opts.source) {
    conditions.push("source = ?");
    params.push(opts.source);
  }
  if (opts.direction) {
    conditions.push("direction = ?");
    params.push(opts.direction);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(opts.limit ?? 20);

  return db.execute(
    `SELECT id, source, symbol, direction, confidence, urgency, status, created_at
     FROM alpha_signals ${where} ORDER BY created_at DESC LIMIT ?`,
    params
  );
}

export async function markSignalsAggregated(
  db: D1Client,
  signalIds: string[],
  aggregatedSignalId: string
): Promise<void> {
  for (const id of signalIds) {
    await db.run(
      `UPDATE alpha_signals SET status = 'aggregated', aggregated_signal_id = ? WHERE id = ?`,
      [aggregatedSignalId, id]
    );
  }
}

export async function insertAggregatedSignal(
  db: D1Client,
  agg: AggregatedSignal
): Promise<string> {
  const id = agg.aggregated_id || generateId();
  const contributingIds = agg.contributing_signals.map((s) => s.signal_id);

  await db.run(
    `INSERT OR IGNORE INTO aggregated_signals
       (id, symbol, final_direction, final_confidence, source_count,
        conflict_detected, contributing_signal_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      agg.symbol.toUpperCase(),
      agg.final_direction,
      agg.final_confidence,
      agg.source_count,
      agg.conflict_detected ? 1 : 0,
      JSON.stringify(contributingIds),
    ]
  );

  if (contributingIds.length > 0) {
    await markSignalsAggregated(db, contributingIds, id);
  }

  return id;
}

export async function getSignalById(
  db: D1Client,
  id: string
): Promise<(AlphaSignal & { status: string; expires_at: string }) | null> {
  type FullSignalRow = {
    id: string;
    source: string;
    symbol: string;
    asset_class: string;
    direction: string;
    confidence: number;
    urgency: string;
    horizon_mins: number;
    suggested_notional: number | null;
    suggested_pct_equity: number | null;
    rationale: string;
    regime_tags: string;
    supporting_data: string;
    generated_at: string;
    ttl_seconds: number;
    status: string;
    expires_at: string;
  };

  const row = await db.executeOne<FullSignalRow>(
    `SELECT * FROM alpha_signals WHERE id = ?`,
    [id]
  );

  if (!row) return null;

  return {
    signal_id: row.id,
    source: row.source as AlphaSignal["source"],
    symbol: row.symbol,
    asset_class: row.asset_class as AlphaSignal["asset_class"],
    direction: row.direction as AlphaSignal["direction"],
    confidence: row.confidence,
    urgency: row.urgency as AlphaSignal["urgency"],
    horizon: row.horizon_mins,
    suggested_notional: row.suggested_notional ?? undefined,
    suggested_pct_equity: row.suggested_pct_equity ?? undefined,
    rationale: row.rationale,
    regime_tags: JSON.parse(row.regime_tags) as string[],
    supporting_data: JSON.parse(row.supporting_data) as Record<string, unknown>,
    generated_at: row.generated_at,
    ttl_seconds: row.ttl_seconds,
    status: row.status,
    expires_at: row.expires_at,
  };
}

export async function cleanupExpiredSignals(db: D1Client): Promise<number> {
  const now = nowISO();
  await db.run(
    `UPDATE alpha_signals SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= ?`,
    [now]
  );
  const result = await db.execute<{ count: number }>(
    `SELECT COUNT(*) as count FROM alpha_signals WHERE status = 'expired' AND created_at < datetime('now', '-7 days')`,
    []
  );
  const staleCount = result[0]?.count ?? 0;
  if (staleCount > 0) {
    await db.run(
      `DELETE FROM alpha_signals WHERE status = 'expired' AND created_at < datetime('now', '-7 days')`,
      []
    );
  }
  return staleCount;
}
