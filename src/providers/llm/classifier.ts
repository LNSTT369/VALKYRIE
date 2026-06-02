import type { LLMProvider, CompletionResult } from "../types";
import type { EventType } from "../../mcp/types";
import { nowISO } from "../../lib/utils";

const EVENT_CLASSIFICATION_PROMPT = `You are a financial event classifier. Analyze the following news/event content and extract structured information.

Respond ONLY with valid JSON in this exact format:
{
  "event_type": "one of: earnings_beat, earnings_miss, earnings_guidance_cut, merger, acquisition, lawsuit, sec_filing, insider_buy, insider_sell, analyst_upgrade, analyst_downgrade, product_launch, macro, rumor, social_momentum",
  "symbols": ["ARRAY", "OF", "TICKER", "SYMBOLS"],
  "summary": "Brief 1-2 sentence summary of the event",
  "confidence": 0.0 to 1.0
}

Rules:
- Only include ticker symbols that are directly mentioned or clearly implied
- Use uppercase for all symbols
- Set confidence based on how clear/verifiable the information is
- If multiple event types apply, choose the most significant one
- If you cannot classify, use "rumor" with low confidence

Content to analyze:
`;

export async function classifyEvent(
  llm: LLMProvider,
  rawContent: string
): Promise<{
  event_type: EventType;
  symbols: string[];
  summary: string;
  confidence: number;
  usage?: CompletionResult["usage"];
}> {
  const result = await llm.complete({
    messages: [
      {
        role: "system",
        content: "You are a precise financial event classifier. Always respond with valid JSON.",
      },
      {
        role: "user",
        content: EVENT_CLASSIFICATION_PROMPT + rawContent.slice(0, 4000),
      },
    ],
    temperature: 0.3,
    max_tokens: 4096,
    response_format: { type: "json_object" },
  });

  try {
    let content = result.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) content = jsonMatch[0];
    const parsed = JSON.parse(content) as {
      event_type: string;
      symbols: string[];
      summary: string;
      confidence: number;
    };

    const validEventTypes: EventType[] = [
      "earnings_beat", "earnings_miss", "earnings_guidance_cut", "merger", "acquisition", 
      "lawsuit", "sec_filing", "insider_buy", "insider_sell", "analyst_upgrade", 
      "analyst_downgrade", "product_launch", "macro", "rumor", "social_momentum",
    ];

    const eventType = validEventTypes.includes(parsed.event_type as EventType)
      ? (parsed.event_type as EventType)
      : "rumor";

    return {
      event_type: eventType,
      symbols: Array.isArray(parsed.symbols) ? parsed.symbols.map((s) => String(s).toUpperCase()) : [],
      summary: String(parsed.summary || "").slice(0, 500),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      usage: result.usage,
    };
  } catch {
    return {
      event_type: "rumor",
      symbols: [],
      summary: rawContent.slice(0, 200),
      confidence: 0.1,
      usage: result.usage,
    };
  }
}

const RESEARCH_REPORT_PROMPT = `You are a senior equity research analyst. Write a concise research report for the given symbol.

Structure your report with these sections:
1. **Overview** - Company description and sector
2. **Recent Developments** - Key news and events
3. **Technical Levels** - Key support/resistance if data provided
4. **Catalysts** - Upcoming events that could move the stock
5. **Risks** - Key risks to monitor
6. **Summary** - 2-3 sentence conclusion

Be factual and avoid speculation. If data is limited, acknowledge it.
`;

export async function generateResearchReport(
  llm: LLMProvider,
  symbol: string,
  context: {
    overview?: Record<string, unknown>;
    recentNews?: Array<{ headline: string; date: string }>;
    technicals?: Record<string, unknown>;
    positions?: Array<{ qty: number; avg_entry_price: number }>;
  }
): Promise<{ report: string; usage: CompletionResult["usage"] }> {
  const contextStr = JSON.stringify(context, null, 2);

  const result = await llm.complete({
    messages: [
      {
        role: "system",
        content: RESEARCH_REPORT_PROMPT,
      },
      {
        role: "user",
        content: `Generate a research report for ${symbol}.\n\nAvailable context:\n${contextStr}`,
      },
    ],
    temperature: 0.5,
    max_tokens: 4096,
  });

  return { 
    report: `# Research Report: ${symbol}\n\n_Generated: ${nowISO()}_\n\n${result.content}`,
    usage: result.usage 
  };
}

const SUMMARIZE_RULES_PROMPT = `You are analyzing trading performance data to extract patterns and rules.

Based on the trading history provided, identify:
1. Patterns that led to winning trades
2. Patterns that led to losing trades  
3. Regime conditions that affected performance
4. Suggested rules to improve future trading

Format as a structured list of learnings. Be specific and actionable.
`;

export async function summarizeLearnedRules(
  llm: LLMProvider,
  journalEntries: Array<{
    symbol: string;
    side: string;
    outcome: string;
    pnl_pct: number;
    regime_tags: string;
    signals: string;
    notes: string;
  }>
): Promise<{ summary: string; usage: CompletionResult["usage"] }> {
  const dataStr = JSON.stringify(journalEntries.slice(0, 50), null, 2);

  const result = await llm.complete({
    messages: [
      {
        role: "system",
        content: SUMMARIZE_RULES_PROMPT,
      },
      {
        role: "user",
        content: `Analyze these trades and extract patterns:\n\n${dataStr}`,
      },
    ],
    temperature: 0.4,
    max_tokens: 4096,
  });

  return {
    summary: result.content,
    usage: result.usage
  };
}

const TRADING_DECISION_PROMPT = `You are a senior algorithmic trader. Analyze the provided data and make a structured trading decision.

Input Data:
- Symbol
- Current Price
- Technical Indicators (RSI, MACD, etc.)
- Recent News/Events (if any)

Your Goal:
Determine if we should BUY, SELL, or HOLD. 

Rules:
1. BUY only if strong bullish signals (e.g. RSI oversold + bullish divergence, break of resistance, positive catalyst).
2. SELL only if strong bearish signals or to take profit/stop loss.
3. HOLD if uncertain or neutral.
4. Confidence score (0.0-1.0) must reflect the strength of conviction. High confidence (>0.8) requires multiple converging factors.

Respond ONLY with valid JSON.`;

export async function generateTradingDecision(
  llm: LLMProvider,
  symbol: string,
  price: number,
  technicals: any,
  news: any[]
): Promise<{
  verdict: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reasoning: string;
  usage: CompletionResult["usage"];
}> {
  const context = {
    symbol,
    price,
    technicals,
    recent_news: news.map(n => n.headline || n.summary).slice(0, 3)
  };

  const result = await llm.complete({
    messages: [
      {
        role: "system",
        content: TRADING_DECISION_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify(context, null, 2),
      },
    ],
    temperature: 0.2, // Low temperature for consistent decisions
    max_tokens: 4096,
  });

  try {
    let content = result.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      content = jsonMatch[0];
    }
    const parsed = JSON.parse(content);
    return {
      verdict: ["BUY", "SELL", "HOLD"].includes(parsed.verdict) ? parsed.verdict : "HOLD",
      confidence: Number(parsed.confidence) || 0,
      reasoning: parsed.reasoning || "No reasoning provided",
      usage: result.usage
    };
  } catch (e) {
    console.error("[Classifier] Failed to parse trading decision JSON:", result.content);
    return {
      verdict: "HOLD",
      confidence: 0,
      reasoning: "Failed to parse LLM response",
      usage: result.usage
    };
  }
}
