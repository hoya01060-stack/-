"""장중 감시: 감시목록의 매수 타이밍 + 보유종목 매도/불타기 알림."""
from __future__ import annotations

import logging
from datetime import datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

from . import strategies as S
from .notifier import esc

log = logging.getLogger(__name__)
TZ = {"KR": ZoneInfo("Asia/Seoul"), "US": ZoneInfo("America/New_York")}


def near_close(cfg, market: str, now: datetime | None = None) -> bool:
    """장 마감 전 N분 이내인가 (급등 후 지지 3일째 '종가 매수' 알림용)."""
    now = now or datetime.now(TZ[market])
    end = dtime.fromisoformat(cfg["schedule"][market]["intraday_end"])
    mins = cfg.strat("surge_hold").get("alert_before_close_min", 30)
    start = (datetime.combine(now.date(), end) - timedelta(minutes=mins)).time()
    return start <= now.time() <= end


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
    if pos["mode"] == "box" and pos["stop"] and price <= pos["stop"]:
        loss = (entry - price) * (pos["qty"] or 0) / cfg["capital"][m] * 100
        out.append(("stop", f"🔴 <b>박스권 돌파 실패 → 즉시 손절</b> {head}\n손절가 {fmt_price(m, pos['stop'])} 도달"
                            f" (박스 상단 아래로 복귀) · 계좌 손실 약 -{loss:.1f}%", {}))
        return out
    if pos["stop"] and price <= pos["stop"]:
        risk = cfg["risk"].get("account_risk_pct", 2)
        out.append(("stop", f"🔴 <b>손절 신호</b> {head}\n손절가 {fmt_price(m, pos['stop'])} 도달 → 무조건 매도\n"
                            f"(기법 손절가와 '계좌 {risk}% 손실 한도' 중 먼저 닿는 가격)", {}))
        return out
    if pos["mode"] in ("turtle", "box") and w and w.get("low10") and price < w["low10"]:
        xp = cfg.strat("donchian").get("exit_period", 10)
        out.append(("low10_break", f"🔴 <b>{xp}일 최저가 이탈 → 전량 매도</b> {head}\n"
                                   f"{xp}일 최저가 {fmt_price(m, w['low10'])} 붕괴 — 미련 없이 전부 매도", {}))
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


def buy_message(cfg, market, t, w, price, reason, regime, mode="fixed", stop_price=None, weight_pct=None) -> str:
    plan = S.plan_for(cfg, market, price, mode, w.get("low10"), stop_price=stop_price, weight_pct=weight_pct)
    from .screener import LABEL

    src = ", ".join(LABEL.get(s, s) for s in w.get("sources", []))
    lines = [f"🔵 <b>매수 타이밍</b> {esc(w.get('name', t))}({t}) {fmt_price(market, price)}",
             f"신호: {reason}", f"근거 기법: {src}",
             f"계획: {plan.qty:,}주(약 {fmt_price(market, plan.amount)}) · 손절 {fmt_price(market, plan.stop)}"
             + (f" · 익절 {fmt_price(market, plan.take)}" if plan.take else "")
             + f" · 손절 시 계좌 -{plan.risk_pct:.1f}%"]
    num = (lambda x: f"{x:.0f}") if market == "KR" else (lambda x: f"{x:.2f}")
    if mode == "box":
        lines.append(f"비중: 계좌의 {plan.amount / cfg['capital'][market] * 100:.0f}% (매집 강도 반영, 10~20%)")
        xp = cfg.strat("donchian").get("exit_period", 10)
        lines.append("손절 기준: 박스 상단 아래로 다시 빠지면 즉시 손절")
        lines.append(f"매도 규칙: {xp}일 최저가 이탈 시 전량 매도 → 등록: /buy {t} {num(price)} {plan.qty} box")
    elif stop_price:
        lines.append(f"손절 기준: 상승분 절반 지지선 이탈 → 등록: /buy {t} {num(price)} {plan.qty} stop={num(plan.stop)}")
    if mode == "turtle":
        lines.append(f"매도 규칙: {cfg.strat('donchian').get('exit_period', 10)}일 최저가 이탈 시 전량 매도"
                     f" → 등록: /buy {t} {num(price)} {plan.qty} turtle")
    if w.get("target"):
        lines.append(f"사이클 목표가: {fmt_price(market, w['target'])}")
    lines.append("※ 장중 신호입니다. 종가에서 조건이 유지되는지 확인하세요.")
    if regime and regime.get("state") == "RISK_OFF":
        lines.append("⚠️ 시장 위험회피 국면 — 비중 축소 / 안전자산 고려")
    return "\n".join(lines)


