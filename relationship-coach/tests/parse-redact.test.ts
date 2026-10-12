import { describe, expect, it } from "vitest";
import { listSpeakers, parseConversation } from "@/lib/parseConversation";
import { DEFAULT_ENABLED, redactText, type RedactionCounts } from "@/lib/redact";
import { buildDraft, toRequest, type DraftInput } from "@/lib/draft";

describe("대화 파싱", () => {
  it("'이름: 내용' 형식과 이어지는 줄을 처리한다", () => {
    const lines = parseConversation("민지: 오늘 시간 돼?\n나: 응\n저녁에 괜찮아\n민지: 좋아");
    expect(lines).toEqual([
      { speaker: "민지", text: "오늘 시간 돼?" },
      { speaker: "나", text: "응\n저녁에 괜찮아" },
      { speaker: "민지", text: "좋아" },
    ]);
    expect(listSpeakers(lines)).toEqual(["민지", "나"]);
  });

  it("카카오톡 PC·모바일 내보내기 형식을 읽고 날짜 줄은 건너뛴다", () => {
    const pc = parseConversation("--------------- 2025년 3월 1일 토요일 ---------------\n[민지] [오후 3:12] 어디야?\n[나] [오후 3:13] 가는 중");
    expect(pc.map((l) => l.speaker)).toEqual(["민지", "나"]);
    const mobile = parseConversation("2025년 3월 1일 오후 3:12, 민지 : 어디야?\n2025. 3. 1. 오후 3:13, 나 : 가는 중");
    expect(mobile).toEqual([
      { speaker: "민지", text: "어디야?" },
      { speaker: "나", text: "가는 중" },
    ]);
  });

  it("시각·URL의 콜론을 발화자로 오인하지 않는다", () => {
    const lines = parseConversation("상대: 링크 https://example.com 봐\n3:30에 보자");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("3:30에 보자");
  });
});

describe("개인정보 가림", () => {
  const opts = { enabled: { ...DEFAULT_ENABLED }, names: ["김민지", "민지"], customWords: ["한빛상사"] };

  it("전화번호·이메일·주민번호·계좌·카드·링크·주소·이름·직접 단어를 가린다", () => {
    const counts: RedactionCounts = {};
    const out = redactText(
      "김민지 010-1234-5678 a.b@test.co.kr 900101-1234567 110-123-456789 1234-5678-9012-3456 https://x.y/z 서울특별시 강남구 테헤란로 123 한빛상사 민지야",
      opts,
      counts,
    );
    expect(out).toBe("[이름] [전화번호] [이메일] [주민번호] [계좌번호] [카드번호] [링크] [주소] [가림] [이름]야");
    expect(counts.names).toBe(2);
  });

  it("끈 규칙은 적용하지 않는다", () => {
    const out = redactText("010-1234-5678", { ...opts, enabled: { ...DEFAULT_ENABLED, phone: false, account: false } });
    expect(out).toBe("010-1234-5678");
  });

  it("미리보기와 전송 본문이 같고, 발화자 이름은 역할로만 전달된다", () => {
    const d: DraftInput = {
      relationship: "friend",
      goal: "understand",
      tone: "plain",
      situation: "민지가 보낸 말",
      conversation: "민지: 내 번호 010-9999-8888로 연락해\n나: 알겠어",
      speakerRoles: { 민지: "other", 나: "me" },
      lineRoles: {},
      redaction: { enabled: { ...DEFAULT_ENABLED }, customWords: "" },
      context: { feeling: "민지한테 서운해" },
    };
    const view = buildDraft(d);
    const req = toRequest(d, view, "req-12345678", false);
    expect(req.messages).toEqual([
      { id: "m1", role: "other", text: "내 번호 [전화번호]로 연락해" },
      { id: "m2", role: "me", text: "알겠어" },
    ]);
    expect(req.situation).toBe("[이름]가 보낸 말");
    expect(req.context.feeling).toBe("[이름]한테 서운해");
    expect(JSON.stringify(req)).not.toContain("민지");
  });

  it("데모 모드 전송 본문에는 사용자 입력이 들어가지 않는다", () => {
    const d: DraftInput = {
      relationship: "friend",
      goal: "understand",
      tone: "plain",
      situation: "비밀 상황",
      conversation: "상대: 비밀 대화",
      speakerRoles: { 상대: "other" },
      lineRoles: {},
      redaction: { enabled: { ...DEFAULT_ENABLED }, customWords: "" },
      context: { before: "비밀 맥락" },
    };
    const req = toRequest(d, buildDraft(d), "req-12345678", true);
    expect(JSON.stringify(req)).not.toContain("비밀");
  });

  it("발화자를 정하지 않은 줄은 전송하지 않고 개수를 알린다", () => {
    const d: DraftInput = {
      relationship: "friend",
      goal: "understand",
      tone: "plain",
      situation: "",
      conversation: "철수: 안녕\n영희: 응",
      speakerRoles: { 철수: "other" },
      lineRoles: {},
      redaction: { enabled: { ...DEFAULT_ENABLED }, customWords: "" },
      context: {},
    };
    const view = buildDraft(d);
    expect(view.unassignedLines).toBe(1);
    expect(view.messages).toHaveLength(1);
  });
});
