"use client";

import { useState } from "react";
import ConfirmDialog from "../ConfirmDialog";
import { REPORT_REASONS, type ReportReasonId } from "@/lib/types";

export default function ReportButton({ mode }: { mode: "live" | "demo" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReasonId | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  const send = async () => {
    if (!reason || state === "sending") return;
    setState("sending");
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, mode }),
      });
      setState(res.ok ? "done" : "error");
      if (res.ok) setOpen(false);
    } catch {
      setState("error");
    }
  };

  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => { setOpen(true); setState(state === "done" ? "done" : "idle"); }}>
        {state === "done" ? "신고해 주셔서 감사합니다" : "결과 신고하기"}
      </button>
      <ConfirmDialog
        open={open}
        title="어떤 점이 문제였나요?"
        body="신고 사유만 전송되며, 대화 원문이나 분석 결과는 함께 보내지 않습니다."
        confirmLabel={state === "sending" ? "보내는 중…" : "신고 보내기"}
        confirmDisabled={!reason || state === "sending"}
        onConfirm={send}
        onCancel={() => setOpen(false)}
      >
        <fieldset>
          <legend className="sr-only">신고 사유</legend>
          <div className="choice-list">
            {REPORT_REASONS.map((r) => (
              <label key={r.id} className="chip">
                <input type="radio" name="report-reason" checked={reason === r.id} onChange={() => setReason(r.id)} />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
        {state === "error" && <p className="field-error" role="alert">신고를 보내지 못했어요. 잠시 후 다시 시도해 주세요.</p>}
      </ConfirmDialog>
    </>
  );
}
