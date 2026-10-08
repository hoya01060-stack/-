"""간단한 백테스트: 신호 다음 날 시가 매수 → 손절/익절 또는 10일선 이탈 매도.

한계(반드시 감안):
- 현재 상장 종목만 대상 → 상장폐지 종목이 빠지는 '생존 편향'으로 성과가 실제보다 좋게 나옴
- 수수료·세금·슬리피지 미반영 (cost_pct 로 왕복비용을 차감할 수 있음)
- 같은 날 손절가와 익절가를 모두 터치하면 보수적으로 손절로 처리
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import strategies as S


@dataclass
class Trade:
    ticker: str
    entry_date: pd.Timestamp
    exit_date: pd.Timestamp
    entry: float
    exit: float
    ret_pct: float
    days: int
    reason: str


def signal_series(name: str, df: pd.DataFrame, cfg) -> pd.Series:
    p = {k: v for k, v in cfg.strat(name if name != "breakout_signal" else "breakout").items()
         if k not in ("enabled", "pyramid_levels_pct")}
    if name == "volume_dryup":
        return S.volume_dryup(df, **p)
    if name == "price_defense":
        return S.price_defense(df, **p)["signal"]
    if name == "volume_surge_sideways":
        return S.volume_surge_sideways(df, **p)
    if name == "ma10":
        return S.ma_cross_up(df, p.get("period", 10))
    if name in ("breakout", "breakout_signal"):
        return S.breakout_signal(df, **p)
    raise ValueError(f"지원하지 않는 전략: {name}")


def simulate(ticker: str, df: pd.DataFrame, signal: pd.Series, exit_mode="fixed", stop_pct=5, take_pct=15,
             ma_period=10, max_hold=60, cost_pct=0.3) -> list[Trade]:
    o, h, l, c = (df[k].to_numpy(float) for k in ("Open", "High", "Low", "Close"))
    ma = df["Close"].rolling(ma_period).mean().to_numpy()
    sig = signal.reindex(df.index).fillna(False).to_numpy(bool)
    idx = df.index
    trades, i, n = [], 0, len(df)
    while i < n - 1:
        if not sig[i]:
            i += 1
            continue
        e = i + 1
        entry = o[e]
        if not entry or np.isnan(entry):
            i += 1
            continue
        stop, take = entry * (1 - stop_pct / 100), entry * (1 + take_pct / 100)
        exit_px, reason, j = None, "", e
        for j in range(e, min(n, e + max_hold)):
            if l[j] <= stop:
                exit_px, reason = (min(o[j], stop) if j > e else stop), "손절"
                break
            if exit_mode == "fixed" and h[j] >= take:
                exit_px, reason = (max(o[j], take) if j > e else take), "익절"
                break
            if exit_mode == "trend" and c[j] < ma[j]:
                exit_px, reason = c[j], "10일선 이탈"
                break
        if exit_px is None:
            exit_px, reason = c[j], "보유기간 만료" if j == e + max_hold - 1 else "데이터 끝"
        ret = (exit_px / entry - 1) * 100 - cost_pct
        trades.append(Trade(ticker, idx[e], idx[j], entry, exit_px, ret, j - e + 1, reason))
        i = j + 1
    return trades


def summarize(trades: list[Trade]) -> dict:
    if not trades:
        return {"trades": 0}
    r = np.array([t.ret_pct for t in trades])
    wins, losses = r[r > 0], r[r <= 0]
    pf = wins.sum() / abs(losses.sum()) if losses.sum() != 0 else float("inf")
    return {"trades": len(r), "win_rate": float((r > 0).mean() * 100), "avg_ret": float(r.mean()),
            "avg_win": float(wins.mean()) if len(wins) else 0.0, "avg_loss": float(losses.mean()) if len(losses) else 0.0,
            "profit_factor": float(pf), "avg_days": float(np.mean([t.days for t in trades]))}


def run(cfg, prices: dict[str, pd.DataFrame], strategy: str, exit_mode: str, cost_pct=0.3) -> tuple[dict, list[Trade]]:
    risk = cfg["risk"]
    all_trades = []
    for t, df in prices.items():
        if len(df) < 150:
            continue
        sig = signal_series(strategy, df, cfg)
        all_trades += simulate(t, df, sig, exit_mode, risk["stop_loss_pct"], risk["take_profit_pct"],
                               cfg.strat("ma10").get("period", 10), cost_pct=cost_pct)
    return summarize(all_trades), all_trades
