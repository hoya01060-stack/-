// 입력 크기 제한. 클라이언트 안내와 서버 검증이 같은 값을 쓴다.
export const LIMITS = {
  situationChars: 1500,
  conversationChars: 8000,
  messageCount: 200,
  messageChars: 1000,
  contextAnswerChars: 500,
  contextAnswers: 12,
  replyChars: 1000,
  /** HTTP 본문 최대 크기(바이트). 한글 3바이트 + JSON 오버헤드를 감안한 값. */
  bodyBytes: 64 * 1024,
} as const;
