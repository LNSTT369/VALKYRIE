import type { Env } from "../env.d";
import type { AlphaSignal, SignalSource, SignalDirection, SignalUrgency, SignalAssetClass } from "../signals/types";
import { DEFAULT_TTL } from "../signals/types";
import { createD1Client } from "../storage/d1/client";
import { insertAlphaSignal, getSignalById } from "../storage/d1/queries/signals";
import { generateId, nowISO } from "../lib/utils";

const VALID_SOURCES: SignalSource[] = ["llm", "technical", "l2_microstructure", "dark_pool", "external", "manual"];
const VALID_DIRECTIONS: SignalDirection[] = ["long", "short", "neutral"];
const VALID_URGENCIES: SignalUrgency[] = ["immediate", "session", "swing"];
const VALID_ASSET_CLASSES: SignalAssetClass[] = ["equity", "option", "future"];

function corsHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

async function checkAuth(request: Request, env: Env): Promise<{ key_id: string; weight: number } | Response> {
  const auth = request.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return json({ ok: false, error: "UNAUTHORIZED", message: "Missing Bearer token" }, 401);
  }

  const db = createD1Client(env.DB);
  try {
    const row = await db.executeOne<{ key_id: string; credibility_weight: number }>(
      "SELECT key_id, credibility_weight FROM api_keys WHERE token_hash = ? AND (revoked = 0 OR revoked IS NULL)",
      [token]
    );

    if (!row) {
      return json({ ok: false, error: "UNAUTHORIZED", message: "Invalid or revoked Bearer token" }, 401);
    }

    return { key_id: row.key_id, weight: row.credibility_weight };
  } catch (err) {
    return json({ ok: false, error: "INTERNAL_ERROR", message: "Database authentication failure" }, 500);
  }
}

export async function handleSignalPost(request: Request, env: Env): Promise<Response> {
  const authRes = await checkAuth(request, env);
  if (authRes instanceof Response) return authRes;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "BAD_REQUEST", message: "Invalid JSON" }, 400);
  }

  const errors: Record<string, string> = {};

  const source = body.source as string;
  if (!source || !VALID_SOURCES.includes(source as SignalSource)) {
    errors.source = `Must be one of: ${VALID_SOURCES.join(", ")}`;
  }

  const symbol = body.symbol as string;
  if (!symbol || typeof symbol !== "string" || symbol.length < 1 || symbol.length > 10) {
    errors.symbol = "Required string, 1-10 characters";
  }

  const direction = body.direction as string;
  if (!direction || !VALID_DIRECTIONS.includes(direction as SignalDirection)) {
    errors.direction = `Must be one of: ${VALID_DIRECTIONS.join(", ")}`;
  }

  const confidence = body.confidence as number;
  if (confidence === undefined || confidence === null || typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    errors.confidence = "Required number between 0 and 1";
  }

  const urgency = body.urgency as string;
  if (!urgency || !VALID_URGENCIES.includes(urgency as SignalUrgency)) {
    errors.urgency = `Must be one of: ${VALID_URGENCIES.join(", ")}`;
  }

  const horizon = body.horizon as number;
  if (!horizon || typeof horizon !== "number" || !Number.isInteger(horizon) || horizon <= 0) {
    errors.horizon = "Required positive integer (minutes)";
  }

  const rationale = body.rationale as string;
  if (!rationale || typeof rationale !== "string" || rationale.trim().length === 0) {
    errors.rationale = "Required non-empty string";
  }

  if (Object.keys(errors).length > 0) {
    return json({ ok: false, error: "VALIDATION_ERROR", fields: errors }, 422);
  }

  const assetClass = (VALID_ASSET_CLASSES.includes(body.asset_class as SignalAssetClass)
    ? body.asset_class
    : "equity") as SignalAssetClass;

  const ttlSeconds = (typeof body.ttl_seconds === "number" && body.ttl_seconds > 0)
    ? body.ttl_seconds
    : DEFAULT_TTL[urgency as SignalUrgency];

  const signal: AlphaSignal = {
    signal_id: generateId(),
    source: source as SignalSource,
    generated_at: nowISO(),
    ttl_seconds: ttlSeconds,
    symbol: symbol.toUpperCase(),
    asset_class: assetClass,
    direction: direction as SignalDirection,
    confidence,
    urgency: urgency as SignalUrgency,
    horizon,
    suggested_notional: typeof body.suggested_notional === "number" ? body.suggested_notional : undefined,
    suggested_pct_equity: typeof body.suggested_pct_equity === "number" ? body.suggested_pct_equity : undefined,
    rationale: rationale.trim(),
    regime_tags: Array.isArray(body.regime_tags) ? body.regime_tags as string[] : [],
    supporting_data: (body.supporting_data && typeof body.supporting_data === "object" && !Array.isArray(body.supporting_data))
      ? body.supporting_data as Record<string, unknown>
      : {},
  };

  try {
    const db = createD1Client(env.DB);
    const id = await insertAlphaSignal(db, signal);
    return json({
      ok: true,
      signal_id: id,
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence,
      expires_in_seconds: ttlSeconds,
    }, 201);
  } catch (err) {
    return json({ ok: false, error: "INTERNAL_ERROR", message: String(err) }, 500);
  }
}

export async function handleSignalGet(request: Request, env: Env, id: string): Promise<Response> {
  const authRes = await checkAuth(request, env);
  if (authRes instanceof Response) return authRes;

  try {
    const db = createD1Client(env.DB);
    const signal = await getSignalById(db, id);
    if (!signal) {
      return json({ ok: false, error: "NOT_FOUND", message: `Signal ${id} not found` }, 404);
    }
    return json({
      ok: true,
      signal_id: signal.signal_id,
      source: signal.source,
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence,
      urgency: signal.urgency,
      horizon: signal.horizon,
      status: signal.status,
      rationale: signal.rationale,
      regime_tags: signal.regime_tags,
      generated_at: signal.generated_at,
      expires_at: signal.expires_at,
    });
  } catch (err) {
    return json({ ok: false, error: "INTERNAL_ERROR", message: String(err) }, 500);
  }
}
