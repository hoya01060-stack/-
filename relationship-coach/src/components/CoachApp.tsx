"use client";

// 전체 흐름과 세션 상태. 모든 입력·결과는 이 컴포넌트의 메모리 상태에만 있고
// localStorage·sessionStorage·쿠키·분석 도구에 저장하지 않는다. 초기화하면 사라진다.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DEFAULT_ENABLED } from "@/lib/redact";
import { buildDraft, guessRole, newRequestId, speakerKey, toRequest, type DraftInput } from "@/lib/draft";
import type { AnalyzeResponse, ApiError, GoalId, RelationshipId, SpeakerRole, ToneId } from "@/lib/types";
import Home from "./steps/Home";
import SetupStep from "./steps/SetupStep";
import InputStep from "./steps/InputStep";
import SpeakerStep from "./steps/SpeakerStep";
import PreviewStep from "./steps/PreviewStep";
import ContextStep from "./steps/ContextStep";
import ResultView from "./result/ResultView";
import ConfirmDialog from "./ConfirmDialog";

export type Step = "home" | "setup" | "input" | "speakers" | "preview" | "context" | "result";
const FLOW: Step[] = ["setup", "input", "speakers", "preview", "context", "result"];

export interface AppConfig {
  mode: "live" | "demo";
  provider: string | null;
  model: string | null;
  reason: string;
}

interface State extends DraftInput {
  step: Step;
  previewConfirmed: boolean;
  response: AnalyzeResponse | null;
}

const initialState: State = {
  step: "home",
  relationship: "romance",
  goal: "understand",
  tone: "gentle",
  situation: "",
  conversation: "",
  speakerRoles: {},
  lineRoles: {},
  redaction: { enabled: { ...DEFAULT_ENABLED }, customWords: "" },
  context: {},
  demoCaseId: undefined,
  previewConfirmed: false,
  response: null,
};

type Action =
  | { type: "go"; step: Step }
  | { type: "patch"; patch: Partial<State> }
  | { type: "setSpeakerRole"; key: string; role: SpeakerRole }
  | { type: "setLineRole"; index: number; role: SpeakerRole | undefined }
  | { type: "setContext"; id: string; value: string }
  | { type: "reset" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "go":
      return { ...state, step: action.step };
    case "patch": {
      const next = { ...state, ...action.patch };
      // 전송 내용에 영향을 주는 값이 바뀌면 미리보기 확인을 다시 받는다.
      const touchesPayload = ["situation", "conversation", "speakerRoles", "lineRoles", "redaction"].some(
        (k) => k in action.patch,
      );
      if (touchesPayload && !("previewConfirmed" in action.patch)) next.previewConfirmed = false;
      if ("conversation" in action.patch) next.lineRoles = {};
      return next;
    }
    case "setSpeakerRole":
      return { ...state, speakerRoles: { ...state.speakerRoles, [action.key]: action.role }, previewConfirmed: false };
    case "setLineRole":
      return { ...state, lineRoles: { ...state.lineRoles, [action.index]: action.role }, previewConfirmed: false };
    case "setContext":
      return { ...state, context: { ...state.context, [action.id]: action.value } };
    case "reset":
      return { ...initialState, redaction: { enabled: { ...DEFAULT_ENABLED }, customWords: "" } };
  }
}

export interface ApiFailure {
  code: string;
  message: string;
}

