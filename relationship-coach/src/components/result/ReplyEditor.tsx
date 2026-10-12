"use client";

import { useRef, useState } from "react";
import ToneChips from "../ToneChips";
import { LIMITS } from "@/lib/limits";
import { newRequestId } from "@/lib/draft";
import type { AnalyzeRequest, ApiError, ReplyDraft, ToneId } from "@/lib/types";

interface Props {
  initial: ReplyDraft[];
  baseRequest: AnalyzeRequest;
  tone: ToneId;
  onTone: (t: ToneId) => void;
  mode: "live" | "demo";
}

export default function ReplyEditor({ initial, baseRequest, tone, onTone, mode }: Props) {
  const [replies, setReplies] = useState<ReplyDraft[]>(initial);
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState(initial[0]?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const inFlight = useRef(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const choose = (i: number) => {
    setSelected(i);
    setText(replies[i].text);
    setStatus("");
  };

  const regenerate = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch("/api/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        // 데모 모드에서는 baseRequest에 사용자 대화가 들어 있지 않다.
        body: JSON.stringify({ requestId: newRequestId(), base: baseRequest, tone, draft: mode === "demo" ? "" : text.slice(0, LIMITS.replyChars) }),
      });
      const data = (await res.json().catch(() => null)) as ({ replies: ReplyDraft[] } | ApiError) | null;
      if (!res.ok || !data || "error" in data) {
        setError(data && "error" in data ? data.error.message : "답장을 다시 만들지 못했어요. 지금 쓰던 답장은 그대로 남아 있어요.");
        return;
      }
      if (data.replies.length === 0) {
        setError("원칙에 맞는 답장을 만들지 못했어요. 직접 다듬어 사용해 주세요.");
        return;
      }
      setReplies(data.replies);
      setSelected(0);
      setText(data.replies[0].text);
      setStatus("새 답장 예시를 만들었어요.");
    } catch {
      setError("네트워크 연결을 확인해 주세요. 지금 쓰던 답장은 그대로 남아 있어요.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("복사했어요. 보내기 전에 한 번 더 읽어 보세요.");
    } catch {
      areaRef.current?.select();
      setStatus("자동 복사가 막혀 있어요. 선택된 글을 길게 눌러 복사해 주세요.");
    }
  };

  return (
    <div className="section">
      <div className="section-head">
        <span className="tag tag-suggest">제안</span>
        <h2 style={{ fontSize: 18 }}>답장 예시</h2>
      </div>
      <p className="tiny">
        내가 보낼 수 있는 문장의 예시예요. <strong>상대가 실제로 어떻게 반응할지 예측한 것이 아니며</strong>, 내 상황에 맞게 고쳐 쓰세요.
      </p>

      <div className="card suggest stack">
        <fieldset>
          <legend className="small">말투</legend>
          <ToneChips value={tone} onChange={onTone} name="tone-result" disabled={busy} />
        </fieldset>
        <button type="button" className="btn btn-secondary" onClick={regenerate} disabled={busy} aria-disabled={busy}>
          {busy ? "만드는 중…" : "이 말투로 다시 만들기"}
        </button>

        {replies.length > 1 && (
          <fieldset>
            <legend className="small">예시 고르기</legend>
            <div className="chip-row">
              {replies.map((r, i) => (
                <label key={i} className="chip">
                  <input type="radio" name="reply-pick" checked={selected === i} onChange={() => choose(i)} />
                  예시 {i + 1}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {replies.length === 0 ? (
          <p className="small muted">제안할 답장이 없어요. 지금은 답장보다 위의 선택지를 먼저 살펴보는 게 좋을 수 있어요. 직접 써 볼 수도 있어요.</p>
        ) : (
          replies[selected]?.note && <p className="tiny">의도: {replies[selected].note}</p>
        )}

        <label className="field small">
          답장 다듬기
          <textarea ref={areaRef} value={text} maxLength={LIMITS.replyChars} onChange={(e) => { setText(e.target.value); setStatus(""); }} autoComplete="off" />
          <span className="counter">{text.length} / {LIMITS.replyChars}자</span>
        </label>
        <button type="button" className="btn btn-primary" onClick={copy} disabled={!text.trim()}>
          복사하기
        </button>
        <p aria-live="polite" className="tiny">{status}</p>
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
