import { describe, it, expect } from "vitest";
import { PolicyEngine, PolicyContext } from "./engine";
import { PolicyConfig } from "./config";
import { TradeIntent } from "./contract";
import { Account, Position, MarketClock } from "../providers/types";
import { RiskState } from "../storage/d1/queries/risk-state";

// Helper to create basic default contexts for testing
function createMockAccount(overrides?: Partial<Account>): Account {
  return {
    id: "acc_123",
    account_number: "mock_account_number",
    status: "ACTIVE",
    currency: "USD",
    cash: 10000,
    buying_power: 20000,
    regt_buying_power: 20000,
    daytrading_buying_power: 20000,
    equity: 10000,
    last_equity: 10000,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: 10000,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "2",
    shorting_enabled: false,
    multiplier_short: "1",
    shorting_margin_requirement: 0.3,
    maintenance_margin: 0,
    initial_margin: 0,
    daytrade_count: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  } as unknown as Account; // force casting to handle potential subtle field mismatches
}

function createMockClock(overrides?: Partial<MarketClock>): MarketClock {
  return {
    timestamp: new Date().toISOString(),
    is_open: true,
    next_open: new Date().toISOString(),
    next_close: new Date().toISOString(),
    ...overrides,
  };
}

function createMockRiskState(overrides?: Partial<RiskState>): RiskState {
  return {
    kill_switch_active: false,
    kill_switch_reason: null,
    kill_switch_at: null,
    daily_loss_usd: 0,
    daily_loss_reset_at: new Date().toISOString(),
    last_loss_at: null,
    cooldown_until: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockConfig(): PolicyConfig {
  return {
    max_position_pct_equity: 0.1, // 10%
    max_open_positions: 3,
    max_notional_per_trade: 5000,
    allowed_order_types: ["market", "limit", "stop", "stop_limit"],
    max_daily_loss_pct: 0.02, // 2%
    cooldown_minutes_after_loss: 30,
    allowed_symbols: null,
    deny_symbols: ["SPY"],
    min_avg_volume: 100000,
    min_price: 1.0,
    trading_hours_only: true,
    extended_hours_allowed: false,
    approval_token_ttl_seconds: 300,
    allow_short_selling: false,
    use_cash_only: true,
    options: {
      options_enabled: false,
      max_pct_per_option_trade: 0.02, // 2%
      max_total_options_exposure_pct: 0.10, // 10%
      min_dte: 30,
      max_dte: 60,
      min_delta: 0.30,
      max_delta: 0.70,
      allowed_strategies: ["long_call", "long_put", "covered_call", "cash_secured_put"],
      no_averaging_down: true,
      max_option_positions: 3,
      min_confidence_for_options: 0.80,
    },
  };
}

describe("PolicyEngine Core Risk Rules", () => {
  it("should allow a valid simple buy trade", () => {
    const config = createMockConfig();
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 5,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
      asset_class: "equity",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock({ is_open: true }),
      riskState: createMockRiskState(),
    };

    const res = engine.evaluate(ctx);
    expect(res.allowed).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it("should block when kill switch is active", () => {
    const config = createMockConfig();
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState({
        kill_switch_active: true,
        kill_switch_reason: "Manual trigger",
      }),
    };

    const res = engine.evaluate(ctx);
    expect(res.allowed).toBe(false);
    expect(res.violations).toContainEqual(
      expect.objectContaining({
        rule: "kill_switch",
        message: expect.stringContaining("Manual trigger"),
      })
    );
  });

  it("should block when in cooldown", () => {
    const config = createMockConfig();
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    const cooldownUntil = new Date();
    cooldownUntil.setMinutes(cooldownUntil.getMinutes() + 15);

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState({
        cooldown_until: cooldownUntil.toISOString(),
      }),
    };

    const res = engine.evaluate(ctx);
    expect(res.allowed).toBe(false);
    expect(res.violations).toContainEqual(
      expect.objectContaining({
        rule: "loss_cooldown",
      })
    );
  });

  it("should block when daily loss limit is breached", () => {
    const config = createMockConfig(); // daily limit 2%
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState({
        daily_loss_usd: 250, // 2.5% loss
      }),
    };

    const res = engine.evaluate(ctx);
    expect(res.allowed).toBe(false);
    expect(res.violations).toContainEqual(
      expect.objectContaining({
        rule: "daily_loss_limit",
      })
    );
  });

  it("should block non-crypto trading outside market hours if extended hours is false", () => {
    const config = createMockConfig();
    config.trading_hours_only = true;
    config.extended_hours_allowed = false;
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock({ is_open: false }),
      riskState: createMockRiskState(),
    };

    const res = engine.evaluate(ctx);
    expect(res.allowed).toBe(false);
    expect(res.violations).toContainEqual(
      expect.objectContaining({
        rule: "trading_hours",
      })
    );
  });

  it("should allow crypto trading outside market hours", () => {
    const config = createMockConfig();
    config.trading_hours_only = true;
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "BTC/USD",
      side: "buy",
      qty: 0.005,
      limit_price: 60000, // notional = $300
      order_type: "limit",
      time_in_force: "day",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: [],
      clock: createMockClock({ is_open: false }),
      riskState: createMockRiskState(),
    };

    const res = engine.evaluate(ctx);
    expect(res.allowed).toBe(true);
  });

  it("should enforce symbol filter allow and deny lists", () => {
    const config = createMockConfig();
    config.allowed_symbols = ["AAPL", "GOOG"];
    config.deny_symbols = ["AAPL"];
    const engine = new PolicyEngine(config);

    const checkSymbol = (symbol: string) => {
      const intent: TradeIntent = {
        symbol,
        side: "buy",
        qty: 1,
        limit_price: 100,
        order_type: "limit",
        time_in_force: "day",
      };
      return engine.evaluate({
        intent,
        account: createMockAccount(),
        positions: [],
        clock: createMockClock(),
        riskState: createMockRiskState(),
      });
    };

    // AAPL is allowed but denied -> should be denied
    let res = checkSymbol("AAPL");
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("symbol_denied");

    // GOOG is in allow list, not in deny list -> should be allowed
    res = checkSymbol("GOOG");
    expect(res.allowed).toBe(true);

    // TSLA is not in allow list -> should be denied
    res = checkSymbol("TSLA");
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("symbol_not_allowed");
  });

  it("should reject unallowed order types", () => {
    const config = createMockConfig();
    config.allowed_order_types = ["limit"];
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      limit_price: 150,
      order_type: "market",
      time_in_force: "day",
    };

    const res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("order_type_not_allowed");
  });

  it("should block when single trade notional exceeds maximum allowed", () => {
    const config = createMockConfig(); // max_notional_per_trade = 5000
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 40,
      limit_price: 150, // notional = 6000
      order_type: "limit",
      time_in_force: "day",
    };

    const res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("max_notional");
  });

  it("should clamp position limit by 50% when high correlation is detected", () => {
    const config = createMockConfig();
    config.max_position_pct_equity = 0.1; // 10%
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 5,
      limit_price: 150, // $750 notional, which is 7.5% of $10,000 equity
      order_type: "limit",
      time_in_force: "day",
    };

    // Case 1: No correlation info. Proposed position is 7.5% <= 10%. Allowed.
    let res = engine.evaluate({
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(true);

    // Case 2: Correlation of candidate AAPL is 0.85 (> 0.70 threshold) with existing holding MSFT.
    // Limit is clamped by 50% from 10% to 5%. Proposed size of 7.5% exceeds 5%. Denied.
    res = engine.evaluate({
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
      correlationResults: [
        {
          symbol_a: "AAPL",
          symbol_b: "MSFT",
          pearson_r: 0.85,
          is_over_threshold: true,
          threshold: 0.70,
          n_observations: 100,
          is_statistically_meaningful: true,
          recommendation: "clamped",
        },
      ],
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("max_position_pct");
    expect(res.warnings).toContainEqual(
      expect.objectContaining({
        rule: "correlation_clamp",
      })
    );
  });

  it("should block when open position limit is reached for new symbols", () => {
    const config = createMockConfig();
    config.max_open_positions = 2;
    config.max_position_pct_equity = 0.5; // increase to prevent position size limits blocking existing positions
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "TSLA",
      side: "buy",
      qty: 1,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    const mockPositions: Position[] = [
      {
        asset_id: "a1",
        symbol: "AAPL",
        exchange: "NASDAQ",
        asset_class: "us_equity",
        avg_entry_price: 150,
        qty: 10,
        side: "long",
        market_value: 1500,
        cost_basis: 1500,
        unrealized_pl: 0,
        unrealized_plpc: 0,
        unrealized_intraday_pl: 0,
        unrealized_intraday_plpc: 0,
        current_price: 150,
        lastday_price: 150,
        change_today: 0,
      },
      {
        asset_id: "a2",
        symbol: "MSFT",
        exchange: "NASDAQ",
        asset_class: "us_equity",
        avg_entry_price: 300,
        qty: 5,
        side: "long",
        market_value: 1500,
        cost_basis: 1500,
        unrealized_pl: 0,
        unrealized_plpc: 0,
        unrealized_intraday_pl: 0,
        unrealized_intraday_plpc: 0,
        current_price: 300,
        lastday_price: 300,
        change_today: 0,
      },
    ];

    // Buying new symbol TSLA should be blocked because already at limit 2
    let res = engine.evaluate({
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: mockPositions,
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("max_open_positions");

    // Adding to an existing position AAPL should NOT be blocked by open positions limit
    const addIntent: TradeIntent = { ...intent, symbol: "AAPL" };
    res = engine.evaluate({
      intent: addIntent,
      account: createMockAccount({ equity: 10000 }),
      positions: mockPositions,
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(true);
  });

  it("should enforce short selling blocks", () => {
    const config = createMockConfig();
    config.allow_short_selling = false;
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "sell",
      qty: 10,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    // Reject sell if not holding symbol
    let res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("short_selling_blocked");

    // Allow sell if holding sufficient qty
    const mockPositions: Position[] = [
      {
        asset_id: "a1",
        symbol: "AAPL",
        exchange: "NASDAQ",
        asset_class: "us_equity",
        avg_entry_price: 150,
        qty: 15,
        side: "long",
        market_value: 2250,
        cost_basis: 2250,
        unrealized_pl: 0,
        unrealized_plpc: 0,
        unrealized_intraday_pl: 0,
        unrealized_intraday_plpc: 0,
        current_price: 150,
        lastday_price: 150,
        change_today: 0,
      },
    ];

    res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: mockPositions,
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(true);

    // Reject sell if selling more than owned
    const oversizedSellIntent = { ...intent, qty: 20 };
    res = engine.evaluate({
      intent: oversizedSellIntent,
      account: createMockAccount(),
      positions: mockPositions,
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("short_selling_blocked");
  });

  it("should enforce cash/buying power limits", () => {
    const config = createMockConfig();
    config.use_cash_only = true;
    config.max_position_pct_equity = 0.8; // increase to prevent position size limits blocking
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 10,
      limit_price: 150, // $1500
      order_type: "limit",
      time_in_force: "day",
    };

    // Case 1: Cash is $1000 (< $1500) -> Denied
    let res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 1000, buying_power: 5000, equity: 10000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("insufficient_funds");

    // Case 2: use_cash_only is false, cash is $1000, buying_power is $5000 -> Allowed
    config.use_cash_only = false;
    res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 1000, buying_power: 5000, equity: 10000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(true);
  });
});

describe("PolicyEngine Options Validation", () => {
  const createBaseOptionIntent = (): TradeIntent => ({
    symbol: "AAPL",
    side: "buy",
    qty: 1,
    limit_price: 1.50, // Premium of $1.50 per share ($150 total cost)
    order_type: "limit",
    time_in_force: "day",
    asset_class: "option",
    options: {
      contract_symbol: "AAPL260620C00150000",
      underlying: "AAPL",
      expiration: "2026-06-20",
      strike: 150,
      option_type: "call",
      dte: 40,
      delta: 0.50,
    },
  });

  it("should reject options trades when options trading is disabled", () => {
    const config = createMockConfig();
    config.options.options_enabled = false;
    const engine = new PolicyEngine(config);

    const intent = createBaseOptionIntent();
    const res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });

    expect(res.allowed).toBe(false);
    expect(res.violations).toContainEqual(
      expect.objectContaining({
        rule: "options_disabled",
      })
    );
  });

  it("should validate DTE range limits", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.min_dte = 30;
    config.options.max_dte = 60;
    const engine = new PolicyEngine(config);

    // Case 1: DTE too low (20 < 30)
    let intent = createBaseOptionIntent();
    intent.options!.dte = 20;
    let res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_min_dte");

    // Case 2: DTE too high (70 > 60)
    intent = createBaseOptionIntent();
    intent.options!.dte = 70;
    res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_max_dte");
  });

  it("should validate options Delta range limits", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.min_delta = 0.30;
    config.options.max_delta = 0.70;
    const engine = new PolicyEngine(config);

    // Case 1: Delta too low (0.20 < 0.30)
    let intent = createBaseOptionIntent();
    intent.options!.delta = 0.20;
    let res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_min_delta");

    // Case 2: Delta too high (0.80 > 0.70)
    intent = createBaseOptionIntent();
    intent.options!.delta = 0.80;
    res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_max_delta");
  });

  it("should enforce options strategies list", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.allowed_strategies = ["long_call"]; // long_put not allowed
    const engine = new PolicyEngine(config);

    // long_call -> allowed
    let intent = createBaseOptionIntent();
    let res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(true);

    // long_put -> denied
    intent = createBaseOptionIntent();
    intent.options!.option_type = "put";
    res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_strategy_not_allowed");
  });

  it("should enforce option trade premium size limit", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.max_pct_per_option_trade = 0.02; // max $200 for $10,000 equity
    const engine = new PolicyEngine(config);

    // $300 cost exceeds limit of $200 -> denied
    const intent = createBaseOptionIntent();
    intent.qty = 2; // cost = 2 * 1.50 * 100 = $300
    const res = engine.evaluate({
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_max_position_size");
  });

  it("should enforce options total exposure limits", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.max_pct_per_option_trade = 0.05; // single max 5% ($500)
    config.options.max_total_options_exposure_pct = 0.10; // max $1000 options total market value
    const engine = new PolicyEngine(config);

    const intent = createBaseOptionIntent();
    intent.qty = 2; // cost = $300

    const mockPositions: Position[] = [
      {
        asset_id: "o1",
        symbol: "AAPL260620C00140000",
        exchange: "OPRA",
        asset_class: "us_option",
        avg_entry_price: 4,
        qty: 2,
        side: "long",
        market_value: 800, // existing $800 options exposure
        cost_basis: 800,
        unrealized_pl: 0,
        unrealized_plpc: 0,
        unrealized_intraday_pl: 0,
        unrealized_intraday_plpc: 0,
        current_price: 4,
        lastday_price: 4,
        change_today: 0,
      },
    ];

    // Proposed $300 + existing $800 = $1100 exposure. Exceeds $1000 limit. Denied.
    const res = engine.evaluate({
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: mockPositions,
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_total_exposure");
  });

  it("should prevent averaging down on losing options positions", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.no_averaging_down = true;
    const engine = new PolicyEngine(config);

    const intent = createBaseOptionIntent(); // contract = AAPL260620C00150000

    const mockPositions: Position[] = [
      {
        asset_id: "o1",
        symbol: "AAPL260620C00150000",
        exchange: "OPRA",
        asset_class: "us_option",
        avg_entry_price: 2.0,
        qty: 1,
        side: "long",
        market_value: 150,
        cost_basis: 200,
        unrealized_pl: -50, // losing position!
        unrealized_plpc: -0.25,
        unrealized_intraday_pl: -50,
        unrealized_intraday_plpc: -0.25,
        current_price: 1.5,
        lastday_price: 2.0,
        change_today: -0.5,
      },
    ];

    const res = engine.evaluate({
      intent,
      account: createMockAccount(),
      positions: mockPositions,
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_no_averaging_down");
  });

  it("should classify covered_call when underlying shares are held, and short_call if not", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.allowed_strategies = ["covered_call", "short_call"];
    const engine = new PolicyEngine(config);

    const intent = createBaseOptionIntent();
    intent.side = "sell"; // Selling a call

    // Case 1: owns 100 shares of AAPL. Should be covered_call.
    const mockPositions: Position[] = [
      {
        asset_id: "a1",
        symbol: "AAPL",
        exchange: "NASDAQ",
        asset_class: "us_equity",
        avg_entry_price: 150,
        qty: 100,
        side: "long",
        market_value: 15000,
        cost_basis: 15000,
        unrealized_pl: 0,
        unrealized_plpc: 0,
        unrealized_intraday_pl: 0,
        unrealized_intraday_plpc: 0,
        current_price: 150,
        lastday_price: 150,
        change_today: 0,
      },
    ];

    let res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 5000, buying_power: 10000 }),
      positions: mockPositions,
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(true);

    // Case 2: owns only 50 shares of AAPL (insufficient). Should classify as short_call.
    mockPositions[0]!.qty = 50;
    res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 5000, buying_power: 10000 }),
      positions: mockPositions,
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    // Classifies as short_call. Since short_call is allowed, it evaluates buying power/margin.
    // Margin needed = (0.20 * 150 + 1.50) * 1 * 100 = (30 + 1.50) * 100 = $3150.
    // Buying power = 10000 >= 3150. So it should be allowed as short_call.
    expect(res.allowed).toBe(true);

    // Case 3: short_call not allowed in config.
    config.options.allowed_strategies = ["covered_call"]; // short_call removed
    res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 5000, buying_power: 10000 }),
      positions: mockPositions, // only 50 shares
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_strategy_not_allowed");
  });

  it("should classify cash_secured_put when cash covers strike, and short_put if not", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.allowed_strategies = ["cash_secured_put", "short_put"];
    const engine = new PolicyEngine(config);

    const intent = createBaseOptionIntent();
    intent.side = "sell";
    intent.options!.option_type = "put"; // strike = 150, qty = 1 -> collateral = $15,000

    // Case 1: Enough cash ($16,000). Should be cash_secured_put.
    let res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 16000, buying_power: 32000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(true);

    // Case 2: Insufficient cash ($10,000). Classifies as short_put.
    res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 10000, buying_power: 20000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    // short_put is allowed. Margin needed = (0.20 * 150 + 1.50) * 100 = $3150.
    // Buying power = 20000 >= 3150. So allowed as short_put.
    expect(res.allowed).toBe(true);

    // Case 3: short_put not allowed.
    config.options.allowed_strategies = ["cash_secured_put"];
    res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 10000, buying_power: 20000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_strategy_not_allowed");
  });

  it("should enforce buying power / margin limits for short options", () => {
    const config = createMockConfig();
    config.options.options_enabled = true;
    config.options.allowed_strategies = ["short_call", "short_put"];
    const engine = new PolicyEngine(config);

    const intent = createBaseOptionIntent();
    intent.side = "sell"; // short call. Strike = 150, qty = 1. Premium = 1.50.
    // Margin needed = (0.20 * 150 + 1.50) * 100 = $3150.

    // Case 1: Insufficient buying power ($2000 < $3150) -> rejected
    let res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 1000, buying_power: 2000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_insufficient_margin");

    // Case 2: short put with insufficient buying power -> rejected
    intent.options!.option_type = "put";
    res = engine.evaluate({
      intent,
      account: createMockAccount({ cash: 1000, buying_power: 2000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    });
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("options_insufficient_margin");
  });
});

