"""(선택) Claude API로 브리핑 해설문 생성. ANTHROPIC_API_KEY 가 없으면 건너뜀."""
from __future__ import annotations

import json
import logging

log = logging.getLogger(__name__)

SYSTEM = """당신은 한국어로 일일 시장 브리핑을 쓰는 주식 애널리스트입니다.
사용자가 제공한 JSON 수치만 근거로 해설하세요. JSON에 없는 뉴스·사건·원인은 지어내지 말고,
원인을 추정할 때는 '추정'이라고 밝히세요. 매수/매도 권유가 아니라 흐름 해석과 점검 포인트를 제시합니다.
형식: 텔레그램 일반 텍스트(마크다운/HTML 태그 금지), 5~8개 짧은 문단 또는 글머리표, 900자 이내.
포함할 것: ① 지수·시장폭(상승종목 비율, 50일선 위 비율)으로 본 오늘의 흐름 ② 강한/약한 업종
③ 환율·금·금리·VIX 등 위험선호 신호 ④ 시장 국면(regime)과 그에 따른 자세(공격/중립/방어, 안전자산 비중)
⑤ 오늘 잡힌 기법별 신호와 보유종목에서 내일 확인할 것."""


def narrate(cfg, facts: dict) -> str | None:
    bcfg = cfg.get("briefing", {})
    if not bcfg.get("use_llm", True) or not cfg.secrets.anthropic_api_key:
        return None
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic 패키지 미설치 → 해설 생략")
        return None
    client = anthropic.Anthropic(api_key=cfg.secrets.anthropic_api_key)
    try:
        resp = client.beta.messages.create(
            model=bcfg.get("model", "claude-opus-5-5"),
            max_tokens=16000,
            system=SYSTEM,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": "오늘 데이터:\n" + json.dumps(facts, ensure_ascii=False, default=str)}],
        )
    except anthropic.AuthenticationError:
        log.error("ANTHROPIC_API_KEY 인증 실패")
        return None
    except anthropic.RateLimitError:
        log.warning("Claude API 요청 한도 초과 → 해설 생략")
        return None
    except anthropic.APIStatusError as e:
        log.warning("Claude API 오류 %s: %s", e.status_code, e.message)
        return None
    except anthropic.APIConnectionError:
        log.warning("Claude API 연결 실패 → 해설 생략")
        return None
    if resp.stop_reason == "refusal":
        log.warning("Claude가 해설 생성을 거절함")
        return None
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    return text or None
