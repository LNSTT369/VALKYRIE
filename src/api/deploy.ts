import type { Env } from "../env.d";
import { createD1Client } from "../storage/d1/client";
import { generateId, nowISO, decryptText } from "../lib/utils";
import { fetchStrategyFromGithub, compileStrategySandbox, runMockSimulation } from "../execution/cloner";
import { createAlpacaProviders } from "../providers/alpaca";

function corsHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

export async function handleStrategyDeploy(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "METHOD_NOT_ALLOWED", message: "Only POST requests are allowed" }, 405);
  }

  // 1. Authenticate Bearer Key
  const auth = request.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return jsonResponse({ ok: false, error: "UNAUTHORIZED", message: "Missing Authorization Bearer header" }, 401);
  }

  const db = createD1Client(env.DB);
  
  // Verify token in D1 api_keys or check global developer fallback
  let partner = await db.executeOne<{ 
    key_id: string; 
    provider_name: string; 
    alpaca_api_key?: string; 
    alpaca_api_secret?: string; 
    alpaca_paper?: number; 
  }>(
    "SELECT key_id, provider_name, alpaca_api_key, alpaca_api_secret, alpaca_paper FROM api_keys WHERE token_hash = ? AND (revoked = 0 OR revoked IS NULL)",
    [token]
  );

  if (!partner && token === env.SIGNAL_API_KEY) {
    partner = { key_id: "master", provider_name: "Master Developer" };
  }

  if (!partner) {
    return jsonResponse({ ok: false, error: "UNAUTHORIZED", message: "Invalid or revoked Bearer token" }, 401);
  }

  // 2. Parse Request Body
  let body: Record<string, any>;
  try {
    body = await request.json() as Record<string, any>;
  } catch {
    return jsonResponse({ ok: false, error: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
  }

  const githubUrl = body.github_url as string;
  const branch = (body.branch as string) || "main";

  if (!githubUrl || typeof githubUrl !== "string") {
    return jsonResponse({ ok: false, error: "VALIDATION_ERROR", message: "Missing required string 'github_url'" }, 422);
  }

  try {
    // 3. Fetch strategy from GitHub
    const sourceCode = await fetchStrategyFromGithub(githubUrl, branch);
    
    // 4. Compile dynamic V8 Sandbox
    const sandbox = compileStrategySandbox(sourceCode);

    // Decrypt credentials if set
    let tenantConfig = undefined;
    if (partner.alpaca_api_key && partner.alpaca_api_secret) {
      try {
        const secretKey = env.KILL_SWITCH_SECRET || "default-fallback-super-secret-key-123456";
        const decKey = await decryptText(partner.alpaca_api_key, secretKey);
        const decSecret = await decryptText(partner.alpaca_api_secret, secretKey);
        tenantConfig = {
          apiKey: decKey,
          apiSecret: decSecret,
          paper: partner.alpaca_paper === 1,
        };
      } catch (err) {
        console.error("Failed to decrypt partner Alpaca credentials:", err);
      }
    }

    // 5. Fetch 30 days of daily historical bars for our simulation watchlist
    const alpaca = createAlpacaProviders(env, tenantConfig);
    const watchlist = ["AAPL", "MSFT", "NVDA", "META", "TSLA"];
    
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 45); // Get past 45 days to guarantee 30 trading days of data
    const startStr = d.toISOString().split("T")[0];

    const rawBarsMap = await alpaca.marketData.getMultiBars(watchlist, "1Day", {
      start: startStr,
      limit: 30,
    });

    // 6. Run Friction-Adjusted Backtest
    const sim = await runMockSimulation(sandbox.scanFn, rawBarsMap, 100000);

    // 7. Audit Results against Policy Gate
    const PASSING_SHARPE_THRESHOLD = 0.50;
    const MAX_DRAWDOWN_THRESHOLD = 0.20;

    const validated = sim.sharpe >= PASSING_SHARPE_THRESHOLD && sim.maxDrawdown <= MAX_DRAWDOWN_THRESHOLD;

    const auditReport = {
      validated,
      sharpe: sim.sharpe,
      max_drawdown: sim.maxDrawdown,
      total_return_pct: sim.totalReturnPct,
      trades_count: sim.tradesCount,
      compiler_logs: sandbox.logs,
      backtest_logs: sim.logs,
    };

    if (!validated) {
      return jsonResponse({
        ok: false,
        error: "POLICY_GATE_REJECTED",
        message: `Dynamic strategy did not meet performance audit thresholds. Sharpe: ${sim.sharpe.toFixed(2)} (min: ${PASSING_SHARPE_THRESHOLD}), Max Drawdown: ${(sim.maxDrawdown * 100).toFixed(1)}% (max: 20%)`,
        report: auditReport,
      }, 422);
    }

    // 8. Cache dynamic strategy JS code in KV & Save to D1 active_strategies
    const strategyId = generateId();
    const parsedRepo = githubUrl.split("/").slice(-1)[0]?.replace(/\.git$/, "") || "dynamic-strategy";

    // Write to D1
    await db.run(
      `INSERT INTO active_strategies 
       (strategy_id, provider_key_id, github_url, name, status, 
        last_backtest_sharpe, last_backtest_beta, last_backtest_drawdown, source_code, registered_at)
       VALUES (?, ?, ?, ?, 'active', ?, 0.0, ?, ?, ?)`,
      [
        strategyId,
        partner.key_id,
        githubUrl,
        parsedRepo,
        sim.sharpe,
        sim.maxDrawdown,
        sourceCode,
        nowISO()
      ]
    );

    // Write to KV
    if (env.CACHE) {
      await env.CACHE.put(`nightwatcher:strategy:${strategyId}`, sourceCode);
    }

    return jsonResponse({
      ok: true,
      strategy_id: strategyId,
      name: parsedRepo,
      message: "Dynamic strategy successfully cloned, compiled, validated, and deployed!",
      report: {
        sharpe: sim.sharpe,
        max_drawdown: sim.maxDrawdown,
        total_return_pct: sim.totalReturnPct,
        trades_count: sim.tradesCount,
      }
    }, 201);

  } catch (err) {
    return jsonResponse({
      ok: false,
      error: "DEPLOYMENT_FAILED",
      message: (err as Error).message,
    }, 500);
  }
}
