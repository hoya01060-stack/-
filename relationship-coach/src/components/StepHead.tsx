"use client";

import { useEffect, useRef } from "react";

/** 단계가 바뀌면 제목으로 포커스를 옮겨 화면 낭독기·키보드 사용자가 위치를 알 수 있게 한다. */
export default function StepHead({ eyebrow, title, desc }: { eyebrow?: string; title: string; desc?: React.ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="step-head">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h2 ref={ref} tabIndex={-1}>
        {title}
      </h2>
      {desc && <p className="muted small">{desc}</p>}
    </div>
  );
}
