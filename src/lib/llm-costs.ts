/**
 * NIGHTWATCHER - LLM Cost Calculator
 * 
 * Tracks pricing for various models per 1M tokens.
 */

export interface LLMPrice {
  input: number;      // USD per 1M tokens
  output: number;     // USD per 1M tokens
}

export const PRICING: Record<string, LLMPrice> = {
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "claude-3-5-sonnet": { input: 3.00, output: 15.00 },
  "gemini-1.5-pro": { input: 3.50, output: 10.50 },
  "gemini-1.5-flash": { input: 0.075, output: 0.30 },
  "gemma4:26b": { input: 0, output: 0 }, // Local is free
  "llama3.2": { input: 0, output: 0 },
};

export function calculateCost(model: string, usage: { prompt_tokens: number; completion_tokens: number }): number {
  const price = PRICING[model] || { input: 0, output: 0 };
  const inputCost = (usage.prompt_tokens / 1_000_000) * price.input;
  const outputCost = (usage.completion_tokens / 1_000_000) * price.output;
  return inputCost + outputCost;
}
