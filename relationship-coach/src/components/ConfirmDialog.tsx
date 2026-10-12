"use client";

import { useEffect, useRef } from "react";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
  confirmDisabled?: boolean;
}

/** 네이티브 <dialog>: Esc로 닫히고 포커스가 대화상자 안에 갇힌다. */
export default function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel, children, confirmDisabled }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} aria-labelledby="dlg-title" aria-describedby="dlg-body" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <div className="stack">
        <h2 id="dlg-title">{title}</h2>
        <p id="dlg-body" className="muted small">{body}</p>
        {children}
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            취소
          </button>
        </div>
      </div>
    </dialog>
  );
}
