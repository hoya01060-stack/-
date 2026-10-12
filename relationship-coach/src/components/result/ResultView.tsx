"use client";

import { useEffect, useRef, useState } from "react";
import Masked from "../Masked";
import ReplyEditor from "./ReplyEditor";
import ReportButton from "./ReportButton";
import { ROLE_LABEL, type AnalyzeRequest, type AnalyzeResponse, type EvidenceItem, type ToneId } from "@/lib/types";

interface Props {
  response: AnalyzeResponse;
  baseRequest: AnalyzeRequest;
  tone: ToneId;
  onTone: (t: ToneId) => void;
  onEditInput: () => void;
  onReset: () => void;
}

function Refs({ ids, index }: { ids: string[]; index: Map<string, number> }) {
  if (!ids.length) return null;
  return (
    <span aria-label="연결된 원문 근거">
      {ids.map((id) => (index.has(id) ? <span key={id} className="ref">근거 {index.get(id)}</span> : null))}
    </span>
  );
}

function SectionHead({ tag, tagClass, title }: { tag: string; tagClass: string; title: string }) {
  return (
    <div className="section-head">
      <span className={`tag ${tagClass}`}>{tag}</span>
      <h2 style={{ fontSize: 18 }}>{title}</h2>
    </div>
  );
}

