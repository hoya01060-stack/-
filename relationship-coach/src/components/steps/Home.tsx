"use client";

import { useEffect, useRef } from "react";
import type { AppConfig } from "../CoachApp";

export default function Home({ config, configError, onStart }: { config: AppConfig | null; configError: boolean; onStart: () => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <section className="stack-lg">
      <div className="hero">
        <h1 ref={ref} tabIndex={-1}>
          이 말, 어떻게 받아들여야 할까요?
        </h1>
        <p className="muted">대화 속 근거와 가능한 해석을 살펴보고, 나에게 맞는 다음 말을 찾아보세요.</p>
      </div>

      <div className="card stack">
        <h2 className="small" style={{ fontSize: 15 }}>이렇게 도와 드려요</h2>
        <ul className="principles">
          <li>대화에 실제로 있는 말과, 그 말에 대한 해석을 구분해 보여 드려요.</li>
          <li>한 가지 정답 대신 가능한 해석과 각각의 한계를 함께 보여 드려요.</li>
          <li>근거가 부족하면 억지로 판단하지 않고, 더 확인할 질문을 드려요.</li>
          <li>호감도 점수나 성격 진단은 하지 않아요.</li>
        </ul>
      </div>

      {config?.mode === "demo" && (
        <p className="notice" role="note">
          <strong>데모 모드</strong>로 실행 중입니다. AI가 연결되어 있지 않아, 입력한 대화 대신 미리 준비한 가상 사례의
          결과를 보여 드립니다.
        </p>
      )}
      {configError && (
        <p className="notice notice-danger" role="alert">
          서버 설정을 불러오지 못했습니다. 데모 모드로 진행되며, 새로고침하면 다시 시도합니다.
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn btn-primary btn-block" onClick={onStart}>
          시작하기
        </button>
        <p className="tiny" style={{ textAlign: "center" }}>
          입력한 내용은 이 화면에만 머무르며, 기록 삭제를 누르거나 창을 닫으면 사라집니다.
        </p>
      </div>
    </section>
  );
}
