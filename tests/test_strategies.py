import numpy as np
import pandas as pd
import pytest

from stockbot import backtest as B
from stockbot import strategies as S


def make(close, volume=None, spread=0.01, start="2024-01-01"):
    close = np.asarray(close, float)
    idx = pd.bdate_range(start, periods=len(close))
    vol = np.full(len(close), 1e6) if volume is None else np.asarray(volume, float)
    return pd.DataFrame({"Open": close, "High": close * (1 + spread), "Low": close * (1 - spread),
                         "Close": close, "Volume": vol}, index=idx)


def test_volume_dryup():
    close = list(np.linspace(100, 130, 60)) + list(np.linspace(129, 100, 20))  # 고점 ~131 → 100: -23%
    vol = [1e6] * 74 + [9e5, 8e5, 7e5, 6e5, 5e5, 4e5]                          # 마지막 5회 연속 감소
    df = make(close, vol)
    assert S.volume_dryup(df).iloc[-1]
    vol2 = vol[:-1] + [7e5]                                                     # 마지막 날 증가 → 탈락
    assert not S.volume_dryup(make(close, vol2)).iloc[-1]
    assert not S.volume_dryup(make(list(np.linspace(100, 110, 80)), vol)).iloc[-1]  # 하락 아님


def test_volume_surge_sideways():
    close = list(np.linspace(80, 100, 80)) + [100 + (i % 2) * 0.5 for i in range(20)]
    vol = [1e6] * 80 + [4e6] * 20
    assert S.volume_surge_sideways(make(close, vol)).iloc[-1]
    vol_low = [1e6] * 80 + [2e6] * 20
    assert not S.volume_surge_sideways(make(close, vol_low)).iloc[-1]          # 2배 → 탈락
    moved = close[:80] + list(np.linspace(100, 110, 20))
    assert not S.volume_surge_sideways(make(moved, vol)).iloc[-1]              # 10% 움직임 → 탈락


def test_price_defense():
    base = list(np.linspace(130, 105, 60))
    # 지지선 100을 15일 전, 9일 전, 2일 전 테스트하고 위에서 버팀
    window = [104, 103, 102, 100.5, 103, 105, 104, 103, 104, 106, 104, 100.8, 103, 104, 105, 104, 103, 100.6, 102, 104]
    close = base + window
    df = make(close, spread=0.0)
    df["Low"] = df["Close"] * 0.995
    vol = np.full(len(close), 1e6)
    for i, c in enumerate(close):
        if i >= 60 and c < 101:
            vol[i] = 3e6          # 테스트일 거래량 급증 = 매도 물량 출회
    df["Volume"] = vol
    res = S.price_defense(df)
    assert res["signal"].iloc[-1]
    assert res["support"].iloc[-1] == pytest.approx(min(window) * 0.995)
    df2 = df.copy()
    df2["Volume"] = 1e6           # 거래량 없는 횡보는 '방어'가 아님
    assert not S.price_defense(df2)["signal"].iloc[-1]


def test_ma10_cross():
    close = [100] * 20 + [95] * 5 + [94, 93, 92, 105]
    df = make(close)
    assert S.ma_cross_up(df).iloc[-1]
    assert not S.ma_cross_up(df).iloc[-2]
    close2 = [100] * 20 + [110] * 5 + [90]
    assert S.ma_break_down(make(close2)).iloc[-1]


def test_breakout_setup_and_signal():
    close = [100] * 30 + [104, 109, 114, 120, 126] + [125, 124] + [130]   # +26% 급등 → 2일 휴식 → 돌파
    df = make(close)
    st = S.breakout_setup(df)
    assert st["setup"].iloc[-2]
    assert st["pivot"].iloc[-2] == pytest.approx(126 * 1.01)
    assert st["rest_days"].iloc[-2] == 2
    assert S.breakout_signal(df).iloc[-1]
    # 휴식 중 크게 밀리면(-12%) setup 아님
    df_bad = make([100] * 30 + [104, 109, 114, 120, 126] + [118, 111])
    assert not S.breakout_setup(df_bad)["setup"].iloc[-1]
    # 급등 폭이 작으면(10%) setup 아님
    df_small = make([100] * 30 + [102, 104, 106, 108, 110] + [109, 109])
    assert not S.breakout_setup(df_small)["setup"].iloc[-1]


