import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type AIProvider, type GenerateJSONOptions } from "./types";

// 서버 측 폴백(refusal 시 다른 모델로 재시도)을 받는 모델.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    timeoutMs: number,
    private useFallbacks: boolean,
  ) {
    // SDK 자체 재시도는 1회로 줄인다. 사용자는 화면에서 다시 시도할 수 있다.
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }

  async generateJSON(opts: GenerateJSONOptions): Promise<unknown> {
    const fallbacks = this.useFallbacks && FALLBACK_MODELS.has(this.model);
    let response;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: [{ role: "user", content: opts.user }],
          output_config: {
            effort: "medium",
            format: { type: "json_schema", schema: opts.schema },
          },
          ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: opts.signal },
      );
    } catch (err) {
      throw mapError(err);
    }

    if (response.stop_reason === "refusal") throw new ProviderError("AI_REFUSAL");
    if (response.stop_reason === "max_tokens") throw new ProviderError("AI_BAD_OUTPUT");
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("AI_BAD_OUTPUT");
    }
  }
}

function mapError(err: unknown): ProviderError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("AI_AUTH", err.status);
  }
  if (err instanceof Anthropic.RateLimitError) return new ProviderError("AI_RATE_LIMIT", 429);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("AI_TIMEOUT");
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("AI_TIMEOUT");
  if (err instanceof Anthropic.APIError) return new ProviderError("AI_UNAVAILABLE", err.status ?? undefined);
  return new ProviderError("AI_UNAVAILABLE");
}
