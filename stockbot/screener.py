"""장 마감 후 스캔: 기법별 후보 → 감시목록(장중 알림용 기준가) → 매수 추천."""
from __future__ import annotations

import logging
import math
from dataclasses import asdict

import pandas as pd

from . import fundamentals
from . import strategies as S
from .data import liquid

log = logging.getLogger(__name__)

LABEL = {
    "volume_dryup": "거래량 급감(코슬라)",
    "price_defense": "가격 방어(아우타니)",
    "volume_surge_sideways": "거래량 폭증+횡보(시겔)",
    "leaders": "폭락장 버팀목(켈)",
    "breakout_setup": "급등 후 휴식(헨)",
    "high20_near": "20일 신고가 임박(터틀)",
    "surge_hold": "급등 후 절반 지지 확인중",
    "box_accum": "24개월 박스권+매집",
    "pullback": "주도주 눌림 방어중",
    "cycle": "사이클 바닥(PSR)",
    "position": "보유종목",
}
ACCUMULATION = ("volume_dryup", "price_defense", "volume_surge_sideways")


def _params(cfg, name):
    return {k: v for k, v in cfg.strat(name).items() if k != "enabled"}


def _on(cfg, name):
    return cfg.strat(name).get("enabled", True)


def _levels(df: pd.DataFrame, ma_period: int, entry_period: int, exit_period: int) -> dict:
    """다음 거래일 장중 판단용 기준가 (오늘 종가까지 반영)."""
    closes = df["Close"].iloc[-(ma_period - 1):]
    return {"close": float(df["Close"].iloc[-1]), "ma10": float(df["Close"].iloc[-ma_period:].mean()),
            "sum9": float(closes.sum()), "n9": len(closes),
            "high20": float(df["High"].iloc[-entry_period:].max()),   # 내일 이 가격을 넘으면 20일 신고가
            "low10": float(df["Low"].iloc[-exit_period:].min())}      # 내일 이 가격을 깨면 10일 신저가


def find_leaders(cfg, prices: dict[str, pd.DataFrame], index_close: pd.Series) -> tuple[list[dict], bool]:
    p = cfg.strat("leaders")
    crash = S.index_drawdown(index_close, p["lookback"]) <= -p["crash_drawdown_pct"]
    rows = []
    for t, df in prices.items():
        r = S.resilience(df, index_close, p["lookback"], p["down_day_pct"])
        if r is None:
            continue
        if crash:
            if r.stock_drawdown > r.index_drawdown * 0.5:   # 지수 낙폭의 절반도 안 빠짐
                rows.append({"ticker": t, "score": r.stock_drawdown - r.index_drawdown, **asdict(r)})
        elif r.down_days >= p["min_down_days"] and not math.isnan(r.excess_on_down_days) and r.excess_on_down_days > 0:
            rows.append({"ticker": t, "score": r.excess_on_down_days, **asdict(r)})
    rows.sort(key=lambda x: x["score"], reverse=True)
    return rows[: p["top_n"]], crash


def find_cycle(cfg, market, universe: pd.DataFrame, prices: dict[str, pd.DataFrame]) -> list[dict]:
    fin = fundamentals.load(cfg.data_dir, market)
    if not fin:
        return []
    p = _params(cfg, "cycle")
    metric = p.get("loss_metric", "operating")
    uni = universe.set_index("Ticker")
    group_col = "Industry" if market == "US" and "Industry" in uni.columns else "Sector"
    groups: dict[str, list[str]] = {}
    for t, g in uni[group_col].dropna().items():
        groups.setdefault(g, []).append(t)
    out = []
    for t, d in fin.items():
        if t not in prices or t not in uni.index:
            continue
        close = float(prices[t]["Close"].iloc[-1])
        if market == "KR":
            sh = uni.at[t, "Shares"]
            mcap = float(sh) * close if sh and sh == sh else None
        else:
            mcap = d.get("market_cap")
        grp = uni.at[t, group_col]
        peers = [fin[x].get(metric, {}) for x in groups.get(grp, []) if x != t and x in fin]
        if market == "US" and len(peers) < p.get("min_peers", 3) and group_col == "Industry":
            grp = uni.at[t, "Sector"]
            peers = [fin[x].get(metric, {}) for x in uni.index[uni["Sector"] == grp] if x != t and x in fin]
        res = S.cycle_bottom(d, mcap, peers, **p)
        if res:
            upside = (res.target_price / close - 1) * 100 if res.target_price == res.target_price else float("nan")
            out.append({"ticker": t, "close": close, "sector": grp, "upside_pct": upside, **asdict(res)})
    out.sort(key=lambda x: x["psr"])
    return out


