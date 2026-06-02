export interface CorrelationInput {
  returns_a: number[];      // daily returns for symbol A in %
  returns_b: number[];      // daily returns for symbol B in %
  symbol_a: string;
  symbol_b: string;
  threshold: number;        // correlation above this is "too concentrated" (default 0.7)
}

export interface CorrelationResult {
  symbol_a: string;
  symbol_b: string;
  pearson_r: number;         // -1 to +1
  is_over_threshold: boolean;
  threshold: number;
  n_observations: number;
  is_statistically_meaningful: boolean;
  recommendation: string;
}

export function calculateCorrelation(input: CorrelationInput): CorrelationResult {
  const { returns_a, returns_b, symbol_a, symbol_b, threshold } = input;

  // Use the shorter series length
  const n = Math.min(returns_a.length, returns_b.length);

  if (n < 10) {
    return {
      symbol_a,
      symbol_b,
      pearson_r: 0,
      is_over_threshold: false,
      threshold,
      n_observations: n,
      is_statistically_meaningful: false,
      recommendation: "Insufficient data for correlation estimate",
    };
  }

  const a = returns_a.slice(-n);
  const b = returns_b.slice(-n);

  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varA = 0;
  let varB = 0;

  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  const pearson_r = denom > 0 ? cov / denom : 0;
  const rounded = Math.round(pearson_r * 10000) / 10000;
  const is_over_threshold = Math.abs(rounded) >= threshold;

  let recommendation: string;
  if (!is_over_threshold) {
    recommendation = `${symbol_a}/${symbol_b} correlation ${rounded.toFixed(2)} is within acceptable range`;
  } else if (rounded > 0) {
    recommendation = `HIGH CORRELATION: ${symbol_a}/${symbol_b} = ${rounded.toFixed(2)} — adding ${symbol_b} increases ${symbol_a} exposure`;
  } else {
    recommendation = `HIGH INVERSE CORRELATION: ${symbol_a}/${symbol_b} = ${rounded.toFixed(2)} — ${symbol_b} hedges ${symbol_a}`;
  }

  return {
    symbol_a,
    symbol_b,
    pearson_r: rounded,
    is_over_threshold,
    threshold,
    n_observations: n,
    is_statistically_meaningful: n >= 20,
    recommendation,
  };
}
