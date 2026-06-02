import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env.d";
import { createD1Client, D1Client } from "../storage/d1/client";
import { createAlpacaProviders } from "../providers/alpaca";
import { getDefaultPolicyConfig, PolicyConfig } from "../policy/config";
import { getPolicyConfig } from "../storage/d1/queries/policy-config";
import { generateId } from "../lib/utils";
import { success, failure } from "./types";
import { ErrorCode } from "../lib/errors";
import { calculateCost } from "../lib/llm-costs";
import { insertToolLog } from "../storage/d1/queries/tool-logs";
import { getRiskState, enableKillSwitch, disableKillSwitch } from "../storage/d1/queries/risk-state";
import { PolicyEngine } from "../policy/engine";
import { TradeIntent } from "../policy/contract";
import { generateApprovalToken, validateApprovalToken, consumeApprovalToken } from "../policy/approval";
import { createKVClient } from "../storage/kv/client";
import type { KellyResult } from "../risk/kelly";
import type { VaRResult } from "../risk/var";
import type { CorrelationResult } from "../risk/correlation";
import { createTrade } from "../storage/d1/queries/trades";
import { hmacVerify, hmacSign } from "../lib/utils";
import {
  createJournalEntry,
  logOutcome,
  queryJournal,
  getJournalStats,
  getActiveRules,
  getPreferences,
  setPreferences,
} from "../storage/d1/queries/memory";
import {
  insertRawEvent,
  insertStructuredEvent,
  queryStructuredEvents,
  queryNewsItems,
  insertNewsItem,
} from "../storage/d1/queries/events";
import { computeTechnicals, detectSignals, type TechnicalIndicators, type Signal } from "../providers/technicals";
import { scrapeUrl, extractFinancialData, isAllowedDomain } from "../providers/scraper";
import { createOpenAIProvider } from "../providers/llm/openai";
import { createGeminiProvider } from "../providers/llm/gemini";
import { createOllamaProvider } from "../providers/llm/ollama";
import { classifyEvent, generateResearchReport, summarizeLearnedRules, generateTradingDecision } from "../providers/llm/classifier";
import { getDTE } from "../providers/alpaca/options";
import type { LLMProvider, OptionsProvider } from "../providers/types";
import type { OptionsOrderPreview } from "./types";
import {
  insertAlphaSignal,
  listRecentSignals,
  getPendingSignals,
  insertAggregatedSignal,
} from "../storage/d1/queries/signals";
import { getExecutionReport, recordExecutionFill } from "../storage/d1/queries/execution_fills";
import { aggregateSignals } from "../signals/aggregator";
import type { AlphaSignal } from "../signals/types";
import { DEFAULT_TTL } from "../signals/types";
import { detectRegime } from "../regime/detector";
import { insertRegimeSnapshot, getLatestRegime, listRegimeHistory } from "../storage/d1/queries/regime";
import { calculateKelly } from "../risk/kelly";
import { calculateSharpe } from "../risk/sharpe";
import { calculateVaR } from "../risk/var";
import { calculateCorrelation } from "../risk/correlation";
import { getFactorLoadings } from "../risk/factor";
import {
  getJournalReturns,
  getKellyInputs,
  insertKellySnapshot,
  insertSharpeSnapshot,
  insertVaRSnapshot,
  insertCorrelationSnapshot,
} from "../storage/d1/queries/risk_metrics";
import { calcSlippageMetrics } from "../execution/quality";
import { routeOrder } from "../execution/sor";

export class NightwatcherMcpAgent extends McpAgent<Env> {
  // @ts-ignore
  server = new McpServer({
    name: "nightwatcher",
    version: "0.1.0",
  });

  private requestId: string = "";
  private policyConfig: PolicyConfig | null = null;

  private llm: LLMProvider | null = null;
  private options: OptionsProvider | null = null;

  async init() {
    this.requestId = generateId();

    const db = createD1Client(this.env.DB);
    const alpaca = createAlpacaProviders(this.env);

    const storedPolicy = await getPolicyConfig(db);
    this.policyConfig = storedPolicy ?? getDefaultPolicyConfig(this.env);

    if (this.env.FEATURE_LLM_RESEARCH === "true") {
      const provider = this.env.LLM_PROVIDER?.toLowerCase();

      if (provider === "ollama") {
        this.llm = createOllamaProvider({
          apiKey: this.env.OLLAMA_API_KEY,
          baseUrl: this.env.OLLAMA_BASE_URL,
          model: this.env.OLLAMA_MODEL,
        });
      } else if (provider === "gemini" && this.env.GEMINI_API_KEY) {
        this.llm = createGeminiProvider({ apiKey: this.env.GEMINI_API_KEY });
      } else if (provider === "openai" && this.env.OPENAI_API_KEY) {
        this.llm = createOpenAIProvider({ apiKey: this.env.OPENAI_API_KEY });
      } else if (!provider) {
        // Backwards-compat: auto-detect from available keys (OpenAI takes priority)
        if (this.env.OPENAI_API_KEY) {
          this.llm = createOpenAIProvider({ apiKey: this.env.OPENAI_API_KEY });
        } else if (this.env.GEMINI_API_KEY) {
          this.llm = createGeminiProvider({ apiKey: this.env.GEMINI_API_KEY });
        } else if (this.env.OLLAMA_API_KEY) {
          this.llm = createOllamaProvider({
            apiKey: this.env.OLLAMA_API_KEY,
            model: this.env.OLLAMA_MODEL,
          });
        }
      }
      // If LLM_PROVIDER is set but the corresponding key is missing, llm remains null
    }

    this.options = alpaca.options;

    this.registerAuthTools(db, alpaca);
    this.registerAccountTools(db, alpaca);
    this.registerPositionTools(db, alpaca);
    this.registerOrderTools(db, alpaca);
    this.registerRiskTools(db, alpaca);
    this.registerMemoryTools(db);
    this.registerMarketDataTools(db, alpaca);
    this.registerTechnicalTools(db, alpaca);
    this.registerEventsTools(db);
    this.registerNewsTools(db);
    this.registerResearchTools(db, alpaca);
    this.registerOptionsTools();
    this.registerSignalTools(db);
    this.registerExecutionTools(db);
    this.registerAlgoTools();
    this.registerRegimeTools(db, alpaca);
    this.registerRiskQuantTools(db, alpaca);
    this.registerUtilityTools();
  }

