// 관계·목표에 따라 분석 전에 묻는 맥락 질문. 모두 선택 응답이다.
import type { GoalId, RelationshipId } from "./types";

export interface ContextQuestion {
  id: string;
  label: string;
  help?: string;
  kind: "choice" | "text";
  choices?: string[];
}

const POWER: ContextQuestion = {
  id: "power",
  label: "두 사람 사이에 평가·고용·경제적 의존 같은 힘의 차이가 있나요?",
  help: "힘의 차이가 있으면 같은 말도 다르게 받아들여질 수 있고, 대응 방법도 달라집니다.",
  kind: "choice",
  choices: ["상대가 더 큰 영향력을 가짐", "비슷함", "내가 더 큰 영향력을 가짐", "잘 모르겠음"],
};

const SAFETY: ContextQuestion = {
  id: "safety",
  label: "최근 이 사람 때문에 안전이 걱정된 적이 있나요? (위협, 폭력, 감시 등)",
  help: "있다고 답하면 대면이나 화해를 권하지 않고 안전을 우선한 선택지를 보여 드립니다.",
  kind: "choice",
  choices: ["없음", "있음", "말하기 어려움"],
};

export function getContextQuestions(relationship: RelationshipId, goal: GoalId): ContextQuestion[] {
  const qs: ContextQuestion[] = [
    {
      id: "before",
      label: "이 대화 전후로 있었던 일이 있나요?",
      help: "예: 약속이 취소됐다, 며칠 연락이 없었다",
      kind: "text",
    },
    {
      id: "usual",
      label: "상대가 평소에도 이런 말투인가요?",
      kind: "choice",
      choices: ["평소와 비슷함", "평소와 다름", "잘 모르겠음"],
    },
    {
      id: "feeling",
      label: "이 대화를 보고 지금 어떤 기분이 드나요?",
      help: "내 감정과 상대의 의도는 따로 살펴봅니다.",
      kind: "text",
    },
  ];

  if (relationship === "work" || relationship === "family" || relationship === "spouse" || relationship === "other") {
    qs.push(POWER);
  }
  if (relationship !== "work") qs.push(SAFETY);
  else qs.push({ ...SAFETY, label: "최근 이 사람 때문에 안전이 걱정되거나 괴롭힘을 겪은 적이 있나요?" });

  if (goal === "request") {
    qs.push({ id: "want", label: "상대에게 바라는 것을 한 문장으로 적어 주세요.", kind: "text" });
  }
  if (goal === "boundary") {
    qs.push({ id: "boundaryLine", label: "지키고 싶은 선은 무엇인가요?", help: "예: 밤 11시 이후 업무 연락", kind: "text" });
  }
  if (goal === "reply") {
    qs.push({ id: "replyAim", label: "답장으로 이루고 싶은 것은 무엇인가요?", help: "예: 서운함을 전하되 다투고 싶지 않다", kind: "text" });
  }
  if (goal === "misunderstanding") {
    qs.push({ id: "myReading", label: "나는 이 말을 어떻게 받아들였나요?", kind: "text" });
  }
  return qs;
}

export function questionLabel(id: string): string {
  const all = [
    ...getContextQuestions("family", "request"),
    ...getContextQuestions("romance", "boundary"),
    ...getContextQuestions("work", "reply"),
    ...getContextQuestions("friend", "misunderstanding"),
  ];
  return all.find((q) => q.id === id)?.label ?? id;
}

export const KNOWN_QUESTION_IDS = ["before", "usual", "feeling", "power", "safety", "want", "boundaryLine", "replyAim", "myReading"];
