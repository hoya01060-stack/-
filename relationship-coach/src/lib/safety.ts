// 입력 속 위험 신호 감지. 키워드 기반이라 놓치거나 과하게 잡을 수 있으므로
// "위험하다고 판정"하지 않고 안전 안내를 띄우고 대면·화해 권유를 막는 데만 쓴다.
import type { RiskLevel } from "./types";

export type RiskCategory = "violence" | "threat" | "stalking" | "selfharm" | "sexual" | "control";

const DANGER: Record<RiskCategory, RegExp[]> = {
  violence: [/때[렸리려]|맞았|폭행|폭력|목을\s*졸|밀쳐|발로\s*차|주먹|칼(?:로|을|이)|흉기/],
  threat: [
    /죽(?:여|일|이겠|여버)|죽어\s*버/,
    /가만\s*(?:안\s*둬|안\s*둔다|두지\s*않)/,
    /(?:찾아|쫓아)\s*갈\s*(?:거|게|꺼)/,
    /협박|보복하겠|뿌릴\s*(?:거|게)|유포|퍼뜨릴/,
  ],
  stalking: [/스토킹|따라다니|집\s*앞에\s*(?:있|왔|와\s*있)|위치\s*추적|몰래\s*(?:따라|찍)/],
  selfharm: [/자해|자살|죽고\s*싶|사라지고\s*싶|살고\s*싶지\s*않|목숨을\s*끊/],
  sexual: [/성관계를?\s*강요|강제로\s*(?:만지|관계)|몰카|불법\s*촬영|성폭력|성추행/],
  control: [/감금|못\s*나가게|휴대폰을?\s*(?:빼앗|부수)|돈을?\s*(?:안\s*주면|끊어\s*버리)/],
};

const CAUTION: RegExp[] = [
  /소리를?\s*(?:지르|질러)/,
  /물건을?\s*(?:던지|던져|부수)/,
  /(?:휴대폰|폰|카톡)\s*(?:검사|검열|확인하자)/,
  /무서[워운웠]|겁[이나]|두려[워웠]/,
  /헤어지면\s*(?:가만|죽)/,
];

export interface RiskAssessment {
  level: RiskLevel;
  categories: RiskCategory[];
}

export function assessRisk(texts: string[], userReportedDanger = false): RiskAssessment {
  const joined = texts.join("\n");
  const categories = (Object.keys(DANGER) as RiskCategory[]).filter((c) =>
    DANGER[c].some((re) => re.test(joined)),
  );
  if (categories.length > 0 || userReportedDanger) {
    return { level: "danger", categories };
  }
  if (CAUTION.some((re) => re.test(joined))) return { level: "caution", categories: [] };
  return { level: "none", categories: [] };
}

export function safetyMessage(risk: RiskAssessment): string {
  if (risk.level === "none") return "";
  if (risk.level === "caution") {
    return "대화에 불안하거나 위축되는 표현이 보입니다. 안전이 걱정된다면 직접 만나기보다 믿을 수 있는 사람이나 전문 기관과 먼저 상의하세요.";
  }
  const parts = [
    "안전이 걱정되는 표현이 포함되어 있습니다. 이런 상황에서는 직접 만나 해결하거나 서둘러 화해하는 것을 권하지 않습니다.",
    "지금 위험하다면 112(경찰)에 연락하세요. 가정폭력·데이트폭력·성폭력·스토킹 상담은 1366(여성긴급전화, 24시간)에서도 받을 수 있습니다.",
  ];
  if (risk.categories.includes("selfharm")) {
    parts.push("스스로를 해치고 싶은 마음이 든다면 109(자살예방상담전화, 24시간)에 연락해 주세요.");
  }
  parts.push("위협이 담긴 메시지는 지우지 말고 화면 캡처 등으로 보관해 두면 도움이 될 수 있습니다.");
  return parts.join(" ");
}
