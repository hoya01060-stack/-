"""장중 감시: 감시목록의 매수 타이밍 + 보유종목 매도/불타기 알림."""
from __future__ import annotations

import logging

from . import strategies as S
from .notifier import esc

log = logging.getLogger(__name__)


def fmt_price(market: str, p: float | None) -> str:
    if p is None or p != p:
        return "-"
    return f"{p:,.0f}원" if market == "KR" else f"${p:,.2f}"


def ma_today(w: dict, price: float) -> float | None:
    """어제까지 9개 종가 합 + 현재가 → 오늘의 10일선(장중 추정)."""
    if w.get("n9", 0) < 9:
        return None
    return (w["sum9"] + price) / 10


def check_position(cfg, pos: dict, price: float, w: dict | None) -> list[tuple[str, str, dict]]:
    """보유 포지션 점검. 반환: [(signal_key, 메시지, DB업데이트)]."""
    m = pos["market"]
    out = []
    entry = pos["entry_price"]
    ret = (price / entry - 1) * 100
    head = f"<b>{esc(pos['name'])}</b>({pos['ticker']}) 현재 {fmt_price(m, price)} ({ret:+.1f}%)"
    if pos["stop"] and price <= pos["stop"]:
        out.append(("stop", f"🔴 <b>손절 신호</b> {head}\n손절가 {fmt_price(m, pos['stop'])} 도달 → 원칙대로 매도", {}))
        return out
    if pos["mode"] == "fixed" and pos["take"] and price >= pos["take"]:
        out.append(("take", f"🟢 <b>익절 신호</b> {head}\n목표 +{cfg['risk']['take_profit_pct']}% "
                            f"({fmt_price(m, pos['take'])}) 도달 → 매도", {}))
    if pos["mode"] == "cycle" and pos["take"] and price >= pos["take"]:
        out.append(("target", f"🟢 <b>사이클 목표가 도달</b> {head}\n과거 최고 EPS x5 = {fmt_price(m, pos['take'])}", {}))
    if pos["mode"] == "trend" and w:
        ma = ma_today(w, price)
        if ma and price < ma:
            out.append(("ma10_break", f"🟠 <b>10일선 이탈 매도 신호</b> {head}\n10일선(장중) {fmt_price(m, ma)} 아래"
                                      " — 종가까지 회복 못하면 매도 (올리버 켈)", {}))
        levels = cfg.strat("breakout").get("pyramid_levels_pct", [])
        n = pos["adds_done"] or 0
        if n < len(levels) and ret >= levels[n]:
            new_stop = max(pos["stop"] or 0, entry)
            out.append((f"pyramid{n + 1}",
                        f"🔥 <b>불타기(추가매수) 신호</b> {head}\n최초 매수가 대비 +{levels[n]}% 도달 → 추가 매수 검토\n"
                        f"손절가를 본전({fmt_price(m, new_stop)})으로 올렸습니다. 추가 매수 후 /buy 로 등록하세요.",
                        {"adds_done": n + 1, "stop": new_stop}))
    return out


def buy_message(cfg, market, t, w, price, reason, regime) -> str:
    plan = S.position_plan(price, cfg["capital"][market], cfg["max_positions"],
                           cfg["risk"]["stop_loss_pct"], cfg["risk"]["take_profit_pct"])
    from .screener import LABEL

    src = ", ".join(LABEL.get(s, s) for s in w.get("sources", []))
    lines = [f"🔵 <b>매수 타이밍</b> {esc(w.get('name', t))}({t}) {fmt_price(market, price)}",
             f"신호: {reason}", f"근거 기법: {src}",
             f"계획: {plan.qty:,}주(약 {fmt_price(market, plan.amount)}) · 손절 {fmt_price(market, plan.stop)}"
             f" · 익절 {fmt_price(market, plan.take)}"]
    if w.get("target"):
        lines.append(f"사이클 목표가: {fmt_price(market, w['target'])}")
    lines.append("※ 장중 신호입니다. 종가에서 조건이 유지되는지 확인하세요.")
    if regime and regime.get("state") == "RISK_OFF":
        lines.append("⚠️ 시장 위험회피 국면 — 비중 축소 / 안전자산 고려")
    return "\n".join(lines)


def run_intraday(cfg, store, tg, provider, market: str) -> int:
    watch = store.watch(market)
    positions = store.positions(market)
    tickers = sorted(set(watch) | {p["ticker"] for p in positions})
    if not tickers:
        return 0
    kr_mk = {t: w.get("kr_market") for t, w in watch.items()}
    quotes = provider.quotes(market, tickers, kr_mk)
    regime = store.get(f"regime_{market}")
    suppress = cfg["regime"].get("suppress_buys_in_risk_off") and regime and regime.get("state") == "RISK_OFF"
    held = {p["ticker"] for p in positions}
    msgs = []
    for t, w in watch.items():
        q = quotes.get(t)
        if not q or t in held or suppress:
            continue
        p = q.price
        if w.get("pivot") and p > w["pivot"] and store.mark_alert(market, t, "breakout"):
            msgs.append(buy_message(cfg, market, t, w, p,
                                    f"급등 후 휴식 고점 {fmt_price(market, w['pivot'])} 돌파 (데이비드 헨)", regime))
        ma = ma_today(w, p)
        if ma and w["close"] <= w["ma10"] and p > ma and store.mark_alert(market, t, "ma10_up"):
            msgs.append(buy_message(cfg, market, t, w, p, f"10일선({fmt_price(market, ma)}) 상향 돌파 (올리버 켈)", regime))
    for pos in positions:
        q = quotes.get(pos["ticker"])
        if not q:
            continue
        for key, msg, upd in check_position(cfg, pos, q.price, watch.get(pos["ticker"])):
            if store.mark_alert(market, pos["ticker"], key):
                msgs.append(msg)
                if upd:
                    store.update_position(pos["id"], **upd)
    if msgs:
        tg.send(f"⏰ [{market} 장중 알림 · {provider.name}]\n\n" + "\n\n".join(msgs))
    log.info("%s 장중 점검: 시세 %d/%d, 알림 %d", market, len(quotes), len(tickers), len(msgs))
    return len(msgs)
