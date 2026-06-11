import type { Env } from "./env.d";
import { ValkyrieMcpAgent } from "./mcp/agent";
import { QuantxMcpAgent } from "./mcp/quantx";
import { handleCronEvent } from "./jobs/cron";
import { handleStreamConnection } from "./stream/handler";
import { handleSignalPost, handleSignalGet } from "./api/signal";
import { handlePortalGet } from "./api/portal";
import { handleStrategyDeploy, handleStrategyList } from "./api/deploy";
import { handlePortfolioHistory } from "./api/portfolio";
import { handleRepoIngest, handleRepoStatus, handleRepoHistory } from "./api/repo";
import { handleKillSwitch } from "./api/killswitch";
import { processCodifyQueue } from "./codification/consumer";
import { processMCQueue } from "./execution/mc_worker";
import { handleV3Regime, handleV3Risk, handleV3Signals, handleV3Config, handleV3Status, handleV3Strategies, handleSetupKeys, handleV3Logs, handleV3Sentiment, handleV3Codifications, handleV3Simulations } from "./api/v3_dashboard";

export { SessionDO } from "./durable-objects/session";
export { ReconciliationDO } from "./durable-objects/reconciliation";
export { CodifyJobDO } from "./durable-objects/CodifyJobDO";
export { SigningDO } from "./durable-objects/SigningDO";
export { ValkyrieMcpAgent, QuantxMcpAgent };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          environment: env.ENVIRONMENT,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "nightwatcher",
          version: "0.1.1",
          description: "Cloudflare Workers MCP server for autonomous stock trading (v3.1)",
          endpoints: {
            health: "/health",
            mcp: "/mcp (via Durable Object)",
            portal: "/portal",
            signal: "/api/signal",
            deploy: "/api/signal/deploy",
            alphaSocket: {
              ingest: "/alpha-socket/repo",
              status: "/alpha-socket/repo/status",
              history: "/alpha-socket/repo/history"
            }
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.pathname === "/api/v3/regime") {
      return handleV3Regime(request, env);
    }

    if (url.pathname === "/api/v3/risk") {
      return handleV3Risk(request, env);
    }

    if (url.pathname === "/api/v3/signals") {
      return handleV3Signals(request, env);
    }

    if (url.pathname === "/api/v3/config") {
      return handleV3Config(request, env);
    }

    if (url.pathname === "/api/v3/status") {
      return handleV3Status(request, env);
    }

    if (url.pathname === "/api/setup/keys") {
      return handleSetupKeys(request, env);
    }

    if (url.pathname === "/api/v3/strategies") {
      return handleV3Strategies(request, env);
    }

    if (url.pathname === "/api/v3/logs") {
      return handleV3Logs(request, env);
    }

    if (url.pathname === "/api/v3/sentiment") {
      return handleV3Sentiment(request, env);
    }

    if (url.pathname === "/api/v3/codifications") {
      return handleV3Codifications(request, env);
    }

    if (url.pathname === "/api/v3/simulations") {
      return handleV3Simulations(request, env);
    }

    if (url.pathname === "/api/sys/activate" && request.method === "POST") {
      ctx.waitUntil(handleCronEvent("manual", env));
      return new Response(JSON.stringify({ 
        status: "activated", 
        timestamp: new Date().toISOString(),
        message: "Manual activation pulse sent to execution bridge."
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/alpha-socket/repo") {
      return handleRepoIngest(request, env, ctx);
    }

    if (url.pathname === "/alpha-socket/repo/status") {
      return handleRepoStatus(request, env);
    }

    if (url.pathname === "/alpha-socket/repo/history") {
      return handleRepoHistory(request, env);
    }

    if (url.pathname.startsWith("/mcp")) {
      return ValkyrieMcpAgent.mount("/mcp", { binding: "MCP_AGENT" }).fetch(request, env, ctx);
    }

    if (url.pathname.startsWith("/quantx")) {
      return QuantxMcpAgent.mount("/quantx", { binding: "QUANTX_AGENT" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/stream") {
      return await handleStreamConnection(request, env);
    }

    if (url.pathname === "/portal" || url.pathname === "/api/signal/portal") {
      return handlePortalGet(request, env);
    }

    if (url.pathname === "/api/portfolio-history") {
      return handlePortfolioHistory(request, env);
    }

    if (url.pathname.startsWith("/reconcile")) {
      const id = env.RECONCILIATION.idFromName("global");
      const stub = env.RECONCILIATION.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/api/signal/deploy") {
      return handleStrategyDeploy(request, env);
    }

    if (url.pathname === "/api/strategies/list") {
      return handleStrategyList(request, env);
    }

    if (url.pathname === "/api/killswitch" && request.method === "POST") {
      return handleKillSwitch(request, env);
    }

    if (url.pathname === "/api/signal" && request.method === "POST") {
      return handleSignalPost(request, env);
    }

    const signalMatch = url.pathname.match(/^\/api\/signal\/([a-f0-9]+)$/);
    if (signalMatch && request.method === "GET") {
      return handleSignalGet(request, env, signalMatch[1]!);
    }

    if (url.pathname.startsWith("/api/signal") && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Fallback to static assets
    return env.ASSETS.fetch(request);
  },

  async queue(
    batch: MessageBatch<any>,
    env: Env
  ): Promise<void> {
    if (batch.queue === "codify-jobs") {
      await processCodifyQueue(batch, env);
    } else if (batch.queue === "mc-jobs") {
      await processMCQueue(batch, env);
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const cronId = event.cron;
    console.log(`Cron triggered: ${cronId} at ${new Date().toISOString()}`);
    ctx.waitUntil(handleCronEvent(cronId, env));
  },
};