  private registerAuthTools(db: ReturnType<typeof createD1Client>, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "auth-verify",
      "Verify that Alpaca API credentials are valid",
      {},
      async () => {
        const startTime = Date.now();
        try {
          const account = await alpaca.trading.getAccount();
          const result = success({
            verified: true,
            account_id: account.id,
            account_number: account.account_number,
            status: account.status,
            paper: this.env.ALPACA_PAPER === "true",
          });
          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "auth-verify",
            input: {},
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 1,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.UNAUTHORIZED, message: String(error) }), null, 2) }],
            isError: true,
          };
        }
      }
    );

    this.server.tool(
      "user-get",
      "Get user/session information and system configuration",
      {},
      async () => {
        const result = success({
          environment: this.env.ENVIRONMENT,
          paper_trading: this.env.ALPACA_PAPER === "true",
          features: {
            llm_research: this.env.FEATURE_LLM_RESEARCH === "true",
            options: this.env.FEATURE_OPTIONS === "true",
          },
          policy: {
            max_position_pct_equity: this.policyConfig!.max_position_pct_equity,
            max_notional_per_trade: this.policyConfig!.max_notional_per_trade,
            max_daily_loss_pct: this.policyConfig!.max_daily_loss_pct,
          },
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }

  private registerAccountTools(db: ReturnType<typeof createD1Client>, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "accounts-get",
      "Get detailed account information including buying power and equity",
      {},
      async () => {
        const startTime = Date.now();
        try {
          const account = await alpaca.trading.getAccount();
          const result = success(account);
          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "accounts-get",
            input: {},
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 1,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }],
            isError: true,
          };
        }
      }
    );

    this.server.tool(
      "portfolio-get",
      "Get comprehensive portfolio snapshot with positions and summary",
      {},
      async () => {
        const startTime = Date.now();
        try {
          const [account, positions, clock] = await Promise.all([
            alpaca.trading.getAccount(),
            alpaca.trading.getPositions(),
            alpaca.trading.getClock(),
          ]);

          const totalUnrealizedPl = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);

          const result = success({
            account: {
              equity: account.equity,
              cash: account.cash,
              buying_power: account.buying_power,
            },
            market: {
              is_open: clock.is_open,
              next_open: clock.next_open,
              next_close: clock.next_close,
            },
            positions: positions.map((p) => ({
              symbol: p.symbol,
              qty: p.qty,
              market_value: p.market_value,
              unrealized_pl: p.unrealized_pl,
              current_price: p.current_price,
            })),
            summary: {
              position_count: positions.length,
              total_unrealized_pl: totalUnrealizedPl,
            },
          });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "portfolio-get",
            input: {},
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 3,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }],
            isError: true,
          };
        }
      }
    );

    this.server.tool(
      "portfolio-history",
      "Get historical portfolio equity and P&L over a specific period",
      {
        period: z.enum(["1D", "1W", "1M", "1A"]).optional(),
        timeframe: z.enum(["1Min", "5Min", "15Min", "1H", "1D"]).optional(),
      },
      async ({ period, timeframe }) => {
        const startTime = Date.now();
        try {
          const history = await alpaca.trading.getPortfolioHistory(period, timeframe);
          const result = success(history);
          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "portfolio-history",
            input: { period, timeframe },
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 1,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  private registerPositionTools(db: ReturnType<typeof createD1Client>, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "positions-list",
      "List all current positions",
      { symbol: z.string().optional() },
      async ({ symbol }) => {
        try {
          const positions = await alpaca.trading.getPositions();
          const filtered = symbol
            ? positions.filter((p) => p.symbol.toUpperCase() === symbol.toUpperCase())
            : positions;

          const result = success({
            count: filtered.length,
            positions: filtered.map((p) => ({
              symbol: p.symbol,
              qty: p.qty,
              side: p.side,
              market_value: p.market_value,
              unrealized_pl: p.unrealized_pl,
              current_price: p.current_price,
            })),
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }],
            isError: true,
          };
        }
      }
    );

    this.server.tool(
      "positions-close",
      "Close a position (bypasses preview/submit but checks kill switch)",
      {
        symbol: z.string(),
        qty: z.number().positive().optional(),
        percentage: z.number().min(0).max(100).optional(),
      },
      async ({ symbol, qty, percentage }) => {
        try {
          const riskState = await getRiskState(db);
          if (riskState.kill_switch_active) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.KILL_SWITCH_ACTIVE, message: riskState.kill_switch_reason ?? "Kill switch active" }), null, 2) }],
              isError: true,
            };
          }

          const order = await alpaca.trading.closePosition(symbol, qty, percentage ? percentage / 100 : undefined);
          const result = success({ message: `Position close order submitted`, order: { id: order.id, symbol: order.symbol, status: order.status } });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  private registerOrderTools(db: ReturnType<typeof createD1Client>, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "orders-preview",
      "Preview order and get approval token. Does NOT execute. Use orders-submit with the token.",
      {
        symbol: z.string().min(1).max(10),
        side: z.enum(["buy", "sell"]),
        qty: z.number().positive().optional(),
        notional: z.number().positive().optional(),
        order_type: z.enum(["market", "limit", "stop", "stop_limit"]),
        limit_price: z.number().positive().optional(),
        stop_price: z.number().positive().optional(),
        time_in_force: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
        signal_confidence: z.number().min(0).max(1).optional(),
      },
      async (input) => {
        const startTime = Date.now();
        try {
          if (!input.qty && !input.notional) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_INPUT, message: "Either qty or notional required" }), null, 2) }], isError: true };
          }

          const [account, positions, clock, riskState, latestRegime] = await Promise.all([
            alpaca.trading.getAccount(),
            alpaca.trading.getPositions(),
            alpaca.trading.getClock(),
            getRiskState(db),
            getLatestRegime(db),
          ]);

          const candidateSymbol = input.symbol.toUpperCase();
          const existingHoldings = positions.filter(
            (p) => p.symbol.toUpperCase() !== candidateSymbol
          );

          // Instantiate KV Client for cache-aside risk calculations
          const kvClient = createKVClient(this.env.CACHE);

          // 1. Get or calculate Kelly Sizing Result
          let kellyResult: KellyResult | undefined = undefined;
          const cachedKelly = await kvClient.get<KellyResult>(`nightwatcher:cache:kelly:${candidateSymbol}`);
          if (cachedKelly) {
            kellyResult = cachedKelly;
          } else {
            const kellyInputs = await getKellyInputs(db, candidateSymbol, 200);
            kellyResult = kellyInputs
              ? calculateKelly({
                  win_rate: kellyInputs.win_rate,
                  avg_win_pct: kellyInputs.avg_win_pct,
                  avg_loss_pct: kellyInputs.avg_loss_pct,
                  fraction_cap: 0.25,
                })
              : undefined;
            if (kellyResult) {
              await kvClient.set(`nightwatcher:cache:kelly:${candidateSymbol}`, kellyResult, 86400); // 24-hour cache
            }
          }

          // 2. Get or calculate Portfolio VaR Result
          let varResult: VaRResult | undefined = undefined;
          const cachedVaR = await kvClient.get<VaRResult>(`nightwatcher:cache:var`);
          if (cachedVaR) {
            varResult = cachedVaR;
          } else {
            const portfolioReturns = await getJournalReturns(db, undefined, 200);
            varResult = calculateVaR({
              returns_pct: portfolioReturns,
              portfolio_value: account.equity,
              confidence: 0.95,
            });
            await kvClient.set(`nightwatcher:cache:var`, varResult, 86400); // 24-hour cache
          }

          // 3. Get or calculate Correlation Results against existing holdings
          const correlationResults: CorrelationResult[] = [];
          const missingHoldings: typeof existingHoldings = [];

          await Promise.all(
            existingHoldings.map(async (pos) => {
              const symbolB = pos.symbol.toUpperCase();
              const cachedCorr = await kvClient.get<CorrelationResult>(`nightwatcher:cache:corr:${candidateSymbol}:${symbolB}`);
              if (cachedCorr) {
                correlationResults.push(cachedCorr);
              } else {
                missingHoldings.push(pos);
              }
            })
          );

          if (missingHoldings.length > 0) {
            const [candidateReturns, ...holdingsReturns] = await Promise.all([
              getJournalReturns(db, candidateSymbol, 200),
              ...missingHoldings.map((p) => getJournalReturns(db, p.symbol.toUpperCase(), 200)),
            ]);

            await Promise.all(
              missingHoldings.map(async (pos, idx) => {
                const symbolB = pos.symbol.toUpperCase();
                const returnsB = holdingsReturns[idx] || [];
                const corr = calculateCorrelation({
                  returns_a: candidateReturns,
                  returns_b: returnsB,
                  symbol_a: candidateSymbol,
                  symbol_b: symbolB,
                  threshold: 0.70,
                });
                correlationResults.push(corr);
                await kvClient.set(`nightwatcher:cache:corr:${candidateSymbol}:${symbolB}`, corr, 86400); // 24-hour cache
              })
            );
          }

          let estimatedPrice = input.limit_price ?? input.stop_price;
          if (!estimatedPrice) {
            try {
              const quote = await alpaca.marketData.getQuote(input.symbol);
              estimatedPrice = input.side === "buy" ? quote.ask_price : quote.bid_price;
            } catch { estimatedPrice = 0; }
          }

          const estimatedCost = input.notional ?? (input.qty ?? 0) * estimatedPrice;

          const preview = {
            symbol: candidateSymbol,
            side: input.side,
            qty: input.qty,
            notional: input.notional,
            order_type: input.order_type,
            limit_price: input.limit_price,
            stop_price: input.stop_price,
            time_in_force: input.time_in_force,
            estimated_price: estimatedPrice,
            estimated_cost: estimatedCost,
          };

          const isCrypto = input.symbol.includes("/") || 
            ["BTC", "ETH", "SOL", "LTC", "BCH", "DOGE", "SHIB", "AVAX", "LINK", "UNI", "MATIC"]
              .some(c => candidateSymbol.startsWith(c) && candidateSymbol.endsWith("USD"));
          const asset_class = isCrypto ? "crypto" : "equity";

          const intent: TradeIntent = {
            symbol: candidateSymbol,
            side: input.side,
            qty: input.qty,
            notional: input.notional,
            order_type: input.order_type,
            limit_price: input.limit_price,
            stop_price: input.stop_price,
            time_in_force: input.time_in_force,
            asset_class,
            signal_confidence: input.signal_confidence,
          };

          // Scale max_position_pct_equity dynamically if we have a fresh market regime state
          const isRegimeFresh = latestRegime && new Date(latestRegime.expires_at).getTime() > Date.now();
          const activePolicyConfig = { ...this.policyConfig! };
          if (isRegimeFresh && latestRegime) {
            activePolicyConfig.max_position_pct_equity = this.policyConfig!.max_position_pct_equity * latestRegime.position_size_multiplier;
          }

          // Fetch Fama-French Factor Loadings from D1 for positions and the candidate symbol
          const factorSymbols = Array.from(new Set([candidateSymbol, ...positions.map((p) => p.symbol.toUpperCase())]));
          const factorLoadings = await getFactorLoadings(db, factorSymbols);

          const policyEngine = new PolicyEngine(activePolicyConfig);
          const policyResult = policyEngine.evaluate({
            order: preview,
            intent,
            account,
            positions,
            clock,
            riskState,
            kellyResult,
            varResult,
            correlationResults,
            latestRegime,
            factorLoadings,
          });

          if (policyResult.allowed) {
            const approval = await generateApprovalToken({
              preview,
              policyResult,
              secret: this.env.KILL_SWITCH_SECRET,
              db,
              ttlSeconds: this.policyConfig!.approval_token_ttl_seconds,
            });
            policyResult.approval_token = approval.token;
            policyResult.approval_id = approval.approval_id;
            policyResult.expires_at = approval.expires_at;
          }

          const result = success({ preview, policy: policyResult });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "orders-preview",
            input,
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 5,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "orders-submit",
      "Execute order with valid approval token from orders-preview",
      { approval_token: z.string().min(1) },
      async ({ approval_token }) => {
        const startTime = Date.now();
        try {
          const riskState = await getRiskState(db);
          if (riskState.kill_switch_active) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.KILL_SWITCH_ACTIVE, message: riskState.kill_switch_reason ?? "Kill switch active" }), null, 2) }], isError: true };
          }

          const validation = await validateApprovalToken({ token: approval_token, secret: this.env.KILL_SWITCH_SECRET, db });
          if (!validation.valid) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_APPROVAL_TOKEN, message: validation.reason ?? "Invalid token" }), null, 2) }], isError: true };
          }

          const orderParams = validation.order_params!;
          const clock = await alpaca.trading.getClock();
          if (!clock.is_open && orderParams.time_in_force === "day") {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.MARKET_CLOSED, message: "Market closed" }), null, 2) }], isError: true };
          }

          const clientOrderId = (await hmacSign(approval_token, this.env.KILL_SWITCH_SECRET)).slice(0, 48);

          const order = await alpaca.trading.createOrder({
            symbol: orderParams.symbol,
            qty: orderParams.qty,
            notional: orderParams.notional,
            side: orderParams.side,
            type: orderParams.order_type,
            time_in_force: orderParams.time_in_force,
            limit_price: orderParams.limit_price,
            stop_price: orderParams.stop_price,
            client_order_id: clientOrderId,
          });

          await consumeApprovalToken(db, validation.approval_id!);
          await createTrade(db, {
            approval_id: validation.approval_id,
            alpaca_order_id: order.id,
            symbol: order.symbol,
            side: order.side,
            qty: order.qty ? parseFloat(order.qty) : undefined,
            notional: orderParams.notional,
            order_type: order.type,
            status: order.status,
          });

          const result = success({ message: "Order submitted", order: { id: order.id, symbol: order.symbol, status: order.status } });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "orders-submit",
            input: { approval_token: "[REDACTED]" },
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 3,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "orders-list",
      "List orders",
      {
        status: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().min(1).max(500).default(50),
      },
      async ({ status, limit }) => {
        try {
          const orders = await alpaca.trading.listOrders({ status, limit });
          const result = success({
            count: orders.length,
            orders: orders.map((o) => ({
              id: o.id,
              symbol: o.symbol,
              side: o.side,
              qty: o.qty,
              type: o.type,
              status: o.status,
              created_at: o.created_at,
            })),
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "orders-cancel",
      "Cancel an order by ID",
      { order_id: z.string() },
      async ({ order_id }) => {
        try {
          await alpaca.trading.cancelOrder(order_id);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ message: `Order ${order_id} cancelled` }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerRiskTools(db: ReturnType<typeof createD1Client>, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "risk-status",
      "Get current risk status and limits",
      {},
      async () => {
        try {
          const [riskState, account, positions] = await Promise.all([
            getRiskState(db),
            alpaca.trading.getAccount(),
            alpaca.trading.getPositions(),
          ]);

          const totalExposure = positions.reduce((sum, p) => sum + Math.abs(p.market_value), 0);
          const dailyLossPct = riskState.daily_loss_usd / account.equity;

          const result = success({
            kill_switch: { active: riskState.kill_switch_active, reason: riskState.kill_switch_reason },
            daily_loss: { usd: riskState.daily_loss_usd, pct: dailyLossPct, limit_pct: this.policyConfig!.max_daily_loss_pct },
            cooldown: { active: riskState.cooldown_until ? new Date(riskState.cooldown_until) > new Date() : false },
            exposure: { total_usd: totalExposure, position_count: positions.length },
            limits: this.policyConfig,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "kill-switch-enable",
      "Enable kill switch to halt all trading",
      { reason: z.string().min(1) },
      async ({ reason }) => {
        try {
          await enableKillSwitch(db, reason);
          await alpaca.trading.cancelAllOrders();
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ message: "Kill switch enabled", reason }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "kill-switch-disable",
      "Disable kill switch (requires secret verification)",
      {
        confirmation: z.string(),
        secret_hash: z.string(),
      },
      async ({ confirmation, secret_hash }) => {
        try {
          if (confirmation !== "CONFIRM_RESUME_TRADING") {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_INPUT, message: "Type 'CONFIRM_RESUME_TRADING'" }), null, 2) }], isError: true };
          }
          const isValid = await hmacVerify("DISABLE_KILL_SWITCH", secret_hash, this.env.KILL_SWITCH_SECRET);
          if (!isValid) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.UNAUTHORIZED, message: "Invalid secret" }), null, 2) }], isError: true };
          }
          await disableKillSwitch(db);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ message: "Kill switch disabled" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerSignalTools(db: D1Client) {
    this.server.tool(
      "signal-submit",
      "Submit an alpha signal from any source (llm, technical, l2_microstructure, dark_pool, external, manual)",
      {
        source: z.enum(["llm", "technical", "l2_microstructure", "dark_pool", "external", "manual"]),
        symbol: z.string().min(1).max(10),
        asset_class: z.enum(["equity", "option", "future"]).default("equity"),
        direction: z.enum(["long", "short", "neutral"]),
        confidence: z.number().min(0).max(1),
        urgency: z.enum(["immediate", "session", "swing"]),
        horizon: z.number().positive().default(60),
        rationale: z.string().min(1),
        suggested_notional: z.number().positive().optional(),
        suggested_pct_equity: z.number().min(0).max(1).optional(),
        regime_tags: z.array(z.string()).default([]),
        supporting_data: z.record(z.unknown()).default({}),
        ttl_seconds: z.number().positive().optional(),
      },
      async (input) => {
        try {
          const signal: AlphaSignal = {
            signal_id: generateId(),
            source: input.source,
            generated_at: new Date().toISOString(),
            ttl_seconds: input.ttl_seconds ?? DEFAULT_TTL[input.urgency],
            symbol: input.symbol.toUpperCase(),
            asset_class: input.asset_class,
            direction: input.direction,
            confidence: input.confidence,
            urgency: input.urgency,
            horizon: input.horizon,
            suggested_notional: input.suggested_notional,
            suggested_pct_equity: input.suggested_pct_equity,
            rationale: input.rationale,
            regime_tags: input.regime_tags,
            supporting_data: input.supporting_data,
          };

          const id = await insertAlphaSignal(db, signal);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(success({ signal_id: id, symbol: signal.symbol, direction: signal.direction, confidence: signal.confidence, expires_in_seconds: signal.ttl_seconds }), null, 2),
            }],
          };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "signal-list",
      "List recent alpha signals with optional filtering",
      {
        symbol: z.string().optional(),
        source: z.enum(["llm", "technical", "l2_microstructure", "dark_pool", "external", "manual"]).optional(),
        direction: z.enum(["long", "short", "neutral"]).optional(),
        limit: z.number().min(1).max(100).default(20),
      },
      async (input) => {
        try {
          const signals = await listRecentSignals(db, {
            symbol: input.symbol,
            source: input.source,
            direction: input.direction,
            limit: input.limit,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ count: signals.length, signals }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "signal-aggregate",
      "Aggregate all pending signals for a symbol into a single directional verdict with conflict detection",
      { symbol: z.string().min(1) },
      async ({ symbol }) => {
        try {
          const [pending, latestRegime] = await Promise.all([
            getPendingSignals(db, symbol.toUpperCase()),
            getLatestRegime(db),
          ]);

          if (pending.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify(success({ symbol: symbol.toUpperCase(), pending_count: 0, result: null, message: "No live signals found" }), null, 2),
              }],
            };
          }

          const isRegimeFresh = latestRegime && new Date(latestRegime.expires_at).getTime() > Date.now();
          const convictionThresholdOverride = isRegimeFresh && latestRegime && latestRegime.confidence_threshold_override !== null
            ? latestRegime.confidence_threshold_override
            : undefined;

          const aggregated = aggregateSignals(pending, { convictionThresholdOverride });
          const aggId = await insertAggregatedSignal(db, aggregated);

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(success({
                symbol: symbol.toUpperCase(),
                pending_count: pending.length,
                aggregated_signal_id: aggId,
                final_direction: aggregated.final_direction,
                final_confidence: aggregated.final_confidence,
                conflict_detected: aggregated.conflict_detected,
                source_count: aggregated.source_count,
                contributing_sources: aggregated.contributing_signals.map((s) => s.source),
              }), null, 2),
            }],
          };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "portfolio-deploy",
      "Deploy a full portfolio from a QuantSpace optimization blob (JSON URL). Parses weights into AlphaSignals.",
      {
        input_url: z.string().url(),
        strategy_name: z.string().min(1),
        rationale: z.string().optional(),
        urgency: z.enum(["immediate", "session", "swing"]).default("session"),
        horizon_mins: z.number().positive().default(60),
      },
      async (input) => {
        try {
          const response = await fetch(input.input_url);
          if (!response.ok) {
            throw new Error(`Failed to fetch portfolio blob: ${response.statusText}`);
          }
          const blob = await response.json() as any;
          
          // QuantSpace standard schema: { weights: { SYMBOL: number }, metrics?: { sharpe: number, drawdown: number } }
          const weights = blob.weights || blob.portfolio || {};
          const symbols = Object.keys(weights);
          
          if (symbols.length === 0) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_INPUT, message: "Portfolio blob contains no weights" }), null, 2) }], isError: true };
          }

          const signalIds: string[] = [];
          for (const symbol of symbols) {
            const weight = weights[symbol];
            if (typeof weight !== "number") continue;

            const symUpper = symbol.toUpperCase();
            // Deterministic signal_id based on deployment context
            const signalId = (await hmacSign(`${input.input_url}:${symUpper}:${input.strategy_name}`, this.env.KILL_SWITCH_SECRET)).slice(0, 32);

            const signal: AlphaSignal = {
              signal_id: signalId,
              source: "external",
              generated_at: new Date().toISOString(),
              ttl_seconds: DEFAULT_TTL[input.urgency],
              symbol: symbol.toUpperCase(),
              asset_class: "equity",
              direction: weight > 0 ? "long" : weight < 0 ? "short" : "neutral",
              confidence: 0.85, // QuantSpace deployments are considered high-confidence
              urgency: input.urgency,
              horizon: input.horizon_mins,
              suggested_pct_equity: Math.abs(weight),
              rationale: input.rationale || `QuantSpace ${input.strategy_name} deployment re-weighting`,
              regime_tags: [],
              supporting_data: {
                quantspace_source: input.input_url,
                raw_weight: weight,
                backtest_metrics: blob.metrics || {}
              }
            };

            const id = await insertAlphaSignal(db, signal);
            signalIds.push(id);
          }

          // Save strategy provenance to active_strategies if metrics are available
          const metrics = blob.metrics || {};
          const strategyId = (await hmacSign(input.input_url, this.env.KILL_SWITCH_SECRET)).slice(0, 32);
          await db.run(
            `INSERT OR IGNORE INTO active_strategies 
             (strategy_id, provider_key_id, github_url, name, status, 
              last_backtest_sharpe, last_backtest_beta, registered_at)
             VALUES (?, 'qca-dev-partner', ?, ?, 'active', ?, ?, ?)`,
            [
              strategyId,
              input.input_url,
              input.strategy_name,
              metrics.sharpe || 0,
              metrics.drawdown || 0, // Mapping drawdown to beta slot as temporary proxy for risk
              new Date().toISOString()
            ]
          );

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(success({
                message: `Successfully ingested ${signalIds.length} signals from QuantSpace blob`,
                strategy_id: strategyId,
                signal_ids: signalIds,
                metrics_recorded: Object.keys(metrics).length > 0
              }), null, 2),
            }],
          };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerExecutionTools(db: D1Client) {
    this.server.tool(
      "execution-report",
      "Get execution quality analytics: slippage, fill latency, venue breakdown",
      {
        days: z.number().min(1).max(365).default(30),
        symbol: z.string().optional(),
      },
      async ({ days, symbol }) => {
        try {
          const report = await getExecutionReport(db, { days, symbol });
          return { content: [{ type: "text" as const, text: JSON.stringify(success(report), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "execution-record-fill",
      "Record execution fill quality data for a completed order",
      {
        trade_id: z.string().optional(),
        alpaca_order_id: z.string().optional(),
        symbol: z.string().min(1),
        side: z.enum(["buy", "sell"]),
        qty: z.number().positive(),
        fill_price: z.number().nonnegative().optional(),
        expected_price: z.number().nonnegative().optional(),
        vwap_at_fill: z.number().nonnegative().optional(),
        fill_latency_ms: z.number().nonnegative().optional(),
        partial_fill_pct: z.number().min(0).max(100).default(100),
        venue: z.string().default("alpaca"),
        algo_type: z.string().default("market"),
        dark_pool_pct: z.number().min(0).max(100).default(0),
        signal_id: z.string().optional(),
        aggregated_signal_id: z.string().optional(),
      },
      async (input) => {
        try {
          const id = await recordExecutionFill(db, input);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ fill_id: id, message: "Fill recorded" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerAlgoTools() {
    this.server.tool(
      "execution-sor-route",
      "Smart Order Router: given symbol, size, urgency, and signal context, recommend the best venue and execution algorithm. Returns venue (alpaca or institutional), algo type (market/limit), and routing notes. Institutional venue stub — defaults to alpaca until Richard's firm API is connected.",
      {
        symbol: z.string().min(1).max(10),
        side: z.enum(["buy", "sell"]),
        total_qty: z.number().int().positive(),
        notional_usd: z.number().positive().describe("Estimated trade value in USD (drives dark pool eligibility)"),
        urgency: z.enum(["immediate", "session", "swing"]).describe("immediate = execute now; session = today; swing = days"),
        signal_source: z.enum(["llm", "technical", "l2_microstructure", "dark_pool", "external", "manual"]).optional(),
        signal_confidence: z.number().min(0).max(1).optional(),
      },
      async (input) => {
        try {
          const decision = routeOrder({
            symbol: input.symbol,
            side: input.side,
            total_qty: input.total_qty,
            notional_usd: input.notional_usd,
            urgency: input.urgency,
            signal_source: input.signal_source,
            signal_confidence: input.signal_confidence,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(success(decision), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "execution-slippage-calc",
      "Calculate fill quality metrics for a completed order: slippage vs. expected price, vs. VWAP at fill, implementation shortfall, and an overall fill grade (excellent/good/fair/poor).",
      {
        side: z.enum(["buy", "sell"]),
        fill_price: z.number().nonnegative().describe("Actual average fill price"),
        expected_price: z.number().nonnegative().optional().describe("Pre-trade expected price (limit price or mid-quote at order time)"),
        vwap_at_fill: z.number().nonnegative().optional().describe("VWAP of the stock at the time of fill"),
        decision_price: z.number().nonnegative().optional().describe("Mid-quote when the trading decision was made (arrival price for implementation shortfall)"),
      },
      async (input) => {
        try {
          const metrics = calcSlippageMetrics({
            side: input.side,
            fill_price: input.fill_price,
            expected_price: input.expected_price,
            vwap_at_fill: input.vwap_at_fill,
            decision_price: input.decision_price,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(success(metrics), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerRegimeTools(db: D1Client, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "regime-detect",
      "Detect current market regime using SPY bars. Classifies into: trending_bull, trending_bear, range_bound, high_volatility, low_volatility, crisis. Persists result to D1 and KV.",
      {
        force_refresh: z.boolean().default(false).describe("Re-detect even if a fresh regime is cached"),
      },
      async ({ force_refresh }) => {
        try {
          // Check KV cache first unless forced
          if (!force_refresh) {
            const cached = await getLatestRegime(db);
            if (cached && new Date(cached.expires_at) > new Date()) {
              return { content: [{ type: "text" as const, text: JSON.stringify(success({ ...cached, cached: true }), null, 2) }] };
            }
          }

          // Fetch 30 daily bars for SPY (regime needs 20-day lookback + ADX buffer)
          const spyBars = await alpaca.marketData.getBars("SPY", "1Day", { limit: 35 });
          if (spyBars.length < 20) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_INPUT, message: "Insufficient SPY bar data for regime detection (need 20+ days)" }), null, 2) }], isError: true };
          }

          const state = detectRegime({ spyBars });
          await insertRegimeSnapshot(db, state);

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ ...state, cached: false }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "regime-history",
      "List recent regime snapshots to see how market conditions have shifted over time",
      {
        limit: z.number().min(1).max(100).default(20),
      },
      async ({ limit }) => {
        try {
          const history = await listRegimeHistory(db, limit);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ history, count: history.length }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerRiskQuantTools(db: D1Client, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "risk-kelly-size",
      "Compute Kelly criterion position size from trade journal history. Returns recommended % of equity to deploy based on historical win rate and payoff ratio. Capped at 25% to prevent overbetting.",
      {
        symbol: z.string().optional().describe("Symbol to filter trade history (omit for all symbols)"),
        kelly_fraction_cap: z.number().min(0.01).max(0.5).default(0.25).describe("Maximum Kelly fraction (default 0.25 = quarter-Kelly)"),
        lookback_trades: z.number().min(10).max(500).default(100).describe("Number of recent trades to include"),
      },
      async ({ symbol, kelly_fraction_cap, lookback_trades }) => {
        try {
          const inputs = await getKellyInputs(db, symbol, lookback_trades);
          if (!inputs) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_FOUND, message: `Insufficient trade history${symbol ? ` for ${symbol}` : ""} (need at least 5 trades with wins and losses)` }), null, 2) }], isError: true };
          }

          const result = calculateKelly({
            win_rate: inputs.win_rate,
            avg_win_pct: inputs.avg_win_pct,
            avg_loss_pct: inputs.avg_loss_pct,
            fraction_cap: kelly_fraction_cap,
          });

          await insertKellySnapshot(db, result, symbol);

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ ...result, n_trades: inputs.n, symbol: symbol ?? "all" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "risk-sharpe",
      "Compute rolling Sharpe ratio from trade journal returns. Uses per-trade pnl_pct as the return series. Higher is better; Sharpe > 1.0 is good, > 2.0 is excellent.",
      {
        symbol: z.string().optional().describe("Symbol to filter (omit for portfolio-level Sharpe)"),
        risk_free_annual_pct: z.number().min(0).max(20).default(5.0).describe("Annualized risk-free rate % (default 5.0)"),
        lookback_trades: z.number().min(10).max(500).default(200).describe("Number of recent trades to include"),
      },
      async ({ symbol, risk_free_annual_pct, lookback_trades }) => {
        try {
          const returns = await getJournalReturns(db, symbol, lookback_trades);
          if (returns.length < 5) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_FOUND, message: `Insufficient trade history${symbol ? ` for ${symbol}` : ""} (need at least 5 trades)` }), null, 2) }], isError: true };
          }

          const result = calculateSharpe({
            returns,
            risk_free_annual_pct,
            periods_per_year: 252,
          });

          await insertSharpeSnapshot(db, result, symbol);

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ ...result, symbol: symbol ?? "portfolio" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "risk-var",
      "Compute historical Value at Risk (VaR) and Conditional VaR (Expected Shortfall) from trade journal returns. Answers: how much can I lose at 95% or 99% confidence?",
      {
        confidence: z.enum(["0.95", "0.99"]).default("0.95").describe("Confidence level"),
        symbol: z.string().optional().describe("Symbol to filter (omit for portfolio-level VaR)"),
        lookback_trades: z.number().min(10).max(500).default(200).describe("Number of recent trades to include"),
      },
      async ({ confidence, symbol, lookback_trades }) => {
        try {
          const returns = await getJournalReturns(db, symbol, lookback_trades);
          if (returns.length < 10) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_FOUND, message: `Insufficient trade history${symbol ? ` for ${symbol}` : ""} (need at least 10 trades)` }), null, 2) }], isError: true };
          }

          // Fetch portfolio equity for USD VaR calculation
          const account = await alpaca.trading.getAccount();
          const portfolio_value = account.equity ?? account.portfolio_value ?? 10000;

          const result = calculateVaR({
            returns_pct: returns,
            portfolio_value,
            confidence: parseFloat(confidence),
          });

          await insertVaRSnapshot(db, result, symbol);

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ ...result, symbol: symbol ?? "portfolio", portfolio_value }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "risk-correlation-check",
      "Check Pearson correlation between two symbols using recent daily price bar returns. High correlation (> threshold) means adding both increases concentration risk. Uses market returns, not sparse trade history.",
      {
        symbol_a: z.string().describe("First symbol"),
        symbol_b: z.string().describe("Second symbol"),
        lookback_days: z.number().min(20).max(252).default(60).describe("Number of trading days for correlation window"),
        threshold: z.number().min(0.3).max(0.99).default(0.7).describe("Correlation above this flags concentration risk"),
      },
      async ({ symbol_a, symbol_b, lookback_days, threshold }) => {
        try {
          const [barsA, barsB] = await Promise.all([
            alpaca.marketData.getBars(symbol_a.toUpperCase(), "1Day", { limit: lookback_days + 1 }),
            alpaca.marketData.getBars(symbol_b.toUpperCase(), "1Day", { limit: lookback_days + 1 }),
          ]);

          if (barsA.length < 10 || barsB.length < 10) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_FOUND, message: "Insufficient bar data for one or both symbols" }), null, 2) }], isError: true };
          }

          // Compute daily log returns from close prices
          const toReturns = (bars: typeof barsA) =>
            bars.slice(1).map((bar, i) => {
              const prev = bars[i]!;
              return prev.c > 0 ? ((bar.c - prev.c) / prev.c) * 100 : 0;
            });

          const result = calculateCorrelation({
            returns_a: toReturns(barsA),
            returns_b: toReturns(barsB),
            symbol_a: symbol_a.toUpperCase(),
            symbol_b: symbol_b.toUpperCase(),
            threshold,
          });

          await insertCorrelationSnapshot(db, result);

          return { content: [{ type: "text" as const, text: JSON.stringify(success(result), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerUtilityTools() {
    this.server.tool(
      "help-usage",
      "Get help information about using Nightwatcher",
      {},
      async () => {
        const result = success({
          name: "Nightwatcher MCP Trading Server",
          version: "0.1.0",
          order_flow: ["1. orders-preview -> get approval_token", "2. orders-submit with token"],
          quick_start: ["auth-verify", "portfolio-get", "risk-status", "orders-preview", "orders-submit"],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );

    this.server.tool(
      "catalog-list",
      "List all available tools",
      {},
      async () => {
        const catalog = [
          { category: "Auth", tools: ["auth-verify", "user-get"] },
          { category: "Account", tools: ["accounts-get", "portfolio-get"] },
          { category: "Positions", tools: ["positions-list", "positions-close"] },
          { category: "Orders", tools: ["orders-preview", "orders-submit", "orders-list", "orders-cancel"] },
          { category: "Risk", tools: ["risk-status", "kill-switch-enable", "kill-switch-disable"] },
          { category: "Memory", tools: ["memory-log-trade", "memory-log-outcome", "memory-query", "memory-summarize", "memory-set-preferences"] },
          { category: "Market Data", tools: ["symbol-overview", "prices-bars", "market-clock", "market-movers"] },
          { category: "Technicals", tools: ["technicals-get", "signals-get", "signals-batch"] },
          { category: "Events", tools: ["events-ingest", "events-list", "events-classify"] },
          { category: "News", tools: ["news-list", "news-index"] },
          { category: "Research", tools: ["symbol-research", "web-scrape-financial"] },
          { category: "Options", tools: ["options-expirations", "options-chain", "options-snapshot", "options-order-preview", "options-order-submit"] },
          { category: "Signal", tools: ["signal-submit", "signal-list", "signal-aggregate"] },
          { category: "Execution", tools: ["execution-report", "execution-record-fill"] },
          { category: "Execution Algos", tools: ["execution-sor-route", "execution-slippage-calc"] },
          { category: "Regime", tools: ["regime-detect", "regime-history"] },
          { category: "Risk Quant", tools: ["risk-kelly-size", "risk-sharpe", "risk-var", "risk-correlation-check"] },
          { category: "Utility", tools: ["help-usage", "catalog-list"] },
        ];
        return { content: [{ type: "text" as const, text: JSON.stringify(success({ catalog }), null, 2) }] };
      }
    );
  }

  private registerMemoryTools(db: D1Client) {
    this.server.tool(
      "memory-log-trade",
      "Log a trade entry to the journal for later analysis",
      {
        symbol: z.string().min(1),
        side: z.enum(["buy", "sell"]),
        qty: z.number().positive(),
        entry_price: z.number().positive().optional(),
        trade_id: z.string().optional(),
        signals: z.record(z.unknown()).optional(),
        technicals: z.record(z.unknown()).optional(),
        regime_tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
      async (input) => {
        try {
          const journalId = await createJournalEntry(db, {
            symbol: input.symbol.toUpperCase(),
            side: input.side,
            qty: input.qty,
            entry_price: input.entry_price,
            trade_id: input.trade_id,
            signals: input.signals,
            technicals: input.technicals,
            regime_tags: input.regime_tags,
            notes: input.notes,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ journal_id: journalId, message: "Trade logged" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "memory-log-outcome",
      "Log the outcome of a previously logged trade",
      {
        journal_id: z.string().min(1),
        exit_price: z.number().positive(),
        pnl_usd: z.number(),
        pnl_pct: z.number(),
        hold_duration_mins: z.number().nonnegative(),
        outcome: z.enum(["win", "loss", "scratch"]),
        lessons_learned: z.string().optional(),
      },
      async (input) => {
        try {
          await logOutcome(db, {
            journal_id: input.journal_id,
            exit_price: input.exit_price,
            pnl_usd: input.pnl_usd,
            pnl_pct: input.pnl_pct,
            hold_duration_mins: input.hold_duration_mins,
            outcome: input.outcome,
            lessons_learned: input.lessons_learned,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ message: "Outcome logged" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "memory-query",
      "Query journal entries and trading statistics",
      {
        symbol: z.string().optional(),
        outcome: z.enum(["win", "loss", "scratch"]).optional(),
        regime_tag: z.string().optional(),
        days: z.number().min(1).max(365).default(30),
        limit: z.number().min(1).max(100).default(20),
      },
      async (input) => {
        try {
          const [entries, stats, rules] = await Promise.all([
            queryJournal(db, { symbol: input.symbol, outcome: input.outcome, regime_tag: input.regime_tag, limit: input.limit }),
            getJournalStats(db, { symbol: input.symbol, days: input.days }),
            getActiveRules(db),
          ]);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ entries, stats, active_rules: rules.length }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "memory-summarize",
      "Use LLM to analyze trading history and extract patterns (requires LLM feature)",
      { days: z.number().min(1).max(365).default(30) },
      async (_input) => {
        const startTime = Date.now();
        if (!this.llm) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "LLM feature not enabled" }), null, 2) }], isError: true };
        }
        try {
          const entries = await queryJournal(db, { limit: 50 });
          const mapped = entries.map((e) => ({
            symbol: e.symbol,
            side: e.side,
            outcome: e.outcome ?? "unknown",
            pnl_pct: e.pnl_pct ?? 0,
            regime_tags: e.regime_tags ?? "",
            signals: e.signals_json ?? "",
            notes: e.notes ?? "",
          }));
          const { summary, usage } = await summarizeLearnedRules(this.llm, mapped);

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "memory-summarize",
            input: { entries_count: mapped.length },
            output: { summary_length: summary.length },
            latency_ms: Date.now() - startTime,
            provider_calls: 1,
            model_name: this.env.OLLAMA_MODEL || "gemma4:26b",
            prompt_tokens: usage?.prompt_tokens,
            completion_tokens: usage?.completion_tokens,
            estimated_cost_usd: usage ? calculateCost(this.env.OLLAMA_MODEL || "gemma4:26b", usage) : 0,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ summary, entries_analyzed: entries.length }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "memory-set-preferences",
      "Store user trading preferences",
      { preferences: z.record(z.unknown()) },
      async ({ preferences }) => {
        try {
          await setPreferences(db, preferences);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ message: "Preferences saved" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "memory-get-preferences",
      "Get stored user trading preferences",
      {},
      async () => {
        try {
          const preferences = await getPreferences(db);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ preferences }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerMarketDataTools(db: D1Client, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "symbol-overview",
      "Get comprehensive overview of a symbol including price, position, and recent bars",
      { symbol: z.string().min(1) },
      async ({ symbol }) => {
        const startTime = Date.now();
        try {
          const [snapshot, bars, positions] = await Promise.all([
            alpaca.marketData.getSnapshot(symbol.toUpperCase()),
            alpaca.marketData.getBars(symbol.toUpperCase(), "1Day", { limit: 5 }),
            alpaca.trading.getPositions(),
          ]);

          const position = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());

          const result = success({
            symbol: symbol.toUpperCase(),
            latest_price: snapshot.latest_trade.price,
            bid: snapshot.latest_quote.bid_price,
            ask: snapshot.latest_quote.ask_price,
            daily_bar: snapshot.daily_bar,
            prev_close: snapshot.prev_daily_bar.c,
            change_pct: ((snapshot.daily_bar.c - snapshot.prev_daily_bar.c) / snapshot.prev_daily_bar.c) * 100,
            volume: snapshot.daily_bar.v,
            recent_bars: bars.slice(-5),
            position: position ? { qty: position.qty, unrealized_pl: position.unrealized_pl, avg_entry: position.avg_entry_price } : null,
          });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "symbol-overview",
            input: { symbol },
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 3,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "prices-bars",
      "Get historical price bars for a symbol",
      {
        symbol: z.string().min(1),
        timeframe: z.enum(["1Min", "5Min", "15Min", "1Hour", "1Day"]).default("1Day"),
        limit: z.number().min(1).max(1000).default(100),
        start: z.string().optional(),
        end: z.string().optional(),
      },
      async ({ symbol, timeframe, limit, start, end }) => {
        try {
          const bars = await alpaca.marketData.getBars(symbol.toUpperCase(), timeframe, { limit, start, end });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ symbol: symbol.toUpperCase(), timeframe, count: bars.length, bars }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "prices-bars-batch",
      "Get historical price bars for multiple symbols at once",
      {
        symbols: z.array(z.string()).min(1).max(150),
        timeframe: z.enum(["1Min", "5Min", "15Min", "1Hour", "1Day"]).default("1Day"),
        limit: z.number().min(1).max(1000).default(100),
        start: z.string().optional(),
        end: z.string().optional(),
      },
      async ({ symbols, timeframe, limit, start, end }) => {
        try {
          const barsMap = await alpaca.marketData.getMultiBars(symbols.map((s) => s.toUpperCase()), timeframe, { limit, start, end });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ count: Object.keys(barsMap).length, bars: barsMap }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "market-clock",
      "Get current market clock status",
      {},
      async () => {
        try {
          const clock = await alpaca.trading.getClock();
          return { content: [{ type: "text" as const, text: JSON.stringify(success(clock), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "market-movers",
      "Get top gainers and losers from watchlist symbols",
      { symbols: z.array(z.string()).min(1).max(50) },
      async ({ symbols }) => {
        try {
          const snapshots = await alpaca.marketData.getSnapshots(symbols.map((s) => s.toUpperCase()));
          const movers = Object.entries(snapshots).map(([sym, snap]) => ({
            symbol: sym,
            price: snap.daily_bar.c,
            change_pct: ((snap.daily_bar.c - snap.prev_daily_bar.c) / snap.prev_daily_bar.c) * 100,
            volume: snap.daily_bar.v,
          }));
          movers.sort((a, b) => b.change_pct - a.change_pct);
          const gainers = movers.filter((m) => m.change_pct > 0).slice(0, 10);
          const losers = movers.filter((m) => m.change_pct < 0).sort((a, b) => a.change_pct - b.change_pct).slice(0, 10);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ gainers, losers }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "quotes-batch",
      "Get latest quotes for multiple symbols",
      { symbols: z.array(z.string()).min(1).max(100) },
      async ({ symbols }) => {
        try {
          const quotes = await alpaca.marketData.getQuotes(symbols.map((s) => s.toUpperCase()));
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ count: Object.keys(quotes).length, quotes }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "prices-snapshots",
      "Get snapshots (latest trade, quote, daily bar, prior close) for multiple symbols at once",
      { symbols: z.array(z.string()).min(1).max(150) },
      async ({ symbols }) => {
        try {
          const snapshots = await alpaca.marketData.getSnapshots(symbols.map((s) => s.toUpperCase()));
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ count: Object.keys(snapshots).length, snapshots }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerTechnicalTools(_db: D1Client, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "technicals-get",
      "Calculate technical indicators for a symbol",
      {
        symbol: z.string().min(1),
        timeframe: z.enum(["1Min", "5Min", "15Min", "1Hour", "1Day"]).default("1Day"),
      },
      async ({ symbol, timeframe }) => {
        try {
          const bars = await alpaca.marketData.getBars(symbol.toUpperCase(), timeframe, { limit: 250 });
          if (bars.length < 20) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_INPUT, message: "Insufficient data for technical analysis" }), null, 2) }], isError: true };
          }
          const technicals = computeTechnicals(symbol.toUpperCase(), bars);
          return { content: [{ type: "text" as const, text: JSON.stringify(success(technicals), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "signals-get",
      "Detect trading signals from technical indicators for a symbol",
      {
        symbol: z.string().min(1),
        timeframe: z.enum(["1Min", "5Min", "15Min", "1Hour", "1Day"]).default("1Day"),
      },
      async ({ symbol, timeframe }) => {
        try {
          const bars = await alpaca.marketData.getBars(symbol.toUpperCase(), timeframe, { limit: 250 });
          if (bars.length < 20) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_INPUT, message: "Insufficient data for signal detection" }), null, 2) }], isError: true };
          }
          const technicals = computeTechnicals(symbol.toUpperCase(), bars);
          const signals = detectSignals(technicals);
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ symbol: symbol.toUpperCase(), timeframe, technicals, signals }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "signals-batch",
      "Detect trading signals for multiple symbols at once",
      {
        symbols: z.array(z.string()).min(1).max(150),
        timeframe: z.enum(["1Min", "5Min", "15Min", "1Hour", "1Day"]).default("1Day"),
      },
      async ({ symbols, timeframe }) => {
        try {
          const results: Array<{ symbol: string; technicals: TechnicalIndicators; signals: Signal[] }> = [];
          const multiBars = await alpaca.marketData.getMultiBars(symbols.map(s => s.toUpperCase()), timeframe, { limit: 250 });

          for (const sym of symbols) {
            const symUpper = sym.toUpperCase();
            try {
              const bars = multiBars[symUpper];
              if (bars && bars.length >= 20) {
                const technicals = computeTechnicals(symUpper, bars);
                const signals = detectSignals(technicals);
                results.push({ symbol: symUpper, technicals, signals });
              }
            } catch {
              continue;
            }
          }

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ count: results.length, results }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerEventsTools(db: D1Client) {
    this.server.tool(
      "events-ingest",
      "Manually ingest a raw event for processing",
      {
        source: z.string().min(1),
        source_id: z.string().min(1),
        content: z.string().min(1),
      },
      async ({ source, source_id, content }) => {
        try {
          const eventId = await insertRawEvent(db, { source, source_id, raw_content: content });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ event_id: eventId, message: "Event ingested" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "events-list",
      "List structured events with optional filtering",
      {
        event_type: z.string().optional(),
        symbol: z.string().optional(),
        validated: z.boolean().optional(),
        limit: z.number().min(1).max(100).default(20),
      },
      async (input) => {
        try {
          const events = await queryStructuredEvents(db, {
            event_type: input.event_type,
            symbol: input.symbol,
            validated: input.validated,
            limit: input.limit,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ count: events.length, events }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "events-classify",
      "Use LLM to classify raw content into structured event (requires LLM feature)",
      {
        content: z.string().min(1),
        store: z.boolean().default(true),
      },
      async ({ content, store }) => {
        const startTime = Date.now();
        if (!this.llm) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "LLM feature not enabled" }), null, 2) }], isError: true };
        }
        try {
          const { event_type, symbols, summary, confidence, usage } = await classifyEvent(this.llm, content);
          let eventId: string | null = null;

          if (store) {
            eventId = await insertStructuredEvent(db, {
              event_type,
              symbols,
              summary,
              confidence,
              validated: false,
            });
          }

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "events-classify",
            input: { content_length: content.length, store },
            output: { event_type, symbols, summary, confidence },
            latency_ms: Date.now() - startTime,
            provider_calls: 1,
            model_name: this.env.OLLAMA_MODEL || "gemma4:26b",
            prompt_tokens: usage?.prompt_tokens,
            completion_tokens: usage?.completion_tokens,
            estimated_cost_usd: usage ? calculateCost(this.env.OLLAMA_MODEL || "gemma4:26b", usage) : 0,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ event_type, symbols, summary, confidence, event_id: eventId }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerNewsTools(db: D1Client) {
    this.server.tool(
      "news-list",
      "List recent news items with optional filtering",
      {
        symbol: z.string().optional(),
        source: z.string().optional(),
        limit: z.number().min(1).max(100).default(20),
      },
      async (input) => {
        try {
          const news = await queryNewsItems(db, {
            symbol: input.symbol,
            source: input.source,
            limit: input.limit,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ count: news.length, news }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "news-index",
      "Manually index a news item",
      {
        source: z.string().min(1),
        source_id: z.string().min(1),
        headline: z.string().min(1),
        summary: z.string().optional(),
        url: z.string().url().optional(),
        symbols: z.array(z.string()).default([]),
        published_at: z.string().optional(),
      },
      async (input) => {
        try {
          const newsId = await insertNewsItem(db, {
            source: input.source,
            source_id: input.source_id,
            headline: input.headline,
            summary: input.summary,
            url: input.url,
            symbols: input.symbols.map((s) => s.toUpperCase()),
            published_at: input.published_at,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ news_id: newsId, message: "News indexed" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerResearchTools(db: D1Client, alpaca: ReturnType<typeof createAlpacaProviders>) {
    this.server.tool(
      "symbol-research",
      "Generate comprehensive research report for a symbol (requires LLM feature)",
      { symbol: z.string().min(1) },
      async ({ symbol }) => {
        const startTime = Date.now();
        if (!this.llm) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "LLM feature not enabled" }), null, 2) }], isError: true };
        }
        try {
          const [snapshot, bars, positions, news] = await Promise.all([
            alpaca.marketData.getSnapshot(symbol.toUpperCase()),
            alpaca.marketData.getBars(symbol.toUpperCase(), "1Day", { limit: 60 }),
            alpaca.trading.getPositions(),
            queryNewsItems(db, { symbol: symbol.toUpperCase(), limit: 5 }),
          ]);

          const technicals = computeTechnicals(symbol.toUpperCase(), bars);
          const position = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());

          const { report, usage } = await generateResearchReport(this.llm, symbol.toUpperCase(), {
            overview: {
              price: snapshot.latest_trade.price,
              change_pct: ((snapshot.daily_bar.c - snapshot.prev_daily_bar.c) / snapshot.prev_daily_bar.c) * 100,
              volume: snapshot.daily_bar.v,
            },
            recentNews: news.map((n) => ({ headline: n.headline, date: n.published_at ?? n.created_at })),
            technicals: technicals as unknown as Record<string, unknown>,
            positions: position ? [{ qty: position.qty, avg_entry_price: position.avg_entry_price }] : [],
          });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "symbol-research",
            input: { symbol },
            output: { report_length: report.length },
            latency_ms: Date.now() - startTime,
            provider_calls: 5,
            model_name: this.env.OLLAMA_MODEL || "gemma4:26b",
            prompt_tokens: usage?.prompt_tokens,
            completion_tokens: usage?.completion_tokens,
            estimated_cost_usd: usage ? calculateCost(this.env.OLLAMA_MODEL || "gemma4:26b", usage) : 0,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ symbol: symbol.toUpperCase(), report }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "llm-prompt",
      "Run a raw prompt against the configured LLM",
      { prompt: z.string().min(1) },
      async ({ prompt }) => {
        if (!this.llm) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "LLM feature not enabled" }), null, 2) }], isError: true };
        }
        try {
          const res = await this.llm.complete({ messages: [{ role: "user", content: prompt }] });
          return { content: [{ type: "text" as const, text: JSON.stringify(success(res.content), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "symbol-analyze",
      "Analyze a symbol using AI to get a structured trading decision (BUY/SELL/HOLD + Confidence)",
      { symbol: z.string() },
      async ({ symbol }) => {
        const startTime = Date.now();
        const db = createD1Client(this.env.DB);
        const alpaca = createAlpacaProviders(this.env);

        if (!this.llm) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "LLM not configured" }), null, 2) }], isError: true };
        }

        try {
          // 1. Get Technicals
          const bars = await alpaca.marketData.getBars(symbol.toUpperCase(), "1Day", { limit: 100 });
          const technicals = computeTechnicals(symbol, bars);

          // 2. Get News (optional, simplified for beta)
          const news: any[] = [];

          // 3. Generate Decision
          // @ts-ignore - generateTradingDecision is newly added
          const { verdict, confidence, reasoning, usage } = await generateTradingDecision(
            this.llm,
            symbol,
            technicals.price,
            technicals,
            news
          );

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "symbol-analyze",
            input: { symbol },
            output: { verdict, confidence, reasoning },
            latency_ms: Date.now() - startTime,
            provider_calls: 1,
            model_name: this.env.OLLAMA_MODEL || "gemma4:26b",
            prompt_tokens: usage?.prompt_tokens,
            completion_tokens: usage?.completion_tokens,
            estimated_cost_usd: usage ? calculateCost(this.env.OLLAMA_MODEL || "gemma4:26b", usage) : 0,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(success({ verdict, confidence, reasoning }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "web-scrape-financial",
      "Scrape financial data from allowed domains (finance.yahoo.com, sec.gov, stockanalysis.com, companiesmarketcap.com)",
      {
        url: z.string().url(),
        symbol: z.string().optional(),
      },
      async ({ url, symbol }) => {
        if (!isAllowedDomain(url)) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.FORBIDDEN, message: "Domain not in allowlist" }), null, 2) }], isError: true };
        }
        try {
          const scraped = await scrapeUrl(url);
          const financialData = symbol ? extractFinancialData(scraped.text, symbol) : null;
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ ...scraped, financial_data: financialData }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
    this.server.tool(
      "llm-usage-stats",
      "Get aggregated LLM usage and cost statistics from D1 logs",
      { days: z.number().min(1).max(365).default(30) },
      async (input) => {
        try {
          const stats = await db.executeOne<{
            total_usd: number;
            calls: number;
            tokens_in: number;
            tokens_out: number;
            top_model: string;
          }>(
            `SELECT 
               SUM(estimated_cost_usd) as total_usd,
               COUNT(*) as calls,
               SUM(prompt_tokens) as tokens_in,
               SUM(completion_tokens) as tokens_out,
               (SELECT model_name FROM tool_logs GROUP BY model_name ORDER BY COUNT(*) DESC LIMIT 1) as top_model
             FROM tool_logs 
             WHERE created_at > datetime('now', ?) AND model_name IS NOT NULL`,
            [`-${input.days} days`]
          );
          return { content: [{ type: "text" as const, text: JSON.stringify(success(stats || { total_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0, top_model: "none" }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private registerOptionsTools() {
    this.server.tool(
      "options-expirations",
      "Get available option expiration dates for a symbol",
      { underlying: z.string().min(1) },
      async ({ underlying }) => {
        if (!this.options || !this.options.isConfigured()) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "Options provider not configured" }), null, 2) }], isError: true };
        }
        try {
          const expirations = await this.options.getExpirations(underlying.toUpperCase());
          return { content: [{ type: "text" as const, text: JSON.stringify(success({ underlying: underlying.toUpperCase(), expirations }), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "options-chain",
      "Get options chain for a symbol and expiration",
      {
        underlying: z.string().min(1),
        expiration: z.string().min(1),
      },
      async ({ underlying, expiration }) => {
        if (!this.options || !this.options.isConfigured()) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "Options provider not configured" }), null, 2) }], isError: true };
        }
        try {
          const chain = await this.options.getChain(underlying.toUpperCase(), expiration);
          return { content: [{ type: "text" as const, text: JSON.stringify(success(chain), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "options-snapshot",
      "Get current snapshot for an options contract",
      { contract_symbol: z.string().min(1) },
      async ({ contract_symbol }) => {
        if (!this.options || !this.options.isConfigured()) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "Options provider not configured" }), null, 2) }], isError: true };
        }
        try {
          const snapshot = await this.options.getSnapshot(contract_symbol);
          return { content: [{ type: "text" as const, text: JSON.stringify(success(snapshot), null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "options-order-preview",
      "Preview options order and get approval token. Does NOT execute. Use options-order-submit with the token.",
      {
        contract_symbol: z.string().min(1),
        side: z.enum(["buy", "sell"]),
        qty: z.number().int().positive(),
        order_type: z.enum(["market", "limit"]),
        limit_price: z.number().positive().optional(),
        time_in_force: z.enum(["day", "gtc"]).default("day"),
        signal_confidence: z.number().min(0).max(1).optional(),
      },
      async (input) => {
        const startTime = Date.now();
        const db = createD1Client(this.env.DB);
        const alpaca = createAlpacaProviders(this.env);

        if (!this.options || !this.options.isConfigured()) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "Options provider not configured" }), null, 2) }], isError: true };
        }

        try {
          const [account, positions, clock, riskState, snapshot, latestRegime] = await Promise.all([
            alpaca.trading.getAccount(),
            alpaca.trading.getPositions(),
            alpaca.trading.getClock(),
            getRiskState(db),
            this.options.getSnapshot(input.contract_symbol),
            getLatestRegime(db),
          ]);

          const contractParts = this.parseOptionsSymbol(input.contract_symbol);
          if (!contractParts) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_INPUT, message: "Invalid options contract symbol" }), null, 2) }], isError: true };
          }

          const dte = getDTE(contractParts.expiration);
          const estimatedPremium = input.limit_price ?? (input.side === "buy" ? snapshot.latest_quote.ask_price : snapshot.latest_quote.bid_price);
          const estimatedCost = input.qty * estimatedPremium * 100;

          const preview: OptionsOrderPreview = {
            contract_symbol: input.contract_symbol.toUpperCase(),
            underlying: contractParts.underlying,
            side: input.side,
            qty: input.qty,
            order_type: input.order_type,
            limit_price: input.limit_price,
            time_in_force: input.time_in_force,
            expiration: contractParts.expiration,
            strike: contractParts.strike,
            option_type: contractParts.type,
            dte,
            delta: snapshot.greeks?.delta,
            estimated_premium: estimatedPremium,
            estimated_cost: estimatedCost,
          };

          // Scale max_position_pct_equity dynamically if we have a fresh market regime state
          const isRegimeFresh = latestRegime && new Date(latestRegime.expires_at).getTime() > Date.now();
          const activePolicyConfig = { ...this.policyConfig! };
          if (isRegimeFresh && latestRegime) {
            activePolicyConfig.max_position_pct_equity = this.policyConfig!.max_position_pct_equity * latestRegime.position_size_multiplier;
          }

          const policyEngine = new PolicyEngine(activePolicyConfig);
          const policyResult = policyEngine.evaluateOptionsOrder({
            order: preview,
            account,
            positions,
            clock,
            riskState,
            latestRegime,
            signal_confidence: input.signal_confidence,
          });

          if (policyResult.allowed) {
            const approval = await generateApprovalToken({
              preview: {
                symbol: input.contract_symbol.toUpperCase(),
                side: input.side,
                qty: input.qty,
                order_type: input.order_type,
                limit_price: input.limit_price,
                time_in_force: input.time_in_force,
                estimated_price: estimatedPremium,
                estimated_cost: estimatedCost,
              },
              policyResult,
              secret: this.env.KILL_SWITCH_SECRET,
              db,
              ttlSeconds: this.policyConfig!.approval_token_ttl_seconds,
            });
            policyResult.approval_token = approval.token;
            policyResult.approval_id = approval.approval_id;
            policyResult.expires_at = approval.expires_at;
          }

          const result = success({ preview, policy: policyResult, greeks: snapshot.greeks, iv: snapshot.implied_volatility });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "options-order-preview",
            input,
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 5,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INTERNAL_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "options-order-submit",
      "Execute options order with valid approval token from options-order-preview",
      { approval_token: z.string().min(1) },
      async ({ approval_token }) => {
        const startTime = Date.now();
        const db = createD1Client(this.env.DB);
        const alpaca = createAlpacaProviders(this.env);

        try {
          const riskState = await getRiskState(db);
          if (riskState.kill_switch_active) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.KILL_SWITCH_ACTIVE, message: riskState.kill_switch_reason ?? "Kill switch active" }), null, 2) }], isError: true };
          }

          const validation = await validateApprovalToken({ token: approval_token, secret: this.env.KILL_SWITCH_SECRET, db });
          if (!validation.valid) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_APPROVAL_TOKEN, message: validation.reason ?? "Invalid token" }), null, 2) }], isError: true };
          }

          const orderParams = validation.order_params!;
          const clock = await alpaca.trading.getClock();
          if (!clock.is_open && orderParams.time_in_force === "day") {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.MARKET_CLOSED, message: "Market closed" }), null, 2) }], isError: true };
          }

          const order = await alpaca.trading.createOrder({
            symbol: orderParams.symbol,
            qty: orderParams.qty,
            side: orderParams.side,
            type: orderParams.order_type,
            time_in_force: orderParams.time_in_force,
            limit_price: orderParams.limit_price,
            client_order_id: validation.approval_id,
          });

          await consumeApprovalToken(db, validation.approval_id!);
          await createTrade(db, {
            approval_id: validation.approval_id,
            alpaca_order_id: order.id,
            symbol: order.symbol,
            side: order.side,
            qty: order.qty ? parseFloat(order.qty) : undefined,
            order_type: order.type,
            status: order.status,
          });

          const result = success({ message: "Options order submitted", order: { id: order.id, symbol: order.symbol, status: order.status } });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "options-order-submit",
            input: { approval_token: "[REDACTED]" },
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 3,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "options-mleg-preview",
      "Preview a multi-leg options order (spreads, condors, straddles, etc.) and get an approval token. Does NOT execute. Use options-mleg-submit with the token. Legs must specify position_intent: buy_to_open | buy_to_close | sell_to_open | sell_to_close.",
      {
        strategy: z.enum([
          "bull_call_spread", "bear_put_spread", "bull_put_spread", "bear_call_spread",
          "long_straddle", "long_strangle", "short_straddle", "short_strangle",
          "iron_condor", "iron_butterfly", "calendar_spread", "wheel", "zero_dte", "gamma_scalping",
        ]).describe("Named strategy — used for policy validation and audit trail"),
        underlying: z.string().min(1).describe("Underlying symbol, e.g. AAPL"),
        legs: z.array(z.object({
          symbol: z.string().min(1).describe("Full OCC options contract symbol"),
          side: z.enum(["buy", "sell"]),
          ratio_qty: z.number().int().positive().default(1).describe("Relative leg quantity (1 = 1x, 2 = 2x)"),
          position_intent: z.enum(["buy_to_open", "buy_to_close", "sell_to_open", "sell_to_close"]),
        })).min(2).max(4).describe("2–4 legs"),
        qty: z.number().int().positive().describe("Number of spreads/structures"),
        order_type: z.enum(["market", "limit", "debit", "credit", "even"]).default("limit"),
        limit_price: z.number().optional().describe("Net debit (+) or credit (−) per spread"),
        time_in_force: z.enum(["day", "gtc"]).default("day"),
      },
      async (input) => {
        const startTime = Date.now();
        const db = createD1Client(this.env.DB);
        const alpaca = createAlpacaProviders(this.env);

        if (!this.options || !this.options.isConfigured()) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.NOT_SUPPORTED, message: "Options provider not configured" }), null, 2) }], isError: true };
        }

        try {
          const [clock, riskState] = await Promise.all([
            alpaca.trading.getClock(),
            getRiskState(db),
          ]);

          // Validate options enabled + strategy allowed
          const violations: import("./types").PolicyViolation[] = [];
          const warnings: import("./types").PolicyWarning[] = [];

          if (!this.policyConfig!.options.options_enabled) {
            violations.push({ rule: "options_disabled", message: "Options trading is disabled in policy config", current_value: false, limit_value: true });
          }
          if (!this.policyConfig!.options.allowed_strategies.includes(input.strategy as import("../policy/config").OptionsStrategy)) {
            violations.push({ rule: "options_strategy_not_allowed", message: `Strategy '${input.strategy}' not in allowed list`, current_value: input.strategy, limit_value: this.policyConfig!.options.allowed_strategies });
          }

          // Market hours
          if (!clock.is_open && input.time_in_force === "day") {
            warnings.push({ rule: "market_closed", message: "Market is currently closed — order will queue until open" });
          }

          // Kill switch
          if (riskState.kill_switch_active) {
            violations.push({ rule: "kill_switch", message: riskState.kill_switch_reason ?? "Kill switch active", current_value: true, limit_value: false });
          }

          // Estimated net cost (positive = debit, negative = credit)
          const estimatedCost = input.limit_price != null ? input.limit_price * input.qty * 100 : undefined;

          const preview: import("./types").OptionsMlegOrderPreview = {
            strategy: input.strategy,
            underlying: input.underlying.toUpperCase(),
            legs: input.legs as import("./types").MlegLeg[],
            qty: input.qty,
            order_type: input.order_type,
            limit_price: input.limit_price,
            time_in_force: input.time_in_force,
            estimated_cost: estimatedCost,
          };

          const policyResult: import("./types").PolicyResult = {
            allowed: violations.length === 0,
            violations,
            warnings,
          };

          if (policyResult.allowed) {
            const approval = await generateApprovalToken({
              preview: {
                symbol: `MLEG:${input.underlying.toUpperCase()}:${input.strategy}`,
                side: "buy",
                order_type: "market",
                time_in_force: input.time_in_force,
                qty: input.qty,
                mleg_legs: input.legs as import("./types").MlegLeg[],
                mleg_order_type: input.order_type,
                mleg_limit_price: input.limit_price,
                mleg_strategy: input.strategy,
              },
              policyResult,
              secret: this.env.KILL_SWITCH_SECRET,
              db,
              ttlSeconds: this.policyConfig!.approval_token_ttl_seconds,
            });
            policyResult.approval_token = approval.token;
            policyResult.approval_id = approval.approval_id;
            policyResult.expires_at = approval.expires_at;
          }

          const result = success({ preview, policy: policyResult });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "options-mleg-preview",
            input: { strategy: input.strategy, underlying: input.underlying, legs: input.legs, qty: input.qty },
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 4,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );

    this.server.tool(
      "options-mleg-submit",
      "Execute a multi-leg options order with a valid approval token from options-mleg-preview",
      { approval_token: z.string().min(1) },
      async ({ approval_token }) => {
        const startTime = Date.now();
        const db = createD1Client(this.env.DB);
        const alpaca = createAlpacaProviders(this.env);

        try {
          const riskState = await getRiskState(db);
          if (riskState.kill_switch_active) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.KILL_SWITCH_ACTIVE, message: riskState.kill_switch_reason ?? "Kill switch active" }), null, 2) }], isError: true };
          }

          const validation = await validateApprovalToken({ token: approval_token, secret: this.env.KILL_SWITCH_SECRET, db });
          if (!validation.valid) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_APPROVAL_TOKEN, message: validation.reason ?? "Invalid token" }), null, 2) }], isError: true };
          }

          const orderParams = validation.order_params!;
          const clock = await alpaca.trading.getClock();
          if (!clock.is_open && orderParams.time_in_force === "day") {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.MARKET_CLOSED, message: "Market closed" }), null, 2) }], isError: true };
          }

          if (!orderParams.mleg_legs?.length) {
            return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.INVALID_INPUT, message: "Token is not for a multi-leg order — use options-order-submit instead" }), null, 2) }], isError: true };
          }

          const order = await alpaca.trading.createMlegOrder({
            legs: orderParams.mleg_legs as Array<{ symbol: string; side: "buy" | "sell"; ratio_qty: number; position_intent: string }>,
            qty: orderParams.qty ?? 1,
            order_type: (orderParams.mleg_order_type ?? "limit") as "market" | "limit" | "debit" | "credit" | "even",
            limit_price: orderParams.mleg_limit_price,
            time_in_force: orderParams.time_in_force as "day" | "gtc",
            client_order_id: validation.approval_id,
          });

          await consumeApprovalToken(db, validation.approval_id!);
          await createTrade(db, {
            approval_id: validation.approval_id,
            alpaca_order_id: order.id,
            symbol: order.symbol,
            side: order.side,
            qty: order.qty ? parseFloat(order.qty) : undefined,
            order_type: order.type,
            status: order.status,
          });

          const result = success({ message: "Multi-leg options order submitted", order: { id: order.id, symbol: order.symbol, status: order.status } });

          await insertToolLog(db, {
            request_id: this.requestId,
            tool_name: "options-mleg-submit",
            input: { approval_token: "[REDACTED]" },
            output: result,
            latency_ms: Date.now() - startTime,
            provider_calls: 3,
          });

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: JSON.stringify(failure({ code: ErrorCode.PROVIDER_ERROR, message: String(error) }), null, 2) }], isError: true };
        }
      }
    );
  }

  private parseOptionsSymbol(symbol: string): { underlying: string; expiration: string; type: "call" | "put"; strike: number } | null {
    const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
    if (!match) return null;

    const underlying = match[1];
    const dateStr = match[2];
    const typeChar = match[3];
    const strikeStr = match[4];

    if (!underlying || !dateStr || !typeChar || !strikeStr) return null;

    const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
    const month = parseInt(dateStr.slice(2, 4), 10);
    const day = parseInt(dateStr.slice(4, 6), 10);
    const expiration = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const type: "call" | "put" = typeChar === "C" ? "call" : "put";
    const strike = parseInt(strikeStr, 10) / 1000;

    return { underlying, expiration, type, strike };
  }
}
