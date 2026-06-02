// Fill quality analytics: slippage vs. expected, vs. VWAP, implementation shortfall.
// Pure functions — no I/O. Augments execution_fills.ts which handles D1 persistence.

export type FillGrade = "excellent" | "good" | "fair" | "poor";

export interface SlippageMetrics {
  slippage_vs_expected_bps: number | null;
  slippage_vs_vwap_bps: number | null;
  implementation_shortfall_bps: number | null;
  fill_grade: FillGrade;
  // true when fill was better than the benchmark (negative slippage for the direction)
  is_favorable: boolean;
}

export interface FillQualityInput {
  side: "buy" | "sell";
  fill_price: number;
  expected_price?: number;    // pre-trade mid or limit
  vwap_at_fill?: number;      // VWAP of the stock at the time of fill
  decision_price?: number;    // mid-quote when the trading decision was made (arrival price)
}

// Positive bps = unfavorable (paid more on buy, received less on sell).
function directionalBps(side: "buy" | "sell", fill: number, reference: number): number {
  const sign = side === "buy" ? 1 : -1;
  return (sign * (fill - reference) / reference) * 10_000;
}

function gradeSlippage(bps: number | null): FillGrade {
  if (bps === null) return "fair";
  const abs = Math.abs(bps);
  if (abs <= 5) return "excellent";
  if (abs <= 15) return "good";
  if (abs <= 50) return "fair";
  return "poor";
}

export function calcSlippageMetrics(input: FillQualityInput): SlippageMetrics {
  const { side, fill_price, expected_price, vwap_at_fill, decision_price } = input;

  const slippage_vs_expected_bps = expected_price != null
    ? directionalBps(side, fill_price, expected_price)
    : null;

  const slippage_vs_vwap_bps = vwap_at_fill != null
    ? directionalBps(side, fill_price, vwap_at_fill)
    : null;

  const implementation_shortfall_bps = decision_price != null
    ? directionalBps(side, fill_price, decision_price)
    : null;

  // Grade by best available benchmark (VWAP preferred, then expected, then IS)
  const primary = slippage_vs_vwap_bps ?? slippage_vs_expected_bps ?? implementation_shortfall_bps;

  return {
    slippage_vs_expected_bps,
    slippage_vs_vwap_bps,
    implementation_shortfall_bps,
    fill_grade: gradeSlippage(primary),
    is_favorable: primary !== null && primary < 0,
  };
}

export function summarizeFillQuality(fills: Array<{ slippage_bps?: number | null }>): {
  avg_slippage_bps: number | null;
  median_slippage_bps: number | null;
  pct_favorable: number;
  grade_distribution: Record<FillGrade, number>;
} {
  const series = fills
    .map((f) => f.slippage_bps)
    .filter((b): b is number => b != null);

  const avg = series.length > 0
    ? series.reduce((a, b) => a + b, 0) / series.length
    : null;

  let median: number | null = null;
  if (series.length > 0) {
    const sorted = [...series].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    median = sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  }

  const dist: Record<FillGrade, number> = { excellent: 0, good: 0, fair: 0, poor: 0 };
  for (const bps of series) dist[gradeSlippage(bps)]++;
  // Count nulls as fair
  for (let i = 0; i < fills.length - series.length; i++) dist.fair++;

  const favorable = series.filter((b) => b < 0).length;

  return {
    avg_slippage_bps: avg,
    median_slippage_bps: median,
    pct_favorable: fills.length > 0 ? (favorable / fills.length) * 100 : 0,
    grade_distribution: dist,
  };
}
