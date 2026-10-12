// 붙여넣은 대화를 줄 단위로 나누고 발화자 이름을 추정한다.
// 추정은 틀릴 수 있으므로 화면에서 사용자가 반드시 확인·수정한다.

export interface ParsedLine {
  speaker: string | null;
  text: string;
}

const KAKAO_PC = /^\[([^\]]{1,30})\]\s*\[(?:오전|오후|AM|PM)?\s*\d{1,2}:\d{2}\]\s*(.*)$/;
const KAKAO_MOBILE =
  /^(?:\d{4}년\s*\d{1,2}월\s*\d{1,2}일|\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?)\s*(?:오전|오후)?\s*\d{1,2}:\d{2},\s*([^:]{1,30}?)\s*:\s*(.*)$/;
const NAME_COLON = /^([^:\[\]\n]{1,20}?)\s*[:：]\s*(.*)$/;
const SKIP_LINE = [
  /^-{3,}.*-{3,}$/, // --------------- 2024년 1월 1일 월요일 ---------------
  /^저장한 날짜\s*:/,
  /^.{1,40}\s님과 카카오톡 대화$/,
  /^\d{4}년\s*\d{1,2}월\s*\d{1,2}일\s*\S*요일$/,
];

function looksLikeName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/^\d+$/.test(n)) return false; // 3:12 같은 시각
  if (/^(https?|ftp|mailto)$/i.test(n)) return false;
  return true;
}

export function parseConversation(raw: string): ParsedLine[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: ParsedLine[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (SKIP_LINE.some((re) => re.test(line))) continue;

    let m = KAKAO_PC.exec(line);
    if (m) {
      out.push({ speaker: m[1].trim(), text: m[2].trim() });
      continue;
    }
    m = KAKAO_MOBILE.exec(line);
    if (m) {
      out.push({ speaker: m[1].trim(), text: m[2].trim() });
      continue;
    }
    m = NAME_COLON.exec(line);
    if (m && looksLikeName(m[1]) && !m[2].startsWith("//")) {
      out.push({ speaker: m[1].trim(), text: m[2].trim() });
      continue;
    }
    // 발화자 표시가 없는 줄은 앞 메시지의 이어지는 줄로 본다.
    const prev = out[out.length - 1];
    if (prev) prev.text = prev.text ? `${prev.text}\n${line}` : line;
    else out.push({ speaker: null, text: line });
  }
  return out.filter((l) => l.text.length > 0);
}

/** 등장 순서대로 고유 발화자 이름 목록. 이름이 없는 줄은 null로 표시된다. */
export function listSpeakers(lines: ParsedLine[]): (string | null)[] {
  const seen: (string | null)[] = [];
  for (const l of lines) if (!seen.includes(l.speaker)) seen.push(l.speaker);
  return seen;
}
