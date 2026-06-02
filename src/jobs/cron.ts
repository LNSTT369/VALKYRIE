import type { Env } from "../env.d";
import { createD1Client } from "../storage/d1/client";
import { createAlpacaProviders } from "../providers/alpaca";
import { resetDailyLoss, getRiskState } from "../storage/d1/queries/risk-state";
import { cleanupExpiredApprovals } from "../storage/d1/queries/approvals";
import {
  insertRawEvent,
  rawEventExists,
} from "../storage/d1/queries/events";
import { createSECEdgarProvider } from "../providers/news/sec-edgar";
import { cleanupExpiredSignals } from "../storage/d1/queries/signals";
import { createKVClient } from "../storage/kv/client";
import { getJournalReturns, getKellyInputs } from "../storage/d1/queries/risk_metrics";
import { calculateKelly } from "../risk/kelly";
import { calculateVaR } from "../risk/var";
import { calculateCorrelation } from "../risk/correlation";
import { updateWatchlistFactorLoadings, getFactorLoadings } from "../risk/factor";


export async function handleCronEvent(cronId: string, env: Env): Promise<void> {

  switch (cronId) {
    case "*/5 13-20 * * 1-5":
      await runEventIngestion(env);
      break;

    case "0 14 * * 1-5":
      await runMarketOpenPrep(env);
      break;

    case "30 21 * * 1-5":
      await runMarketCloseCleanup(env);
      break;

    case "0 5 * * *":
      await runMidnightReset(env);
      break;

    case "0 * * * *":
      await runHourlyCacheRefresh(env);
      break;

    case "*/15 * * * *":
      await runAutonomousFuturesHedging(env);
      break;

    default:
      console.log(`Unknown cron: ${cronId}`);
  }
}

async function runEventIngestion(env: Env): Promise<void> {
  console.log("Starting event ingestion...");

  const db = createD1Client(env.DB);
  const alpaca = createAlpacaProviders(env);

  try {
    const clock = await alpaca.trading.getClock();

    if (!clock.is_open) {
      console.log("Market closed, skipping event ingestion");
      return;
    }

    const riskState = await getRiskState(db);
    if (riskState.kill_switch_active) {
      console.log("Kill switch active, skipping event ingestion");
      return;
    }

    const secProvider = createSECEdgarProvider();
    const events = await secProvider.poll();

    let newEvents = 0;
    for (const event of events) {
      const exists = await rawEventExists(db, event.source, event.source_id);
      if (!exists) {
        await insertRawEvent(db, {
          source: event.source,
          source_id: event.source_id,
          raw_content: event.content,
        });
        newEvents++;
      }
    }

    console.log(`Event ingestion complete: ${newEvents} new events`);
  } catch (error) {
    console.error("Event ingestion error:", error);
  }
}

async function runMarketOpenPrep(env: Env): Promise<void> {
  console.log("Running market open prep...");

  const db = createD1Client(env.DB);

  try {
    const riskState = await getRiskState(db);
    console.log(`Risk state at open: kill_switch=${riskState.kill_switch_active}, daily_loss=${riskState.daily_loss_usd}`);

    const cleaned = await cleanupExpiredApprovals(db);
    console.log(`Cleaned up ${cleaned} expired approvals`);

  } catch (error) {
    console.error("Market open prep error:", error);
  }
}

async function runMarketCloseCleanup(env: Env): Promise<void> {
  console.log("Running market close cleanup...");

  const db = createD1Client(env.DB);
  const alpaca = createAlpacaProviders(env);

  try {
    const positions = await alpaca.trading.getPositions();
    const account = await alpaca.trading.getAccount();

    console.log(`End of day: ${positions.length} positions, equity=${account.equity}`);

    const cleaned = await cleanupExpiredApprovals(db);
    console.log(`Cleaned up ${cleaned} expired approvals`);

  } catch (error) {
    console.error("Market close cleanup error:", error);
  }
}

