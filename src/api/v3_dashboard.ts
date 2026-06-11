import type { Env } from "../env.d";
import { createD1Client } from "../storage/d1/client";
import { getLatestRegime, insertRegimeSnapshot } from "../storage/d1/queries/regime";
import { getLatestRiskMetric } from "../storage/d1/queries/risk_metrics";
import { listRecentSignals } from "../storage/d1/queries/signals";
import { generateId, nowISO, decryptText, encryptText } from "../lib/utils";
import { createAlpacaClient } from "../providers/alpaca/client";
import { createAlpacaTradingProvider } from "../providers/alpaca/trading";
import { AlpacaMarketDataProvider } from "../providers/alpaca/market-data";
import { calculateCost } from "../lib/llm-costs";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handleSetupKeys(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const body = await request.json() as {
      alpaca_key: string;
      alpaca_secret: string;
      paper_mode: boolean;
      llm_provider: "openai" | "gemini" | "ollama";
      llm_key?: string;
      llm_url?: string;
      starting_equity: number;
      policy: {
        max_position_pct: number;
        max_notional: number;
        max_daily_loss_pct: number;
      }
    };

    const db = createD1Client(env.DB);
    const secretKey = env.KILL_SWITCH_SECRET || "default-fallback-super-secret-key-123456";
    
    const encryptedAlpacaKey = await encryptText(body.alpaca_key, secretKey);
    const encryptedAlpacaSecret = await encryptText(body.alpaca_secret, secretKey);

    // 1. Update Master Alpaca Key
    await db.run(
      `INSERT INTO api_keys (key_id, token_hash, alpaca_api_key, alpaca_api_secret, alpaca_paper)
       VALUES ('master', 'master-dev-token', ?, ?, ?)
       ON CONFLICT(key_id) DO UPDATE SET 
       alpaca_api_key = EXCLUDED.alpaca_api_key,
       alpaca_api_secret = EXCLUDED.alpaca_api_secret,
       alpaca_paper = EXCLUDED.alpaca_paper`,
      [encryptedAlpacaKey, encryptedAlpacaSecret, body.paper_mode ? 1 : 0]
    );

    // 2. Encrypt LLM Key if provided
    let encryptedLlmKey = null;
    if (body.llm_key) {
      encryptedLlmKey = await encryptText(body.llm_key, secretKey);
    }

    // 3. Update Policy Config
    const currentConfigRow = await db.executeOne<{ config_json: string }>(
      "SELECT config_json FROM policy_configs WHERE id = 1"
    );
    const currentConfig = currentConfigRow ? JSON.parse(currentConfigRow.config_json) : {};

    const newConfig = {
      ...currentConfig,
      starting_equity: body.starting_equity,
      llm_provider: body.llm_provider,
      llm_url: body.llm_url,
      llm_key_ciphertext: encryptedLlmKey,
      policy: body.policy
    };

    await db.run(
      "UPDATE policy_configs SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
      [JSON.stringify(newConfig)]
    );

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}

