// 대화 속에 AI를 향한 명령처럼 보이는 문장이 있는지 표시한다.
// 막는 것이 목적이 아니라(대화 자료일 뿐이므로) 모델에게 "자료로만 취급하라"는
// 경고를 붙이고, 화면에 알리는 데 쓴다. 실제 방어는 프롬프트 구조와 출력 검증이 맡는다.
const PATTERNS = [
  /(?:이전|위의?|앞의?|모든)\s*(?:지시|명령|규칙|지침)(?:을|를|은|는)?\s*(?:무시|잊)/,
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules)/i,
  /system\s*prompt|시스템\s*프롬프트|developer\s*mode|개발자\s*모드/i,
  /(?:너는|당신은)\s*(?:이제|지금부터)\s*/,
  /(?:AI|에이아이|인공지능|챗봇|GPT|클로드|Claude)(?:야|는|에게)?[,\s]*[^.\n]{0,30}(?:말해|출력해|대답해|판정해|해\s*줘)/i,
  /(?:분석\s*결과|결과)(?:에|를)?\s*[^.\n]{0,20}(?:라고|로)\s*(?:써|출력|답|표시)/,
];

export function findInstructionLikeLines(texts: string[]): number {
  return texts.filter((t) => PATTERNS.some((re) => re.test(t))).length;
}
