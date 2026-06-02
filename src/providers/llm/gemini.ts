import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { createError, ErrorCode } from "../../lib/errors";
import type { LLMProvider, CompletionParams, CompletionResult } from "../types";

export interface GeminiConfig {
    apiKey: string;
    model?: string;
}

export class GeminiProvider implements LLMProvider {
    private client: GoogleGenerativeAI;
    private model: string;

    constructor(config: GeminiConfig) {
        this.client = new GoogleGenerativeAI(config.apiKey);
        this.model = config.model ?? "gemini-2.0-flash";
    }

    async complete(params: CompletionParams): Promise<CompletionResult> {
        const modelName = params.model ?? this.model;

        // Extract system message if present
        const systemMessage = params.messages.find(m => m.role === "system");
        const history = params.messages.filter(m => m.role !== "system");

        const model = this.client.getGenerativeModel({
            model: modelName,
            systemInstruction: systemMessage?.content,
        });

        const generationConfig: any = {
            temperature: params.temperature ?? 0.7,
            maxOutputTokens: params.max_tokens ?? 1024,
        };

        if (params.response_format?.type === "json_object") {
            generationConfig.responseMimeType = "application/json";
        }

        // Convert messages to Gemini format
        // Gemini expects a chat history + a final message
        // But here we are just treating it as a "generateContent" or "startChat"
        // For simplicity and compatibility with "complete" paradigm, we can use generateContent with full history 
        // if we format it correctly, or use startChat.
        // startChat is better for preserving context.

        // Map roles: 'user' -> 'user', 'assistant' -> 'model'
        const geminiHistory = history.slice(0, -1).map(msg => ({
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content }],
        }));

        const lastMessage = history[history.length - 1];
        if (!lastMessage) {
            throw createError(ErrorCode.INVALID_INPUT, "No messages provided");
        }

        const chat = model.startChat({
            history: geminiHistory,
            generationConfig,
            safetySettings: [
                {
                    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                }
            ]
        });

        try {
            const result = await chat.sendMessage(lastMessage.content);
            const response = result.response;
            const text = response.text();

            return {
                content: text,
                usage: {
                    prompt_tokens: response.usageMetadata?.promptTokenCount ?? 0,
                    completion_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
                    total_tokens: response.usageMetadata?.totalTokenCount ?? 0,
                },
            };
        } catch (error) {
            throw createError(
                ErrorCode.PROVIDER_ERROR,
                `Gemini API error: ${String(error)}`
            );
        }
    }
}

export function createGeminiProvider(config: GeminiConfig): GeminiProvider {
    return new GeminiProvider(config);
}