export default function ResultView({ response, baseRequest, tone, onTone, onEditInput, onReset }: Props) {
  const { result, mode, demoCase } = response;
  const headRef = useRef<HTMLHeadingElement>(null);
  const [showDemoConv, setShowDemoConv] = useState(true);
  useEffect(() => headRef.current?.focus(), []);

  const evIndex = new Map(result.evidence.map((e, i) => [e.id, i + 1] as const));
  const f = result.filtered;
  const filteredTotal = f.unverifiedQuotes + f.removedSentences + f.removedOptions;

  return (
    <section className="stack-lg">
      <div className="step-head">
        <span className="eyebrow">분석 결과</span>
        <h2 ref={headRef} tabIndex={-1}>
          {result.status === "hold" ? "지금은 판단을 보류할게요" : "대화에서 살펴본 내용이에요"}
        </h2>
        <p className="tiny">
          <span className="tag tag-observe">관찰</span> 대화에 있는 것 · <span className="tag tag-interpret">해석</span> 가능성일 뿐 확정 아님 ·{" "}
          <span className="tag tag-suggest">제안</span> 선택은 내가
        </p>
      </div>

      {mode === "demo" && demoCase && (
        <div className="card stack" style={{ borderColor: "#1f1d1a" }}>
          <div className="row">
            <span className="tag tag-demo">데모 결과</span>
            <strong className="small">{demoCase.title}</strong>
          </div>
          <p className="small">
            이 결과는 <strong>입력하신 대화를 분석한 것이 아닙니다.</strong> 미리 만들어 둔 가상 대화와 예시 출력을, 실제 분석과 같은
            검증 과정에 통과시켜 보여 드리는 것입니다.
          </p>
          {demoCase.note && <p className="tiny">{demoCase.note}</p>}
          <button type="button" className="btn btn-ghost small" aria-expanded={showDemoConv} onClick={() => setShowDemoConv((v) => !v)}>
            {showDemoConv ? "가상 대화 접기" : "가상 대화 보기"}
          </button>
          {showDemoConv && (
            <div className="stack" style={{ gap: 8 }}>
              <p className="small muted">상황: {demoCase.situation}</p>
              <ol className="bubble-list">
                {demoCase.messages.map((m) => (
                  <li key={m.id} className={`bubble ${m.role}`}>
                    <span className="who">{ROLE_LABEL[m.role]}</span>
                    {m.text}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {result.safety.level !== "none" && (
        <div className={`notice ${result.safety.level === "danger" ? "notice-danger" : ""}`} role={result.safety.level === "danger" ? "alert" : "note"}>
          <strong>{result.safety.level === "danger" ? "안전을 먼저 생각해 주세요" : "살펴볼 점"}</strong>
          <p>{result.safety.message}</p>
        </div>
      )}

      {response.notice && <p className="notice notice-plain">{response.notice}</p>}

      {/* 관찰 */}
      <div className="section">
        <SectionHead tag="관찰" tagClass="tag-observe" title="관찰된 내용" />
        {result.observations.length === 0 ? (
          <p className="card-quiet small muted">원문 근거로 확인된 관찰이 없습니다.</p>
        ) : (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {result.observations.map((o, i) => (
              <li key={i} className="card observe small">
                <Masked text={o.text} /> <Refs ids={o.evidenceIds} index={evIndex} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <SectionHead tag="관찰" tagClass="tag-observe" title="원문 근거" />
        <p className="tiny">아래 인용은 모두 전송된 대화에 글자 그대로 있는지 확인된 것만 보여 드려요.</p>
        {result.evidence.length === 0 ? (
          <p className="card-quiet small muted">확인된 인용이 없습니다.</p>
        ) : (
          <ol className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {result.evidence.map((e: EvidenceItem, i) => (
              <li key={e.id}>
                <blockquote className="quote">
                  <cite>근거 {i + 1} · {ROLE_LABEL[e.role]}</cite>
                  <Masked text={e.quote} />
                </blockquote>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* 해석 */}
      <div className="section">
        <SectionHead tag="해석" tagClass="tag-interpret" title="가능한 해석" />
        {result.status === "hold" ? (
          <div className="card interpret stack">
            <strong>판단 보류</strong>
            <p className="small"><Masked text={result.holdReason} /></p>
            <p className="tiny">근거가 부족한 상태에서 해석을 만들면 오해를 키울 수 있어 해석을 제시하지 않았어요.</p>
          </div>
        ) : (
          <>
            <p className="tiny">어느 것도 확정이 아니에요. 상대의 속마음은 상대에게 확인해야 알 수 있어요.</p>
            {result.interpretations.map((it, i) => (
              <article key={i} className="card interpret">
                <h3>{i + 1}. <Masked text={it.title} /></h3>
                <p className="small" style={{ marginTop: 6 }}>
                  <Masked text={it.explanation} /> <Refs ids={it.evidenceIds} index={evIndex} />
                </p>
                <div className="limits">
                  <h4>반대 근거 · 한계</h4>
                  <ul className="plain small">
                    {it.limits.map((l, j) => (<li key={j}><Masked text={l} /></li>))}
                  </ul>
                </div>
              </article>
            ))}
            {result.interpretations.length === 1 && (
              <p className="tiny">다른 해석을 세울 만한 근거는 대화에서 찾지 못했어요.</p>
            )}
          </>
        )}
      </div>

      {result.unknowns.length > 0 && (
        <div className="section">
          <SectionHead tag="해석" tagClass="tag-interpret" title="확인되지 않은 부분" />
          <div className="card-quiet">
            <ul className="plain small">{result.unknowns.map((u, i) => (<li key={i}><Masked text={u} /></li>))}</ul>
          </div>
        </div>
      )}

      {result.followUpQuestions.length > 0 && (
        <div className="section">
          <SectionHead tag="제안" tagClass="tag-suggest" title="추가로 확인해 볼 질문" />
          <div className="card suggest">
            <ul className="plain small">{result.followUpQuestions.map((q, i) => (<li key={i}><Masked text={q} /></li>))}</ul>
          </div>
        </div>
      )}

      {result.responseOptions.length > 0 && (
        <div className="section">
          <SectionHead tag="제안" tagClass="tag-suggest" title="대응 선택지" />
          {result.responseOptions.map((o, i) => (
            <article key={i} className="card suggest">
              <h3><Masked text={o.title} /></h3>
              <p className="small" style={{ marginTop: 4 }}><Masked text={o.description} /></p>
              <div className="proscons">
                <div>
                  <h4>장점</h4>
                  <ul>{o.pros.map((x, j) => (<li key={j}><Masked text={x} /></li>))}</ul>
                </div>
                <div>
                  <h4>단점 · 주의</h4>
                  <ul>{o.cons.map((x, j) => (<li key={j}><Masked text={x} /></li>))}</ul>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <ReplyEditor
        initial={result.replies}
        baseRequest={baseRequest}
        tone={tone}
        onTone={onTone}
        mode={mode}
      />

      {filteredTotal > 0 && (
        <p className="notice notice-plain small">
          검증 과정에서{" "}
          {[
            f.unverifiedQuotes ? `원문에서 찾을 수 없는 인용 ${f.unverifiedQuotes}개` : "",
            f.removedSentences ? `원칙(점수·진단·단정 금지 등)에 맞지 않는 문장 ${f.removedSentences}개` : "",
            f.removedOptions ? `부적절한 제안 ${f.removedOptions}개` : "",
          ]
            .filter(Boolean)
            .join(", ")}
          를 결과에서 제외했어요.
        </p>
      )}

      <div className="actions">
        <ReportButton mode={mode} />
        <button type="button" className="btn btn-secondary" onClick={onEditInput}>입력 수정하고 다시 분석하기</button>
        <button type="button" className="btn btn-ghost" onClick={onReset}>기록 삭제하고 처음으로</button>
      </div>
    </section>
  );
}