export async function handleV3Regime(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);
  let regime = await getLatestRegime(db);

  // If no regime in DB, compute a lightweight one from Alpaca SPY bars
  if (!regime) {
    try {
      const row = await db.executeOne<{ alpaca_api_key: string; alpaca_api_secret: string; alpaca_paper: number }>(
        "SELECT alpaca_api_key, alpaca_api_secret, alpaca_paper FROM api_keys WHERE key_id = 'master' AND (revoked = 0 OR revoked IS NULL)"
      );
      if (row) {
        const secretKey = env.KILL_SWITCH_SECRET || "default-fallback-super-secret-key-123456";
        const apiKey = await decryptText(row.alpaca_api_key, secretKey);
        const apiSecret = await decryptText(row.alpaca_api_secret, secretKey);
        const client = createAlpacaClient({ apiKey, apiSecret, paper: row.alpaca_paper === 1 });
        const mdp = new AlpacaMarketDataProvider(client);

        const now = new Date();
        const start = new Date(now);
        start.setDate(start.getDate() - 30);
        const bars = await mdp.getBars("SPY", "1Day", { limit: 25, start: start.toISOString().split("T")[0] });

        if (bars.length >= 5) {
          const closes = bars.map(b => b.c);
          const ret20d = closes.length >= 20 ? (closes[closes.length - 1] - closes[closes.length - 20]) / closes[closes.length - 20] : 0;

          // Simple ATR (average of daily ranges)
          const ranges = bars.map(b => b.h - b.l);
          const atr = ranges.reduce((s, r) => s + r, 0) / ranges.length;
          const atrPct = (atr / closes[closes.length - 1]) * 100;

          // Realized vol (std of log returns * sqrt(252))
          const logRets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
          const mean = logRets.reduce((s, r) => s + r, 0) / logRets.length;
          const variance = logRets.reduce((s, r) => s + (r - mean) ** 2, 0) / logRets.length;
          const realizedVol = Math.sqrt(variance * 252) * 100;

          let detectedRegime: string;
          let confidence: number;
          let multiplier: number;

          if (realizedVol > 30) {
            detectedRegime = "high_volatility"; confidence = 0.75; multiplier = 0.5;
          } else if (ret20d > 0.04) {
            detectedRegime = "trending_bull"; confidence = 0.7 + Math.min(ret20d * 2, 0.25); multiplier = 1.0;
          } else if (ret20d < -0.04) {
            detectedRegime = "trending_bear"; confidence = 0.7 + Math.min(Math.abs(ret20d) * 2, 0.25); multiplier = 0.5;
          } else if (realizedVol < 10) {
            detectedRegime = "low_volatility"; confidence = 0.65; multiplier = 1.2;
          } else {
            detectedRegime = "range_bound"; confidence = 0.6; multiplier = 0.8;
          }

          const detected = now.toISOString();
          const expires = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();

          regime = {
            regime: detectedRegime as any,
            confidence,
            detected_at: detected,
            expires_at: expires,
            spy_return_20d: ret20d,
            adx: null,
            atr_pct: atrPct,
            realized_vol_20d: realizedVol,
            confidence_threshold_override: null,
            position_size_multiplier: multiplier,
            signal_ttl_override_seconds: null,
          };

          // Persist so next request is instant
          await insertRegimeSnapshot(db, regime).catch(() => {});
        }
      }
    } catch {
      // Return null regime if computation fails — UI shows "Identifying Regime..."
    }
  }

  return jsonResponse({ ok: true, data: regime });
}

export async function handleV3Risk(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);
  const kelly = await getLatestRiskMetric(db, "kelly");
  const sharpe = await getLatestRiskMetric(db, "sharpe");
  const varMetric = await getLatestRiskMetric(db, "var");

  return jsonResponse({
    ok: true,
    data: {
      kelly: kelly ? JSON.parse(kelly.raw_json) : null,
      sharpe: sharpe ? JSON.parse(sharpe.raw_json) : null,
      var: varMetric ? JSON.parse(varMetric.raw_json) : null
    }
  });
}

export async function handleV3Signals(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);
  const signals = await listRecentSignals(db, { limit: 50 });
  return jsonResponse({ ok: true, data: { signals } });
}

