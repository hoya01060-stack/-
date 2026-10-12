import type { RawAnalysis } from "@/lib/schema";
import type { AIProvider, GenerateJSONOptions } from "@/lib/ai/types";
import type { AnalyzeRequest, Message } from "@/lib/types";

export function raw(partial: Partial<RawAnalysis> = {}): RawAnalysis {
  return {
    status: "ok",
    holdReason: "",
    evidence: [],
    observations: [],
    interpretations: [],
    unknowns: [],
    followUpQuestions: [],
    responseOptions: [],
    replies: [],
    safetyConcern: false,
    safetyNote: "",
    ...partial,
  };
}

export const MESSAGES: Message[] = [
  { id: "m1", role: "me", text: "어제 왜 연락 안 했어?" },
  { id: "m2", role: "other", text: "미안 일이 너무 많아서 정신이 없었어" },
  { id: "m3", role: "other", text: "주말에 만나서 얘기하자" },
];

export function request(partial: Partial<AnalyzeRequest> = {}): AnalyzeRequest {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 12)}`,
    relationship: "romance",
    goal: "understand",
    tone: "gentle",
    situation: "답장이 늦어서 서운했어요.",
    messages: MESSAGES,
    context: {},
    ...partial,
  };
}

export class FakeProvider implements AIProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  calls: GenerateJSONOptions[] = [];
  constructor(private impl: (o: GenerateJSONOptions) => Promise<unknown> | unknown) {}
  async generateJSON(o: GenerateJSONOptions): Promise<unknown> {
    this.calls.push(o);
    return this.impl(o);
  }
}

let ipSeq = 0;
export function post(path: string, body: unknown, ip = `10.0.0.${++ipSeq % 250}`): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
