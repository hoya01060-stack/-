"use client";

import { useState } from "react";
import StepHead from "../StepHead";
import Masked from "../Masked";
import type { DraftView } from "@/lib/draft";
import { RULE_OPTIONS, type RedactionRuleId } from "@/lib/redact";
import { GOALS, RELATIONSHIPS, ROLE_LABEL, type GoalId, type RelationshipId } from "@/lib/types";

interface Props {
  draft: DraftView;
  relationship: RelationshipId;
  goal: GoalId;
  redaction: { enabled: Record<RedactionRuleId, boolean>; customWords: string };
  confirmed: boolean;
  isDemo: boolean;
  provider: string | null;
  onRedaction: (r: Props["redaction"]) => void;
  onConfirm: (v: boolean) => void;
  onEdit: () => void;
  onBack: () => void;
  onNext: () => void;
}

const PROVIDER_NAME: Record<string, string> = { anthropic: "Anthropic" };

export default function PreviewStep(p: Props) {
  const [err, setErr] = useState("");
  const total = Object.values(p.draft.counts).reduce((a, b) => a + (b ?? 0), 0);
  const providerName = p.provider ? PROVIDER_NAME[p.provider] ?? p.provider : "외부 AI 제공사";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!p.confirmed) {
      setErr("전송될 내용을 확인했다는 항목에 체크해 주세요.");
      document.getElementById("confirm-check")?.focus();
      return;
    }
    p.onNext();
  };

  return (
    <section>
      <StepHead eyebrow="4단계" title="전송될 내용을 확인해 주세요" desc="아래 미리보기가 분석을 위해 전송되는 내용 그대로입니다." />
      <form className="stack-lg" onSubmit={submit}>
        {p.isDemo ? (
          <p className="notice" role="note">
            데모 모드에서는 이 내용이 서버로 <strong>전송되지 않습니다</strong>. 실제 분석 모드라면 아래 내용이 전송됩니다.
          </p>
        ) : (
          <p className="notice" role="note">
            분석을 위해 아래 내용이 서버를 거쳐 <strong>{providerName}</strong>로 전송됩니다. 이 서비스는 원문을 데이터베이스나
            브라우저 저장소에 저장하지 않지만, 외부 제공사의 처리·보존 조건은 해당 제공사의 정책을 따릅니다.
          </p>
        )}

        <fieldset className="card stack">
          <legend>자동 가림</legend>
          <p className="tiny">
            정해진 형식만 찾아 가리기 때문에 별명, 회사·학교 이름, 특이한 형식의 주소·번호 등은 놓칠 수 있어요. 미리보기를 보고
            남은 정보는 아래 칸에 직접 추가해 주세요.
          </p>
          <div className="stack" style={{ gap: 6 }}>
            {RULE_OPTIONS.map((r) => (
              <label key={r.id} className="check small">
                <input
                  type="checkbox"
                  checked={p.redaction.enabled[r.id]}
                  onChange={(e) => p.onRedaction({ ...p.redaction, enabled: { ...p.redaction.enabled, [r.id]: e.target.checked } })}
                />
                <span>
                  {r.label}
                  {p.draft.counts[r.id] ? <span className="tiny"> · {p.draft.counts[r.id]}곳 가림</span> : null}
                </span>
              </label>
            ))}
          </div>
          <label className="field small">
            직접 가릴 단어 (쉼표로 구분, 2글자 이상)
            <input
              type="text"
              value={p.redaction.customWords}
              onChange={(e) => p.onRedaction({ ...p.redaction, customWords: e.target.value })}
              placeholder="예: 민지, 한빛상사, 강남역"
              autoComplete="off"
            />
          </label>
          <p className="tiny" aria-live="polite">총 {total}곳을 가렸습니다.</p>
        </fieldset>

        <div className="card stack">
          <h3>전송 미리보기</h3>
          <dl className="stack small" style={{ margin: 0, gap: 4 }}>
            <div className="row"><dt className="muted">관계</dt><dd style={{ margin: 0 }}>{RELATIONSHIPS.find((r) => r.id === p.relationship)?.label}</dd></div>
            <div className="row"><dt className="muted">목표</dt><dd style={{ margin: 0 }}>{GOALS.find((g) => g.id === p.goal)?.label}</dd></div>
          </dl>
          {p.draft.situation && (
            <div className="card-quiet small" style={{ whiteSpace: "pre-wrap" }}>
              <strong>상황 설명</strong>
              <br />
              <Masked text={p.draft.situation} />
            </div>
          )}
          <div className="preview-box" tabIndex={0} aria-label="전송될 대화">
            {p.draft.messages.length === 0 ? (
              <p className="tiny">전송될 메시지가 없습니다.</p>
            ) : (
              <ol className="bubble-list">
                {p.draft.messages.map((m) => (
                  <li key={m.id} className={`bubble ${m.role}`}>
                    <span className="who">{ROLE_LABEL[m.role]}</span>
                    <Masked text={m.text} />
                  </li>
                ))}
              </ol>
            )}
          </div>
          <p className="tiny">다음 단계의 맥락 답변도 같은 가림 규칙을 거쳐 함께 전송됩니다.</p>
        </div>

        <label className="check">
          <input id="confirm-check" type="checkbox" checked={p.confirmed} onChange={(e) => { p.onConfirm(e.target.checked); setErr(""); }} />
          <span>전송될 내용을 확인했고, 더 가릴 정보가 없습니다.</span>
        </label>
        {err && <p className="field-error" role="alert">{err}</p>}

        <div className="actions">
          <button type="submit" className="btn btn-primary">맥락 질문으로</button>
          <button type="button" className="btn btn-secondary" onClick={p.onEdit}>입력 내용 수정하기</button>
          <button type="button" className="btn btn-ghost" onClick={p.onBack}>이전</button>
        </div>
      </form>
    </section>
  );
}
