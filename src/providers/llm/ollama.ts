import { createError, ErrorCode } from "../../lib/errors";
import type { LLMProvider, CompletionParams, CompletionResult } from "../types";

// Ollama exposes an OpenAI-compatible /v1/chat/completions endpoint.
// For hosted Ollama (e.g. ollama.ai cloud) an API key is required.
// For local Ollama (http://localhost:11434) no key is needed.

export interface OllamaConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export class OllamaProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: OllamaConfig) {
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "gemma4:26b";
    // Default to hosted ollama.ai; override with OLLAMA_BASE_URL for local
    let base = config.baseUrl ?? "https://api.ollama.ai/v1";
    // If it's a naked host (local ollama), ensure we don't have double /v1 or missing /v1
    if (base.endsWith("/v1")) {
      this.baseUrl = base;
    } else {
      // For local Ollama, the user might provide just the host. 
      // We want the OpenAI-compatible endpoint.
      this.baseUrl = base.endsWith("/") ? `${base}v1` : `${base}/v1`;
    }
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const targetModel = params.model ?? this.model;
    const body: Record<string, unknown> = {
      model: targetModel,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 1024,
      stream: false,
    };

    if (params.response_format?.type === "json_object") {
      body.response_format = { type: "json_object" };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const fullUrl = `${this.baseUrl}/chat/completions`;
    console.log(`[Ollama] Calling ${fullUrl} with model ${targetModel}`);

    const response = await fetch(fullUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw createError(
        ErrorCode.PROVIDER_ERROR,
        `Ollama API error (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as any;
    const choice = data.choices[0]?.message;
    const content = choice?.content ?? "";
    const reasoning = choice?.reasoning ?? "";
    
    // Combine reasoning and content. 
    // Reasoning models often put the actual answer inside the reasoning field or use it for thought.
    // For our JSON parsers, having both is safer.
    const combinedContent = reasoning ? `${reasoning}\n${content}` : content;

    return {
      content: combinedContent,
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        total_tokens: data.usage?.total_tokens ?? 0,
      },
    };
  }
}

export function createOllamaProvider(config: OllamaConfig): OllamaProvider {
  return new OllamaProvider(config);
}
