import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.d";
import { createD1Client } from "../storage/d1/client";
import { fetchStrategyFromGithub, compileStrategySandbox, runMockSimulation } from "../execution/cloner";
import { createAlpacaProviders } from "../providers/alpaca";
import { getMultiBarsWithCache } from "../utils/market_cache";
import { extractStrategyIR } from "../codification/llm_codifier";
import { StrategyPolicyGate } from "../policy/strategy_gate";
import { getDailyReturns, computePathMetrics, mean, percentile } from "../execution/mc_worker";
import type { StrategyPayload } from "../lib/crypto/harness_signer";
import type { SignedStrategy } from "../lib/contracts/signed_strategy";

export type JobStatus = 'queued' | 'ingesting' | 'codifying' | 'validating' | 'signing' | 'completed' | 'failed';

export interface CodifyJobState {
  jobId: string;
  tenantId: string;
  githubUrl: string;
  branch: string;
  status: JobStatus;
  progress: number;
  error?: string;
  resultStrategyId?: string;
  createdAt: string;
  updatedAt: string;
}

export class CodifyJobDO extends DurableObject<Env> {
  private state: CodifyJobState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<CodifyJobState>("state");
      if (stored) {
        this.state = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);

    try {
      switch (action) {
        case "status":
          return this.jsonResponse(this.state || { status: "not_found" });

        case "init": {
          const data = await request.json() as any;
          const now = new Date().toISOString();
          this.state = {
            jobId: data.jobId,
            tenantId: data.tenantId,
            githubUrl: data.githubUrl,
            branch: data.branch,
            status: "queued",
            progress: 0,
            createdAt: now,
            updatedAt: now,
          };
          await this.persist();
          return this.jsonResponse({ ok: true, state: this.state });
        }

        case "start":
          if (!this.state) return new Response("Job not initialized", { status: 400 });
          this.ctx.waitUntil(this.runJob());
          return this.jsonResponse({ ok: true, message: "Job processing started" });

        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  private async runJob() {
    if (!this.state) return;

    try {
      // Stage 1: Ingestion
      await this.updateStatus("ingesting", 15);
      const sourceCode = await fetchStrategyFromGithub(this.state.githubUrl, this.state.branch);
      await this.env.ARTIFACTS.put(`jobs/${this.state.jobId}/source.js`, sourceCode);

      // Stage 2: LLM Codifier
      await this.updateStatus("codifying", 35);
      const llmCredentials = {
        LLM_API_KEY: this.env.OPENAI_API_KEY || this.env.GEMINI_API_KEY || this.env.OLLAMA_API_KEY || "local-no-key-required",
        LLM_API_URL: this.env.OLLAMA_BASE_URL || (this.env.GEMINI_API_KEY ? "https://generativelanguage.googleapis.com" : "https://api.openai.com/v1"),
        LLM_MODEL: this.env.LLM_MODEL || this.env.OLLAMA_MODEL || "gpt-4o-mini"
      };
      const sourceInfo = {
        git_url: this.state.githubUrl,
        commit: this.state.branch || "main"
      };
      
      const strategyIR = await extractStrategyIR(sourceCode, llmCredentials, sourceInfo);
      await this.env.ARTIFACTS.put(`jobs/${this.state.jobId}/ir.json`, JSON.stringify(strategyIR));

      // Stage 3: V8 Sandbox & Monte Carlo Simulation
      await this.updateStatus("validating", 65);
      const sandbox = compileStrategySandbox(sourceCode);
      const alpaca = createAlpacaProviders(this.env);
      
      // Load historical bar data for the universe tickers (or fallback tickers if empty)
      const tickers = strategyIR.universe?.tickers || [];
      const watchlist = tickers.length > 0 ? tickers : ["AAPL", "MSFT", "NVDA", "META", "TSLA"];
      
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 45); // Guarantee 30 trading days of data
      const startStr = d.toISOString().split("T")[0];
      const rawBarsMap = await getMultiBarsWithCache(this.env.CACHE, alpaca, watchlist, "1Day", 30, startStr);

      // Run baseline simulation
      const sim = await runMockSimulation(sandbox.scanFn, rawBarsMap, 100000);

      // Run Monte Carlo bootstrap confidence metrics
      const dailyReturns = await getDailyReturns(sandbox.scanFn, rawBarsMap);
      if (dailyReturns.length < 10) {
        throw new Error("Insufficient historical data for simulation");
      }

      const iterations = 250;
      const horizon = dailyReturns.length;
      const paths: number[][] = [];
      const pathMetrics: { return: number; mdd: number; sharpe: number; winRate: number }[] = [];

      for (let i = 0; i < iterations; i++) {
        const pathReturnIndices = Array.from({ length: horizon }, () => 
          Math.floor(Math.random() * dailyReturns.length)
        );
        
        const pathReturns = pathReturnIndices.map(idx => dailyReturns[idx]!);
        const { cumReturn, mdd, sharpe, winRate } = computePathMetrics(pathReturns);
        
        paths.push(pathReturns);
        pathMetrics.push({ return: cumReturn, mdd, sharpe, winRate });
      }

      const mcSummary = {
        expected_return: mean(pathMetrics.map(m => m.return)),
        max_drawdown_p95: percentile(pathMetrics.map(m => m.mdd), 95),
        sharpe_ratio: mean(pathMetrics.map(m => m.sharpe)),
        win_rate: mean(pathMetrics.map(m => m.winRate)),
        total_paths: iterations,
      };

      // Store simulation and MC metrics inside job's artifacts
      await this.env.ARTIFACTS.put(`jobs/${this.state.jobId}/mc_simulation.json`, JSON.stringify({
        summary: mcSummary,
        paths,
        timestamp: new Date().toISOString()
      }));

      // Stage 4: Policy Gate Checks (Pre-Trade Verification)
      const policyGate = new StrategyPolicyGate(alpaca.marketData);
      const verdict = await policyGate.validate(strategyIR);

      if (!verdict.approved) {
        throw new Error(`Strategy policy gate check failed. Violations: ${verdict.violations.join("; ")}`);
      }

      // Stage 5: Package Compiler & Signing (USP generation)
      await this.updateStatus("signing", 90);
      const strategyId = crypto.randomUUID();

      // Compile payload for SigningDO
      const payload: StrategyPayload = {
        id: strategyId,
        version: strategyIR.version || "1.0.0",
        code_hash: strategyIR.provenance_hash,
        author: this.state.tenantId || "system",
        timestamp: Date.now(),
        strategy: strategyIR,
        verdict: {
          approved: verdict.approved,
          violations: verdict.violations,
          warnings: verdict.warnings,
        },
        simulation: {
          sharpe: sim.sharpe,
          maxDrawdown: sim.maxDrawdown,
          totalReturnPct: sim.totalReturnPct,
          tradesCount: sim.tradesCount,
          monteCarlo: mcSummary
        }
      };

      // Fetch from SigningDO
      const signingDoId = this.env.SIGNING_DO.idFromName("global-signing-service");
      const signingDoStub = this.env.SIGNING_DO.get(signingDoId);

      const signResponse = await signingDoStub.fetch(
        new Request("http://signing-service/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );

      if (!signResponse.ok) {
        const errText = await signResponse.text();
        throw new Error(`SigningDO failed: ${errText}`);
      }

      const { signature } = await signResponse.json() as { signature: string };

      // Write fully signed USP to ARTIFACTS
      const signedUSP: SignedStrategy = {
        strategy: strategyIR,
        verdict: {
          approved: verdict.approved,
          violations: verdict.violations,
          warnings: verdict.warnings,
        },
        signature,
        key_id: "global-valkyrie-ed25519-key",
        expires_at: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60) // 1 year expiry
      };

      await this.env.ARTIFACTS.put(`jobs/${this.state.jobId}/signed_strategy.json`, JSON.stringify(signedUSP));

      // Register the strategy in D1
      const db = createD1Client(this.env.DB);
      const parsedRepo = this.state.githubUrl.split("/").slice(-1)[0]?.replace(/\.git$/, "") || "dynamic-strategy";
      
      await db.run(
        `INSERT INTO active_strategies 
         (strategy_id, provider_key_id, github_url, name, status, 
          last_backtest_sharpe, last_backtest_beta, last_backtest_drawdown, source_code, registered_at)
         VALUES (?, ?, ?, ?, 'active', ?, 0.0, ?, ?, datetime('now'))`,
        [
          strategyId,
          this.state.tenantId,
          this.state.githubUrl,
          parsedRepo,
          sim.sharpe,
          sim.maxDrawdown,
          sourceCode
        ]
      );

      // Insert MC summary in D1
      await db.run(
        "INSERT INTO mc_summaries (job_id, strategy_id, metrics_json) VALUES (?, ?, ?)",
        [this.state.jobId, strategyId, JSON.stringify(mcSummary)]
      );

      // Cache in KV
      if (this.env.CACHE) {
        await this.env.CACHE.put(`nightwatcher:strategy:${strategyId}`, sourceCode);
      }

      await this.updateStatus("completed", 100, undefined, strategyId);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Codification Job ${this.state.jobId} failed:`, errorMsg);
      await this.updateStatus("failed", 0, errorMsg);
    }
  }

  private async updateStatus(status: JobStatus, progress: number, error?: string, strategyId?: string) {
    if (!this.state) return;
    
    this.state.status = status;
    this.state.progress = progress;
    this.state.updatedAt = new Date().toISOString();
    if (error) this.state.error = error;
    if (strategyId) this.state.resultStrategyId = strategyId;

    await this.persist();

    // Sync to D1
    try {
      const db = createD1Client(this.env.DB);
      await db.run(
        `UPDATE codify_jobs SET status = ?, progress = ?, error = ?, result_strategy_id = ?, updated_at = datetime('now') WHERE job_id = ?`,
        [status, progress, error || null, strategyId || null, this.state.jobId]
      );
    } catch (d1Err) {
      console.error("Failed to update D1 status:", d1Err);
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  private jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