def check_surge_hold(cfg, market, t, w, q, closing: bool) -> list[tuple[str, str]]:
    """급등 후 절반 지지: 지지선 붕괴 경고 / 3일째 마감 무렵 지지 유지 시 매수 알림."""
    sup = w.get("half_support")
    if not sup:
        return []
    sp = cfg.strat("surge_hold")
    k = sp.get("hold_days", 3)
    day = w.get("surge_day", 0) + 1          # 오늘이 급등 후 며칠째인지 (어제 스캔 기준 +1)
    low = q.low if q.low is not None else q.price
    check = low if sp.get("basis", "low") == "low" else q.price
    if day > k + 1:
        return []
    if check < sup:
        return [("half_broken", f"⚪ <b>지지 실패</b> {esc(w.get('name', t))}({t}) {fmt_price(market, q.price)}\n"
                                f"급등 상승분 절반({fmt_price(market, sup)}) 이탈 → 매수 후보에서 제외")]
    if day == k and closing:
        lows = [x for x in (w.get("min_low_since"), low) if x is not None]
        pulled = not sp.get("require_pullback", True) or (w.get("surge_close") and min(lows) < w["surge_close"])
        if pulled:
            return [("surge_hold_buy", buy_message(
                cfg, market, t, w, q.price,
                f"하루 +{sp.get('surge_pct', 20)}% 급등 후 {k}일간 차익매물에도 상승분 절반({fmt_price(market, sup)}) 지지",
                None, stop_price=sup))]
    return []


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
    closing = near_close(cfg, market)
    msgs = []
    for t, w in watch.items():
        q = quotes.get(t)
        if not q or t in held or suppress:
            continue
        p = q.price
        for key, msg in check_surge_hold(cfg, market, t, w, q, closing):
            if store.mark_alert(market, t, key):
                msgs.append(msg + ("\n⚠️ 시장 위험회피 국면 — 비중 축소 / 안전자산 고려"
                                   if key == "surge_hold_buy" and regime and regime.get("state") == "RISK_OFF" else ""))
        if w.get("pivot") and p > w["pivot"] and store.mark_alert(market, t, "breakout"):
            msgs.append(buy_message(cfg, market, t, w, p,
                                    f"급등 후 휴식 고점 {fmt_price(market, w['pivot'])} 돌파 (데이비드 헨)", regime))
        if w.get("box_top") and p > w["box_top"] and store.mark_alert(market, t, "box_break"):
            msgs.append(buy_message(cfg, market, t, w, p,
                                    f"24개월 박스권 상단 {fmt_price(market, w['box_top'])} 돌파 · 매집 거래량비 "
                                    f"{w.get('box_ratio', 0):.2f}배", regime, mode="box",
                                    stop_price=w.get("box_fail"), weight_pct=w.get("box_weight")))
            continue        # 같은 종목의 다른 매수 알림(20일 신고가 등)은 중복이므로 생략
        if (cfg.strat("donchian").get("enabled", True) and w.get("high20") and p > w["high20"]
                and store.mark_alert(market, t, "high20")):
            ep = cfg.strat("donchian").get("entry_period", 20)
            msgs.append(buy_message(cfg, market, t, w, p, f"{ep}일 최고가 {fmt_price(market, w['high20'])} 돌파 (터틀)",
                                    regime, mode="turtle"))
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
