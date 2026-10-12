// AI 출력 검증 계층. 프롬프트만으로는 원칙 준수를 보장할 수 없으므로
// 코드로 (1) 원문에 없는 인용 제거 (2) 확률·진단·편들기·단정 문장 제거
// (3) 조종·감시·보복 제안 제거 (4) 위험 상황의 대면·화해 권유 제거 를 수행한다.
import type {
  AnalysisResult,
  EvidenceItem,
  Interpretation,
  Message,
  ReplyDraft,
  ResponseOption,
  RiskLevel,
} from "./types";
import type { RawAnalysis } from "./schema";
import type { RiskAssessment } from "./safety";
import { safetyMessage } from "./safety";

const MAX = {
  evidence: 12,
  observations: 6,
  interpretations: 3,
  list: 6,
  options: 4,
  replies: 3,
  text: 600,
} as const;

// ── 금지 표현 ──────────────────────────────────────────────
/** 검증되지 않은 수치화(호감도·관심도·확률). */
export const PROBABILITY = [
  /\d{1,3}(?:\.\d+)?\s*(?:%|퍼센트|프로)/,
  /(?:호감|관심|애정|진심)(?:도|지수|점수)\s*(?:가|는|이|를|은)?\s*(?:\d|매우\s*)?(?:높|낮|올라|떨어|상승|하락|\d)/,
  /확률\s*(?:이|은|는)?\s*\d/,
  /(?:호감|관심|애정)\S*\s*\d+\s*점/,
];

/** 진단·애착 유형 라벨. */
export const DIAGNOSIS = [
  /나르시시스트|나르시시즘|자기애성|소시오패스|사이코패스|싸이코/,
  /(?:인격|성격)\s*장애|경계성|반사회성|히스테리성/,
  /우울증|조울증|양극성|공황\s*장애|강박증|ADHD|adhd|자폐|아스퍼거|정신\s*(?:질환|병)/,
  /회피형|불안형|혼란형|안정형|애착\s*(?:유형|장애|스타일)/,
  /가스라이터|가스라이팅\s*(?:하는\s*사람|가해자)/,
];

/** 상대의 속마음을 확정하거나 사용자 편을 무조건 드는 표현. */
export const OVERCLAIM = [
  /(?:분명히?|확실히|틀림없이|명백히|100\s*%|백\s*퍼센트)[^.!?\n]{0,25}(?:좋아하|싫어하|사랑하|관심이\s*(?:있|없)|속마음|의도[가는]|마음이\s*(?:있|없|식|떠))/,
  /(?:당신|사용자|님)(?:의)?\s*(?:말|생각|해석|판단|느낌)?\s*(?:이|은|는|가)?\s*(?:전적으로|완전히|무조건|당연히|100\s*%|백\s*퍼센트)\s*(?:옳|맞)/,
  /상대(?:방)?(?:이|가|는|은)\s*(?:명백히|분명히|확실히|완전히|전적으로)\s*(?:잘못|나쁜|이기적|문제)/,
  /(?:당신|사용자|님)(?:은|는)\s*(?:아무\s*)?잘못(?:이|한\s*게)\s*없/,
];

/** 조종·질투 유발·감시·보복 전략. */
export const MANIPULATION = [
  /질투(?:를|심을?)?\s*(?:유발|자극|나게|느끼게|하게\s*만)/,
  /일부러\s*(?:답장을?\s*)?(?:늦|무시|읽씹|안\s*읽|씹)/,
  /읽씹\s*(?:전략|하세요|해\s*보|하기)|밀당/,
  /몰래\s*(?:확인|보|추적|열어|따라|녹음|찍)/,
  /위치\s*(?:추적|를?\s*몰래)|(?:휴대폰|폰|카톡|메신저)을?\s*(?:몰래|훔쳐|뒤져)/,
  /(?:복수|보복)(?:을|를)?\s*하(?!지)|똑같이\s*(?:갚|당하게|해\s*주)/,
  /겁을?\s*주|죄책감을?\s*(?:느끼게|자극|심어)|떠보|시험해\s*보|무시하는\s*척/,
  /(?:헤어지자|이혼하자|퇴사하겠다)고\s*(?:떠보|협박|겁)/,
];

/** 위험 상황에서 막을 대면·화해 권유. */
export const CONFRONTATION = [
  /직접\s*만나|만나서\s*(?:이야기|얘기|대화|풀)|얼굴\s*보고|찾아가|대면|단둘이/,
  /화해(?:하|를\s*(?:시도|청|제안))|먼저\s*사과(?:하|를)|(?:집|회사|직장)(?:으로|에)\s*가/,
];
const NEGATION = /피하|않|말고|마세요|지\s*마|권하지|삼가|자제/;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Counters {
  unverifiedQuotes: number;
  removedSentences: number;
  removedOptions: number;
}

