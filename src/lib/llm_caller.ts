import type { Env } from "../env.d";
import { OpenAIProvider } from "../providers/llm/openai";
import { GeminiProvider } from "../providers/llm/gemini";
import { OllamaProvider } from "../providers/llm/ollama";
import { LLMProvider } from "../providers/types";

/**
 * Unified LLM caller that selects the appropriate provider based on environment configuration.
 * Optimized for local servers like llama.cpp, Ollama, and cloud providers.
 */
export async function callLLM(
  system: string,
  user: string,
  env: any,
  preferredModel?: string
): Promise<string> {
  const provider = getLLMProvider(env);
  
  if (!provider) {
    throw new Error("No LLM provider configured. Please set OPENAI_API_KEY, GEMINI_API_KEY, or a local server URL.");
  }

  // Use the user's specified model or fallback to env default
  const model = preferredModel || env.OLLAMA_MODEL || "gemma4";

  const result = await provider.complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    model: model,
    temperature: 0.1,
    max_tokens: 4096
  });

  return result.content;
}

function getLLMProvider(env: any): LLMProvider | null {
  // Check for custom credentials first (e.g. from LLM Codifier)
  if (env && env.LLM_API_KEY) {
    return new OpenAIProvider({
      apiKey: env.LLM_API_KEY,
      baseUrl: env.LLM_API_URL || undefined,
      model: env.LLM_MODEL || undefined
    });
  }

  // 1. Handle Local Server (llama.cpp / local OpenAI-compatible)
  // We'll use the OpenAI provider for llama.cpp as it's API compatible.
  const localUrl = "http://localhost:8080"; 
  
  // 2. Explicit Provider Selection
  if (env.LLM_PROVIDER === "openai" && env.OPENAI_API_KEY) {
    return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY });
  }
  if (env.LLM_PROVIDER === "gemini" && env.GEMINI_API_KEY) {
    return new GeminiProvider({ apiKey: env.GEMINI_API_KEY });
  }
  
  // 3. Auto-detection / Fallback to Local
  // If we're in local dev and have no cloud keys, try the local server
  if (env.ENVIRONMENT === "development" || !env.OPENAI_API_KEY) {
    console.log(`[LLM] Defaulting to local provider at ${localUrl}`);
    return new OpenAIProvider({ 
      apiKey: "local-no-key-required", 
      baseUrl: "http://localhost:8080" 
    });
  }

  if (env.OPENAI_API_KEY) {
    return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY });
  }
  if (env.GEMINI_API_KEY) {
    return new GeminiProvider({ apiKey: env.GEMINI_API_KEY });
  }

  return null;
}
