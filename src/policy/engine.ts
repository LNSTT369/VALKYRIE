/**
 * Policy Engine - Trade Validation System (V3)
 * 
 * Safety layer that validates every order before execution.
 * Decoupled from speculative research, enforcing mathematically computed bounds.
 */

import type { PolicyConfig, OptionsStrategy } from "./config";
import type { PolicyViolation, PolicyWarning, PolicyResult, OrderPreview, OptionsOrderPreview } from "../mcp/types";
import type { Account, Position, MarketClock } from "../providers/types";
import type { RiskState } from "../storage/d1/queries/risk-state";
import type { TradeIntent } from "./contract";
import type { KellyResult } from "../risk/kelly";
import type { VaRResult } from "../risk/var";
import type { CorrelationResult } from "../risk/correlation";
import type { RegimeState } from "../regime/types";
import type { FactorExposure } from "../risk/factor";

import type { TradeRow } from "../storage/d1/client";

export interface PolicyContext {
  order?: OrderPreview; // Backwards-compatibility
  intent?: TradeIntent;   // Unified V3 intent contract
  account: Account;
  positions: Position[];
  clock: MarketClock;
  riskState: RiskState;
  recentTrades?: TradeRow[];

  // Quantitative risk metrics (resolved asynchronously, evaluated synchronously)
  kellyResult?: KellyResult;
  varResult?: VaRResult;
  correlationResults?: CorrelationResult[];
  latestRegime?: RegimeState | null;
  factorLoadings?: Record<string, FactorExposure>;
}

export class PolicyEngine {
  constructor(public config: PolicyConfig) {}