export async function handleV3Status(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);
  
  try {
    // 1. Get Master Alpaca Credentials
    const row = await db.executeOne<{
      alpaca_api_key: string;
      alpaca_api_secret: string;
      alpaca_paper: number;
    }>(
      "SELECT alpaca_api_key, alpaca_api_secret, alpaca_paper FROM api_keys WHERE key_id = 'master' AND (revoked = 0 OR revoked IS NULL)"
    );

    if (!row || !row.alpaca_api_key || !row.alpaca_api_secret) {
      return jsonResponse({ ok: false, error: "ALPACA_NOT_CONFIGURED" });
    }

    // 2. Get Config from D1
    const configRow = await db.executeOne<{ config_json: string }>(
      "SELECT config_json FROM policy_configs WHERE id = 1"
    );
    const d1Config = configRow ? JSON.parse(configRow.config_json) : {};

    const secretKey = env.KILL_SWITCH_SECRET || "default-fallback-super-secret-key-123456";
    const apiKey = await decryptText(row.alpaca_api_key, secretKey);
    const apiSecret = await decryptText(row.alpaca_api_secret, secretKey);
    
    const client = createAlpacaClient({
      apiKey,
      apiSecret,
      paper: row.alpaca_paper === 1
    });

    const provider = createAlpacaTradingProvider(client);
    const mdp = new AlpacaMarketDataProvider(client);

    // 3. Fetch Account & Positions in parallel
    const [account, positions, clock] = await Promise.all([
      provider.getAccount(),
      provider.getPositions(),
      provider.getClock()
    ]);

    // 4a. Fetch 7-day daily bars for each position symbol (sparklines)
    const sparklineMap: Record<string, number[]> = {};
    if (positions.length > 0) {
      const stockSymbols = positions.map(p => p.symbol).filter(s => !s.includes("/")).slice(0, 8);
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 10);
      const startDate = sevenDaysAgo.toISOString().split("T")[0];

      const sparklineResults = await Promise.allSettled(
        stockSymbols.map(sym => mdp.getBars(sym, "1Day", { limit: 7, start: startDate }))
      );
      stockSymbols.forEach((sym, i) => {
        const result = sparklineResults[i];
        if (result && result.status === "fulfilled" && result.value.length > 0) {
          sparklineMap[sym] = result.value.map(b => b.c);
        }
      });
    }

    // 4. Fetch LLM usage from tool_logs
    const costs = await db.execute<{ total_in: number, total_out: number, calls: number }>(
      `SELECT SUM(prompt_tokens) as total_in,
              SUM(completion_tokens) as total_out,
              COUNT(*) as calls
       FROM tool_logs 
       WHERE tool_name = 'research-symbol'`
    );

    const prompt_tokens = costs[0]?.total_in || 0;
    const completion_tokens = costs[0]?.total_out || 0;
    const llmModel = d1Config.llm_model || env.LLM_MODEL || 'gpt-4o';
    const total_usd = calculateCost(llmModel, { prompt_tokens, completion_tokens });

    return jsonResponse({
      ok: true,
      data: {
        account,
        positions: positions.map(p => ({
          ...p,
          sparkline: sparklineMap[p.symbol] || [],
        })),
        clock,
        costs: {
          total_usd,
          calls: costs[0]?.calls || 0,
          tokens_in: prompt_tokens,
          tokens_out: completion_tokens
        },
        config: {
          llm_provider: d1Config.llm_provider || env.LLM_PROVIDER || "openai",
          llm_model: llmModel,
          starting_equity: d1Config.starting_equity || 100000,
          max_position_value: d1Config.policy?.max_notional || 10000,
          min_sentiment_score: 0.3,
          take_profit_pct: 0.15,
          stop_loss_pct: 0.05,
          options_enabled: env.FEATURE_OPTIONS === "true",
          crypto_enabled: true,
          crypto_symbols: ["BTC/USD", "ETH/USD", "SOL/USD"]
        }
      }
    });

  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}

export async function handleV3Strategies(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);

  const strategies = await db.execute<{
    strategy_id: string; name: string; status: string; registered_at: string;
    last_backtest_sharpe: number | null;
  }>(
    "SELECT strategy_id, name, status, registered_at, last_backtest_sharpe FROM active_strategies ORDER BY registered_at DESC"
  );

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [fillRows, logRows] = await Promise.all([
    db.execute<{ strategy_id: string; fills: number }>(
      `SELECT strategy_id, COUNT(*) as fills FROM trade_journal
       WHERE created_at >= ? GROUP BY strategy_id`,
      [todayStart.toISOString()]
    ).catch(() => [] as { strategy_id: string; fills: number }[]),
    db.execute<{ module: string; event: string; ts: number }>(
      `SELECT module, event, ts FROM error_log
       WHERE module LIKE 'strategy%' OR module LIKE 'execution%'
       ORDER BY ts DESC LIMIT 50`,
      []
    ).catch(() => [] as { module: string; event: string; ts: number }[]),
  ]);

  const fillsMap = new Map(fillRows.map(r => [r.strategy_id, r.fills]));
  const latestLogByModule = new Map<string, string>();
  for (const r of logRows) {
    if (!latestLogByModule.has(r.module)) {
      latestLogByModule.set(r.module, r.event);
    }
  }

  return jsonResponse({
    ok: true,
    data: {
      strategies: strategies.map(s => {
        const lastLog = latestLogByModule.get(`strategy:${s.strategy_id}`)
          || latestLogByModule.get("execution")
          || "Awaiting next evaluation cycle.";
        return {
          name: s.name,
          strategy_id: s.strategy_id,
          status: s.status === 'active' ? 'active' : 'idle',
          lastActivity: s.registered_at,
          lastAction: lastLog,
          fillsToday: fillsMap.get(s.strategy_id) || 0,
          sharpe: s.last_backtest_sharpe,
        };
      })
    }
  });
}

