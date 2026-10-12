// 서버 로그는 오류 코드와 숫자만 남긴다. 요청 본문·AI 응답·오류 객체(본문을 담을 수 있음)는 기록하지 않는다.
export function safeLog(scope: string, code: string, detail?: Record<string, number | string | boolean>): void {
  if (process.env.NODE_ENV === "test") return;
  const safe = detail
    ? Object.fromEntries(
        Object.entries(detail).filter(([, v]) => typeof v !== "string" || /^[A-Za-z0-9_.:-]{0,40}$/.test(v)),
      )
    : undefined;
  console.warn(`[${scope}] ${code}`, safe ? JSON.stringify(safe) : "");
}
