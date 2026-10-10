"""일일 시장 브리핑: 지수·시장폭·업종·환율/금·국면·기법 신호·보유종목."""
from __future__ import annotations

import logging

import pandas as pd

from . import data as D
from . import strategies as S
from .llm import narrate
from .monitor import fmt_price
from .notifier import esc
from .screener import LABEL

log = logging.getLogger(__name__)
REGIME_KO = {"RISK_ON": "🟢 상승(공격)", "NEUTRAL": "🟡 중립", "RISK_OFF": "🔴 위험회피(방어)", "UNKNOWN": "❔ 판단불가"}


def _chg(s: pd.Series, n: int) -> float | None:
    s = s.dropna()
    return float((s.iloc[-1] / s.iloc[-1 - n] - 1) * 100) if len(s) > n else None


def _pct(v):
    return "-" if v is None or v != v else f"{v:+.2f}%"


def index_summary(series: dict[str, pd.Series]) -> list[dict]:
    rows = []
    for name, s in series.items():
        if s is None or s.empty:
            continue
        rows.append({"name": name, "close": float(s.iloc[-1]), "d1": _chg(s, 1), "d5": _chg(s, 5), "d20": _chg(s, 20),
                     "above_ma50": bool(s.iloc[-1] > s.rolling(50).mean().iloc[-1]) if len(s) >= 50 else None,
                     "above_ma200": bool(s.iloc[-1] > s.rolling(200).mean().iloc[-1]) if len(s) >= 200 else None})
    return rows


def market_stats(prices: dict[str, pd.DataFrame], universe: pd.DataFrame, min_price: float, min_value: float) -> dict:
    names = dict(zip(universe["Ticker"], universe["Name"]))
    sectors = dict(zip(universe["Ticker"], universe["Sector"]))
    last_date = max((df.index[-1] for df in prices.values() if len(df)), default=None)
    rows = []
    for t, df in prices.items():
        if not D.liquid(df, min_price, min_value) or df.index[-1] != last_date:
            continue
        c, v = df["Close"], df["Volume"]
        rows.append({"ticker": t, "name": names.get(t, t), "sector": sectors.get(t),
                     "ret": float((c.iloc[-1] / c.iloc[-2] - 1) * 100),
                     "above50": bool(c.iloc[-1] > c.rolling(50).mean().iloc[-1]),
                     "high52": bool(df["High"].iloc[-1] >= df["High"].iloc[-250:].max()),
                     "low52": bool(df["Low"].iloc[-1] <= df["Low"].iloc[-250:].min()),
                     "vol_ratio": float(v.iloc[-1] / max(v.iloc[-21:-1].mean(), 1))})
    if not rows:
        return {}
    f = pd.DataFrame(rows)
    sec = f.dropna(subset=["sector"]).groupby("sector")["ret"].agg(["mean", "count"])
    sec = sec[sec["count"] >= 3].sort_values("mean", ascending=False)
    top = lambda d, col, n=5, asc=False: d.sort_values(col, ascending=asc).head(n)[["ticker", "name", "ret", "vol_ratio"]].to_dict("records")
    return {
        "date": str(last_date.date()) if last_date is not None else None,
        "count": len(f),
        "advancers_pct": float((f["ret"] > 0).mean() * 100),
        "above_ma50_pct": float(f["above50"].mean() * 100),
        "new_highs": int(f["high52"].sum()), "new_lows": int(f["low52"].sum()),
        "top_sectors": [{"sector": s, "ret": float(r["mean"]), "n": int(r["count"])} for s, r in sec.head(3).iterrows()],
        "bottom_sectors": [{"sector": s, "ret": float(r["mean"]), "n": int(r["count"])} for s, r in sec.tail(3).iloc[::-1].iterrows()],
        "gainers": top(f, "ret"), "losers": top(f, "ret", asc=True),
        "volume_spikes": top(f[f["ret"].abs() < 30], "vol_ratio"),
    }


