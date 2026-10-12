// 서버로 들어오는 요청 검증. 크기 제한도 여기서 강제한다.
import { z } from "zod";
import { LIMITS } from "./limits";
import { GOALS, RELATIONSHIPS, TONES } from "./types";
import { KNOWN_QUESTION_IDS } from "./contextQuestions";
import { REPORT_REASONS, type ReportReasonId } from "./types";

const ids = <T extends readonly { id: string }[]>(list: T) =>
  list.map((x) => x.id) as unknown as [T[number]["id"], ...T[number]["id"][]];

export const AnalyzeRequestSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    relationship: z.enum(ids(RELATIONSHIPS)),
    goal: z.enum(ids(GOALS)),
    tone: z.enum(ids(TONES)),
    situation: z.string().max(LIMITS.situationChars),
    messages: z
      .array(
        z.object({
          id: z.string().regex(/^m\d{1,4}$/),
          role: z.enum(["me", "other", "third"]),
          text: z.string().min(1).max(LIMITS.messageChars),
        }),
      )
      .max(LIMITS.messageCount),
    context: z
      .record(z.string(), z.string().max(LIMITS.contextAnswerChars))
      .refine((r) => Object.keys(r).length <= LIMITS.contextAnswers)
      .refine((r) => Object.keys(r).every((k) => KNOWN_QUESTION_IDS.includes(k))),
    /** 데모 모드에서 사용자가 고른 가상 사례. */
    demoCaseId: z.string().max(20).optional(),
  })
  .refine((r) => r.messages.reduce((n, m) => n + m.text.length, 0) <= LIMITS.conversationChars, {
    message: "conversation_too_long",
  })
  .refine((r) => new Set(r.messages.map((m) => m.id)).size === r.messages.length, {
    message: "duplicate_message_id",
  });

export const ReplyRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  base: AnalyzeRequestSchema,
  tone: z.enum(ids(TONES)),
  draft: z.string().max(LIMITS.replyChars),
});

export const ReportRequestSchema = z.strictObject({
  // 자유 의견란은 두지 않는다. 사용자가 원문을 붙여 넣어 서버에 남는 것을 막기 위해서다.
  reason: z.enum(REPORT_REASONS.map((r) => r.id) as [ReportReasonId, ...ReportReasonId[]]),
  mode: z.enum(["live", "demo"]),
});
