"use client";

import { useState } from "react";
import StepHead from "../StepHead";
import RoleRadios from "../RoleRadios";
import { speakerKey, type DraftView } from "@/lib/draft";
import { ROLE_LABEL, type SpeakerRole } from "@/lib/types";

interface Props {
  draft: DraftView;
  speakerRoles: Record<string, SpeakerRole | undefined>;
  lineRoles: Record<number, SpeakerRole | undefined>;
  isDemo: boolean;
  onSpeakerRole: (key: string, role: SpeakerRole) => void;
  onLineRole: (index: number, role: SpeakerRole | undefined) => void;
  onBack: () => void;
  onNext: () => void;
}

export default function SpeakerStep({ draft, speakerRoles, lineRoles, isDemo, onSpeakerRole, onLineRole, onBack, onNext }: Props) {
  const [err, setErr] = useState("");
  const noLines = draft.lines.length === 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.unassignedLines > 0) {
      setErr(`발화자가 정해지지 않은 메시지가 ${draft.unassignedLines}개 있습니다. 모든 발화자를 '나', '상대', '제3자' 중 하나로 골라 주세요.`);
      return;
    }
    if (!isDemo && !draft.messages.some((m) => m.role === "other")) {
      setErr("'상대'로 지정된 메시지가 없습니다. 상대의 말이 없으면 상대의 의도를 살펴볼 수 없어요. 그래도 계속하면 판단 보류 결과가 나옵니다.");
      // 두 번째 제출은 허용한다.
      if (err.startsWith("'상대'")) onNext();
      return;
    }
    onNext();
  };

  return (
    <section>
      <StepHead eyebrow="3단계" title="누가 한 말인지 확인해 주세요" desc="자동으로 나눈 결과가 틀릴 수 있어요. 각 발화자가 누구인지 골라 주세요. 발화자 이름은 전송되지 않고 ‘나/상대/제3자’로만 전달됩니다." />
      <form className="stack-lg" onSubmit={submit}>
        {noLines ? (
          <p className="notice notice-plain">
            {isDemo ? "입력한 대화가 없습니다. 데모 모드에서는 대화 없이도 가상 사례 결과를 볼 수 있어요." : "입력한 대화가 없습니다. 이전 단계에서 대화를 붙여 넣어 주세요."}
          </p>
        ) : (
          <>
            <div className="card">
              {draft.speakers.map((s) => {
                const key = speakerKey(s);
                const sample = draft.lines.find((l) => l.speaker === s)?.text ?? "";
                const count = draft.lines.filter((l) => l.speaker === s).length;
                return (
                  <div key={key} className="speaker-row">
                    <div>
                      <div className="speaker-name">{s ?? "이름 표시가 없는 줄"} <span className="tiny">· {count}개</span></div>
                      <div className="speaker-sample">“{sample.length > 40 ? `${sample.slice(0, 40)}…` : sample}”</div>
                    </div>
                    <RoleRadios name={`sp-${key}`} legend={`${s ?? "이름 없는 줄"}의 역할`} value={speakerRoles[key]} onChange={(r) => onSpeakerRole(key, r)} />
                  </div>
                );
              })}
            </div>

            <details>
              <summary>메시지별로 고치기 ({draft.lines.length}개)</summary>
              <ol className="stack" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
                {draft.lines.map((l, i) => {
                  const effective = lineRoles[i] ?? speakerRoles[speakerKey(l.speaker)];
                  return (
                    <li key={i} className="card-quiet stack" style={{ gap: 6 }}>
                      <span className="small" style={{ whiteSpace: "pre-wrap" }}>{l.text}</span>
                      <label className="field small">
                        <span className="sr-only">{i + 1}번째 메시지 발화자</span>
                        <select
                          value={lineRoles[i] ?? ""}
                          onChange={(e) => onLineRole(i, (e.target.value || undefined) as SpeakerRole | undefined)}
                        >
                          <option value="">발화자 설정 따름{effective ? ` (${ROLE_LABEL[effective]})` : " (미지정)"}</option>
                          <option value="me">나</option>
                          <option value="other">상대</option>
                          <option value="third">제3자</option>
                        </select>
                      </label>
                    </li>
                  );
                })}
              </ol>
            </details>
          </>
        )}

        {err && <p className="field-error" role="alert">{err}</p>}

        <div className="actions">
          <button type="submit" className="btn btn-primary">전송 내용 확인하기</button>
          <button type="button" className="btn btn-ghost" onClick={onBack}>대화 수정하기</button>
        </div>
      </form>
    </section>
  );
}
