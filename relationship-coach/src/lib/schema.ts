// AI가 돌려줘야 하는 원시 출력 형식. 여기 통과했다고 믿지 않고
// postprocess 단계에서 근거 검증·원칙 필터를 다시 거친다.
import { z } from "zod";

export const RawAnalysisSchema = z.object({
  status: z.enum(["ok", "hold"]),
  holdReason: z.string(),
  evidence: z.array(
    z.object({
      id: z.string(),
      messageId: z.string(),
      quote: z.string(),
    }),
  ),
  observations: z.array(z.object({ text: z.string(), evidenceIds: z.array(z.string()) })),
  interpretations: z.array(
    z.object({
      title: z.string(),
      explanation: z.string(),
      evidenceIds: z.array(z.string()),
      limits: z.array(z.string()),
    }),
  ),
  unknowns: z.array(z.string()),
  followUpQuestions: z.array(z.string()),
  responseOptions: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
    }),
  ),
  replies: z.array(z.object({ text: z.string(), note: z.string() })),
  safetyConcern: z.boolean(),
  safetyNote: z.string(),
});

export type RawAnalysis = z.infer<typeof RawAnalysisSchema>;

export const RawRepliesSchema = z.object({
  replies: z.array(z.object({ text: z.string(), note: z.string() })),
});
export type RawReplies = z.infer<typeof RawRepliesSchema>;

/** 구조화 출력용 JSON Schema ($schema 키 제거). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