  evaluate(ctx: PolicyContext): PolicyResult {
    const violations: PolicyViolation[] = [];
    const warnings: PolicyWarning[] = [];

    // Resolve unified trade intent
    const intent = ctx.intent ?? (ctx.order ? this.orderToIntent(ctx.order) : null);
    if (!intent) {
      violations.push({
        rule: "invalid_input",
        message: "No trade intent or order preview provided for policy evaluation",
        current_value: null,
        limit_value: "TradeIntent | OrderPreview",
      });
      return { allowed: false, violations, warnings };
    }

    // Core validation checks
    this.checkKillSwitch(ctx, violations);
    this.checkCooldown(ctx, violations);
    this.checkDailyLossLimit(ctx, violations);
    this.checkTradingHours(intent, ctx.clock, violations, warnings);
    this.checkWashSale(intent, ctx, violations);

    if (intent.asset_class === "option" || intent.options) {
      // Validate options specific parameters
      this.evaluateOptionsIntent(intent, ctx, violations, warnings);
    } else {
      // Validate equity specific parameters
      this.evaluateEquityIntent(intent, ctx, violations, warnings);
    }

    // Quant bounds (Kelly and VaR)
    this.checkConfidenceThreshold(intent, ctx, violations);
    this.checkKellySizing(intent, ctx, violations);
    this.checkVaRLimit(ctx, violations);

    // Kelly Suggested Sizing Calculation (always returned for BUY intents)
    let kelly_suggested_size: import("../mcp/types").KellySuggestedSize | undefined = undefined;
    if (intent.side === "buy") {
      const defaultPct = this.config.max_position_pct_equity;
      if (ctx.kellyResult) {
        kelly_suggested_size = {
          symbol: intent.symbol.toUpperCase(),
          recommended_pct_equity: ctx.kellyResult.recommended_pct_equity,
          recommended_notional: Math.round((ctx.kellyResult.recommended_pct_equity / 100) * ctx.account.equity * 100) / 100,
          historical_trades_analyzed: 200,
          win_rate: ctx.kellyResult.win_rate,
          avg_win_pct: ctx.kellyResult.avg_win_pct,
          avg_loss_pct: ctx.kellyResult.avg_loss_pct,
          skipped_due_to_no_history: false,
        };
      } else {
        // No history fallback to safety cap (max_position_pct_equity)
        kelly_suggested_size = {
          symbol: intent.symbol.toUpperCase(),
          recommended_pct_equity: defaultPct * 100,
          recommended_notional: Math.round(defaultPct * ctx.account.equity * 100) / 100,
          historical_trades_analyzed: 0,
          win_rate: null,
          avg_win_pct: null,
          avg_loss_pct: null,
          skipped_due_to_no_history: true,
        };
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
      warnings,
      kelly_suggested_size,
    };
  }

  evaluateOptionsOrder(ctx: {
    order: OptionsOrderPreview;
    account: Account;
    positions: Position[];
    clock: MarketClock;
    riskState: RiskState;
    latestRegime?: RegimeState | null;
    signal_confidence?: number;
  }): PolicyResult {
    const intent: TradeIntent = {
      symbol: ctx.order.contract_symbol,
      side: ctx.order.side,
      qty: ctx.order.qty,
      order_type: ctx.order.order_type,
      limit_price: ctx.order.limit_price,
      time_in_force: ctx.order.time_in_force === "day" ? "day" : "gtc",
      asset_class: "option",
      signal_confidence: ctx.signal_confidence,
      options: {
        contract_symbol: ctx.order.contract_symbol,
        underlying: ctx.order.underlying,
        expiration: ctx.order.expiration,
        strike: ctx.order.strike,
        option_type: ctx.order.option_type,
        dte: ctx.order.dte,
        delta: ctx.order.delta,
      }
    };
    return this.evaluate({
      intent,
      account: ctx.account,
      positions: ctx.positions,
      clock: ctx.clock,
      riskState: ctx.riskState,
      latestRegime: ctx.latestRegime,
    });
  }

  private checkKillSwitch(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (ctx.riskState.kill_switch_active) {
      violations.push({
        rule: "kill_switch",
        message: `Trading halted: ${ctx.riskState.kill_switch_reason ?? "Kill switch activated"}`,
        current_value: true,
        limit_value: false,
      });
    }
  }

  private checkCooldown(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (!ctx.riskState.cooldown_until) return;

    const cooldownEnd = new Date(ctx.riskState.cooldown_until);
    const now = new Date();

    if (now < cooldownEnd) {
      violations.push({
        rule: "loss_cooldown",
        message: `In cooldown period until ${ctx.riskState.cooldown_until}`,
        current_value: now.toISOString(),
        limit_value: ctx.riskState.cooldown_until,
      });
    }
  }

  private checkDailyLossLimit(ctx: PolicyContext, violations: PolicyViolation[]): void {
    const dailyLossPct = ctx.riskState.daily_loss_usd / ctx.account.equity;

    if (dailyLossPct >= this.config.max_daily_loss_pct) {
      violations.push({
        rule: "daily_loss_limit",
        message: `Daily loss limit reached: ${(dailyLossPct * 100).toFixed(2)}% of equity`,
        current_value: dailyLossPct,
        limit_value: this.config.max_daily_loss_pct,
      });
    }
  }

  private checkWashSale(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (intent.side !== "buy" || !ctx.recentTrades) return;

    const symbol = intent.symbol.toUpperCase();
    const WASH_SALE_PERIOD_DAYS = 30;
    const now = new Date();

    // Look for recent SELL trades for the same symbol that resulted in a loss
    const recentLosingSells = ctx.recentTrades.filter(t => {
      if (t.symbol.toUpperCase() !== symbol) return false;
      if (t.side !== "sell") return false;

      const tradeDate = new Date(t.created_at);
      const diffDays = (now.getTime() - tradeDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > WASH_SALE_PERIOD_DAYS) return false;

      // Check if it was a losing trade
      // Note: We need realized P/L from the trade record. 
      // If not explicitly stored, we can look at filled_avg_price vs cost basis (if we had it).
      // For now, let's assume any sell within 30 days is a potential wash sale risk if we re-buy.
      return true;
    });

    if (recentLosingSells.length > 0) {
      violations.push({
        rule: "wash_sale_risk",
        message: `Wash sale risk: Recent SELL of ${symbol} detected within 30 days. Re-entering is restricted to prevent tax complications and churning.`,
        current_value: recentLosingSells[0].created_at,
        limit_value: `>${WASH_SALE_PERIOD_DAYS} days since last sell`,
      });
    }
  }

  private checkTradingHours(
    intent: TradeIntent,
    clock: MarketClock,
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): void {
    if (!this.config.trading_hours_only) return;

    const isCrypto = intent.symbol.includes("/") || 
      ["BTC", "ETH", "SOL", "LTC", "BCH", "DOGE", "SHIB", "AVAX", "LINK", "UNI", "MATIC"]
        .some(c => intent.symbol.startsWith(c) && intent.symbol.endsWith("USD"));
    
    if (isCrypto) return; // Crypto trades 24/7

    if (!clock.is_open) {
      if (!this.config.extended_hours_allowed) {
        violations.push({
          rule: "trading_hours",
          message: "Trading outside market hours is not allowed",
          current_value: clock.is_open,
          limit_value: true,
        });
      } else {
        warnings.push({
          rule: "extended_hours",
          message: "Order will be placed during extended hours",
        });
      }
    }
  }

  private evaluateEquityIntent(
    intent: TradeIntent,
    ctx: PolicyContext,
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): void {
    this.checkSymbolFilters(intent, violations);
    this.checkOrderType(intent, violations);
    this.checkNotionalLimit(intent, violations);
    this.checkEquityPositionSize(intent, ctx, violations, warnings);
    this.checkOpenPositionsLimit(intent, ctx, violations);
    this.checkShortSelling(intent, ctx, violations);
    this.checkBuyingPower(intent, ctx, violations);
  }

  private checkSymbolFilters(intent: TradeIntent, violations: PolicyViolation[]): void {
    const symbol = intent.symbol.toUpperCase();

    if (this.config.deny_symbols.map((s) => s.toUpperCase()).includes(symbol)) {
      violations.push({
        rule: "symbol_denied",
        message: `Symbol ${symbol} is on the deny list`,
        current_value: symbol,
        limit_value: "not in deny list",
      });
      return;
    }

    if (this.config.allowed_symbols !== null) {
      const allowed = this.config.allowed_symbols.map((s) => s.toUpperCase());
      if (!allowed.includes(symbol)) {
        violations.push({
          rule: "symbol_not_allowed",
          message: `Symbol ${symbol} is not on the allow list`,
          current_value: symbol,
          limit_value: "in allow list",
        });
      }
    }
  }

  private checkOrderType(intent: TradeIntent, violations: PolicyViolation[]): void {
    if (!this.config.allowed_order_types.includes(intent.order_type)) {
      violations.push({
        rule: "order_type_not_allowed",
        message: `Order type '${intent.order_type}' is not allowed`,
        current_value: intent.order_type,
        limit_value: this.config.allowed_order_types,
      });
    }
  }

  private checkNotionalLimit(intent: TradeIntent, violations: PolicyViolation[]): void {
    const estimatedNotional = this.estimateNotional(intent);

    if (estimatedNotional > this.config.max_notional_per_trade) {
      violations.push({
        rule: "max_notional",
        message: `Order notional $${estimatedNotional.toFixed(2)} exceeds limit of $${this.config.max_notional_per_trade}`,
        current_value: estimatedNotional,
        limit_value: this.config.max_notional_per_trade,
      });
    }
  }

  private checkEquityPositionSize(
    intent: TradeIntent,
    ctx: PolicyContext,
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): void {
    if (intent.side !== "buy") return;

    const estimatedNotional = this.estimateNotional(intent);
    const existingPosition = ctx.positions.find(
      (p) => p.symbol.toUpperCase() === intent.symbol.toUpperCase()
    );
    const existingValue = existingPosition?.market_value ?? 0;
    const totalPositionValue = estimatedNotional + existingValue;
    const positionPct = totalPositionValue / ctx.account.equity;

    // Apply correlation clamp: If correlated with existing holdings, cap size at 50%
    let positionLimitPct = this.config.max_position_pct_equity;
    if (ctx.correlationResults) {
      for (const corr of ctx.correlationResults) {
        if (corr.is_over_threshold && corr.pearson_r > 0) {
          positionLimitPct = this.config.max_position_pct_equity * 0.5;
          warnings.push({
            rule: "correlation_clamp",
            message: `High correlation detected with ${corr.symbol_b} (r = ${corr.pearson_r.toFixed(2)}). Position limit clamped by 50% to ${(positionLimitPct * 100).toFixed(1)}% of equity.`,
          });
          break;
        }
      }
    }

    // Apply factor concentration clamp: if net portfolio Beta > 0.85, scale down position limit by 50%
    const factorMultiplier = this.checkFactorConcentration(intent, ctx, warnings);
    positionLimitPct = positionLimitPct * factorMultiplier;

    if (positionPct > positionLimitPct) {
      violations.push({
        rule: "max_position_pct",
        message: `Position would be ${(positionPct * 100).toFixed(2)}% of equity (limit: ${(positionLimitPct * 100).toFixed(1)}% due to risk rules)`,
        current_value: positionPct,
        limit_value: positionLimitPct,
      });
    } else if (positionPct > positionLimitPct * 0.8) {
      warnings.push({
        rule: "position_size_warning",
        message: `Position will be ${(positionPct * 100).toFixed(2)}% of equity, approaching limit`,
      });
    }
  }

  private checkFactorConcentration(
    intent: TradeIntent,
    ctx: PolicyContext,
    warnings: PolicyWarning[]
  ): number {
    if (!ctx.factorLoadings) return 1.0;

    let totalWeightedBeta = 0;
    const equity = ctx.account.equity || 1.0;

    // 1. Calculate beta for existing positions
    for (const pos of ctx.positions) {
      const symbol = pos.symbol.toUpperCase();
      const loading = ctx.factorLoadings[symbol];
      const beta = loading ? loading.betaMkt : 1.0; // fallback to 1.0
      const value = pos.market_value ?? 0;

      if (symbol === intent.symbol.toUpperCase()) continue;

      totalWeightedBeta += (value / equity) * beta;
    }

    // 2. Add proposed position beta
    const symbol = intent.symbol.toUpperCase();
    const loading = ctx.factorLoadings[symbol];
    const beta = loading ? loading.betaMkt : 1.0;

    const existingPosition = ctx.positions.find(
      (p) => p.symbol.toUpperCase() === symbol
    );
    const existingValue = existingPosition?.market_value ?? 0;
    const estimatedNotional = intent.side === "buy" 
      ? this.estimateNotional(intent) 
      : intent.side === "sell" 
        ? -this.estimateNotional(intent) 
        : 0;

    const newPositionValue = existingValue + estimatedNotional;
    totalWeightedBeta += (newPositionValue / equity) * beta;

    const netPortfolioBeta = totalWeightedBeta;

    if (netPortfolioBeta > 0.85) {
      warnings.push({
        rule: "factor_concentration_warning",
        message: `Net portfolio Market Beta (${netPortfolioBeta.toFixed(3)}) exceeds limit of 0.85. Position limit clamped by 50% to prevent excessive factor concentration.`,
      });
      return 0.5;
    }

    return 1.0;
  }

  private checkOpenPositionsLimit(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (intent.side !== "buy") return;

    const existingPosition = ctx.positions.find(
      (p) => p.symbol.toUpperCase() === intent.symbol.toUpperCase()
    );
    const isNewPosition = !existingPosition;
    const openPositionCount = ctx.positions.length;

    if (isNewPosition && openPositionCount >= this.config.max_open_positions) {
      violations.push({
        rule: "max_open_positions",
        message: `Already at max ${this.config.max_open_positions} open positions`,
        current_value: openPositionCount,
        limit_value: this.config.max_open_positions,
      });
    }
  }

  private checkShortSelling(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (intent.side !== "sell") return;
    if (this.config.allow_short_selling) return;

    const existingPosition = ctx.positions.find(
      (p) => p.symbol.toUpperCase() === intent.symbol.toUpperCase()
    );

    if (!existingPosition) {
      violations.push({
        rule: "short_selling_blocked",
        message: `Short selling is disabled. You don't own ${intent.symbol}.`,
        current_value: 0,
        limit_value: "must own position to sell",
      });
      return;
    }

    const sellQty = intent.qty ?? (intent.notional ? intent.notional / (intent.limit_price ?? intent.stop_price ?? 1) : 0);
    if (sellQty > existingPosition.qty) {
      violations.push({
        rule: "short_selling_blocked",
        message: `Cannot sell ${sellQty.toFixed(2)} shares of ${intent.symbol} - you only own ${existingPosition.qty.toFixed(2)}. Short selling is disabled.`,
        current_value: sellQty,
        limit_value: existingPosition.qty,
      });
    }
  }

  private checkBuyingPower(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (intent.side !== "buy") return;

    const estimatedNotional = this.estimateNotional(intent);
    const availableFunds = this.config.use_cash_only ? ctx.account.cash : ctx.account.buying_power;
    const fundType = this.config.use_cash_only ? "cash" : "buying power";

    if (estimatedNotional > availableFunds) {
      violations.push({
        rule: "insufficient_funds",
        message: `Insufficient ${fundType}: need $${estimatedNotional.toFixed(2)}, have $${availableFunds.toFixed(2)}`,
        current_value: availableFunds,
        limit_value: estimatedNotional,
      });
    }
  }

  // ============================================================================
  // Options validation refactored for unified TradeIntent
  // ============================================================================

  private evaluateOptionsIntent(
    intent: TradeIntent,
    ctx: PolicyContext,
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): void {
    this.checkOptionsEnabled(violations);
    
    const opt = intent.options;
    if (!opt) {
      violations.push({
        rule: "options_parameters_missing",
        message: "Options specific parameter structure was missing from trade intent",
        current_value: null,
        limit_value: "options object with contract_symbol, underlying, strike, expiration, etc",
      });
      return;
    }

    this.checkOptionsDTE(opt.dte, violations);
    this.checkOptionsDelta(opt.delta, violations, warnings);
    this.checkOptionsStrategy(intent, ctx, violations);
    this.checkOptionsPositionSize(intent, ctx, violations);
    this.checkOptionsTotalExposure(intent, ctx, violations, warnings);
    this.checkOptionsPositionCount(opt.contract_symbol, ctx, violations);
    this.checkOptionsAveragingDown(opt.contract_symbol, ctx, violations);
    this.checkOptionsBuyingPower(intent, ctx, violations);
  }

  private checkOptionsEnabled(violations: PolicyViolation[]): void {
    if (!this.config.options.options_enabled) {
      violations.push({
        rule: "options_disabled",
        message: "Options trading is disabled in policy config",
        current_value: false,
        limit_value: true,
      });
    }
  }

  private checkOptionsDTE(dte: number, violations: PolicyViolation[]): void {
    const { min_dte, max_dte } = this.config.options;

    if (dte < min_dte) {
      violations.push({
        rule: "options_min_dte",
        message: `Option DTE ${dte} is below minimum ${min_dte} days (no weeklies)`,
        current_value: dte,
        limit_value: min_dte,
      });
    }

    if (dte > max_dte) {
      violations.push({
        rule: "options_max_dte",
        message: `Option DTE ${dte} exceeds maximum ${max_dte} days`,
        current_value: dte,
        limit_value: max_dte,
      });
    }
  }

  private checkOptionsDelta(
    delta: number | undefined,
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): void {
    if (delta === undefined) {
      warnings.push({
        rule: "options_delta_unknown",
        message: "Delta not available - proceeding without delta validation",
      });
      return;
    }

    const absDelta = Math.abs(delta);
    const { min_delta, max_delta } = this.config.options;

    if (absDelta < min_delta) {
      violations.push({
        rule: "options_min_delta",
        message: `Option delta ${absDelta.toFixed(2)} is below minimum ${min_delta} (too far OTM)`,
        current_value: absDelta,
        limit_value: min_delta,
      });
    }

    if (absDelta > max_delta) {
      violations.push({
        rule: "options_max_delta",
        message: `Option delta ${absDelta.toFixed(2)} exceeds maximum ${max_delta} (too far ITM)`,
        current_value: absDelta,
        limit_value: max_delta,
      });
    }
  }

  private checkOptionsStrategy(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    const opt = intent.options!;
    const side = intent.side;
    const option_type = opt.option_type;
    const { allowed_strategies } = this.config.options;
    const positions = ctx.positions ?? [];

    let strategy: OptionsStrategy | null = null;
    if (side === "buy" && option_type === "call") {
      strategy = "long_call";
    } else if (side === "buy" && option_type === "put") {
      strategy = "long_put";
    } else if (side === "sell" && option_type === "call") {
      const underlying = opt.underlying.toUpperCase();
      const underlyingPosition = positions.find(p => p.symbol === underlying);
      const sharesOwned = underlyingPosition ? Number(underlyingPosition.qty) : 0;
      const sharesNeeded = (intent.qty ?? 0) * 100;
      strategy = (sharesOwned >= sharesNeeded && sharesNeeded > 0) ? "covered_call" : "short_call";
    } else if (side === "sell" && option_type === "put") {
      const collateralNeeded = opt.strike * (intent.qty ?? 0) * 100;
      const hasCollateral = ctx.account.cash >= collateralNeeded;
      strategy = hasCollateral ? "cash_secured_put" : "short_put";
    }

    if (!strategy) {
      violations.push({
        rule: "options_strategy_invalid",
        message: `Options strategy '${side} ${option_type}' is not recognized`,
        current_value: `${side} ${option_type}`,
        limit_value: allowed_strategies,
      });
      return;
    }

    if (!allowed_strategies.includes(strategy)) {
      violations.push({
        rule: "options_strategy_not_allowed",
        message: `Options strategy '${strategy}' is not in allowed list.`,
        current_value: strategy,
        limit_value: allowed_strategies,
      });
    }
  }

  private checkOptionsPositionSize(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (intent.side !== "buy") return;

    const estimatedCost = this.estimateOptionsCost(intent);
    const maxAllowed = ctx.account.equity * this.config.options.max_pct_per_option_trade;

    if (estimatedCost > maxAllowed) {
      violations.push({
        rule: "options_max_position_size",
        message: `Options order cost $${estimatedCost.toFixed(2)} exceeds ${(this.config.options.max_pct_per_option_trade * 100).toFixed(0)}% of equity ($${maxAllowed.toFixed(2)})`,
        current_value: estimatedCost,
        limit_value: maxAllowed,
      });
    }
  }

  private checkOptionsTotalExposure(
    intent: TradeIntent,
    ctx: PolicyContext,
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): void {
    if (intent.side !== "buy") return;

    const optionsPositions = ctx.positions.filter(p => p.asset_class === "us_option");
    const currentExposure = optionsPositions.reduce((sum, p) => sum + Math.abs(p.market_value), 0);
    const orderCost = this.estimateOptionsCost(intent);
    const newTotalExposure = currentExposure + orderCost;
    const maxExposure = ctx.account.equity * this.config.options.max_total_options_exposure_pct;

    if (newTotalExposure > maxExposure) {
      violations.push({
        rule: "options_total_exposure",
        message: `Total options exposure $${newTotalExposure.toFixed(2)} would exceed ${(this.config.options.max_total_options_exposure_pct * 100).toFixed(0)}% of equity ($${maxExposure.toFixed(2)})`,
        current_value: newTotalExposure,
        limit_value: maxExposure,
      });
    } else if (newTotalExposure > maxExposure * 0.8) {
      warnings.push({
        rule: "options_exposure_warning",
        message: `Options exposure $${newTotalExposure.toFixed(2)} approaching ${(this.config.options.max_total_options_exposure_pct * 100).toFixed(0)}% limit ($${maxExposure.toFixed(2)})`,
      });
    }
  }

  private checkOptionsPositionCount(contractSymbol: string, ctx: PolicyContext, violations: PolicyViolation[]): void {
    const optionsPositions = ctx.positions.filter(p => p.asset_class === "us_option");
    const existingPosition = optionsPositions.find(
      p => p.symbol.toUpperCase() === contractSymbol.toUpperCase()
    );

    if (!existingPosition && optionsPositions.length >= this.config.options.max_option_positions) {
      violations.push({
        rule: "options_max_positions",
        message: `Already at max ${this.config.options.max_option_positions} options positions`,
        current_value: optionsPositions.length,
        limit_value: this.config.options.max_option_positions,
      });
    }
  }

  private checkOptionsAveragingDown(contractSymbol: string, ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (!this.config.options.no_averaging_down) return;

    const optionsPositions = ctx.positions.filter(p => p.asset_class === "us_option");
    const existingPosition = optionsPositions.find(
      p => p.symbol.toUpperCase() === contractSymbol.toUpperCase()
    );

    if (existingPosition && existingPosition.unrealized_pl < 0) {
      violations.push({
        rule: "options_no_averaging_down",
        message: `Cannot add to losing options position (current P/L: $${existingPosition.unrealized_pl.toFixed(2)})`,
        current_value: existingPosition.unrealized_pl,
        limit_value: 0,
      });
    }
  }

  private checkOptionsBuyingPower(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    const opt = intent.options!;
    if (intent.side === "buy") {
      const estimatedCost = this.estimateOptionsCost(intent);
      const availableFunds = this.config.use_cash_only ? ctx.account.cash : ctx.account.buying_power;
      const fundType = this.config.use_cash_only ? "cash" : "buying power";

      if (estimatedCost > availableFunds) {
        violations.push({
          rule: "options_insufficient_funds",
          message: `Insufficient ${fundType}: need $${estimatedCost.toFixed(2)}, have $${availableFunds.toFixed(2)}`,
          current_value: availableFunds,
          limit_value: estimatedCost,
        });
      }
    } else if (intent.side === "sell") {
      const positions = ctx.positions ?? [];
      const option_type = opt.option_type;

      if (option_type === "call") {
        const underlying = opt.underlying.toUpperCase();
        const underlyingPosition = positions.find(p => p.symbol === underlying);
        const sharesOwned = underlyingPosition ? Number(underlyingPosition.qty) : 0;
        const sharesNeeded = (intent.qty ?? 0) * 100;

        if (sharesOwned < sharesNeeded) {
          // Naked short call margin requirement estimation
          const premium = intent.limit_price ?? 0;
          const marginRequired = (0.20 * opt.strike + premium) * (intent.qty ?? 0) * 100;
          const availableBP = ctx.account.buying_power;

          if (marginRequired > availableBP) {
            violations.push({
              rule: "options_insufficient_margin",
              message: `Insufficient buying power for naked short call: need $${marginRequired.toFixed(2)} margin, have $${availableBP.toFixed(2)}`,
              current_value: availableBP,
              limit_value: marginRequired,
            });
          }
        }
      } else if (option_type === "put") {
        const collateralNeeded = opt.strike * (intent.qty ?? 0) * 100;
        const hasCollateral = ctx.account.cash >= collateralNeeded;

        if (!hasCollateral) {
          // Naked short put margin requirement estimation
          const premium = intent.limit_price ?? 0;
          const marginRequired = (0.20 * opt.strike + premium) * (intent.qty ?? 0) * 100;
          const availableBP = ctx.account.buying_power;

          if (marginRequired > availableBP) {
            violations.push({
              rule: "options_insufficient_margin",
              message: `Insufficient buying power for short put: need $${marginRequired.toFixed(2)} margin, have $${availableBP.toFixed(2)}`,
              current_value: availableBP,
              limit_value: marginRequired,
            });
          }
        }
      }
    }
  }

  // ============================================================================
  // Quantitative bounds checking
  // ============================================================================

  private checkKellySizing(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (intent.side !== "buy" || !ctx.kellyResult) return;

    const estimatedCost = this.estimateNotional(intent);
    const proposedSizePct = (estimatedCost / ctx.account.equity) * 100;
    const limit = ctx.kellyResult.recommended_pct_equity;

    if (proposedSizePct > limit) {
      violations.push({
        rule: "kelly_size_violation",
        message: `Proposed size of ${proposedSizePct.toFixed(2)}% of equity exceeds Kelly-optimal sizing limit of ${limit.toFixed(2)}%`,
        current_value: proposedSizePct,
        limit_value: limit,
      });
    }
  }

  private checkVaRLimit(ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (!ctx.varResult) return;

    const varFraction = ctx.varResult.var_usd / ctx.account.equity;
    const limitFraction = this.config.max_daily_loss_pct;

    if (varFraction > limitFraction) {
      violations.push({
        rule: "var_limit_exceeded",
        message: `Portfolio Value-at-Risk (${(varFraction * 100).toFixed(2)}%) exceeds configured max daily loss cap of ${(limitFraction * 100).toFixed(2)}%`,
        current_value: varFraction,
        limit_value: limitFraction,
      });
    }
  }

  private checkConfidenceThreshold(intent: TradeIntent, ctx: PolicyContext, violations: PolicyViolation[]): void {
    if (intent.signal_confidence === undefined || intent.signal_confidence === null) return;

    let activeThreshold = 0.5; // default fallback confidence threshold
    if (ctx.latestRegime && new Date(ctx.latestRegime.expires_at).getTime() > Date.now()) {
      if (ctx.latestRegime.confidence_threshold_override !== null) {
        activeThreshold = ctx.latestRegime.confidence_threshold_override;
      }
    }

    if (intent.signal_confidence < activeThreshold) {
      violations.push({
        rule: "confidence_threshold_violation",
        message: `Signal confidence ${intent.signal_confidence.toFixed(2)} is below the active threshold of ${activeThreshold.toFixed(2)}`,
        current_value: intent.signal_confidence,
        limit_value: activeThreshold,
      });
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private estimateNotional(intent: TradeIntent): number {
    if (intent.notional) {
      return intent.notional;
    }

    const price = intent.limit_price ?? intent.stop_price ?? 0;
    return (intent.qty ?? 0) * price;
  }

  private estimateOptionsCost(intent: TradeIntent): number {
    const opt = intent.options;
    const premium = intent.limit_price ?? (opt?.delta ? Math.abs(opt.delta) * 2 : 0);
    return (intent.qty ?? 0) * premium * 100;
  }

  // Backwards-compatibility parsers
  private orderToIntent(order: OrderPreview): TradeIntent {
    return {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      notional: order.notional,
      order_type: order.order_type,
      limit_price: order.limit_price,
      stop_price: order.stop_price,
      time_in_force: order.time_in_force,
      asset_class: order.mleg_legs ? "option" : "equity",
    };
  }
}
