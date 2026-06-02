import type { D1Client } from "../client";
import type { RegimeState } from "../../../regime/types";
import { generateId } from "../../../lib/utils";

export async function insertRegimeSnapshot(
  db: D1Client,
  state: RegimeState
): Promise<string> {
  const id = generateId();

  await db.run(
    `INSERT INTO regime_snapshots
       (id, regime, confidence, detected_at, expires_at,
        spy_return_20d, adx, atr_pct, realized_vol_20d,
        confidence_threshold_override, position_size_multiplier, signal_ttl_override_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      state.regime,
      state.confidence,
      state.detected_at,
      state.expires_at,
      state.spy_return_20d ?? null,
      state.adx ?? null,
      state.atr_pct ?? null,
      state.realized_vol_20d ?? null,
      state.confidence_threshold_override ?? null,
      state.position_size_multiplier,
      state.signal_ttl_override_seconds ?? null,
    ]
  );

  return id;
}

export async function getLatestRegime(db: D1Client): Promise<RegimeState | null> {
  const row = await db.executeOne<{
    regime: string;
    confidence: number;
    detected_at: string;
    expires_at: string;
    spy_return_20d: number | null;
    adx: number | null;
    atr_pct: number | null;
    realized_vol_20d: number | null;
    confidence_threshold_override: number | null;
    position_size_multiplier: number;
    signal_ttl_override_seconds: number | null;
  }>(
    `SELECT * FROM regime_snapshots ORDER BY detected_at DESC LIMIT 1`,
    []
  );

  if (!row) return null;

  return {
    regime: row.regime as RegimeState["regime"],
    confidence: row.confidence,
    detected_at: row.detected_at,
    expires_at: row.expires_at,
    spy_return_20d: row.spy_return_20d,
    adx: row.adx,
    atr_pct: row.atr_pct,
    realized_vol_20d: row.realized_vol_20d,
    confidence_threshold_override: row.confidence_threshold_override,
    position_size_multiplier: row.position_size_multiplier,
    signal_ttl_override_seconds: row.signal_ttl_override_seconds,
  };
}

export async function listRegimeHistory(
  db: D1Client,
  limit: number = 20
): Promise<Array<{ id: string; regime: string; confidence: number; detected_at: string; position_size_multiplier: number }>> {
  return db.execute(
    `SELECT id, regime, confidence, detected_at, position_size_multiplier
     FROM regime_snapshots ORDER BY detected_at DESC LIMIT ?`,
    [limit]
  );
}
