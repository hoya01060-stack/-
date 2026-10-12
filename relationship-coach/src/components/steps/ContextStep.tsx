"use client";

import StepHead from "../StepHead";
import Masked from "../Masked";
import ToneChips from "../ToneChips";
import { getContextQuestions } from "@/lib/contextQuestions";
import { LIMITS } from "@/lib/limits";
import type { ContextAnswers, GoalId, RelationshipId, ToneId } from "@/lib/types";
import type { ApiFailure } from "../CoachApp";

interface Props {
  relationship: RelationshipId;
  goal: GoalId;
  tone: ToneId;
  answers: ContextAnswers;
  redactedAnswers: ContextAnswers;
  isDemo: boolean;
  loading: boolean;
  error: ApiFailure | null;
  onAnswer: (id: string, value: string) => void;
  onTone: (t: ToneId) => void;
  onBack: () => void;
  onAnalyze: () => void;
}

export default function ContextStep(p: Props) {
  const questions = getContextQuestions(p.relationship, p.goal);
  const answered = Object.keys(p.redactedAnswers);

  return (
    <section>
      <StepHead eyebrow="5단계" title="조금 더 알려 주시겠어요?" desc="모두 선택 사항이에요. 답할수록 해석의 근거와 한계를 더 정확히 짚을 수 있어요." />
      <form
        className="stack-lg"
        onSubmit={(e) => {
          e.preventDefault();
          p.onAnalyze();
        }}
        aria-busy={p.loading}
      >
        {questions.map((q) =>
          q.kind === "choice" ? (
            <fieldset key={q.id}>
              <legend>{q.label}</legend>
              {q.help && <p className="tiny" style={{ marginTop: -6, marginBottom: 8 }}>{q.help}</p>}
              <div className="chip-row">
                {q.choices!.map((c) => (
                  <label key={c} className="chip">
                    <input type="radio" name={`ctx-${q.id}`} value={c} checked={p.answers[q.id] === c} onChange={() => p.onAnswer(q.id, c)} />
                    {c}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <label key={q.id} className="field">
              {q.label}
              {q.help && <span className="tiny">{q.help}</span>}
              <textarea
                style={{ minHeight: 80 }}
                maxLength={LIMITS.contextAnswerChars}
                value={p.answers[q.id] ?? ""}
                onChange={(e) => p.onAnswer(q.id, e.target.value)}
                autoComplete="off"
              />
            </label>
          ),
        )}

        {p.answers.safety === "있음" && (
          <p className="notice notice-danger" role="alert">
            안전이 걱정되는 상황이라면 직접 만나 해결하려 하기보다 112(경찰) 또는 1366(여성긴급전화, 24시간)과 먼저 상의해 보세요.
            결과에서도 안전을 우선한 선택지를 보여 드립니다.
          </p>
        )}

        <fieldset>
          <legend>답장 말투</legend>
          <ToneChips value={p.tone} onChange={p.onTone} name="tone-context" />
        </fieldset>

        {!p.isDemo && answered.length > 0 && (
          <details>
            <summary>함께 전송될 맥락 답변 보기 ({answered.length}개)</summary>
            <ul className="plain small">
              {answered.map((k) => (
                <li key={k}><Masked text={p.redactedAnswers[k]} /></li>
              ))}
            </ul>
          </details>
        )}

        <div aria-live="polite" className="stack">
          {p.loading && (
            <>
              <p className="small muted">대화를 살펴보고 있어요. 근거를 확인하느라 시간이 조금 걸릴 수 있어요.</p>
              <div className="skeleton" aria-hidden="true" />
            </>
          )}
          {p.error && !p.loading && (
            <div className="notice notice-danger" role="alert">
              <p>{p.error.message}</p>
              <p className="tiny" style={{ color: "inherit" }}>오류 코드: {p.error.code} · 입력한 내용은 그대로 남아 있어요.</p>
            </div>
          )}
        </div>

        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={p.loading} aria-disabled={p.loading}>
            {p.loading ? (<><span className="spinner" aria-hidden="true" /> 분석 중…</>) : p.error ? "다시 시도하기" : p.isDemo ? "가상 사례 결과 보기" : "분석하기"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={p.onBack} disabled={p.loading}>이전</button>
        </div>
      </form>
    </section>
  );
}