def macro_summary() -> list[dict]:
    rows = []
    for name, sym in D.MACRO_SYMBOLS.items():
        try:
            s = D.fetch_series(sym, 60)
            if not s.empty:
                rows.append({"name": name, "close": float(s.iloc[-1]), "d1": _chg(s, 1), "d20": _chg(s, 20)})
        except Exception as e:
            log.debug("매크로 수집 실패 %s: %s", name, e)
    return rows


def positions_summary(store, market, prices) -> list[dict]:
    out = []
    for p in store.positions(market):
        df = prices.get(p["ticker"])
        if df is None or df.empty:
            continue
        c = float(df["Close"].iloc[-1])
        ma10 = float(df["Close"].iloc[-10:].mean())
        out.append({"ticker": p["ticker"], "name": p["name"], "mode": p["mode"], "entry": p["entry_price"],
                    "close": c, "ret": (c / p["entry_price"] - 1) * 100, "stop": p["stop"], "take": p["take"],
                    "above_ma10": c > ma10})
    return out


def build(cfg, store, market: str, scan: dict, idx: dict[str, pd.Series], stats: dict, macro: list[dict],
          positions: list[dict]) -> str:
    regime = S.market_regime(idx[D.PRIMARY_INDEX[market]], cfg["regime"]["crash_drawdown_pct"]) \
        if not idx[D.PRIMARY_INDEX[market]].empty else {"state": "UNKNOWN", "reasons": []}
    store.put(f"regime_{market}", regime)
    flag = "🇰🇷" if market == "KR" else "🇺🇸"
    L = [f"{flag} <b>{market} 일일 브리핑</b> ({scan.get('date') or stats.get('date')})", ""]

    L.append("<b>■ 지수</b>")
    for r in index_summary(idx):
        ma = ("50일선 위" if r["above_ma50"] else "50일선 아래") if r["above_ma50"] is not None else ""
        L.append(f"{r['name']} {r['close']:,.2f} ({_pct(r['d1'])}) · 1주 {_pct(r['d5'])} · 1달 {_pct(r['d20'])} · {ma}")
    if stats:
        L += ["", "<b>■ 시장 폭</b>",
              f"상승 종목 {stats['advancers_pct']:.0f}% · 50일선 위 {stats['above_ma50_pct']:.0f}% · "
              f"52주 신고가 {stats['new_highs']} / 신저가 {stats['new_lows']} (유동성 상위 {stats['count']}종목)"]
        if stats["top_sectors"]:
            L.append("강한 업종: " + ", ".join(f"{esc(s['sector'])} {s['ret']:+.1f}%" for s in stats["top_sectors"]))
            L.append("약한 업종: " + ", ".join(f"{esc(s['sector'])} {s['ret']:+.1f}%" for s in stats["bottom_sectors"]))
        L.append("상승 상위: " + ", ".join(f"{esc(g['name'])} {g['ret']:+.1f}%" for g in stats["gainers"]))
        L.append("거래량 급증: " + ", ".join(f"{esc(g['name'])} x{g['vol_ratio']:.1f}" for g in stats["volume_spikes"]))
    if macro:
        L += ["", "<b>■ 환율 · 원자재 · 금리</b>",
              " · ".join(f"{m['name']} {m['close']:,.2f}({_pct(m['d1'])})" for m in macro)]

    L += ["", f"<b>■ 시장 국면: {REGIME_KO.get(regime['state'], regime['state'])}</b>"]
    L += [f"- {esc(r)}" for r in regime.get("reasons", [])]
    if regime["state"] == "RISK_OFF":
        safe = cfg["regime"]["safe_assets"][market]
        L.append("🛡 방어 전략(레이 달리오): 신규 매수 축소, 현금 대신 금·달러 자산으로 가치 방어 고려 → "
                 + ", ".join(f"{esc(n)}({t})" for t, n in safe.items()))
    if scan.get("crash_mode"):
        L.append("⚡ 폭락장 모드: 아래 '버팀목' 종목이 다음 상승장 대장주 후보입니다 (올리버 켈).")

    L += ["", "<b>■ 매수 추천 (오늘 종가 기준 매수 타이밍 + 기법 근거)</b>"]
    recs = scan.get("recommendations", [])
    if not recs:
        L.append("없음")
    for r in recs[:10]:
        L.append(f"• <b>{esc(r['name'])}</b>({r['ticker']}) {fmt_price(market, r['entry'])} — {', '.join(r['signals'])}"
                 + (f" | 근거: {', '.join(r['sources'])}" if r["sources"] else ""))
        exit_rule = (f"익절 {fmt_price(market, r['take'])}" if r.get("take")
                     else f"{cfg.strat('donchian').get('exit_period', 10)}일 최저가 이탈 시 전량 매도")
        stop_arg = (f"{r['stop']:.0f}" if market == "KR" else f"{r['stop']:.2f}") \
            if r.get("method_stop") and r.get("mode") != "box" else ""
        if r.get("mode") == "box":
            exit_rule = f"계좌 {r['amount'] / cfg['capital'][market] * 100:.0f}% 투입 · 돌파 실패 시 즉시 손절"
        how = f"/buy 모드 {r.get('mode', 'fixed')}" + (f" stop={stop_arg}" if stop_arg else "")
        L.append(f"   {r['qty']:,}주 · 손절 {fmt_price(market, r['stop'])}(계좌 -{r.get('risk_pct', 0):.1f}%) · {exit_rule} · {how}")
    if regime["state"] == "RISK_OFF" and recs:
        L.append("⚠️ 위험회피 국면이므로 비중을 줄이거나 보류를 권장합니다.")

    L += ["", "<b>■ 관심종목 (기법별 포착)</b>"]
    for key in ("volume_dryup", "price_defense", "volume_surge_sideways", "breakout_setup", "surge_hold", "box_accum", "high20_near",
                "leaders", "cycle"):
        items = scan.get("hits", {}).get(key, [])
        if not items:
            continue
        def extra(it):
            if key == "breakout_setup":
                return f" 돌파가 {fmt_price(market, it['pivot'])}"
            if key == "box_accum":
                return f" 상단 {fmt_price(market, it['top'])}(거래량비 {it['ratio']:.1f})"
            if key == "surge_hold":
                return f" 지지 {fmt_price(market, it['support'])}(D+{it['day']})"
            if key == "high20_near":
                return f" 돌파가 {fmt_price(market, it['high20'])}"
            if key == "price_defense":
                return f" 지지 {fmt_price(market, it['support'])}"
            if key == "cycle":
                return f" PSR {it['psr']:.2f}, 목표 {fmt_price(market, it['target_price'])}"
            return ""
        shown = ", ".join(f"{esc(it['name'])}{extra(it)}" for it in items[:8])
        L.append(f"[{LABEL[key]}] {len(items)}종목: {shown}" + (" 외" if len(items) > 8 else ""))

    if positions:
        L += ["", "<b>■ 보유 종목</b>"]
        for p in positions:
            warn = "" if p["above_ma10"] else " ⚠️10일선 아래"
            L.append(f"• {esc(p['name'])} {fmt_price(market, p['close'])} ({p['ret']:+.1f}%) [{p['mode']}] "
                     f"손절 {fmt_price(market, p['stop'])}{warn}")

    facts = {"market": market, "indices": index_summary(idx), "breadth": {k: v for k, v in stats.items()
             if k not in ("gainers", "losers", "volume_spikes")} if stats else {},
             "top_movers": {k: stats.get(k) for k in ("gainers", "losers", "volume_spikes")} if stats else {},
             "macro": macro, "regime": regime,
             "signals": {LABEL[k]: [i["name"] for i in v[:10]] for k, v in scan.get("hits", {}).items() if k in LABEL},
             "recommendations": [{"name": r["name"], "signals": r["signals"], "sources": r["sources"]} for r in recs[:10]],
             "positions": positions}
    note = narrate(cfg, facts)
    if note:
        L += ["", "<b>■ AI 해설 (Claude)</b>", esc(note)]
    L += ["", "<i>※ 기계적 조건 검색 결과이며 투자 권유가 아닙니다. 최종 판단과 책임은 본인에게 있습니다.</i>"]
    return "\n".join(L)
