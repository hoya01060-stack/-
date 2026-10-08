"""텔레그램 알림 발송 + 명령어 수신(long polling)."""
from __future__ import annotations

import html
import logging
import threading
import time
from typing import Callable

import requests

log = logging.getLogger(__name__)
MAX_LEN = 3800  # 텔레그램 한도 4096자, 여유를 둠


def esc(s) -> str:
    return html.escape(str(s), quote=False)


class Telegram:
    def __init__(self, token: str, chat_id: str):
        self.token, self.chat_id = token, str(chat_id)
        self.base = f"https://api.telegram.org/bot{token}"
        self.enabled = bool(token and chat_id)
        if not self.enabled:
            log.warning("TELEGRAM_BOT_TOKEN/CHAT_ID 미설정 → 알림을 콘솔에만 출력합니다.")

    def send(self, text: str, chat_id: str | None = None):
        """HTML 형식 메시지 발송. 길면 줄 단위로 나눠 보냄."""
        for part in _split(text):
            if not self.enabled:
                print(part, "\n" + "-" * 40)
                continue
            for attempt in range(3):
                try:
                    r = requests.post(f"{self.base}/sendMessage", timeout=20, data={
                        "chat_id": chat_id or self.chat_id, "text": part,
                        "parse_mode": "HTML", "disable_web_page_preview": "true"})
                    if r.status_code == 429:
                        time.sleep(int(r.json().get("parameters", {}).get("retry_after", 3)))
                        continue
                    if not r.ok:
                        log.error("텔레그램 발송 실패 %s: %s", r.status_code, r.text[:200])
                    break
                except requests.RequestException as e:
                    log.error("텔레그램 연결 오류: %s", e)
                    time.sleep(2 ** attempt)

    def poll_commands(self, handler: Callable[[str], str | None], stop: threading.Event):
        """본인 chat_id 에서 온 명령만 처리 (다른 사람이 봇을 조작하지 못하게)."""
        if not self.enabled:
            return
        offset = None
        while not stop.is_set():
            try:
                r = requests.get(f"{self.base}/getUpdates", timeout=40,
                                 params={"timeout": 30, **({"offset": offset} if offset else {})})
                for upd in r.json().get("result", []):
                    offset = upd["update_id"] + 1
                    msg = upd.get("message") or {}
                    if str(msg.get("chat", {}).get("id")) != self.chat_id:
                        continue
                    text = (msg.get("text") or "").strip()
                    if not text.startswith("/"):
                        continue
                    try:
                        reply = handler(text)
                    except Exception as e:
                        log.exception("명령 처리 오류")
                        reply = f"⚠️ 오류: {esc(e)}"
                    if reply:
                        self.send(reply)
            except Exception as e:
                log.warning("텔레그램 폴링 오류: %s", e)
                time.sleep(5)


def _split(text: str) -> list[str]:
    if len(text) <= MAX_LEN:
        return [text]
    parts, cur = [], ""
    for line in text.split("\n"):
        if len(cur) + len(line) + 1 > MAX_LEN:
            parts.append(cur)
            cur = ""
        cur += line + "\n"
    if cur.strip():
        parts.append(cur)
    return parts