export default function CoachApp() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("config"))))
      .then((c: AppConfig) => alive && setConfig(c))
      .catch(() => alive && setConfigError(true));
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, []);

  const draft = useMemo(() => buildDraft(state), [state]);
  const isDemo = config?.mode !== "live";

  // 발화자 목록이 바뀌면 추정 가능한 역할을 채운다(사용자가 고른 값은 유지).
  useEffect(() => {
    const missing: Record<string, SpeakerRole> = {};
    for (const s of draft.speakers) {
      const k = speakerKey(s);
      const g = guessRole(s);
      if (state.speakerRoles[k] === undefined && g) missing[k] = g;
    }
    if (Object.keys(missing).length) {
      dispatch({ type: "patch", patch: { speakerRoles: { ...state.speakerRoles, ...missing } } });
    }
  }, [draft.speakers, state.speakerRoles]);

  const go = useCallback((step: Step) => {
    setError(null);
    dispatch({ type: "go", step });
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const doReset = useCallback(() => {
    abortRef.current?.abort();
    inFlight.current = false;
    setLoading(false);
    setError(null);
    setConfirmReset(false);
    dispatch({ type: "reset" });
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const analyze = useCallback(async () => {
    // 버튼 비활성화와 별개로 ref로 한 번 더 막아 빠른 연타에도 한 번만 보낸다.
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const body = toRequest(state, draft, newRequestId(), isDemo);
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as AnalyzeResponse | ApiError | null;
      if (!res.ok || !data || "error" in data) {
        setError(
          data && "error" in data
            ? data.error
            : { code: `HTTP_${res.status}`, message: "분석 중 문제가 생겼습니다. 입력은 그대로 남아 있으니 다시 시도해 주세요." },
        );
        return;
      }
      dispatch({ type: "patch", patch: { response: data } });
      go("result");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError({ code: "NETWORK", message: "네트워크 연결을 확인해 주세요. 입력은 그대로 남아 있습니다." });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [state, draft, isDemo, go]);

  const stepIndex = FLOW.indexOf(state.step);

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="btn btn-ghost brand" onClick={() => state.step !== "home" && setConfirmReset(true)} aria-label="처음 화면으로">
          말결
        </button>
        <div className="row">
          {config && isDemo && <span className="tag tag-demo" aria-label="데모 모드">데모</span>}
          {state.step !== "home" && (
            <button type="button" className="btn btn-ghost small" onClick={() => setConfirmReset(true)}>
              기록 삭제
            </button>
          )}
        </div>
      </header>

      {stepIndex >= 0 && state.step !== "result" && (
        <div className="progress" role="progressbar" aria-label="진행 단계" aria-valuemin={1} aria-valuemax={FLOW.length - 1} aria-valuenow={stepIndex + 1}>
          {FLOW.slice(0, -1).map((s, i) => (
            <span key={s} className={i <= stepIndex ? "done" : ""} />
          ))}
        </div>
      )}

      <main>
        {state.step === "home" && <Home config={config} configError={configError} onStart={() => go("setup")} />}
        {state.step === "setup" && (
          <SetupStep
            relationship={state.relationship}
            goal={state.goal}
            onChange={(p: { relationship?: RelationshipId; goal?: GoalId }) => dispatch({ type: "patch", patch: p })}
            onBack={() => go("home")}
            onNext={() => go("input")}
          />
        )}
        {state.step === "input" && (
          <InputStep
            isDemo={isDemo}
            situation={state.situation}
            conversation={state.conversation}
            demoCaseId={state.demoCaseId}
            relationship={state.relationship}
            onChange={(p) => dispatch({ type: "patch", patch: p })}
            onBack={() => go("setup")}
            onNext={() => go("speakers")}
          />
        )}
        {state.step === "speakers" && (
          <SpeakerStep
            draft={draft}
            speakerRoles={state.speakerRoles}
            lineRoles={state.lineRoles}
            isDemo={isDemo}
            onSpeakerRole={(key, role) => dispatch({ type: "setSpeakerRole", key, role })}
            onLineRole={(index, role) => dispatch({ type: "setLineRole", index, role })}
            onBack={() => go("input")}
            onNext={() => go("preview")}
          />
        )}
        {state.step === "preview" && (
          <PreviewStep
            draft={draft}
            relationship={state.relationship}
            goal={state.goal}
            redaction={state.redaction}
            confirmed={state.previewConfirmed}
            isDemo={isDemo}
            provider={config?.provider ?? null}
            onRedaction={(redaction) => dispatch({ type: "patch", patch: { redaction } })}
            onConfirm={(v) => dispatch({ type: "patch", patch: { previewConfirmed: v } })}
            onEdit={() => go("input")}
            onBack={() => go("speakers")}
            onNext={() => go("context")}
          />
        )}
        {state.step === "context" && (
          <ContextStep
            relationship={state.relationship}
            goal={state.goal}
            tone={state.tone}
            answers={state.context}
            redactedAnswers={draft.context}
            isDemo={isDemo}
            loading={loading}
            error={error}
            onAnswer={(id, value) => dispatch({ type: "setContext", id, value })}
            onTone={(tone: ToneId) => dispatch({ type: "patch", patch: { tone } })}
            onBack={() => go("preview")}
            onAnalyze={analyze}
          />
        )}
        {state.step === "result" && state.response && (
          <ResultView
            response={state.response}
            baseRequest={toRequest(state, draft, newRequestId(), isDemo)}
            tone={state.tone}
            onTone={(tone: ToneId) => dispatch({ type: "patch", patch: { tone } })}
            onEditInput={() => go("input")}
            onReset={() => setConfirmReset(true)}
          />
        )}
      </main>

      <footer className="footer">
        이 서비스는 상대의 속마음을 판정하지 않으며, 상담·치료·법률 조언을 대신하지 않습니다. 위급한 상황이라면 112에
        연락하세요.
      </footer>

      <ConfirmDialog
        open={confirmReset}
        title="이 세션의 기록을 지울까요?"
        body="입력한 상황·대화·맥락 답변과 분석 결과가 이 화면에서 모두 지워지고 처음으로 돌아갑니다. 이미 복사한 답장은 기기 클립보드에 남아 있을 수 있습니다."
        confirmLabel="모두 지우기"
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
