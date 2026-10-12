// API 라우트 처리 로직. 라우트 파일은 얇게 두고 여기서 테스트한다.
import "server-only";
import type { z } from "zod";
import { LIMITS } from "./limits";
import { AnalyzeRequestSchema, ReplyRequestSchema, ReportRequestSchema } from "./requestSchema";
import { RawAnalysisSchema, RawRepliesSchema, jsonSchemaOf } from "./schema";
import { assessRisk, type RiskAssessment } from "./safety";
import { findInstructionLikeLines } from "./injection";
import { buildReplyContent, buildUserContent, REPLY_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompt";
import { postprocess, postprocessReplies } from "./postprocess";
import { pickDemoCase } from "./demo";
import { getAIConfig, getProvider } from "./ai/registry";
import { ProviderError, type ProviderErrorCode } from "./ai/types";
import { analyzeLimiter, clientKey, inFlight, replyLimiter, reportLimiter } from "./rateLimit";
import { safeLog } from "./log";
import type { AnalysisResult, AnalyzeRequest, AnalyzeResponse, ApiError, ReportReasonId } from "./types";

const ANALYSIS_JSON_SCHEMA = jsonSchemaOf(RawAnalysisSchema);
const REPLIES_JSON_SCHEMA = jsonSchemaOf(RawRepliesSchema);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function fail(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, status, headers);
}

const PROVIDER_ERRORS: Record<ProviderErrorCode, [number, string]> = {
  AI_AUTH: [502, "AI 서비스 설정에 문제가 있어 분석하지 못했습니다. 관리자가 API 키를 확인해야 합니다."],
  AI_RATE_LIMIT: [503, "AI 서비스 요청이 많아 잠시 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."],
  AI_TIMEOUT: [504, "분석 시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요."],
  AI_UNAVAILABLE: [502, "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."],
  AI_BAD_OUTPUT: [502, "AI 응답 형식이 올바르지 않아 결과를 보여 드릴 수 없습니다. 다시 시도해 주세요."],
  AI_REFUSAL: [422, "AI가 이 요청을 처리하지 않았습니다. 내용을 조금 바꿔 다시 시도하거나, 위급한 상황이라면 112에 연락하세요."],
};

/** 본문 크기·형식을 확인하고 JSON으로 읽는다. 실패 시 Response를 돌려준다. */
async function readJson(req: Request): Promise<unknown | Response> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return fail(415, "UNSUPPORTED_MEDIA_TYPE", "JSON 형식의 요청만 받습니다.");
  }
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > LIMITS.bodyBytes) return fail(413, "INPUT_TOO_LARGE", "입력이 너무 깁니다. 대화를 줄여 주세요.");
  const text = await req.text();
  if (new TextEncoder().encode(text).length > LIMITS.bodyBytes) {
    return fail(413, "INPUT_TOO_LARGE", "입력이 너무 깁니다. 대화를 줄여 주세요.");
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(400, "BAD_JSON", "요청 형식이 올바르지 않습니다.");
  }
}

function validationFailure(error: z.ZodError): Response {
  const tooBig = error.issues.some((i) => i.code === "too_big" || i.message === "conversation_too_long");
  if (tooBig) return fail(413, "INPUT_TOO_LARGE", "입력 길이 제한을 넘었습니다. 대화나 설명을 줄여 주세요.");
  return fail(400, "INVALID_INPUT", "입력 형식이 올바르지 않습니다. 내용을 확인해 주세요.");
}

function riskOf(r: AnalyzeRequest): RiskAssessment {
  return assessRisk(
    [r.situation, ...r.messages.map((m) => m.text), ...Object.values(r.context)],
    r.context.safety === "있음",
  );
}

function localHold(reason: string, risk: RiskAssessment): AnalysisResult {
  return postprocess(
    {
      status: "hold",
      holdReason: reason,
      evidence: [],
      observations: [],
      interpretations: [],
      unknowns: ["상대가 실제로 어떤 말을 했는지"],
      followUpQuestions: [
        "상대가 한 말을 대화 그대로 붙여 넣을 수 있나요?",
        "발화자 확인 단계에서 상대의 메시지를 '상대'로 지정했나요?",
      ],
      responseOptions: [],
      replies: [],
      safetyConcern: false,
      safetyNote: "",
    },
    [],
    risk,
  );
}

async function callProvider<T>(
  run: (signal: AbortSignal) => Promise<unknown>,
  schema: z.ZodType<T>,
  scope: string,
): Promise<T | Response> {
  const timeout = Number(process.env.AI_TIMEOUT_MS) || 60_000;
  const signal = AbortSignal.timeout(timeout + 5_000);
  let raw: unknown;
  try {
    raw = await run(signal);
  } catch (err) {
    const code: ProviderErrorCode = err instanceof ProviderError ? err.code : "AI_UNAVAILABLE";
    safeLog(scope, code, err instanceof ProviderError && err.status ? { status: err.status } : undefined);
    const [status, message] = PROVIDER_ERRORS[code];
    return fail(status, code, message);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    safeLog(scope, "AI_BAD_OUTPUT", { issues: parsed.error.issues.length });
    const [status, message] = PROVIDER_ERRORS.AI_BAD_OUTPUT;
    return fail(status, "AI_BAD_OUTPUT", message);
  }
  return parsed.data;
}