def test_resilience():
    idx_close = pd.Series(np.r_[np.full(30, 100.0), np.linspace(100, 85, 31)],
                          index=pd.bdate_range("2024-01-01", periods=61))
    strong = make(np.r_[np.full(30, 50.0), np.linspace(50, 49, 31)])
    weak = make(np.r_[np.full(30, 50.0), np.linspace(50, 35, 31)])
    rs, rw = S.resilience(strong, idx_close, 60, -0.3), S.resilience(weak, idx_close, 60, -0.3)
    assert rs.stock_drawdown > rw.stock_drawdown
    assert rs.excess_on_down_days > rw.excess_on_down_days
    assert S.index_drawdown(idx_close, 60) == pytest.approx(-15, abs=0.01)


def test_cycle_bottom():
    fin = {"revenue": {2023: 1000, 2024: 1000}, "operating": {2022: 50, 2023: -20, 2024: -30},
           "eps": {2018: 2000, 2019: 3000, 2024: -100}}
    peers = [{2024: -1}, {2024: -5}, {2024: 3}, {2024: -2}]
    r = S.cycle_bottom(fin, 400, peers)
    assert r and r.psr == pytest.approx(0.4) and r.loss_streak == 2
    assert r.target_price == pytest.approx(15000)
    assert r.peer_loss_ratio == pytest.approx(0.75)
    assert S.cycle_bottom(fin, 600, peers) is None                       # PSR 0.6
    assert S.cycle_bottom(fin, 400, [{2024: 1}] * 4) is None             # 경쟁사 흑자 → 회사 문제
    fin3 = dict(fin, operating={2022: -5, 2023: -20, 2024: -30})
    assert S.cycle_bottom(fin3, 400, peers) is None                      # 적자 3년차 (strict)
    assert S.cycle_bottom(fin3, 400, peers, strict_second_year=False)


def test_position_plan_and_regime():
    p = S.position_plan(10000, 10_000_000, 10, 5, 15)
    assert (p.qty, p.stop, p.take) == (100, 9500, 11500)
    up = pd.Series(np.linspace(100, 200, 300), index=pd.bdate_range("2023-01-01", periods=300))
    assert S.market_regime(up)["state"] == "RISK_ON"
    down = pd.Series(np.r_[np.linspace(100, 200, 150), np.linspace(200, 120, 150)],
                     index=pd.bdate_range("2023-01-01", periods=300))
    assert S.market_regime(down)["state"] == "RISK_OFF"


def test_backtest_fixed_and_trend():
    close = [100] * 30 + [101, 103, 106, 110, 116, 120]
    df = make(close, spread=0.0)
    df["Open"] = df["Close"].shift(1).fillna(100)
    sig = pd.Series(False, index=df.index)
    sig.iloc[29] = True                              # 다음 날 시가 100 매수
    tr = B.simulate("X", df, sig, "fixed", cost_pct=0)
    assert len(tr) == 1 and tr[0].reason == "익절" and tr[0].ret_pct == pytest.approx(15)
    close_dn = [100] * 30 + [99, 97, 94, 90]
    df2 = make(close_dn, spread=0.0)
    df2["Open"] = df2["Close"].shift(1).fillna(100)
    tr2 = B.simulate("X", df2, sig.reindex(df2.index).fillna(False), "fixed", cost_pct=0)
    assert tr2[0].reason == "손절" and tr2[0].ret_pct == pytest.approx(-5)
    s = B.summarize(tr + tr2)
    assert s["trades"] == 2 and s["win_rate"] == 50 and s["profit_factor"] == pytest.approx(3)