describe("PolicyEngine Quantitative risk (Kelly & VaR)", () => {
  it("should block buy order when size percentage exceeds recommended Kelly-optimal sizing limit", () => {
    const config = createMockConfig();
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 6,
      limit_price: 150, // $900 proposed = 9.0% of $10,000 equity
      order_type: "limit",
      time_in_force: "day",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
      kellyResult: {
        recommended_pct_equity: 5.0, // Kelly suggests max 5.0%
        win_rate: 0.55,
        avg_win_pct: 2.5,
        avg_loss_pct: 1.2,
        odds_ratio: 2.08,
        edge: 0.14,
        is_positive_edge: true,
        kelly_fraction: 0.14,
      },
    };

    const res = engine.evaluate(ctx);
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("kelly_size_violation");
  });

  it("should block trade when total portfolio historical Value-at-Risk exceeds max daily loss config", () => {
    const config = createMockConfig();
    config.max_daily_loss_pct = 0.02; // 2% maximum daily loss cap
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount({ equity: 10000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
      varResult: {
        confidence: 0.95,
        cutoff_return_pct: -2.0,
        n_observations: 100,
        is_statistically_meaningful: true,
        var_usd: 250, // portfolio Value-at-Risk is $250, which is 2.5% of equity (> 2%)
        var_pct: 2.5,
        cvar_usd: 350,
        cvar_pct: 3.5,
      },
    };

    const res = engine.evaluate(ctx);
    expect(res.allowed).toBe(false);
    expect(res.violations[0]!.rule).toBe("var_limit_exceeded");
  });

  it("should return KellySuggestedSize recommendations on BUY intents, degrading gracefully with no history", () => {
    const config = createMockConfig();
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 10,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount({ equity: 100000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
    };

    // Case 1: No history (kellyResult = undefined)
    const resNoHist = engine.evaluate(ctx);
    expect(resNoHist.kelly_suggested_size).toBeDefined();
    expect(resNoHist.kelly_suggested_size!.skipped_due_to_no_history).toBe(true);
    expect(resNoHist.kelly_suggested_size!.recommended_pct_equity).toBe(config.max_position_pct_equity * 100);

    // Case 2: With history (kellyResult defined)
    const ctxWithHist: PolicyContext = {
      ...ctx,
      kellyResult: {
        kelly_fraction: 0.22,
        recommended_pct_equity: 5.5,
        win_rate: 0.6,
        avg_win_pct: 0.12,
        avg_loss_pct: 0.08,
        odds_ratio: 1.5,
        edge: 0.1,
        is_positive_edge: true,
      },
    };
    const resWithHist = engine.evaluate(ctxWithHist);
    expect(resWithHist.kelly_suggested_size).toBeDefined();
    expect(resWithHist.kelly_suggested_size!.skipped_due_to_no_history).toBe(false);
    expect(resWithHist.kelly_suggested_size!.recommended_pct_equity).toBe(5.5);
    expect(resWithHist.kelly_suggested_size!.recommended_notional).toBe(5500); // 5.5% of 100,000 equity
  });

  it("should enforce the confidence threshold override when a fresh regime is provided", () => {
    const config = createMockConfig();
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 5,
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
      signal_confidence: 0.45, // below 0.85 threshold
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount({ equity: 100000 }),
      positions: [],
      clock: createMockClock(),
      riskState: createMockRiskState(),
      latestRegime: {
        regime: "crisis",
        confidence: 0.90,
        detected_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(), // active/fresh
        spy_return_20d: -0.05,
        adx: 35,
        atr_pct: 0.02,
        realized_vol_20d: 0.28,
        confidence_threshold_override: 0.85,
        position_size_multiplier: 0.25,
        signal_ttl_override_seconds: 30,
      },
    };

    // Case 1: Confidence is 0.45, threshold override is 0.85 -> blocked
    const resBlocked = engine.evaluate(ctx);
    expect(resBlocked.allowed).toBe(false);
    expect(resBlocked.violations.some(v => v.rule === "confidence_threshold_violation")).toBe(true);

    // Case 2: Confidence is 0.90, threshold override is 0.85 -> allowed
    const intentAllowed: TradeIntent = {
      ...intent,
      signal_confidence: 0.90,
    };
    const resAllowed = engine.evaluate({ ...ctx, intent: intentAllowed });
    expect(resAllowed.violations.some(v => v.rule === "confidence_threshold_violation")).toBe(false);
  });

  it("should enforce factor concentration clamp when net portfolio Market Beta exceeds 0.85", () => {
    const config = createMockConfig();
    config.max_position_pct_equity = 0.10; // 10%
    const engine = new PolicyEngine(config);

    const intent: TradeIntent = {
      symbol: "AAPL",
      side: "buy",
      qty: 60, // 60 * 150 = $9,000 (9.0% of $100,000 equity)
      limit_price: 150,
      order_type: "limit",
      time_in_force: "day",
    };

    const ctx: PolicyContext = {
      intent,
      account: createMockAccount({ equity: 100000 }),
      positions: [
        {
          asset_id: "spy-id",
          symbol: "SPY",
          qty: 150,
          avg_entry_price: 500,
          market_value: 75000, // 75% of equity in SPY (Market Beta = 1.0)
          cost_basis: 75000,
          unrealized_pl: 0,
          unrealized_plpc: 0,
          current_price: 500,
          side: "long",
          asset_class: "us_equity",
          exchange: "ARCA",
          unrealized_intraday_pl: 0,
          unrealized_intraday_plpc: 0,
          lastday_price: 500,
          change_today: 0,
        }
      ],
      clock: createMockClock(),
      riskState: createMockRiskState(),
      factorLoadings: {
        SPY: { betaMkt: 1.0, betaSmb: 0.0, betaHml: 0.0 },
        AAPL: { betaMkt: 1.2, betaSmb: 0.1, betaHml: -0.1 },
      },
    };

    // Net Beta = (75,000/100,000 * 1.0) + (9,000/100,000 * 1.2) = 0.75 + 0.108 = 0.858 > 0.85
    // Clamps position limit from 10% to 5% of equity. Since proposed AAPL size is 9%, it should violate max_position_pct!
    const res = engine.evaluate(ctx);
    
    expect(res.allowed).toBe(false);
    expect(res.violations.some(v => v.rule === "max_position_pct")).toBe(true);
    expect(res.warnings.some(w => w.rule === "factor_concentration_warning")).toBe(true);
  });
});

