// 화면 입력 → 전송 본문 변환. 미리보기와 실제 전송이 같은 함수를 쓰므로
// 사용자가 확인한 내용과 전송 내용이 달라지지 않는다.
import { parseConversation, listSpeakers, type ParsedLine } from "./parseConversation";
import { redactText, type RedactionCounts, type RedactionOptions } from "./redact";
import type { AnalyzeRequest, ContextAnswers, GoalId, Message, RelationshipId, SpeakerRole, ToneId } from "./types";

export const UNKNOWN_SPEAKER = "__unknown__";

export function speakerKey(s: string | null): string {
  return s ?? UNKNOWN_SPEAKER;
}

export function guessRole(name: string | null): SpeakerRole | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  if (["나", "me", "본인", "내가", "저"].includes(n)) return "me";
  if (["상대", "상대방", "그", "그녀", "걔"].includes(n)) return "other";
  return undefined;
}

export interface DraftInput {
  relationship: RelationshipId;
  goal: GoalId;
  tone: ToneId;
  situation: string;
  conversation: string;
  /** 발화자 이름 → 역할 */
  speakerRoles: Record<string, SpeakerRole | undefined>;
  /** 줄 번호 → 역할(개별 수정) */
  lineRoles: Record<number, SpeakerRole | undefined>;
  redaction: { enabled: RedactionOptions["enabled"]; customWords: string };
  context: ContextAnswers;
  demoCaseId?: string;
}

export interface DraftView {
  lines: ParsedLine[];
  speakers: (string | null)[];
  unassignedLines: number;
  messages: Message[];
  situation: string;
  context: ContextAnswers;
  counts: RedactionCounts;
}

export function splitWords(s: string): string[] {
  return s.split(/[,，\n]/).map((w) => w.trim()).filter(Boolean);
}

export function buildDraft(d: DraftInput): DraftView {
  const lines = parseConversation(d.conversation);
  const speakers = listSpeakers(lines);
  const counts: RedactionCounts = {};
  const opts: RedactionOptions = {
    enabled: d.redaction.enabled,
    names: speakers.filter((s): s is string => !!s && !guessRole(s)),
    customWords: splitWords(d.redaction.customWords),
  };
  let unassigned = 0;
  const messages: Message[] = [];
  lines.forEach((line, i) => {
    const role = d.lineRoles[i] ?? d.speakerRoles[speakerKey(line.speaker)];
    if (!role) {
      unassigned++;
      return;
    }
    messages.push({ id: `m${messages.length + 1}`, role, text: redactText(line.text, opts, counts) });
  });
  const context: ContextAnswers = {};
  for (const [k, v] of Object.entries(d.context)) {
    if (v.trim()) context[k] = redactText(v.trim(), opts, counts);
  }
  return {
    lines,
    speakers,
    unassignedLines: unassigned,
    messages,
    situation: redactText(d.situation.trim(), opts, counts),
    context,
    counts,
  };
}

export function toRequest(d: DraftInput, view: DraftView, requestId: string, demo: boolean): AnalyzeRequest {
  // 데모 모드에서는 사용자의 대화를 서버로 보내지 않는다.
  return {
    requestId,
    relationship: d.relationship,
    goal: d.goal,
    tone: d.tone,
    situation: demo ? "" : view.situation,
    messages: demo ? [] : view.messages,
    context: demo ? {} : view.context,
    ...(d.demoCaseId ? { demoCaseId: d.demoCaseId } : {}),
  };
}

export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
