import type { Env } from "../env.d";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { success, failure } from "./types";
import { ErrorCode } from "../lib/errors";
import { createD1Client } from "../storage/d1/client";
import { createAlpacaProviders } from "../providers/alpaca";
import { getDefaultPolicyConfig } from "../policy/config";
import { getPolicyConfig } from "../storage/d1/queries/policy-config";
import { generateId, hmacSign } from "../lib/utils";
import { insertAlphaSignal } from "../storage/d1/queries/signals";
import { getExecutionReport } from "../storage/d1/queries/execution_fills";
import { getRiskState, enableKillSwitch } from "../storage/d1/queries/risk-state";
import { PolicyEngine } from "../policy/engine";
import { generateApprovalToken, validateApprovalToken, consumeApprovalToken } from "../policy/approval";
import { createTrade } from "../storage/d1/queries/trades";
import { getLatestRegime } from "../storage/d1/queries/regime";

export class QuantxMcpAgent extends McpAgent<Env> {
  // @ts-ignore
  server = new McpServer({
    name: "quantspace-execution-rail",
    version: "1.0.0",
  });

  async init() {
    const db = createD1Client(this.env.DB);
    const alpaca = createAlpacaProviders(this.env);

    // 1. portfolio-deploy
    this.server.tool(
      "portfolio-deploy",
      "Consume a QuantSpace JSON blob URL and map weights to AlphaSignals for execution.",
      {
        input_url: z.string().describe("URL to the QuantSpace blob"),
        strategy_name: z.string().describe("Name of the strategy"),
        urgency: z.enum(["immediate", "session", "swing"]).default("session"),
        rationale: z.string().optional()
      },
      async (input) => {
        try {
          const res = await fetch(input.input_url);
          if (!res.ok) throw new Error(`Failed to fetch blob from ${input.input_url}`);
          const blob = await res.json() as any;
          if (!blob.weights || typeof blob.weights !== "object") throw new Error("Invalid blob format.");

          const strategyId = (await hmacSign(input.input_url, this.env.KILL_SWITCH_SECRET)).slice(0, 32);
          const metrics = blob.metrics || {};

          await db.run(
            `INSERT OR IGNORE INTO active_strategies 
             (strategy_id, provider_key_id, github_url, name, status, last_backtest_sharpe, last_backtest_beta, registered_at)
             VALUES (?, 'qca-dev-partner', ?, ?, 'active', ?, ?, ?)`,
            [strategyId, input.input_url, input.strategy_name, metrics.sharpe || 0, metrics.drawdown || 0, new Date().toISOString()]
          );

          const signalIds: string[] = [];
          for (const [symbol, weightRaw] of Object.entries(blob.weights)) {
            const weight = Number(weightRaw);
            if (weight === 0) continue;
            const direction = weight > 0 ? "long" : "short";
            const id = await insertAlphaSignal(db, {
              signal_id: generateId(),
              source: "external",
              generated_at: new Date().toISOString(),
              ttl_seconds: 3600,
              symbol: symbol.toUpperCase(),
              asset_class: "equity",
              direction,
              confidence: 0.85,
              urgency: input.urgency as any,
              horizon: 60,
              suggested_pct_equity: Math.abs(weight) * 100,
              rationale: `QuantSpace deployment: ${input.strategy_name}`,
              regime_tags: [],
              supporting_data: { quantspace_source: input.input_url, strategy_id: strategyId },
            });
            signalIds.push(id);
          }
          return { content: [{ type: "text", text: JSON.stringify(success({ strategy_id: strategyId, deployed_signals: signalIds.length, signal_ids: signalIds }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    // 2. signal-submit
    this.server.tool("signal-submit", "Submit alpha signal.", {
      symbol: z.string(), direction: z.enum(["long", "short", "neutral"]), confidence: z.number()
    }, async (input) => {
      try {
        const id = await insertAlphaSignal(db, {
          signal_id: generateId(), source: "external", generated_at: new Date().toISOString(),
          ttl_seconds: 3600, symbol: input.symbol.toUpperCase(), asset_class: "equity",
          direction: input.direction as any, confidence: input.confidence, urgency: "session",
          horizon: 60, rationale: "QuantX Signal", regime_tags: [], supporting_data: {},
        });
        return { content: [{ type: "text", text: JSON.stringify(success({ signal_id: id }), null, 2) }] };
      } catch (error) { return { content: [{ type: "text", text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true }; }
    });

    // 3. kill-switch
    this.server.tool("kill-switch", "Disable all trading and cancel open orders.", {}, async () => {
      try {
        await enableKillSwitch(db, "QuantX API global halt requested");
        const orders = await alpaca.trading.listOrders({ status: "open" });
        for (const order of orders) await alpaca.trading.cancelOrder(order.id);
        return { content: [{ type: "text", text: JSON.stringify(success({ kill_switch_active: true, cancelled_orders: orders.length }), null, 2) }] };
      } catch (error) { return { content: [{ type: "text", text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true }; }
    });

    // 4. deploy-report
    this.server.tool("deploy-report", "Get execution report.", { days: z.number().optional() }, async (input) => {
      try {
        const report = await getExecutionReport(db, { days: input.days || 30 });
        return { content: [{ type: "text", text: JSON.stringify(success(report), null, 2) }] };
      } catch (error) { return { content: [{ type: "text", text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true }; }
    });

    // 5. portfolio-risk
    this.server.tool("portfolio-risk", "Get risk status.", {}, async () => {
      try {
        const storedPolicy = await getPolicyConfig(db);
        const policy = storedPolicy ?? getDefaultPolicyConfig(this.env);
        const riskState = await getRiskState(db);
        return { content: [{ type: "text", text: JSON.stringify(success({ kill_switch_active: riskState.kill_switch_active, max_drawdown: policy.max_daily_loss_pct }), null, 2) }] };
      } catch (error) { return { content: [{ type: "text", text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true }; }
    });

    // 6. orders-preview (Simplified for QuantX Marketplace without KV cache overhead)
    this.server.tool("orders-preview", "Preview order and get approval token.", {
      symbol: z.string(), side: z.enum(["buy", "sell"]), qty: z.number().positive().optional(), notional: z.number().positive().optional(),
      order_type: z.enum(["market", "limit", "stop"]).default("market"),
    }, async (input) => {
      try {
        const [account, positions, clock, riskState, latestRegime] = await Promise.all([
          alpaca.trading.getAccount(), alpaca.trading.getPositions(), alpaca.trading.getClock(),
          getRiskState(db), getLatestRegime(db)
        ]);

        const candidateSymbol = input.symbol.toUpperCase();
        let estimatedPrice = 100; // Mock for simplicity in this proxy if quote fails
        try {
          const quote = await alpaca.marketData.getQuote(candidateSymbol);
          estimatedPrice = input.side === "buy" ? quote.ask_price : quote.bid_price;
        } catch {}
        
        const estimatedCost = input.notional ?? (input.qty ?? 0) * estimatedPrice;

        const preview = { symbol: candidateSymbol, side: input.side, qty: input.qty, notional: input.notional, order_type: input.order_type, estimated_price: estimatedPrice, estimated_cost: estimatedCost, time_in_force: "day" as any, stop_price: undefined, limit_price: undefined };
        const intent = { symbol: candidateSymbol, side: input.side, qty: input.qty, notional: input.notional, order_type: input.order_type, time_in_force: "day" as any, asset_class: "equity" as any, stop_price: undefined, limit_price: undefined, signal_confidence: undefined };

        const storedPolicy = await getPolicyConfig(db);
        const activePolicyConfig = storedPolicy ?? getDefaultPolicyConfig(this.env);
        const policyEngine = new PolicyEngine(activePolicyConfig);
        
        const policyResult = policyEngine.evaluate({
          order: preview, intent, account, positions, clock, riskState, latestRegime: latestRegime || undefined,
          factorLoadings: {}, correlationResults: [] // Simplified for proxy
        });

        if (policyResult.allowed) {
          const approval = await generateApprovalToken({ preview, policyResult, secret: this.env.KILL_SWITCH_SECRET, db, ttlSeconds: 300 });
          policyResult.approval_token = approval.token;
        }
        return { content: [{ type: "text", text: JSON.stringify(success({ preview, policy: policyResult }), null, 2) }] };
      } catch (error) { return { content: [{ type: "text", text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true }; }
    });

    // 7. orders-submit
    this.server.tool("orders-submit", "Execute order with token.", { approval_token: z.string() }, async ({ approval_token }) => {
      try {
        const validation = await validateApprovalToken({ token: approval_token, secret: this.env.KILL_SWITCH_SECRET, db });
        if (!validation.valid) throw new Error(validation.reason ?? "Invalid token");
        
        const orderParams = validation.order_params!;
        const clientOrderId = (await hmacSign(approval_token, this.env.KILL_SWITCH_SECRET)).slice(0, 48);

        const order = await alpaca.trading.createOrder({
          symbol: orderParams.symbol, qty: orderParams.qty, notional: orderParams.notional, side: orderParams.side,
          type: orderParams.order_type, time_in_force: "day", client_order_id: clientOrderId,
        });

        await consumeApprovalToken(db, validation.approval_id!);
        await createTrade(db, { approval_id: validation.approval_id, alpaca_order_id: order.id, symbol: order.symbol, side: order.side, qty: order.qty ? parseFloat(order.qty) : undefined, notional: orderParams.notional, order_type: order.type, status: order.status });
        return { content: [{ type: "text", text: JSON.stringify(success({ message: "Order submitted", order: { id: order.id, symbol: order.symbol, status: order.status } }), null, 2) }] };
      } catch (error) { return { content: [{ type: "text", text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true }; }
    });
  }
}