def scan(cfg, store, market: str, universe: pd.DataFrame, prices: dict[str, pd.DataFrame],
         index_close: pd.Series) -> dict:
    ucfg = cfg["universe"][market]
    names = dict(zip(universe["Ticker"], universe["Name"]))
    kr_mk = dict(zip(universe["Ticker"], universe["Market"]))
    tradable = {t: df for t, df in prices.items()
                if liquid(df, ucfg["min_price"], ucfg["min_avg_value"])}
    log.info("%s 스캔 대상 %d / 전체 %d", market, len(tradable), len(prices))

    hits: dict[str, dict[str, dict]] = {k: {} for k in LABEL}
    buy_signals: dict[str, list[str]] = {}
    levels: dict[str, dict] = {}
    ma_period = cfg.strat("ma10").get("period", 10)
    dc = cfg.strat("donchian")
    ep, xp = dc.get("entry_period", 20), dc.get("exit_period", 10)
    near: list[tuple[float, str]] = []
    box_breaks: set[str] = set()
    stops: dict[str, float] = {}          # 기법이 정한 손절가 (급등 후 절반 지지선, 박스 돌파 실패선)
    weights: dict[str, float] = {}        # 기법이 정한 계좌 비중 (박스권 돌파 10~20%)
    box_near: list[tuple[float, str, dict]] = []
    bx = _params(cfg, "box")
    pb = _params(cfg, "pullback")
    pb_setup = {k: v for k, v in pb.items() if k not in ("breakout_vol_mult", "min_close_strength")}

    for t, df in tradable.items():
        try:
            c = float(df["Close"].iloc[-1])
            if _on(cfg, "volume_dryup") and S.volume_dryup(df, **_params(cfg, "volume_dryup")).iloc[-1]:
                hits["volume_dryup"][t] = {}
            if _on(cfg, "price_defense"):
                pdf = S.price_defense(df, **_params(cfg, "price_defense"))
                if pdf["signal"].iloc[-1]:
                    hits["price_defense"][t] = {"support": float(pdf["support"].iloc[-1])}
            if _on(cfg, "volume_surge_sideways") and S.volume_surge_sideways(
                    df, **_params(cfg, "volume_surge_sideways")).iloc[-1]:
                hits["volume_surge_sideways"][t] = {}
            if _on(cfg, "breakout"):
                bp = {k: v for k, v in _params(cfg, "breakout").items() if k != "pyramid_levels_pct"}
                st = S.breakout_setup(df, **bp)
                if st["setup"].iloc[-1]:
                    hits["breakout_setup"][t] = {"pivot": float(st["pivot"].iloc[-1]),
                                                 "rest_days": int(st["rest_days"].iloc[-1])}
                if st["setup"].shift(1, fill_value=False).iloc[-1] and c > st["pivot"].shift(1).iloc[-1]:
                    buy_signals.setdefault(t, []).append("돌파 매수(헨)")
            if _on(cfg, "ma10") and S.ma_cross_up(df, ma_period).iloc[-1]:
                buy_signals.setdefault(t, []).append(f"{ma_period}일선 상향 돌파(켈)")
            if _on(cfg, "donchian"):
                if S.high_breakout(df, ep).iloc[-1]:
                    buy_signals.setdefault(t, []).append(f"{ep}일 최고가 돌파(터틀)")
                hi = float(df["High"].iloc[-ep:].max())
                dist = (hi - c) / hi * 100
                if dist <= dc.get("near_pct", 3):
                    near.append((dist, t))
            if _on(cfg, "surge_hold"):
                sp = _params(cfg, "surge_hold")
                sh = S.surge_hold(df, **sp)
                if sh["signal"].iloc[-1]:
                    sup = float(sh["support"].iloc[-1])
                    buy_signals.setdefault(t, []).append(f"급등 후 {sp['hold_days']}일 절반 지지")
                    stops[t] = sup
                    hits["surge_hold"][t] = {"support": sup, "day": sp["hold_days"]}
                else:
                    prog = S.surge_hold_progress(df, **sp)
                    if prog:
                        hits["surge_hold"][t] = prog
            if _on(cfg, "box") and len(df) > bx["lookback"]:
                bb = S.box_breakout(df, **bx)
                if bb["signal"].iloc[-1]:
                    ratio = float(bb["ratio"].iloc[-1])
                    buy_signals.setdefault(t, []).append("24개월 박스권 상단 돌파(매집 확인)")
                    stops[t] = float(bb["support"].iloc[-1])
                    weights[t] = S.box_weight(ratio, **bx)
                    box_breaks.add(t)
                br = S.box_range(df, **bx).iloc[-1]
                if br["setup"]:
                    dist = (br["top"] - c) / br["top"] * 100
                    if dist <= bx.get("near_pct", 10):
                        box_near.append((dist, t, {"top": float(br["top"]), "bottom": float(br["bottom"]),
                                                   "ratio": float(br["ratio"]), "fail": float(br["fail"]),
                                                   "weight": S.box_weight(float(br["ratio"]), **bx)}))
            if _on(cfg, "pullback") and len(df) > pb["surge_window"] + pb["vol_base"] + 2:
                arr = [df[k].to_numpy(float) for k in ("High", "Low", "Close", "Volume")]
                last = len(df) - 1
                sig_ = S.pullback_signal_at(*arr, last, **pb)
                if sig_:
                    buy_signals.setdefault(t, []).append("주도주 눌림 후 거래량 동반 고점 돌파")
                    stops.setdefault(t, sig_["defense"])
                st = S.pullback_setup_at(*arr, last, **{**pb_setup, "min_pullback_days": 1})
                if st:
                    hits["pullback"][t] = st
            levels[t] = _levels(df, ma_period, ep, xp)
        except Exception as e:
            log.debug("스캔 오류 %s: %s", t, e)

    leaders, crash_mode = ([], False)
    if _on(cfg, "leaders") and not index_close.empty:
        leaders, crash_mode = find_leaders(cfg, tradable, index_close)
        hits["leaders"] = {r["ticker"]: r for r in leaders}
    cycle = find_cycle(cfg, market, universe, tradable) if _on(cfg, "cycle") else []
    hits["cycle"] = {r["ticker"]: r for r in cycle}

    positions = store.positions(market)
    for pos in positions:
        hits["position"][pos["ticker"]] = {}
        df = prices.get(pos["ticker"])
        if df is not None and len(df) and pos["ticker"] not in levels:
            levels[pos["ticker"]] = _levels(df, ma_period, ep, xp)
    near.sort()
    box_near.sort(key=lambda x: x[0])
    hits["box_accum"] = {t: d for _, t, d in box_near[: bx.get("near_watch_max", 40)]}
    hits["high20_near"] = {t: {"high20": levels[t]["high20"], "dist_pct": d}
                           for d, t in near[: dc.get("near_watch_max", 60)]}

    # 감시목록: 출처(기법) 수가 많을수록, 보유/돌파대기 종목 우선
    sources: dict[str, list[str]] = {}
    for strat, d in hits.items():
        for t in d:
            sources.setdefault(t, []).append(strat)
    prio = {"position": 100, "breakout_setup": 10, "surge_hold": 10, "box_accum": 10, "pullback": 10}
    ranked = sorted(sources, key=lambda t: (max(prio.get(s, 0) for s in sources[t]), len(sources[t])), reverse=True)
    watch = {}
    for t in ranked[: cfg["intraday"]["max_watch"]]:
        if t not in levels:
            continue
        w = {"name": names.get(t, t), "sources": sources[t], "kr_market": kr_mk.get(t), **levels[t]}
        if t in hits["breakout_setup"]:
            w["pivot"] = hits["breakout_setup"][t]["pivot"]
        if t in hits["price_defense"]:
            w["support"] = hits["price_defense"][t]["support"]
        if t in hits["cycle"]:
            w["target"] = hits["cycle"][t]["target_price"]
        if t in hits["surge_hold"]:
            w["half_support"] = hits["surge_hold"][t]["support"]
            w["surge_day"] = hits["surge_hold"][t]["day"]
            w["surge_close"] = hits["surge_hold"][t].get("surge_close")
            w["min_low_since"] = hits["surge_hold"][t].get("min_low")
        if t in hits["pullback"] and hits["pullback"][t]["days"] + 1 >= pb.get("min_pullback_days", 5):
            p_ = hits["pullback"][t]
            w.update(pb_pivot=p_["pivot"], pb_defense=p_["defense"], pb_avg_vol=p_["avg_vol"])
        if t in hits["box_accum"]:
            b = hits["box_accum"][t]
            w.update(box_top=b["top"], box_fail=b["fail"], box_weight=b["weight"], box_ratio=b["ratio"])
        watch[t] = w
    store.replace_watch(market, watch)

    # 매수 추천: 오늘 '매수 타이밍' 신호 + (돌파 기법 자체이거나, 매집/대장주/사이클 후보에 속한 종목)
    recs = []
    for t, sigs in buy_signals.items():
        src = [s for s in sources.get(t, []) if s != "position"]
        turtle = any("최고가 돌파" in s for s in sigs)
        standalone = turtle or t in stops or any("돌파 매수" in s for s in sigs)
        src = [s for s in src if s not in ("high20_near", "surge_hold", "box_accum", "pullback")]
        if not (standalone or src):
            continue
        mode = "box" if t in box_breaks else "turtle" if turtle else "fixed"
        plan = S.plan_for(cfg, market, levels[t]["close"], mode, levels[t]["low10"], stop_price=stops.get(t),
                          weight_pct=weights.get(t))
        df = tradable[t]
        vol_ratio = float(df["Volume"].iloc[-1] / max(df["Volume"].iloc[-21:-1].mean(), 1))
        recs.append({"ticker": t, "name": names.get(t, t), "signals": sigs, "mode": mode,
                     "method_stop": stops.get(t),
                     "sources": [LABEL[s] for s in src], "score": len(sigs) + len(src),
                     "vol_ratio": vol_ratio, **asdict(plan)})
    recs.sort(key=lambda r: (r["score"], r["vol_ratio"]), reverse=True)

    result = {
        "market": market,
        "date": str(next(iter(tradable.values())).index[-1].date()) if tradable else None,
        "scanned": len(tradable),
        "hits": {k: [{"ticker": t, "name": names.get(t, t), **v} for t, v in d.items()]
                 for k, d in hits.items() if k != "position"},
        "crash_mode": crash_mode,
        "recommendations": recs,
        "watch_count": len(watch),
    }
    store.put(f"scan_{market}", result)
    return result