/** 문장 단위로 금지 표현을 제거한다. 남는 문장이 없으면 빈 문자열. */
function cleanText(text: string, c: Counters, extra: RegExp[] = []): string {
  const banned = [...PROBABILITY, ...DIAGNOSIS, ...OVERCLAIM, ...extra];
  const kept = splitSentences(text.slice(0, MAX.text * 2)).filter((s) => {
    if (matchesAny(s, banned)) {
      c.removedSentences++;
      return false;
    }
    return true;
  });
  return kept.join(" ").slice(0, MAX.text).trim();
}

function cleanList(items: string[], c: Counters, limit: number = MAX.list, extra: RegExp[] = []): string[] {
  return items
    .map((t) => cleanText(t, c, extra))
    .filter(Boolean)
    .slice(0, limit);
}

/** 대면·화해 권유인지 판단. "직접 만나는 것은 피하세요" 같은 부정문은 허용. */
export function isConfrontationAdvice(text: string): boolean {
  return splitSentences(text).some((s) => matchesAny(s, CONFRONTATION) && !NEGATION.test(s));
}

// ── 원문 근거 검증 ────────────────────────────────────────
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[“”„‟"«»]/g, "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripOuterQuotes(s: string): string {
  return s.trim().replace(/^['"“”‘’「」『』]+|['"“”‘’「」『』]+$/g, "").trim();
}

/**
 * AI가 제시한 인용이 실제 전송된 메시지에 글자 그대로 존재하는지 확인한다.
 * 지정한 메시지에 없으면 다른 메시지에서 찾아 messageId를 바로잡고,
 * 어디에도 없으면 제외한다. 발화자 역할은 AI 출력이 아니라 원문에서 가져온다.
 */
export function verifyEvidence(
  raw: RawAnalysis["evidence"],
  messages: Message[],
  c: Counters,
): EvidenceItem[] {
  const normalized = messages.map((m) => ({ m, text: normalizeForMatch(m.text) }));
  const out: EvidenceItem[] = [];
  const seenIds = new Set<string>();
  for (const e of raw) {
    const quote = normalizeForMatch(stripOuterQuotes(e.quote));
    // 너무 짧은 인용(한두 글자)은 어디에나 우연히 존재할 수 있어 근거로 인정하지 않는다.
    // 단, 메시지 전체가 한 글자("응")인 경우는 그 메시지 전체 인용으로 인정한다.
    const meaningful = quote.replace(/[\s.,!?~…]/g, "");
    const wholeMessage = normalized.some((n) => n.text === quote);
    if (!e.id || seenIds.has(e.id) || meaningful.length === 0 || (meaningful.length < 2 && !wholeMessage)) {
      c.unverifiedQuotes++;
      continue;
    }
    const target =
      normalized.find((n) => n.m.id === e.messageId && n.text.includes(quote)) ??
      normalized.find((n) => n.text.includes(quote));
    if (!target) {
      c.unverifiedQuotes++;
      continue;
    }
    seenIds.add(e.id);
    out.push({ id: e.id, messageId: target.m.id, role: target.m.role, quote });
    if (out.length >= MAX.evidence) break;
  }
  return out;
}

// ── 전체 후처리 ───────────────────────────────────────────
const DEFAULT_HOLD =
  "제공된 대화만으로는 상대의 의도를 해석할 근거가 충분하지 않습니다. 아래 질문으로 맥락을 더 확인해 보세요.";
const DEFAULT_LIMIT = "이 해석을 확정할 만큼의 정보는 대화에 없습니다.";

const SAFE_OPTION: ResponseOption = {
  title: "안전을 먼저 확보하기",
  description:
    "당장 답하거나 만나서 풀기보다, 위협이 담긴 메시지를 보관하고 믿을 수 있는 사람이나 전문 기관(112, 1366 등)과 먼저 상의합니다.",
  pros: ["상황이 악화될 위험을 줄일 수 있습니다", "혼자 판단하지 않아도 됩니다"],
  cons: ["관계 문제가 바로 풀리지는 않을 수 있습니다"],
};

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ["none", "caution", "danger"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

export function postprocess(raw: RawAnalysis, messages: Message[], risk: RiskAssessment): AnalysisResult {
  const c: Counters = { unverifiedQuotes: 0, removedSentences: 0, removedOptions: 0 };
  const level = maxLevel(risk.level, raw.safetyConcern ? "caution" : "none");
  const danger = level === "danger";

  const evidence = verifyEvidence(raw.evidence, messages, c);
  const validIds = new Set(evidence.map((e) => e.id));
  const keepIds = (ids: string[]) => [...new Set(ids)].filter((id) => validIds.has(id));

  const observations = raw.observations
    .map((o) => ({ text: cleanText(o.text, c), evidenceIds: keepIds(o.evidenceIds) }))
    .filter((o) => o.text && o.evidenceIds.length > 0)
    .slice(0, MAX.observations);

  let interpretations: Interpretation[] = raw.interpretations
    .map((i) => {
      const limits = cleanList(i.limits, c, 4);
      return {
        title: cleanText(i.title, c).slice(0, 80),
        explanation: cleanText(i.explanation, c),
        evidenceIds: keepIds(i.evidenceIds),
        limits: limits.length > 0 ? limits : [DEFAULT_LIMIT],
      };
    })
    // 검증된 원문 근거가 하나도 없는 해석은 내보내지 않는다.
    .filter((i) => i.title && i.explanation && i.evidenceIds.length > 0)
    .slice(0, MAX.interpretations);

  const status: AnalysisResult["status"] =
    raw.status === "hold" || interpretations.length === 0 ? "hold" : "ok";
  if (status === "hold") interpretations = [];

  let responseOptions: ResponseOption[] = raw.responseOptions
    .filter((o) => {
      const all = [o.title, o.description, ...o.pros, ...o.cons].join("\n");
      const bad = matchesAny(all, MANIPULATION) || (danger && isConfrontationAdvice(all));
      if (bad) c.removedOptions++;
      return !bad;
    })
    .map((o) => ({
      title: cleanText(o.title, c).slice(0, 80),
      description: cleanText(o.description, c),
      pros: cleanList(o.pros, c, 4),
      cons: cleanList(o.cons, c, 4),
    }))
    .filter((o) => o.title && o.description)
    .slice(0, MAX.options);
  if (danger && !responseOptions.some((o) => o.title === SAFE_OPTION.title)) {
    responseOptions = [SAFE_OPTION, ...responseOptions].slice(0, MAX.options);
  }

  const replies: ReplyDraft[] = raw.replies
    .filter((r) => {
      const bad = matchesAny(r.text, MANIPULATION) || (danger && isConfrontationAdvice(r.text));
      if (bad) c.removedOptions++;
      return !bad;
    })
    .map((r) => ({ text: cleanText(r.text, c).slice(0, 1000), note: cleanText(r.note, c).slice(0, 200) }))
    .filter((r) => r.text)
    .slice(0, MAX.replies);

  const unknowns = cleanList(raw.unknowns, c);
  const followUpQuestions = cleanList(raw.followUpQuestions, c);

  const serverMsg = safetyMessage({ ...risk, level });
  const modelNote = raw.safetyConcern ? cleanText(raw.safetyNote, c, danger ? CONFRONTATION : []) : "";

  return {
    status,
    holdReason: status === "hold" ? cleanText(raw.holdReason, c) || DEFAULT_HOLD : "",
    observations,
    evidence,
    interpretations,
    unknowns,
    followUpQuestions:
      status === "hold" && followUpQuestions.length === 0
        ? ["이 대화 전후로 어떤 일이 있었나요?", "상대가 평소에도 이런 방식으로 말하나요?"]
        : followUpQuestions,
    responseOptions,
    replies,
    safety: { level, message: [serverMsg, modelNote].filter(Boolean).join(" ") },
    filtered: c,
  };
}

export function postprocessReplies(
  raw: { text: string; note: string }[],
  risk: RiskAssessment,
): { replies: ReplyDraft[]; removed: number } {
  const c: Counters = { unverifiedQuotes: 0, removedSentences: 0, removedOptions: 0 };
  const danger = risk.level === "danger";
  const replies = raw
    .filter((r) => {
      const bad = matchesAny(r.text, MANIPULATION) || (danger && isConfrontationAdvice(r.text));
      if (bad) c.removedOptions++;
      return !bad;
    })
    .map((r) => ({ text: cleanText(r.text, c).slice(0, 1000), note: cleanText(r.note, c).slice(0, 200) }))
    .filter((r) => r.text)
    .slice(0, MAX.replies);
  return { replies, removed: c.removedOptions + c.removedSentences };
}
