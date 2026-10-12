// 환경변수로 제공사·모델을 고른다. 키가 없으면 데모 모드.
import "server-only";
import { AnthropicProvider } from "./anthropic";
import type { AIProvider } from "./types";

export interface AIConfig {
  mode: "live" | "demo";
  provider: string;
  model: string;
  /** 키가 없어서 데모가 되었는지(설정 안내용). 키 값 자체는 절대 담지 않는다. */
  reason: "configured" | "no_key" | "demo_selected" | "unknown_provider";
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-5-5",
};

let override: AIProvider | null | undefined;

/** 테스트에서 가짜 제공사를 주입한다. null이면 강제로 데모 모드. */
export function setProviderOverride(p: AIProvider | null | undefined): void {
  override = p;
}

export function getAIConfig(): AIConfig {
  if (override !== undefined) {
    return override
      ? { mode: "live", provider: override.name, model: override.model, reason: "configured" }
      : { mode: "demo", provider: "demo", model: "-", reason: "no_key" };
  }
  const provider = (process.env.AI_PROVIDER || "anthropic").trim().toLowerCase();
  const model = (process.env.AI_MODEL || DEFAULT_MODELS[provider] || "").trim();
  if (provider === "demo") return { mode: "demo", provider, model: "-", reason: "demo_selected" };
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) return { mode: "demo", provider, model, reason: "no_key" };
    return { mode: "live", provider, model, reason: "configured" };
  }
  return { mode: "demo", provider, model, reason: "unknown_provider" };
}

export function getProvider(): AIProvider | null {
  if (override !== undefined) return override;
  const cfg = getAIConfig();
  if (cfg.mode !== "live") return null;
  const timeout = Number(process.env.AI_TIMEOUT_MS) || 60_000;
  const fallbacks = process.env.AI_FALLBACKS !== "off";
  if (cfg.provider === "anthropic") {
    return new AnthropicProvider(process.env.ANTHROPIC_API_KEY!.trim(), cfg.model, timeout, fallbacks);
  }
  return null;
}
