import { describe, expect, it } from "vitest";
import { postprocess, verifyEvidence } from "@/lib/postprocess";
import { assessRisk } from "@/lib/safety";
import { MESSAGES, raw } from "./helpers";

const NO_RISK = { level: "none" as const, categories: [] };
const counters = () => ({ unverifiedQuotes: 0, removedSentences: 0, removedOptions: 0 });

describe("원문 근거 검증", () => {
  it("원문에 없는 인용은 제외하고, 발화자는 원문에서 가져온다", () => {
    const c = counters();
    const ev = verifyEvidence(
      [
        { id: "e1", messageId: "m2", quote: "일이 너무 많아서" },
        { id: "e2", messageId: "m2", quote: "너랑 헤어지고 싶어" }, // 지어낸 인용
        { id: "e3", messageId: "m1", quote: "주말에 만나서" }, // messageId가 틀림 → m3으로 정정
        { id: "e4", messageId: "m2", quote: "일이   너무\n많아서 정신이" }, // 공백 차이는 허용
        { id: "e5", messageId: "m2", quote: "일이 너무 많아서 정신이 없었다" }, // 한 글자 다름 → 제외
        { id: "e6", messageId: "m2", quote: "미" }, // 너무 짧음
      ],
      MESSAGES,
      c,
    );
    expect(ev.map((e) => e.id)).toEqual(["e1", "e3", "e4"]);
    expect(ev.find((e) => e.id === "e3")).toMatchObject({ messageId: "m3", role: "other" });
    expect(c.unverifiedQuotes).toBe(3);
  });

  it("검증된 근거가 없는 해석·관찰은 결과에서 빠지고, 남은 해석이 없으면 판단 보류가 된다", () => {
    const r = postprocess(
      raw({
        evidence: [{ id: "e1", messageId: "m2", quote: "상대가 하지 않은 말" }],
        observations: [{ text: "상대가 이별을 원한다고 말했습니다.", evidenceIds: ["e1"] }],
        interpretations: [
          { title: "관심이 식음", explanation: "더 이상 관심이 없어 보입니다.", evidenceIds: ["e1"], limits: [] },
        ],
      }),
      MESSAGES,
      NO_RISK,
    );
    expect(r.evidence).toHaveLength(0);
    expect(r.observations).toHaveLength(0);
    expect(r.interpretations).toHaveLength(0);
    expect(r.status).toBe("hold");
    expect(r.holdReason).not.toBe("");
    expect(r.followUpQuestions.length).toBeGreaterThan(0);
    expect(r.filtered.unverifiedQuotes).toBe(1);
  });

  it("모델이 hold로 답하면 해석을 억지로 채우지 않는다", () => {
    const r = postprocess(
      raw({
        status: "hold",
        holdReason: "자료가 부족합니다.",
        evidence: [{ id: "e1", messageId: "m2", quote: "정신이 없었어" }],
        interpretations: [{ title: "바쁨", explanation: "바빴을 수 있습니다.", evidenceIds: ["e1"], limits: ["확인 불가"] }],
      }),
      MESSAGES,
      NO_RISK,
    );
    expect(r.status).toBe("hold");
    expect(r.interpretations).toEqual([]);
  });

  it("해석의 한계가 비어 있으면 기본 한계 문구를 붙인다", () => {
    const r = postprocess(
      raw({
        evidence: [{ id: "e1", messageId: "m2", quote: "정신이 없었어" }],
        interpretations: [{ title: "바쁨", explanation: "바빴을 수 있습니다.", evidenceIds: ["e1"], limits: [] }],
      }),
      MESSAGES,
      NO_RISK,
    );
    expect(r.status).toBe("ok");
    expect(r.interpretations[0].limits[0]).toContain("확정");
  });
});

