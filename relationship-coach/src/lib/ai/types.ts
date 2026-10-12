// AI 제공사 추상화. 새 제공사는 이 인터페이스를 구현하고 registry에 등록한다.
export interface GenerateJSONOptions {
  system: string;
  user: string;
  /** 구조화 출력용 JSON Schema. 지원하지 않는 제공사는 프롬프트 지시로 대체할 수 있다. */
  schema: Record<string, unknown>;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  /** 파싱된 JSON 값을 돌려준다. 형식 검증은 호출하는 쪽에서 한다. */
  generateJSON(opts: GenerateJSONOptions): Promise<unknown>;
}

export type ProviderErrorCode =
  | "AI_AUTH"
  | "AI_RATE_LIMIT"
  | "AI_TIMEOUT"
  | "AI_UNAVAILABLE"
  | "AI_BAD_OUTPUT"
  | "AI_REFUSAL";

/** 제공사 오류. message에는 사용자 입력을 절대 넣지 않는다. */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly status?: number,
  ) {
    super(code);
    this.name = "ProviderError";
  }
}
