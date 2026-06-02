import type { MarketRegime, RegimeState } from "./types";
import { REGIME_PARAMS } from "./types";
import { calculateSMA, calculateATR } from "../providers/technicals";
import type { Bar } from "../providers/types";

// ADX requires directional movement computation — not in existing technicals.ts
// Implemented here as a standalone because ADX uses bar H/L/C, not just closes.
function calculateADX(bars: Bar[], period: number = 14): number | null {
  if (bars.length < period * 2) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const upMove = cur.h - prev.h;
    const downMove = prev.l - cur.l;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }

  // Wilder smoothing
  const smooth = (arr: number[]) => {
    let val = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const result = [val];
    for (let i = period; i < arr.length; i++) {
      val = val - val / period + arr[i]!;
      result.push(val);
    }
    return result;
  };

  const sTR = smooth(trueRanges);
  const sPlusDM = smooth(plusDM);
  const sMinusDM = smooth(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < sTR.length; i++) {
    const tr = sTR[i]!;
    if (tr === 0) continue;
    const plusDI = (sPlusDM[i]! / tr) * 100;
    const minusDI = (sMinusDM[i]! / tr) * 100;
    const sum = plusDI + minusDI;
    if (sum === 0) continue;
    dx.push((Math.abs(plusDI - minusDI) / sum) * 100);
  }

  if (dx.length < period) return null;
  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRealizedVol(closes: number[], period: number = 20): number | null {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push(Math.log(slice[i]! / slice[i - 1]!));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  return Math.sqrt(variance * 252) * 100; // annualized %
}

export interface RegimeInputs {
  spyBars: Bar[];   // 30+ daily bars for SPY
}

export function detectRegime(inputs: RegimeInputs): RegimeState {
  const { spyBars } = inputs;
  const closes = spyBars.map((b) => b.c);
  const now = new Date();

  // --- Compute indicators ---
  const adx = calculateADX(spyBars, 14);
  const atr = calculateATR(spyBars, 14);
  const currentPrice = closes[closes.length - 1] ?? 0;
  const atrPct = atr && currentPrice > 0 ? (atr / currentPrice) * 100 : null;
  const realizedVol = calcRealizedVol(closes, 20);

  const sma20 = calculateSMA(closes, 20);
  const price20dAgo = closes.length >= 20 ? closes[closes.length - 20] : null;
  const spy20dReturn =
    price20dAgo && price20dAgo > 0
      ? ((currentPrice - price20dAgo) / price20dAgo) * 100
      : null;

  // --- Classify regime ---
  let regime: MarketRegime;
  let confidence: number;

  // Crisis: ATR% > 3% or realized vol > 60% annualized
  if ((atrPct !== null && atrPct > 3.0) || (realizedVol !== null && realizedVol > 60)) {
    regime = "crisis";
    confidence = Math.min(0.95, 0.70 + (atrPct ?? 0) / 10);
  }
  // High volatility: ATR% 1.8–3% or realized vol 35–60%
  else if ((atrPct !== null && atrPct > 1.8) || (realizedVol !== null && realizedVol > 35)) {
    regime = "high_volatility";
    confidence = 0.70;
  }
  // Trending: ADX > 25
  else if (adx !== null && adx > 25) {
    regime = spy20dReturn !== null && spy20dReturn > 0 ? "trending_bull" : "trending_bear";
    confidence = Math.min(0.90, 0.60 + adx / 100);
  }
  // Low volatility: ATR% < 0.6% and realized vol < 12%
  else if ((atrPct !== null && atrPct < 0.6) && (realizedVol !== null && realizedVol < 12)) {
    regime = "low_volatility";
    confidence = 0.65;
  }
  // Price above SMA20 and ADX weak → range-bound
  else {
    regime = "range_bound";
    confidence = adx !== null ? Math.min(0.80, 0.50 + (25 - adx) / 50) : 0.55;
  }

  // Trend confirmation: tighten or loosen confidence
  if (regime === "trending_bull" && sma20 && currentPrice > sma20) confidence = Math.min(0.95, confidence + 0.05);
  if (regime === "trending_bear" && sma20 && currentPrice < sma20) confidence = Math.min(0.95, confidence + 0.05);

  const params = REGIME_PARAMS[regime];
  const ttlSeconds = 300; // regime re-evaluated every 5 minutes

  return {
    regime,
    confidence,
    detected_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    spy_return_20d: spy20dReturn,
    adx,
    atr_pct: atrPct,
    realized_vol_20d: realizedVol,
    confidence_threshold_override: params.confidence_threshold,
    position_size_multiplier: params.position_size_multiplier,
    signal_ttl_override_seconds: params.signal_ttl_override_seconds,
  };
}