export async function handleV3Logs(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);

  const [errorLogs, toolLogs] = await Promise.all([
    db.execute<{ ts: number; module: string; event: string; severity: string; payload: string | null }>(
      `SELECT ts, module, event, severity, payload FROM error_log ORDER BY ts DESC LIMIT 60`
    ).catch(() => []),
    db.execute<{ created_at: string; tool_name: string; model_name: string | null; latency_ms: number | null; error_json: string | null }>(
      `SELECT created_at, tool_name, model_name, latency_ms, error_json FROM tool_logs ORDER BY created_at DESC LIMIT 40`
    ).catch(() => []),
  ]);

  type LogEntry = { timestamp: number; agent: string; action: string; severity?: string };
  const entries: LogEntry[] = [];

  for (const r of errorLogs) {
    entries.push({
      timestamp: r.ts,
      agent: r.module,
      action: r.event + (r.payload ? ` — ${r.payload.slice(0, 120)}` : ""),
      severity: r.severity,
    });
  }

  for (const r of toolLogs) {
    const ts = new Date(r.created_at).getTime();
    const status = r.error_json ? "ERROR" : "OK";
    const latency = r.latency_ms != null ? ` ${r.latency_ms}ms` : "";
    entries.push({
      timestamp: ts,
      agent: r.tool_name,
      action: `[${status}]${latency}${r.model_name ? ` via ${r.model_name}` : ""}`,
      severity: r.error_json ? "error" : "info",
    });
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);

  return jsonResponse({ ok: true, data: { entries: entries.slice(0, 80) } });
}

export async function handleV3Sentiment(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);

  const [newsItems, structuredEvents] = await Promise.all([
    db.execute<{ headline: string; summary: string | null; symbols: string | null; source: string; published_at: string | null; created_at: string }>(
      `SELECT headline, summary, symbols, source, published_at, created_at FROM news_items ORDER BY created_at DESC LIMIT 20`
    ).catch(() => []),
    db.execute<{ event_type: string; symbols: string | null; summary: string | null; confidence: number | null; created_at: string }>(
      `SELECT event_type, symbols, summary, confidence, created_at FROM structured_events ORDER BY created_at DESC LIMIT 20`
    ).catch(() => []),
  ]);

  type FeedItem = { timestamp: number; source: string; headline: string; symbols: string[]; confidence: number | null; type: string };
  const feed: FeedItem[] = [];

  for (const n of newsItems) {
    feed.push({
      timestamp: new Date(n.published_at || n.created_at).getTime(),
      source: n.source,
      headline: n.headline,
      symbols: n.symbols ? (n.symbols.startsWith("[") ? JSON.parse(n.symbols) : n.symbols.split(",").map((s: string) => s.trim())) : [],
      confidence: null,
      type: "news",
    });
  }

  for (const e of structuredEvents) {
    if (!e.summary) continue;
    feed.push({
      timestamp: new Date(e.created_at).getTime(),
      source: e.event_type,
      headline: e.summary,
      symbols: e.symbols ? (e.symbols.startsWith("[") ? JSON.parse(e.symbols) : e.symbols.split(",").map((s: string) => s.trim())) : [],
      confidence: e.confidence,
      type: "event",
    });
  }

  feed.sort((a, b) => b.timestamp - a.timestamp);

  return jsonResponse({ ok: true, data: { feed: feed.slice(0, 30) } });
}

export async function handleV3Config(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);
  const configRow = await db.executeOne<{ config_json: string }>(
    "SELECT config_json FROM policy_configs WHERE id = 1"
  );
  const d1Config = configRow ? JSON.parse(configRow.config_json) : {};

  return jsonResponse({
    ok: true,
    data: {
      max_position_value: d1Config.policy?.max_notional || parseFloat(env.DEFAULT_MAX_NOTIONAL_PER_TRADE || "10000"),
      max_positions: parseInt(env.DEFAULT_MAX_OPEN_POSITIONS || "10"),
      min_sentiment_score: 0.3,
      take_profit_pct: 3.0,
      stop_loss_pct: 1.5,
      options_enabled: env.FEATURE_OPTIONS === "true",
      crypto_enabled: true,
      crypto_symbols: ["BTC/USD", "ETH/USD", "SOL/USD"],
      llm_provider: d1Config.llm_provider || env.LLM_PROVIDER || "openai",
      llm_model: d1Config.llm_model || env.LLM_MODEL || "gpt-4o",
      alpaca_api_key: !!env.ALPACA_API_KEY
    }
  });
}

export async function handleV3Codifications(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);
  try {
    const jobs = await db.execute(
      "SELECT job_id, tenant_id, github_url, branch, status, progress, error, result_strategy_id, created_at, updated_at FROM codify_jobs ORDER BY created_at DESC LIMIT 20"
    );
    return jsonResponse({ ok: true, data: { jobs } });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}

export async function handleV3Simulations(request: Request, env: Env): Promise<Response> {
  const db = createD1Client(env.DB);
  try {
    const simulations = await db.execute(
      "SELECT job_id, strategy_id, metrics_json, created_at FROM mc_summaries ORDER BY created_at DESC LIMIT 20"
    );
    return jsonResponse({ ok: true, data: { simulations } });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}
