// 규칙 기반 개인정보 가림. 정규식은 모든 형식을 잡지 못하므로
// 화면에서 "누락될 수 있음"을 알리고 최종 전송 내용을 사용자가 확인하게 한다.

export type RedactionRuleId =
  | "rrn"
  | "card"
  | "phone"
  | "account"
  | "email"
  | "url"
  | "address"
  | "names"
  | "custom";

interface Rule {
  id: Exclude<RedactionRuleId, "names" | "custom">;
  label: string;
  token: string;
  pattern: RegExp;
}

// 순서가 중요하다: 긴/구체적인 형식을 먼저 가려야 짧은 규칙이 일부만 먹지 않는다.
const RULES: Rule[] = [
  { id: "rrn", label: "주민등록번호", token: "[주민번호]", pattern: /\b\d{6}\s?-\s?[1-8]\d{6}\b/g },
  { id: "card", label: "카드번호", token: "[카드번호]", pattern: /\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{3,4}\b/g },
  {
    id: "phone",
    label: "전화번호",
    token: "[전화번호]",
    pattern: /(?:\+82[-\s]?)?\b0(?:1[016789]|2|[3-6][1-5]|70)[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
  },
  { id: "account", label: "계좌번호", token: "[계좌번호]", pattern: /\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?\b/g },
  { id: "email", label: "이메일", token: "[이메일]", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { id: "url", label: "링크", token: "[링크]", pattern: /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/gi },
  {
    id: "address",
    label: "주소(일부 형식)",
    token: "[주소]",
    pattern: /[가-힣]{1,10}(?:특별시|광역시|특별자치시|시|도)\s+[가-힣]{1,10}(?:시|군|구)(?:\s+[가-힣0-9]{1,15}(?:로|길|동|읍|면|리))(?:\s*\d{1,5}(?:-\d{1,5})?(?:번길)?)?/g,
  },
];

export const RULE_OPTIONS: { id: RedactionRuleId; label: string }[] = [
  ...RULES.map((r) => ({ id: r.id, label: r.label })),
  { id: "names", label: "대화 속 발화자 이름" },
  { id: "custom", label: "직접 입력한 단어" },
];

export interface RedactionOptions {
  enabled: Record<RedactionRuleId, boolean>;
  /** 발화자 이름(대화 본문에서 이름으로 불리는 경우를 가린다). */
  names: string[];
  /** 사용자가 직접 지정한 가릴 단어. */
  customWords: string[];
}

export const DEFAULT_ENABLED: Record<RedactionRuleId, boolean> = {
  rrn: true,
  card: true,
  phone: true,
  account: true,
  email: true,
  url: true,
  address: true,
  names: true,
  custom: true,
};

export type RedactionCounts = Partial<Record<RedactionRuleId, number>>;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 2자 미만 단어는 일반 글자까지 지워 버리므로 제외한다. */
export function normalizeWords(words: string[]): string[] {
  const set = new Set(words.map((w) => w.trim()).filter((w) => w.length >= 2));
  // 긴 단어부터 바꿔야 "김민지"가 "민지"보다 먼저 처리된다.
  return [...set].sort((a, b) => b.length - a.length);
}

export function redactText(text: string, opts: RedactionOptions, counts: RedactionCounts = {}): string {
  let out = text;
  for (const rule of RULES) {
    if (!opts.enabled[rule.id]) continue;
    out = out.replace(rule.pattern, () => {
      counts[rule.id] = (counts[rule.id] ?? 0) + 1;
      return rule.token;
    });
  }
  const wordGroups: [RedactionRuleId, string[], string][] = [
    ["names", opts.names, "[이름]"],
    ["custom", opts.customWords, "[가림]"],
  ];
  for (const [id, words, token] of wordGroups) {
    if (!opts.enabled[id]) continue;
    for (const w of normalizeWords(words)) {
      out = out.replace(new RegExp(escapeRegExp(w), "g"), () => {
        counts[id] = (counts[id] ?? 0) + 1;
        return token;
      });
    }
  }
  return out;
}
