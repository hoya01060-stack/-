"use client";

import StepHead from "../StepHead";
import { GOALS, RELATIONSHIPS, type GoalId, type RelationshipId } from "@/lib/types";

interface Props {
  relationship: RelationshipId;
  goal: GoalId;
  onChange: (p: { relationship?: RelationshipId; goal?: GoalId }) => void;
  onBack: () => void;
  onNext: () => void;
}

export default function SetupStep({ relationship, goal, onChange, onBack, onNext }: Props) {
  return (
    <section>
      <StepHead eyebrow="1단계" title="어떤 관계의 대화인가요?" desc="관계와 목표에 따라 살펴볼 점과 답장 방향이 달라집니다." />
      <form
        className="stack-lg"
        onSubmit={(e) => {
          e.preventDefault();
          onNext();
        }}
      >
        <fieldset>
          <legend>관계</legend>
          <div className="choice-grid">
            {RELATIONSHIPS.map((r) => (
              <label key={r.id} className="chip">
                <input type="radio" name="relationship" value={r.id} checked={relationship === r.id} onChange={() => onChange({ relationship: r.id })} />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>이번에 하고 싶은 것</legend>
          <div className="choice-list">
            {GOALS.map((g) => (
              <label key={g.id} className="chip">
                <input type="radio" name="goal" value={g.id} checked={goal === g.id} onChange={() => onChange({ goal: g.id })} />
                {g.label}
                <span className="hint">{g.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="actions">
          <button type="submit" className="btn btn-primary">다음</button>
          <button type="button" className="btn btn-ghost" onClick={onBack}>이전</button>
        </div>
      </form>
    </section>
  );
}
