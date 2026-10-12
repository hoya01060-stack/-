// 클라이언트·서버가 함께 쓰는 도메인 타입과 선택지.

export const RELATIONSHIPS = [
  { id: "romance", label: "연애" },
  { id: "spouse", label: "부부" },
  { id: "family", label: "가족" },
  { id: "friend", label: "친구" },
  { id: "work", label: "직장" },
  { id: "other", label: "기타" },
] as const;

export const GOALS = [
  { id: "understand", label: "표현 이해", hint: "이 말이 어떤 뜻일 수 있는지 살펴봐요" },
  { id: "misunderstanding", label: "오해 확인", hint: "서로 다르게 받아들인 부분을 찾아봐요" },
  { id: "reply", label: "답장 작성", hint: "보낼 말을 함께 다듬어요" },
  { id: "request", label: "요구 전달", hint: "원하는 것을 분명하게 말해요" },
  { id: "boundary", label: "경계 설정", hint: "괜찮지 않은 것을 정중하게 선 그어요" },
] as const;

export const TONES = [
  { id: "gentle", label: "부드럽게" },
  { id: "plain", label: "담백하게" },
  { id: "firm", label: "단호하게" },
  { id: "formal", label: "정중하게(격식)" },
] as const;

export type RelationshipId = (typeof RELATIONSHIPS)[number]["id"];
export type GoalId = (typeof GOALS)[number]["id"];
export type ToneId = (typeof TONES)[number]["id"];

/** 사용자가 확인한 발화자 역할. */
export type SpeakerRole = "me" | "other" | "third";

export const ROLE_LABEL: Record<SpeakerRole, string> = {
  me: "나",
  other: "상대",
  third: "제3자",
};

export interface Message {
  id: string; // m1, m2, ...
  role: SpeakerRole;
  text: string;
}

export interface ContextAnswers {
  [questionId: string]: string;
}

/** 서버로 전송되는 분석 요청 본문. 모든 텍스트는 가림 처리 후의 값이다. */
export interface AnalyzeRequest {
  requestId: string;
  relationship: RelationshipId;
  goal: GoalId;
  tone: ToneId;
  situation: string;
  messages: Message[];
  context: ContextAnswers;
  /** 데모 모드에서 고른 가상 사례 id. */
  demoCaseId?: string;
}

export interface EvidenceItem {
  id: string;
  messageId: string;
  role: SpeakerRole;
  quote: string;
}

export interface Observation {
  text: string;
  evidenceIds: string[];
}

export interface Interpretation {
  title: string;
  explanation: string;
  evidenceIds: string[];
  limits: string[];
}

export interface ResponseOption {
  title: string;
  description: string;
  pros: string[];
  cons: string[];
}

export interface ReplyDraft {
  text: string;
  note: string;
}

export type RiskLevel = "none" | "caution" | "danger";

export interface AnalysisResult {
  status: "ok" | "hold";
  holdReason: string;
  observations: Observation[];
  evidence: EvidenceItem[];
  interpretations: Interpretation[];
  unknowns: string[];
  followUpQuestions: string[];
  responseOptions: ResponseOption[];
  replies: ReplyDraft[];
  safety: { level: RiskLevel; message: string };
  /** 서버 검증 단계에서 걸러낸 항목 수(투명성 표시용). */
  filtered: {
    unverifiedQuotes: number;
    removedSentences: number;
    removedOptions: number;
  };
}

export interface AnalyzeResponse {
  mode: "live" | "demo";
  result: AnalysisResult;
  /** 데모 모드일 때 결과가 근거로 삼은 가상 대화. */
  demoCase?: { title: string; situation: string; messages: Message[]; note?: string };
  /** 입력 속 명령문 감지 등 사용자에게 알릴 참고 사항. */
  notice?: string;
}

export interface ApiError {
  error: { code: string; message: string };
}

export const REPORT_REASONS = [
  { id: "inaccurate", label: "대화 내용과 다르게 분석함" },
  { id: "unverified_quote", label: "없는 말을 인용함" },
  { id: "one_sided", label: "한쪽 편만 듦" },
  { id: "diagnosis", label: "진단·낙인 표현" },
  { id: "harmful", label: "위험하거나 부적절한 조언" },
  { id: "privacy", label: "개인정보 노출" },
  { id: "other", label: "기타" },
] as const;
export type ReportReasonId = (typeof REPORT_REASONS)[number]["id"];
