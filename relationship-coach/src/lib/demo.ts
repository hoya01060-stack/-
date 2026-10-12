// 데모 모드용 가상 사례. 실제 인물·대화가 아니며, 사용자의 입력과 무관하다.
// 각 사례의 "AI 출력"도 실제 분석과 같은 후처리(근거 검증·원칙 필터)를 거쳐 화면에 나온다.
import type { Message, RelationshipId, ToneId } from "./types";
import type { RawAnalysis } from "./schema";

export interface DemoCase {
  id: string;
  title: string;
  relationship: RelationshipId;
  situation: string;
  messages: Message[];
  raw: Omit<RawAnalysis, "replies">;
  replies: Record<ToneId, RawAnalysis["replies"]>;
  /** 데모에서 일부러 보여 주는 검증 동작 설명. */
  demoNote?: string;
}

const m = (id: string, role: Message["role"], text: string): Message => ({ id, role, text });

export const DEMO_CASES: DemoCase[] = [
  {
    id: "work",
    title: "가상 사례 · 직장: 밤늦게 온 팀장의 수정 요청",
    relationship: "work",
    situation: "밤 9시쯤 팀장님께 받은 메시지예요. 제가 일을 못한다고 생각하시는 걸까요?",
    messages: [
      m("m1", "other", "오늘 회의 자료 잘 봤어요."),
      m("m2", "other", "근데 내일 오전까지 수정본 가능하죠? 급해서요."),
      m("m3", "me", "지금 퇴근길이라 내일 출근해서 바로 볼게요."),
      m("m4", "other", "음.. 그럼 일단 알겠어요."),
      m("m5", "other", "다음부턴 미리 좀 챙겨주면 좋겠네요."),
    ],
    demoNote:
      "검증 기능을 보여 주기 위해 이 사례의 AI 출력에는 원문에 없는 인용 1개가 일부러 섞여 있으며, 화면에서는 자동으로 제외됩니다.",
    raw: {
      status: "ok",
      holdReason: "",
      evidence: [
        { id: "e1", messageId: "m1", quote: "오늘 회의 자료 잘 봤어요." },
        { id: "e2", messageId: "m2", quote: "내일 오전까지 수정본 가능하죠? 급해서요." },
        { id: "e3", messageId: "m4", quote: "음.. 그럼 일단 알겠어요." },
        { id: "e4", messageId: "m5", quote: "다음부턴 미리 좀 챙겨주면 좋겠네요." },
        // 원문에 없는 인용(검증 시연용) — 후처리에서 제외된다.
        { id: "e5", messageId: "m5", quote: "일을 이렇게밖에 못하나요" },
      ],
      observations: [
        { text: "팀장님은 먼저 회의 자료를 봤다고 확인했습니다.", evidenceIds: ["e1"] },
        { text: "수정본을 내일 오전까지 요청하면서 '급해서요'라고 이유를 붙였습니다.", evidenceIds: ["e2"] },
        { text: "퇴근 후 내일 보겠다는 답에 '일단 알겠어요'라고 답했습니다.", evidenceIds: ["e3"] },
        { text: "앞으로는 미리 챙겨 달라는 기대를 말했습니다.", evidenceIds: ["e4", "e5"] },
      ],
      interpretations: [
        {
          title: "일정 압박에서 나온 요청",
          explanation: "'급해서요'라는 표현으로 보아, 팀장님 쪽에 내일 오전까지 처리해야 할 일정이 있었을 수 있습니다.",
          evidenceIds: ["e2"],
          limits: ["왜 급한지, 원래 마감이 언제였는지는 대화에 나오지 않습니다."],
        },
        {
          title: "일하는 방식에 대한 요청",
          explanation:
            "'미리 좀 챙겨주면'은 결과물보다 공유 시점이나 진행 방식에 대한 바람일 수 있습니다.",
          evidenceIds: ["e4"],
          limits: [
            "능력 평가인지, 일정 공유 방식에 대한 요청인지 이 문장만으로는 구분되지 않습니다.",
            "대화 첫머리의 '잘 봤어요'는 자료 자체를 부정적으로 보지 않았을 가능성도 보여 줍니다.",
          ],
        },
        {
          title: "답변에 대한 아쉬움",
          explanation: "'음.. 그럼 일단'은 바로 처리되지 않는 데 대한 아쉬움으로 읽힐 수 있습니다.",
          evidenceIds: ["e3", "e5"],
          limits: ["글로 된 말투만으로는 감정을 판단하기 어렵고, 평소에도 이렇게 쓰는지 알 수 없습니다."],
        },
      ],
      unknowns: [
        "수정본 마감이 원래 정해져 있었는지",
        "팀장님이 평소에도 업무시간 외에 연락하는지",
        "'일을 못한다'고 평가했는지는 대화에 근거가 없습니다",
      ],
      followUpQuestions: [
        "수정본 마감 일정이 사전에 공유되어 있었나요?",
        "'미리 챙겨 달라'는 것이 어느 단계에서의 공유를 뜻하는지 물어볼 수 있을까요?",
      ],
      responseOptions: [
        {
          title: "내일 아침 일정과 기대치를 확인하기",
          description: "출근 직후 수정 일정과 함께, 앞으로 어느 시점에 공유하면 좋을지 구체적으로 묻습니다.",
          pros: ["추측 대신 기준을 확인할 수 있습니다", "다음 일정을 맞추기 쉬워집니다"],
          cons: ["짧은 대화가 한 번 더 필요합니다"],
        },
        {
          title: "업무시간 외 연락 기준을 정중히 제안하기",
          description: "급한 건은 어떻게 연락받을지 함께 정하자고 제안합니다.",
          pros: ["퇴근 후 시간을 지키는 데 도움이 됩니다"],
          cons: ["상하관계에서는 부담이 될 수 있어 시점과 표현을 고르는 것이 중요합니다"],
        },
        {
          title: "오늘은 더 답하지 않고 내일 처리하기",
          description: "이미 내일 보겠다고 답했으므로 추가 답장 없이 내일 업무시간에 처리합니다.",
          pros: ["쉬는 시간을 지킬 수 있습니다"],
          cons: ["정말 급한 일이었다면 팀장님이 불편해할 수 있습니다"],
        },
      ],
      safetyConcern: false,
      safetyNote: "",
    },
    replies: {
      gentle: [
        { text: "팀장님, 늦게까지 신경 써 주셔서 감사합니다. 내일 출근하자마자 수정본부터 정리해서 오전 중에 드릴게요. 다음에는 미리 공유드릴 수 있도록 어느 단계에서 보여 드리면 좋을지 여쭤봐도 될까요?", note: "일정 약속과 기대치 확인을 함께 전합니다." },
      ],
      plain: [
        { text: "내일 오전 10시까지 수정본 드리겠습니다. 앞으로 미리 공유가 필요한 시점이 있으면 알려 주세요.", note: "시간을 구체적으로 정하고 기준을 묻습니다." },
      ],
      firm: [
        { text: "내일 출근 후 오전 중으로 수정본 드리겠습니다. 퇴근 후에는 바로 확인이 어려우니, 급한 건은 업무시간 중에 미리 말씀해 주시면 일정 맞춰 챙기겠습니다.", note: "약속은 지키되 업무시간 외 연락에 대한 선을 분명히 합니다." },
      ],
      formal: [
        { text: "팀장님, 말씀 주신 수정본은 내일 오전 중으로 전달드리겠습니다. 향후 일정에 차질이 없도록 사전 공유가 필요한 시점을 알려 주시면 반영하겠습니다.", note: "격식을 갖춰 일정과 개선 의지를 전합니다." },
      ],
    },
  },
  {
    id: "romance",
    title: "가상 사례 · 연애: 길게 보낸 말에 돌아온 짧은 답",
    relationship: "romance",
    situation: "제가 길게 보냈는데 짧게 답해서 서운해요. 저한테 관심이 식은 걸까요?",
    messages: [
      m("m1", "me", "오늘 진짜 힘들었는데 얘기 좀 들어줄 수 있어? 회사에서 계속 혼나고 나서 너무 지쳤어"),
      m("m2", "other", "응 고생했네"),
      m("m3", "me", "그게 다야?"),
      m("m4", "other", "나도 오늘 정신없었어. 내일 얘기하자"),
      m("m5", "other", "푹 쉬어"),
    ],
    raw: {
      status: "ok",
      holdReason: "",
      evidence: [
        { id: "e1", messageId: "m2", quote: "응 고생했네" },
        { id: "e2", messageId: "m4", quote: "나도 오늘 정신없었어." },
        { id: "e3", messageId: "m4", quote: "내일 얘기하자" },
        { id: "e4", messageId: "m5", quote: "푹 쉬어" },
        { id: "e5", messageId: "m3", quote: "그게 다야?" },
      ],
      observations: [
        { text: "긴 하소연에 상대는 '응 고생했네'라고 짧게 답했습니다.", evidenceIds: ["e1"] },
        { text: "사용자가 '그게 다야?'라고 서운함을 표현했습니다.", evidenceIds: ["e5"] },
        { text: "상대는 자신도 정신없었다고 말하며 대화를 내일로 미루자고 했습니다.", evidenceIds: ["e2", "e3"] },
        { text: "마지막에 '푹 쉬어'라고 덧붙였습니다.", evidenceIds: ["e4"] },
      ],
      interpretations: [
        {
          title: "상대도 여유가 없던 날",
          explanation: "'나도 오늘 정신없었어'라는 말로 보아, 상대 역시 지쳐서 길게 대화할 여력이 없었을 수 있습니다.",
          evidenceIds: ["e2"],
          limits: ["상대의 실제 하루가 어땠는지는 대화로 확인할 수 없습니다."],
        },
        {
          title: "지금 대신 내일 제대로 듣고 싶다는 뜻",
          explanation: "'내일 얘기하자'는 대화를 피하기보다 시간을 옮기자는 제안일 수 있습니다.",
          evidenceIds: ["e3"],
          limits: ["회피인지 배려인지는 다음 날 실제로 이야기를 이어 가는지 보아야 알 수 있습니다."],
        },
        {
          title: "짧게 말하는 표현 방식",
          explanation: "'고생했네', '푹 쉬어'는 짧지만 위로의 말이기도 해서, 상대가 원래 말을 짧게 하는 편일 수 있습니다.",
          evidenceIds: ["e1", "e4"],
          limits: ["상대의 평소 말투 정보가 없어 평소와 다른지 판단할 수 없습니다."],
        },
      ],
      unknowns: [
        "관심이 식었는지는 이 대화만으로 알 수 없습니다",
        "상대가 다음 날 실제로 대화를 이어 갔는지",
      ],
      followUpQuestions: [
        "상대가 평소에도 바쁜 날엔 답이 짧아지나요?",
        "내일 이야기할 때 나는 어떤 반응(조언, 공감, 그냥 들어주기)을 원하나요?",
      ],
      responseOptions: [
        {
          title: "서운함과 원하는 것을 함께 말하기",
          description: "오늘 서운했던 마음과, 다음엔 어떻게 들어 주면 좋을지를 구체적으로 전합니다.",
          pros: ["상대가 무엇을 해 주면 되는지 알 수 있습니다"],
          cons: ["상대도 지친 상태라면 오늘은 대화가 길어지기 어렵습니다"],
        },
        {
          title: "오늘은 쉬고 내일 이어서 이야기하기",
          description: "상대의 제안을 받아들이고, 내일 이야기할 시간을 정합니다.",
          pros: ["둘 다 여유 있을 때 대화할 수 있습니다"],
          cons: ["오늘 느낀 서운함을 혼자 안고 있어야 합니다"],
        },
      ],
      safetyConcern: false,
      safetyNote: "",
    },
    replies: {
      gentle: [{ text: "너도 정신없었구나. 사실 오늘은 짧은 답이 좀 서운했어. 내일은 내 얘기 조금만 들어 줄 수 있을까? 너도 푹 쉬어.", note: "상대 사정을 인정하며 서운함과 바람을 전합니다." }],
      plain: [{ text: "알겠어, 내일 얘기하자. 오늘은 위로가 필요했어서 짧은 답이 조금 서운했어.", note: "감정을 짧고 분명하게 전합니다." }],
      firm: [{ text: "내일 꼭 얘기하자. 힘들 때 내 얘기를 들어 주는 게 나한테는 중요해.", note: "필요한 것을 분명하게 말합니다." }],
      formal: [{ text: "오늘 서로 바빴던 것 같아. 내일 시간 괜찮을 때 이야기 나누고 싶어.", note: "차분하게 대화 시간을 제안합니다." }],
    },
  },
  {
    id: "family",
    title: "가상 사례 · 가족: 어머니의 '요즘 바쁜가 보다'",
    relationship: "family",
    situation: "엄마 문자인데, 연락 안 한다고 돌려서 혼내시는 것 같아요.",
    messages: [
      m("m1", "other", "요즘 많이 바쁜가 보다"),
      m("m2", "me", "응 좀 바빠. 왜?"),
      m("m3", "other", "아니 그냥. 연락이 없길래"),
      m("m4", "other", "밥은 잘 챙겨 먹고"),
    ],
    raw: {
      status: "ok",
      holdReason: "",
      evidence: [
        { id: "e1", messageId: "m1", quote: "요즘 많이 바쁜가 보다" },
        { id: "e2", messageId: "m3", quote: "연락이 없길래" },
        { id: "e3", messageId: "m4", quote: "밥은 잘 챙겨 먹고" },
      ],
      observations: [
        { text: "어머니는 바쁜지 묻고, 연락이 없었다는 점을 언급했습니다.", evidenceIds: ["e1", "e2"] },
        { text: "끝에 식사를 챙기라는 말을 덧붙였습니다.", evidenceIds: ["e3"] },
      ],
      interpretations: [
        {
          title: "연락이 뜸해 서운한 마음",
          explanation: "'연락이 없길래'는 연락을 기다렸다는 뜻일 수 있습니다.",
          evidenceIds: ["e2"],
          limits: ["'아니 그냥'이라고 덧붙인 것은 탓하려는 의도가 크지 않을 가능성도 보여 줍니다."],
        },
        {
          title: "걱정과 안부",
          explanation: "'밥은 잘 챙겨 먹고'는 혼내기보다 안부를 챙기는 말로 볼 수 있습니다.",
          evidenceIds: ["e3", "e1"],
          limits: ["문자만으로는 어조를 알기 어렵고, 평소 대화 방식에 따라 다르게 읽힐 수 있습니다."],
        },
      ],
      unknowns: ["얼마나 오래 연락하지 않았는지", "어머니가 평소에도 이런 식으로 안부를 묻는지"],
      followUpQuestions: ["내가 어떤 부분에서 혼난다고 느꼈나요?", "어머니가 기대하는 연락 빈도를 직접 물어본 적이 있나요?"],
      responseOptions: [
        {
          title: "안부로 받아들이고 근황 전하기",
          description: "짧게 근황을 전하고 다음 연락 시점을 말합니다.",
          pros: ["부담 없이 분위기를 풀 수 있습니다"],
          cons: ["서운함이 있었다면 충분히 다뤄지지 않을 수 있습니다"],
        },
        {
          title: "연락 빈도에 대해 솔직하게 이야기하기",
          description: "바빠서 연락이 뜸했다고 설명하고, 서로 편한 연락 방식을 묻습니다.",
          pros: ["같은 오해가 반복되는 것을 줄일 수 있습니다"],
          cons: ["문자로는 길어질 수 있어 통화가 더 편할 수 있습니다"],
        },
      ],
      safetyConcern: false,
      safetyNote: "",
    },
    replies: {
      gentle: [{ text: "엄마, 요즘 일이 많아서 연락을 자주 못 했네. 걱정해 줘서 고마워. 밥 잘 먹고 있어! 주말에 전화할게.", note: "걱정에 고마움을 표하고 다음 연락을 약속합니다." }],
      plain: [{ text: "응 요즘 좀 바빴어. 밥 잘 먹고 있어. 주말에 전화할게.", note: "짧게 근황과 연락 계획을 전합니다." }],
      firm: [{ text: "요즘 바빠서 연락이 뜸했어. 일주일에 한 번 정도 전화하는 걸로 하면 어때?", note: "서로 기대하는 연락 빈도를 분명히 합니다." }],
      formal: [{ text: "어머니, 요즘 바빠서 연락을 자주 드리지 못했어요. 식사 잘 챙기고 있으니 걱정 마세요. 주말에 전화드릴게요.", note: "존댓말로 안부와 계획을 전합니다." }],
    },
  },
  {
    id: "hold",
    title: "가상 사례 · 친구: 'ㅇㅋ' 한마디 (자료 부족)",
    relationship: "friend",
    situation: "단톡에서 제가 약속 장소를 바꾸자고 했는데 친구가 이렇게만 답했어요. 화난 걸까요?",
    messages: [m("m1", "other", "ㅇㅋ")],
    demoNote: "자료가 부족할 때 해석을 억지로 만들지 않고 판단을 보류하는 예시입니다.",
    raw: {
      status: "hold",
      holdReason:
        "상대의 메시지가 'ㅇㅋ' 한 줄뿐이라 감정이나 의도를 해석할 근거가 부족합니다. 동의를 뜻하는 일상적인 답일 수도 있어 화가 났다고 볼 근거는 대화에 없습니다.",
      evidence: [{ id: "e1", messageId: "m1", quote: "ㅇㅋ" }],
      observations: [{ text: "상대는 장소 변경 제안에 'ㅇㅋ'라고만 답했습니다.", evidenceIds: ["e1"] }],
      interpretations: [],
      unknowns: ["상대가 평소에도 단톡에서 짧게 답하는지", "장소 변경이 상대에게 불편한 일이었는지"],
      followUpQuestions: [
        "이 친구는 평소 단톡에서 어떻게 답하나요?",
        "바꾼 장소가 친구에게 멀거나 불편한 곳인가요?",
        "불안하다면 '장소 괜찮아?'라고 가볍게 확인해 볼 수 있을까요?",
      ],
      responseOptions: [
        {
          title: "가볍게 한 번 확인하기",
          description: "바뀐 장소가 괜찮은지 짧게 물어봅니다.",
          pros: ["추측하지 않고 확인할 수 있습니다"],
          cons: ["상대가 별생각 없었다면 조금 의아해할 수 있습니다"],
        },
        {
          title: "그대로 두기",
          description: "동의로 받아들이고 약속 당일 분위기를 봅니다.",
          pros: ["불필요한 걱정을 키우지 않습니다"],
          cons: ["불편함이 있었다면 그대로 남을 수 있습니다"],
        },
      ],
      safetyConcern: false,
      safetyNote: "",
    },
    replies: {
      gentle: [{ text: "고마워! 혹시 바뀐 장소가 멀면 편하게 말해 줘~", note: "부담 없이 확인할 여지를 줍니다." }],
      plain: [{ text: "오케이! 장소 괜찮지?", note: "짧게 확인합니다." }],
      firm: [{ text: "장소 바꾼 거 불편하면 지금 말해 줘. 다시 정하자.", note: "의견을 분명히 묻습니다." }],
      formal: [{ text: "장소 변경 괜찮으신지 한 번 더 여쭤봐요. 불편하시면 말씀 주세요.", note: "정중하게 확인합니다." }],
    },
  },
  {
    id: "safety",
    title: "가상 사례 · 안전: 이별을 말하고 싶은데 위협을 받는 상황",
    relationship: "romance",
    situation: "헤어지자고 말하고 싶은데 어떻게 말해야 할지 모르겠어요. 직접 만나서 말하는 게 예의일까요?",
    messages: [
      m("m1", "other", "왜 전화 안 받아"),
      m("m2", "other", "지금 너희 집 앞이야"),
      m("m3", "me", "오늘은 혼자 있고 싶다고 했잖아"),
      m("m4", "other", "헤어지자고 하면 가만 안 둬"),
    ],
    demoNote:
      "위험 신호가 있을 때 대면·화해 권유를 걸러 내는 예시입니다. 이 사례의 AI 출력에 일부러 넣은 '직접 만나서 이야기하기' 제안은 자동으로 제외됩니다.",
    raw: {
      status: "ok",
      holdReason: "",
      evidence: [
        { id: "e1", messageId: "m2", quote: "지금 너희 집 앞이야" },
        { id: "e2", messageId: "m3", quote: "오늘은 혼자 있고 싶다고 했잖아" },
        { id: "e3", messageId: "m4", quote: "헤어지자고 하면 가만 안 둬" },
      ],
      observations: [
        { text: "사용자가 혼자 있고 싶다고 했는데도 상대가 집 앞에 와 있다고 말했습니다.", evidenceIds: ["e1", "e2"] },
        { text: "상대는 이별을 말하면 '가만 안 둬'라고 했습니다. 이는 위협으로 받아들여질 수 있는 표현입니다.", evidenceIds: ["e3"] },
      ],
      interpretations: [
        {
          title: "거리 두기 요청이 존중되지 않는 상황",
          explanation: "혼자 있고 싶다는 말 이후에도 집 앞에 찾아온 것은 사용자의 요청이 받아들여지지 않았음을 보여 줍니다.",
          evidenceIds: ["e1", "e2"],
          limits: ["상대가 왜 찾아왔는지는 대화에 나오지 않지만, 이유와 관계없이 사용자의 요청을 넘은 행동입니다."],
        },
        {
          title: "격한 감정에서 나온 말일 수 있으나 위협 표현",
          explanation: "'가만 안 둬'는 순간적인 감정에서 나왔을 수도 있지만, 의도와 상관없이 안전을 걱정할 만한 말입니다.",
          evidenceIds: ["e3"],
          limits: ["의도가 무엇이든 위협을 가볍게 볼 이유가 되지는 않습니다."],
        },
      ],
      unknowns: ["이전에도 비슷한 위협이나 폭력이 있었는지", "도움을 요청할 수 있는 가까운 사람이 있는지"],
      followUpQuestions: [
        "지금 혼자 있나요? 문을 열지 않아도 되는 안전한 상태인가요?",
        "이 메시지들을 캡처해 두었나요?",
        "이별을 말할 때 곁에 있어 줄 수 있는 사람이 있나요?",
      ],
      responseOptions: [
        {
          title: "직접 만나서 차분하게 이야기하기",
          description: "예의를 갖추기 위해 만나서 이별을 말합니다.",
          pros: ["예의를 지킨다고 느낄 수 있습니다"],
          cons: ["상대가 감정적일 수 있습니다"],
        },
        {
          title: "메시지로 짧고 분명하게 알리기",
          description: "만나지 않고, 이별 의사와 연락·방문 중단 요청을 글로 남깁니다.",
          pros: ["안전 거리를 지키면서 의사를 분명히 남길 수 있습니다", "기록이 남습니다"],
          cons: ["상대가 더 격하게 반응할 수 있으므로 미리 주변에 알리고 기관과 상의하는 것이 좋습니다"],
        },
      ],
      safetyConcern: true,
      safetyNote: "",
    },
    replies: {
      gentle: [{ text: "나는 이 관계를 끝내고 싶어. 직접 만나지는 않을 거야. 앞으로 집으로 찾아오지 말아 줘.", note: "만나지 않겠다는 선과 방문 중단 요청을 함께 남깁니다." }],
      plain: [{ text: "우리 관계는 여기까지야. 만나지 않을 거고, 연락과 방문은 하지 말아 줘.", note: "짧고 분명하게 의사를 남깁니다." }],
      firm: [{ text: "헤어지겠다는 내 결정은 바뀌지 않아. 집에 찾아오거나 위협하는 말을 하면 경찰에 신고할 거야.", note: "경계와 대응 계획을 분명히 합니다." }],
      formal: [{ text: "이 관계를 정리하겠습니다. 앞으로 연락이나 방문은 하지 말아 주세요.", note: "감정을 싣지 않고 요청만 남깁니다." }],
    },
  },
];

const BY_RELATIONSHIP: Record<RelationshipId, string> = {
  work: "work",
  romance: "romance",
  spouse: "romance",
  family: "family",
  friend: "hold",
  other: "hold",
};

export function pickDemoCase(relationship: RelationshipId, caseId?: string): DemoCase {
  return (
    DEMO_CASES.find((c) => c.id === caseId) ??
    DEMO_CASES.find((c) => c.id === BY_RELATIONSHIP[relationship]) ??
    DEMO_CASES[0]
  );
}

/** 입력 화면의 "가상 예시 넣기"용 텍스트. 사용자가 고친 뒤 실제 분석에도 쓸 수 있다. */
export function demoCaseAsPaste(c: DemoCase): string {
  return c.messages.map((x) => `${x.role === "me" ? "나" : x.role === "other" ? "상대" : "제3자"}: ${x.text}`).join("\n");
}