export async function handleAnalyze(req: Request): Promise<Response> {
  const retryAfter = analyzeLimiter.hit(clientKey(req.headers));
  if (retryAfter !== null) {
    return fail(429, "RATE_LIMITED", `요청이 너무 잦습니다. 약 ${Math.ceil(retryAfter / 60)}분 뒤 다시 시도해 주세요.`, {
      "Retry-After": String(retryAfter),
    });
  }
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const parsed = AnalyzeRequestSchema.safeParse(body);
  if (!parsed.success) return validationFailure(parsed.error);
  const input = parsed.data;

  if (!inFlight.acquire(input.requestId)) {
    return fail(409, "DUPLICATE_REQUEST", "같은 요청이 이미 처리 중이거나 처리되었습니다.");
  }

  const cfg = getAIConfig();
  if (cfg.mode === "demo") {
    // 데모 모드: 사용자 입력은 분석하지 않고 가상 사례 결과를 돌려준다.
    const demo = pickDemoCase(input.relationship, input.demoCaseId);
    const demoRisk = assessRisk([demo.situation, ...demo.messages.map((m) => m.text)]);
    const result = postprocess({ ...demo.raw, replies: demo.replies[input.tone] }, demo.messages, demoRisk);
    const res: AnalyzeResponse = {
      mode: "demo",
      result,
      demoCase: { title: demo.title, situation: demo.situation, messages: demo.messages, note: demo.demoNote },
    };
    return json(res);
  }

  const risk = riskOf(input);
  if (!input.messages.some((m) => m.role === "other")) {
    inFlight.release(input.requestId);
    return json({
      mode: "live",
      result: localHold("상대의 메시지가 없어 상대의 의도를 해석할 근거가 없습니다.", risk),
    } satisfies AnalyzeResponse);
  }

  const provider = getProvider();
  if (!provider) return fail(500, "AI_NOT_CONFIGURED", "AI 제공사 설정을 확인해 주세요.");
  const injections = findInstructionLikeLines([input.situation, ...input.messages.map((m) => m.text)]);

  const raw = await callProvider(
    (signal) =>
      provider.generateJSON({
        system: SYSTEM_PROMPT,
        user: buildUserContent(input, risk, injections),
        schema: ANALYSIS_JSON_SCHEMA,
        maxTokens: 16000,
        signal,
      }),
    RawAnalysisSchema,
    "analyze",
  );
  if (raw instanceof Response) {
    inFlight.release(input.requestId);
    return raw;
  }
  const res: AnalyzeResponse = { mode: "live", result: postprocess(raw, input.messages, risk) };
  if (injections > 0) res.notice = `대화 속 명령처럼 보이는 문장 ${injections}개는 분석 자료로만 다뤘습니다.`;
  return json(res);
}

export async function handleReply(req: Request): Promise<Response> {
  const retryAfter = replyLimiter.hit(clientKey(req.headers));
  if (retryAfter !== null) {
    return fail(429, "RATE_LIMITED", "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", {
      "Retry-After": String(retryAfter),
    });
  }
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const parsed = ReplyRequestSchema.safeParse(body);
  if (!parsed.success) return validationFailure(parsed.error);
  const { base, tone, draft, requestId } = parsed.data;
  if (!inFlight.acquire(requestId)) {
    return fail(409, "DUPLICATE_REQUEST", "같은 요청이 이미 처리 중입니다.");
  }

  if (getAIConfig().mode === "demo") {
    const demo = pickDemoCase(base.relationship, base.demoCaseId);
    const demoRisk = assessRisk([demo.situation, ...demo.messages.map((m) => m.text)]);
    return json({ mode: "demo", ...postprocessReplies(demo.replies[tone], demoRisk) });
  }

  const provider = getProvider();
  if (!provider) return fail(500, "AI_NOT_CONFIGURED", "AI 제공사 설정을 확인해 주세요.");
  const risk = riskOf(base);
  const raw = await callProvider(
    (signal) =>
      provider.generateJSON({
        system: REPLY_SYSTEM_PROMPT,
        user: buildReplyContent(base, tone, draft, risk),
        schema: REPLIES_JSON_SCHEMA,
        maxTokens: 4000,
        signal,
      }),
    RawRepliesSchema,
    "reply",
  );
  if (raw instanceof Response) {
    inFlight.release(requestId);
    return raw;
  }
  return json({ mode: "live", ...postprocessReplies(raw.replies, risk) });
}

// 신고는 사유별 개수만 메모리에 센다. 원문·결과·의견은 받지도 저장하지도 않는다.
const reportCounts = new Map<string, number>();
export function getReportCounts(): Record<string, number> {
  return Object.fromEntries(reportCounts);
}

export async function handleReport(req: Request): Promise<Response> {
  if (reportLimiter.hit(clientKey(req.headers)) !== null) {
    return fail(429, "RATE_LIMITED", "신고가 너무 잦습니다. 잠시 후 다시 시도해 주세요.");
  }
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const parsed = ReportRequestSchema.safeParse(body);
  if (!parsed.success) return fail(400, "INVALID_INPUT", "신고 사유를 선택해 주세요.");
  const key = `${parsed.data.mode}:${parsed.data.reason satisfies ReportReasonId}`;
  reportCounts.set(key, (reportCounts.get(key) ?? 0) + 1);
  safeLog("report", "RECEIVED", { reason: parsed.data.reason, mode: parsed.data.mode });
  return json({ ok: true });
}

export function handleConfig(): Response {
  const cfg = getAIConfig();
  return json({
    mode: cfg.mode,
    provider: cfg.mode === "live" ? cfg.provider : null,
    model: cfg.mode === "live" ? cfg.model : null,
    reason: cfg.reason,
    limits: {
      situationChars: LIMITS.situationChars,
      conversationChars: LIMITS.conversationChars,
      messageCount: LIMITS.messageCount,
    },
  });
}