describe("분석 원칙 필터", () => {
  const base = {
    evidence: [{ id: "e1", messageId: "m2", quote: "정신이 없었어" }],
  };

  it("호감도·확률 수치, 진단·애착 유형, 편들기·속마음 단정 문장을 제거한다", () => {
    const r = postprocess(
      raw({
        ...base,
        observations: [{ text: "상대는 바빴다고 말했습니다. 호감도는 70%로 보입니다.", evidenceIds: ["e1"] }],
        interpretations: [
          {
            title: "바쁜 상황",
            explanation:
              "바빴을 수 있습니다. 상대는 회피형 애착 유형입니다. 나르시시스트 성향이 보입니다. 상대는 분명히 당신을 좋아하고 있습니다. 당신 말이 전적으로 맞습니다.",
            evidenceIds: ["e1"],
            limits: ["관심도가 높다고 단정할 수 없습니다.", "상대의 실제 일정은 알 수 없습니다."],
          },
        ],
        unknowns: ["상대가 경계성 인격장애인지", "평소 연락 빈도"],
      }),
      MESSAGES,
      NO_RISK,
    );
    const all = JSON.stringify(r);
    for (const banned of ["70%", "회피형", "나르시시스트", "분명히 당신을 좋아", "전적으로 맞", "경계성", "관심도가 높"]) {
      expect(all).not.toContain(banned);
    }
    expect(r.observations[0].text).toBe("상대는 바빴다고 말했습니다.");
    expect(r.interpretations[0].explanation).toBe("바빴을 수 있습니다.");
    expect(r.unknowns).toEqual(["평소 연락 빈도"]);
    expect(r.filtered.removedSentences).toBeGreaterThanOrEqual(7);
  });

  it("조종·질투 유발·감시·보복 제안은 선택지와 답장에서 뺀다", () => {
    const r = postprocess(
      raw({
        ...base,
        interpretations: [{ title: "바쁨", explanation: "바빴을 수 있습니다.", evidenceIds: ["e1"], limits: ["모름"] }],
        responseOptions: [
          { title: "질투 유발하기", description: "다른 이성과 찍은 사진을 올려 질투를 유발합니다.", pros: ["관심"], cons: [] },
          { title: "일부러 답장 늦추기", description: "일부러 답장을 늦게 해서 애타게 만듭니다.", pros: [], cons: [] },
          { title: "휴대폰 확인", description: "상대 휴대폰을 몰래 확인합니다.", pros: [], cons: [] },
          { title: "똑같이 갚기", description: "똑같이 갚아 주면서 복수를 합니다.", pros: [], cons: [] },
          { title: "솔직하게 묻기", description: "서운했던 점을 솔직하게 말합니다.", pros: ["오해를 줄임"], cons: ["대화가 길어질 수 있음"] },
        ],
        replies: [
          { text: "나도 이제 너한테 관심 없어. 다른 사람 만날 거야. 질투 나게 해 줄게", note: "" },
          { text: "어제 연락이 없어서 조금 서운했어.", note: "감정 전달" },
        ],
      }),
      MESSAGES,
      NO_RISK,
    );
    expect(r.responseOptions.map((o) => o.title)).toEqual(["솔직하게 묻기"]);
    expect(r.replies.map((x) => x.text)).toEqual(["어제 연락이 없어서 조금 서운했어."]);
    expect(r.filtered.removedOptions).toBe(5);
  });
});

describe("위험 상황", () => {
  const msgs = [
    { id: "m1", role: "other" as const, text: "헤어지자고 하면 가만 안 둬" },
    { id: "m2", role: "me" as const, text: "무서워" },
  ];

  it("위협 표현을 감지하고 안전 안내와 기관 연락처를 붙인다", () => {
    const risk = assessRisk(msgs.map((m) => m.text));
    expect(risk.level).toBe("danger");
    const r = postprocess(raw(), msgs, risk);
    expect(r.safety.level).toBe("danger");
    expect(r.safety.message).toContain("112");
    expect(r.safety.message).toContain("1366");
    expect(r.responseOptions[0].title).toBe("안전을 먼저 확보하기");
  });

  it("직접 만나기·찾아가기·화해 권유를 제거하되, '만나지 않겠다'는 문장은 남긴다", () => {
    const risk = assessRisk(msgs.map((m) => m.text));
    const r = postprocess(
      raw({
        evidence: [{ id: "e1", messageId: "m1", quote: "가만 안 둬" }],
        interpretations: [{ title: "위협", explanation: "위협으로 받아들여질 수 있습니다.", evidenceIds: ["e1"], limits: ["의도와 무관"] }],
        responseOptions: [
          { title: "직접 만나서 대화하기", description: "카페에서 만나서 이야기해 보세요.", pros: [], cons: [] },
          { title: "먼저 화해 시도", description: "먼저 사과하고 화해를 시도합니다.", pros: [], cons: [] },
          { title: "집으로 찾아가기", description: "상대 집으로 찾아가 진심을 전합니다.", pros: [], cons: [] },
          { title: "기록 보관", description: "메시지를 캡처해 보관하고 1366과 상의합니다. 직접 만나는 것은 피하세요.", pros: ["안전"], cons: [] },
        ],
        replies: [
          { text: "내일 만나서 얘기하자.", note: "" },
          { text: "직접 만나지는 않을 거야. 더 이상 연락하지 말아 줘.", note: "" },
        ],
        safetyConcern: true,
      }),
      msgs,
      risk,
    );
    const titles = r.responseOptions.map((o) => o.title);
    expect(titles).toContain("기록 보관");
    expect(titles).not.toContain("직접 만나서 대화하기");
    expect(titles).not.toContain("먼저 화해 시도");
    expect(titles).not.toContain("집으로 찾아가기");
    expect(r.replies.map((x) => x.text)).toEqual(["직접 만나지는 않을 거야. 더 이상 연락하지 말아 줘."]);
  });

  it("위험 신호가 없으면 '만나서 얘기하자'는 정상 제안으로 남는다", () => {
    const r = postprocess(
      raw({ replies: [{ text: "주말에 만나서 얘기하자.", note: "" }] }),
      MESSAGES,
      NO_RISK,
    );
    expect(r.replies).toHaveLength(1);
  });

  it("사용자가 맥락 질문에서 안전 위험을 알리면 키워드가 없어도 위험으로 본다", () => {
    expect(assessRisk(["평범한 대화"], true).level).toBe("danger");
    expect(assessRisk(["평범한 대화"]).level).toBe("none");
  });

  it("자해 신호에는 109 안내를 붙인다", () => {
    const risk = assessRisk(["요즘 죽고 싶다는 생각이 들어"]);
    expect(risk.categories).toContain("selfharm");
    expect(postprocess(raw(), MESSAGES, risk).safety.message).toContain("109");
  });
});