async function runMidnightReset(env: Env): Promise<void> {
  console.log("Running midnight reset...");

  const db = createD1Client(env.DB);

  try {
    await resetDailyLoss(db);
    console.log("Daily loss counter reset");

    const cleanedApprovals = await cleanupExpiredApprovals(db);
    console.log(`Cleaned up ${cleanedApprovals} expired approvals`);

    const cleanedSignals = await cleanupExpiredSignals(db);
    console.log(`Cleaned up ${cleanedSignals} stale signals`);

  } catch (error) {
    console.error("Midnight reset error:", error);
  }
}

async function runHourlyCacheRefresh(env: Env): Promise<void> {
  console.log("Running hourly cache refresh...");
  const db = createD1Client(env.DB);
  const alpaca = createAlpacaProviders(env);
  const kvClient = createKVClient(env.CACHE);

  try {
    const [account, positions] = await Promise.all([
      alpaca.trading.getAccount(),
      alpaca.trading.getPositions(),
    ]);

    // 1. Refresh Portfolio VaR
    const portfolioReturns = await getJournalReturns(db, undefined, 200);
    const varResult = calculateVaR({
      returns_pct: portfolioReturns,
      portfolio_value: account.equity,
      confidence: 0.95,
    });
    await kvClient.set(`nightwatcher:cache:var`, varResult, 86400);
    console.log(`Cached portfolio VaR: ${varResult.var_usd.toFixed(2)} USD`);

    // 2. Refresh Kelly and Correlations for active holdings (Parallelized)
    const uniqueSymbols = Array.from(new Set(positions.map(p => p.symbol.toUpperCase())));

    // 2a. Refresh Fama-French Factor Loadings in D1
    if (uniqueSymbols.length > 0) {
      try {
        await updateWatchlistFactorLoadings(db, alpaca, uniqueSymbols);
      } catch (err) {
        console.error("Failed to update Fama-French loadings during cache refresh:", err);
      }
    }

    const returnsMap: Record<string, number[]> = {};
    const kellyInputsMap: Record<string, any> = {};

    await Promise.all([
      ...uniqueSymbols.map(async (symbol) => {
        const returns = await getJournalReturns(db, symbol, 200);
        returnsMap[symbol] = returns;
      }),
      ...uniqueSymbols.map(async (symbol) => {
        const kellyInputs = await getKellyInputs(db, symbol, 200);
        if (kellyInputs) {
          kellyInputsMap[symbol] = kellyInputs;
        }
      })
    ]);

    for (const pos of positions) {
      const symbol = pos.symbol.toUpperCase();
      
      // Kelly Sizing (in-memory)
      const kellyInputs = kellyInputsMap[symbol];
      if (kellyInputs) {
        const kellyResult = calculateKelly({
          win_rate: kellyInputs.win_rate,
          avg_win_pct: kellyInputs.avg_win_pct,
          avg_loss_pct: kellyInputs.avg_loss_pct,
          fraction_cap: 0.25,
        });
        await kvClient.set(`nightwatcher:cache:kelly:${symbol}`, kellyResult, 86400);
        console.log(`Cached Kelly for ${symbol}: ${kellyResult.recommended_pct_equity}%`);
      }

      // Correlations against other active holdings (in-memory calculations)
      const returnsA = returnsMap[symbol] ?? [];
      for (const otherPos of positions) {
        const otherSymbol = otherPos.symbol.toUpperCase();
        if (symbol === otherSymbol) continue;

        const returnsB = returnsMap[otherSymbol] ?? [];
        const corr = calculateCorrelation({
          returns_a: returnsA,
          returns_b: returnsB,
          symbol_a: symbol,
          symbol_b: otherSymbol,
          threshold: 0.70,
        });
        await kvClient.set(`nightwatcher:cache:corr:${symbol}:${otherSymbol}`, corr, 86400);
      }
    }
    console.log("Hourly cache refresh completed successfully.");
  } catch (error) {
    console.error("Hourly cache refresh error:", error);
  }
}

