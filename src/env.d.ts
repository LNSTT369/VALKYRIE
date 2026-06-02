export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;
  SESSION: DurableObjectNamespace;

  ALPACA_API_KEY: string;
  ALPACA_API_SECRET: string;
  ALPACA_PAPER?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OLLAMA_API_KEY?: string;     // Hosted Ollama API key (optional for local)
  OLLAMA_BASE_URL?: string;    // Defaults to https://api.ollama.ai/v1 (or http://localhost:11434/v1 for local)
  OLLAMA_MODEL?: string;       // Model name, e.g. "gpt-oss:20b", "llama3.2"
  LLM_PROVIDER?: string;       // "openai" | "gemini" | "ollama" — explicit provider selection
  TWITTER_BEARER_TOKEN?: string;
  KILL_SWITCH_SECRET: string;
  SIGNAL_API_KEY?: string;

  ENVIRONMENT: string;
  FEATURE_LLM_RESEARCH: string;
  FEATURE_OPTIONS: string;

  DEFAULT_MAX_POSITION_PCT: string;
  DEFAULT_MAX_NOTIONAL_PER_TRADE: string;
  DEFAULT_MAX_DAILY_LOSS_PCT: string;
  DEFAULT_COOLDOWN_MINUTES: string;
  DEFAULT_MAX_OPEN_POSITIONS: string;
  DEFAULT_APPROVAL_TTL_SECONDS: string;
}

declare module "cloudflare:workers" {
  interface Env extends Env {}
}
