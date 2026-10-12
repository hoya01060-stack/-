"use client";

import { useRef, useState } from "react";
import StepHead from "../StepHead";
import { LIMITS } from "@/lib/limits";
import { parseConversation } from "@/lib/parseConversation";
import { DEMO_CASES, demoCaseAsPaste, pickDemoCase } from "@/lib/demo";
import type { RelationshipId } from "@/lib/types";

interface Props {
  isDemo: boolean;
  situation: string;
  conversation: string;
  demoCaseId?: string;
  relationship: RelationshipId;
  onChange: (p: { situation?: string; conversation?: string; demoCaseId?: string }) => void;
  onBack: () => void;
  onNext: () => void;
}

export function validateInput(situation: string, conversation: string, isDemo: boolean): { field: "situation" | "conversation"; message: string } | null {
  if (situation.length > LIMITS.situationChars) {
    return { field: "situation", message: `상황 설명은 ${LIMITS.situationChars.toLocaleString()}자까지 입력할 수 있습니다.` };
  }
  if (conversation.length > LIMITS.conversationChars) {
    return { field: "conversation", message: `대화는 ${LIMITS.conversationChars.toLocaleString()}자까지 입력할 수 있습니다. 중요한 부분만 남겨 주세요.` };
  }
  const lines = parseConversation(conversation);
  if (!isDemo && lines.length === 0) {
    return { field: "conversation", message: "분석할 대화를 붙여 넣어 주세요." };
  }
  if (lines.length > LIMITS.messageCount) {
    return { field: "conversation", message: `메시지는 ${LIMITS.messageCount}개까지 분석할 수 있습니다. 대화를 줄여 주세요.` };
  }
  if (lines.some((l) => l.text.length > LIMITS.messageChars)) {
    return { field: "conversation", message: `메시지 하나가 ${LIMITS.messageChars.toLocaleString()}자를 넘습니다. 줄을 나누거나 줄여 주세요.` };
  }
  return null;
}

export default function InputStep({ isDemo, situation, conversation, demoCaseId, relationship, onChange, onBack, onNext }: Props) {
  const [err, setErr] = useState<ReturnType<typeof validateInput>>(null);
  const sitRef = useRef<HTMLTextAreaElement>(null);
  const convRef = useRef<HTMLTextAreaElement>(null);
  const selectedDemo = pickDemoCase(relationship, demoCaseId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateInput(situation, conversation, isDemo);
    setErr(v);
    if (v) (v.field === "situation" ? sitRef : convRef).current?.focus();
    else onNext();
  };

  const fillDemo = () => {
    onChange({ situation: selectedDemo.situation, conversation: demoCaseAsPaste(selectedDemo), demoCaseId: selectedDemo.id });
    setErr(null);
  };

  return (
    <section>
      <StepHead eyebrow="2단계" title="상황과 대화를 알려 주세요" desc="다음 단계에서 발화자와 전송될 내용을 확인한 뒤 분석합니다. 아직 아무것도 전송되지 않았습니다." />
      <form className="stack-lg" onSubmit={submit} noValidate>
        {isDemo && (
          <div className="notice stack" role="note">
            <p>
              <strong>데모 모드</strong>에서는 입력한 대화를 분석하지 않고 서버로 보내지도 않습니다. 아래에서 고른
              가상 사례의 결과가 표시됩니다.
            </p>
            <label className="field small">
              가상 사례
              <select value={selectedDemo.id} onChange={(e) => onChange({ demoCaseId: e.target.value })}>
                {DEMO_CASES.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-secondary" onClick={fillDemo}>가상 사례 대화 넣기</button>
          </div>
        )}

        <label className="field">
          어떤 상황인가요? <span className="tiny">(선택)</span>
          <textarea
            ref={sitRef}
            value={situation}
            onChange={(e) => onChange({ situation: e.target.value })}
            placeholder="예: 약속을 미룬 뒤 친구가 보낸 메시지예요. 화가 난 건지 궁금해요."
            autoComplete="off"
            aria-invalid={err?.field === "situation"}
            aria-describedby="sit-count"
          />
          <span id="sit-count" className={`counter ${situation.length > LIMITS.situationChars ? "over" : ""}`}>
            {situation.length.toLocaleString()} / {LIMITS.situationChars.toLocaleString()}자
          </span>
        </label>

        <label className="field">
          대화 붙여넣기
          <span className="tiny">한 줄에 한 메시지, “이름: 내용” 형식이면 발화자를 더 잘 나눌 수 있어요. 카카오톡 내보내기 형식도 읽을 수 있어요.</span>
          <textarea
            ref={convRef}
            className="tall"
            value={conversation}
            onChange={(e) => onChange({ conversation: e.target.value })}
            placeholder={"상대: 내일 시간 돼?\n나: 응 저녁 괜찮아\n상대: 그럼 그때 얘기하자"}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={err?.field === "conversation"}
            aria-describedby="conv-count conv-privacy"
          />
          <span id="conv-count" className={`counter ${conversation.length > LIMITS.conversationChars ? "over" : ""}`}>
            {conversation.length.toLocaleString()} / {LIMITS.conversationChars.toLocaleString()}자
          </span>
        </label>

        <p id="conv-privacy" className="notice notice-plain">
          🔒 전화번호·이메일·계좌 같은 정보는 다음 단계에서 자동으로 가리고, 전송 전에 직접 확인할 수 있어요. 자동 가림은
          일부를 놓칠 수 있으니 꼭 필요한 부분만 붙여 넣어 주세요.
        </p>

        {err && (
          <p className="field-error" role="alert">
            {err.message}
          </p>
        )}

        <div className="actions">
          <button type="submit" className="btn btn-primary">발화자 확인하기</button>
          <button type="button" className="btn btn-ghost" onClick={onBack}>이전</button>
        </div>
      </form>
    </section>
  );
}