async function runAutonomousFuturesHedging(env: Env): Promise<void> {
  console.log("Running autonomous futures hedging check...");
  const db = createD1Client(env.DB);
  const alpaca = createAlpacaProviders(env);

  try {
    const [account, positions] = await Promise.all([
      alpaca.trading.getAccount(),
      alpaca.trading.getPositions(),
    ]);

    if (positions.length === 0) {
      console.log("No active positions. Skipping hedging check.");
      return;
    }

    const uniqueSymbols = Array.from(new Set(positions.map(p => p.symbol.toUpperCase())));
    
    // Load factor loadings
    const factorMap = await getFactorLoadings(db, uniqueSymbols);
    
    let portfolioDollarBeta = 0;
    for (const pos of positions) {
      const symbol = pos.symbol.toUpperCase();
      const exposure = factorMap[symbol];
      const beta = exposure ? exposure.betaMkt : 1.0; // fallback to 1.0
      portfolioDollarBeta += pos.market_value * beta;
    }

    const portfolioBeta = portfolioDollarBeta / account.equity;
    console.log(`Portfolio Equity: $${account.equity.toFixed(2)}, Portfolio Dollar Beta: $${portfolioDollarBeta.toFixed(2)}, Net Portfolio Beta: ${portfolioBeta.toFixed(3)}`);

    const HEDGE_SYMBOL = "/ES"; // E-mini S&P 500 futures
    const FALLBACK_HEDGE_SYMBOL = "SPY";
    
    // Check if we have an active hedge position
    const activeHedge = positions.find(p => p.symbol.toUpperCase() === HEDGE_SYMBOL || p.symbol.toUpperCase() === FALLBACK_HEDGE_SYMBOL);
    
    if (portfolioBeta > 0.85) {
      console.log(`Net portfolio beta (${portfolioBeta.toFixed(3)}) exceeds threshold (0.85). Triggering autonomous hedge.`);
      
      // Calculate how much we need to short. Target hedging the portfolio Dollar Beta.
      if (activeHedge && activeHedge.side === "short") {
        console.log(`Active short hedge position already exists in ${activeHedge.symbol} (qty: ${activeHedge.qty}). Adjusting may not be necessary.`);
        return;
      }
      
      // Get the price of SPY
      let hedgePrice = 0;
      try {
        const quote = await alpaca.marketData.getQuote(FALLBACK_HEDGE_SYMBOL);
        hedgePrice = quote.ask_price || quote.bid_price || 500;
      } catch (err) {
        console.error("Failed to fetch quote for SPY, using fallback price $500", err);
        hedgePrice = 500;
      }
      
      // Calculate share quantity to short SPY
      const shortQty = Math.round(portfolioDollarBeta / hedgePrice);
      
      if (shortQty > 0) {
        // Deterministic ID ensures we don't double-hedge within the same hour if cron retries
        const clientOrderId = `hedge_open_${FALLBACK_HEDGE_SYMBOL}_${new Date().toISOString().slice(0, 13)}`.replace(/[:-]/g, "");
        
        console.log(`Submitting fully autonomous short hedge for ${shortQty} shares of SPY (notional ~$${(shortQty * hedgePrice).toFixed(2)})`);
        await alpaca.trading.createOrder({
          symbol: FALLBACK_HEDGE_SYMBOL,
          side: "sell",
          type: "market",
          time_in_force: "day",
          qty: shortQty,
          client_order_id: clientOrderId,
        });
      }
    } else if (portfolioBeta <= 0.50 && activeHedge) {
      console.log(`Net portfolio beta (${portfolioBeta.toFixed(3)}) has subsided below 0.50. Clearing active hedge in ${activeHedge.symbol}.`);
      
      // Buy back the short hedge
      if (activeHedge.side === "short") {
        const clientOrderId = `hedge_close_${activeHedge.symbol}_${new Date().toISOString().slice(0, 13)}`.replace(/[:-]/g, "");
        
        await alpaca.trading.createOrder({
          symbol: activeHedge.symbol,
          side: "buy",
          type: "market",
          time_in_force: "day",
          qty: Math.abs(activeHedge.qty),
          client_order_id: clientOrderId,
        });
        console.log(`Successfully closed active hedge position in ${activeHedge.symbol}.`);
      }
    } else {
      console.log("Portfolio beta is within safe bounds. No hedging action required.");
    }
  } catch (error) {
    console.error("Failed to run autonomous futures hedging:", error);
  }
}

