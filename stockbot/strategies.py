"""매매 기법을 계산 가능한 조건식으로 옮긴 모듈.

모든 함수는 일봉 DataFrame(index=날짜, columns=Open/High/Low/Close/Volume)을 받아
날짜별 결과(Series/DataFrame)를 돌려줍니다. 같은 함수를 '오늘 스캔'과 '백테스트'에
모두 사용하므로, 스캔 결과와 백테스트 결과가 서로 다른 규칙으로 계산되는 일이 없습니다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view


def _false(df: pd.DataFrame) -> pd.Series:
    return pd.Series(False, index=df.index)


# ---------------------------------------------------------------------------
# 1. 거래량과 수급을 통한 '세력 매집' 포착
# ---------------------------------------------------------------------------

def volume_dryup(df: pd.DataFrame, drawdown_pct=20, high_lookback=120, decline_days=5, **_) -> pd.Series:
    """1-1 거래량 급감: 고점 대비 drawdown_pct% 이상 하락 + 거래량이 decline_days일 연속 감소."""
    c, h, v = df["Close"], df["High"], df["Volume"]
    peak = h.rolling(high_lookback, min_periods=min(high_lookback, 20)).max()
    dd = c / peak - 1
    dec = (v.diff() < 0).astype(int).rolling(decline_days).sum() == decline_days
    return ((dd <= -drawdown_pct / 100) & dec).fillna(False)


def price_defense(df: pd.DataFrame, window=20, band_pct=2, min_tests=3, min_hold_days=10,
                  max_above_pct=8, vol_mult=1.3, recent_test_days=5, vol_base=60, **_) -> pd.DataFrame:
    """1-2 가격 방어: 매도 물량(높은 거래량)이 나오는데도 같은 가격대(지지선)를 반복해서 지켜낸 종목.

    window 기간의 최저가를 지지선으로 보고,
      - 저가가 지지선 +band_pct% 이내로 내려온 날(=테스트)이 min_tests회 이상
      - 첫 테스트가 min_hold_days일 이상 전 (지지선이 오래 버팀)
      - 최근 recent_test_days일 안에 다시 테스트 (지금도 방어 중)
      - 테스트일 평균 거래량 >= 직전 vol_base일 평균 거래량 x vol_mult (매도 물량 출회)
      - 현재 종가가 지지선 위, 지지선 +max_above_pct% 이내 (손절 기준이 가까운 매수 구간)
    반환: columns = signal(bool), support(float)
    """
    n = len(df)
    out = pd.DataFrame({"signal": False, "support": np.nan}, index=df.index)
    if n < window + vol_base:
        return out
    low = df["Low"].to_numpy(float)
    close = df["Close"].to_numpy(float)
    vol = df["Volume"].to_numpy(float)
    W = sliding_window_view(low, window)          # row i -> 구간 [i, i+window-1]
    VW = sliding_window_view(vol, window)
    sup = W.min(axis=1)
    near = W <= sup[:, None] * (1 + band_pct / 100)
    tests = near.sum(axis=1)
    first_test = near.argmax(axis=1)
    held = first_test <= window - min_hold_days
    recent = near[:, -recent_test_days:].any(axis=1)
    test_vol = (VW * near).sum(axis=1) / np.maximum(tests, 1)
    vbase = pd.Series(vol).rolling(vol_base).mean().shift(window).to_numpy()[window - 1:]
    c_end = close[window - 1:]
    sig = ((tests >= min_tests) & held & recent & (c_end > sup)
           & (c_end <= sup * (1 + max_above_pct / 100))
           & (test_vol >= vol_mult * np.nan_to_num(vbase, nan=np.inf)))
    out.iloc[window - 1:, 0] = sig
    out.iloc[window - 1:, 1] = sup
    out["signal"] = out["signal"].astype(bool)
    return out


def volume_surge_sideways(df: pd.DataFrame, window=20, base=60, vol_mult=3, max_move_pct=3, **_) -> pd.Series:
    """1-3 거래량 폭증 + 주가 횡보: 최근 window일 평균 거래량이 그 이전 base일 평균의 vol_mult배 이상인데
    window일 동안 종가 변동이 max_move_pct% 미만."""
    c, v = df["Close"], df["Volume"]
    recent = v.rolling(window).mean()
    prior = v.shift(window).rolling(base).mean()
    move = (c / c.shift(window) - 1).abs()
    return ((recent >= vol_mult * prior) & (move < max_move_pct / 100)).fillna(False)


# ---------------------------------------------------------------------------
# 2. 대장주 / 오르는 주식 매매
# ---------------------------------------------------------------------------

def moving_average(df: pd.DataFrame, period=10) -> pd.Series:
    return df["Close"].rolling(period).mean()


def ma_cross_up(df: pd.DataFrame, period=10, **_) -> pd.Series:
    """2-2 매수: 종가가 10일선 아래(이하)에 있다가 위로 올라선 날."""
    c = df["Close"]
    ma = moving_average(df, period)
    return ((c > ma) & (c.shift(1) <= ma.shift(1))).fillna(False)


def ma_break_down(df: pd.DataFrame, period=10, **_) -> pd.Series:
    """2-2 매도: 종가가 10일선 위에 있다가 아래로 깨진 날."""
    c = df["Close"]
    ma = moving_average(df, period)
    return ((c < ma) & (c.shift(1) >= ma.shift(1))).fillna(False)


def breakout_setup(df: pd.DataFrame, surge_pct=20, surge_window=10, min_rest=2, max_rest=3,
                   max_pullback_pct=8, **_) -> pd.DataFrame:
    """2-3 돌파 준비 상태 (해당 날짜 종가 기준).

    마지막 k일(min_rest<=k<=max_rest)이 '쉬는 구간'이고, 그 직전 날(peak day)이
      - 직전 surge_window일 최저 종가 대비 surge_pct% 이상 오른 급등의 고점이고
      - 쉬는 구간의 고가가 peak 고가를 넘지 않았고
      - 쉬는 구간 저가가 peak 고가 대비 max_pullback_pct% 이내
    이면 setup=True, pivot=peak 고가. 다음 날 pivot을 넘으면 돌파 매수.
    """
    c, h, l = df["Close"], df["High"], df["Low"]
    setup = pd.Series(False, index=df.index)
    pivot = pd.Series(np.nan, index=df.index)
    rest_days = pd.Series(0, index=df.index)
    for k in range(min_rest, max_rest + 1):
        peak_close = c.shift(k)
        peak_high = h.shift(k)
        prior_min = c.shift(k + 1).rolling(surge_window).min()
        prior_max_high = h.shift(k + 1).rolling(surge_window).max()
        surge = (peak_close / prior_min - 1 >= surge_pct / 100) & (peak_high >= prior_max_high)
        rest_high = h.rolling(k).max()
        rest_low = l.rolling(k).min()
        resting = (rest_high <= peak_high) & ((peak_high - rest_low) / peak_high <= max_pullback_pct / 100)
        ok = (surge & resting).fillna(False) & ~setup
        setup |= ok
        pivot = pivot.where(~ok, peak_high)
        rest_days = rest_days.where(~ok, k)
    return pd.DataFrame({"setup": setup, "pivot": pivot, "rest_days": rest_days})


def breakout_signal(df: pd.DataFrame, **params) -> pd.Series:
    """2-3 돌파 매수: 전일 setup 상태였고 오늘 종가가 pivot(쉬기 전 고점)을 넘은 날."""
    s = breakout_setup(df, **params)
    return (s["setup"].shift(1, fill_value=False) & (df["Close"] > s["pivot"].shift(1))).fillna(False)


@dataclass
class Resilience:
    excess_on_down_days: float   # 지수 하락일 평균 초과수익(%p)
    down_days: int
    stock_drawdown: float        # lookback 고점 대비 현재 하락률(%)
    index_drawdown: float


def resilience(stock: pd.DataFrame, index_close: pd.Series, lookback=60, down_day_pct=-1.0) -> Resilience | None:
    """2-1 폭락장의 버팀목: 지수가 크게 빠진 날 얼마나 덜 빠졌는지/버텼는지."""
    c = stock["Close"].iloc[-lookback - 1:]
    idx = index_close.reindex(c.index).ffill()
    if len(c) < lookback // 2 or idx.isna().all():
        return None
    sr, ir = c.pct_change(), idx.pct_change()
    mask = ir <= down_day_pct / 100
    n_down = int(mask.sum())
    excess = float(((sr - ir)[mask]).mean() * 100) if n_down else float("nan")
    s_dd = float((c.iloc[-1] / stock["High"].iloc[-lookback:].max() - 1) * 100)
    i_dd = float((idx.iloc[-1] / idx.max() - 1) * 100)
    return Resilience(excess, n_down, s_dd, i_dd)


def index_drawdown(index_close: pd.Series, lookback=60) -> float:
    s = index_close.dropna().iloc[-lookback:]
    return float((s.iloc[-1] / s.max() - 1) * 100) if len(s) else 0.0


# ---------------------------------------------------------------------------
# 3. 사이클 주식 바닥 (재무 데이터 기반, fundamentals.py 에서 데이터 수집)
# ---------------------------------------------------------------------------

@dataclass
class CycleResult:
    psr: float
    loss_streak: int
    peer_loss_ratio: float
    peers: int
    peak_eps: float
    target_price: float
    latest_year: int


def loss_streak(profits: dict[int, float]) -> int:
    """최근 연도부터 연속 적자 연수."""
    streak = 0
    for y in sorted(profits, reverse=True):
        v = profits[y]
        if v is None or (isinstance(v, float) and math.isnan(v)):
            break
        if v < 0:
            streak += 1
        else:
            break
    return streak


def cycle_bottom(fin: dict, market_cap: float, peer_profits: list[dict[int, float]], max_psr=0.5,
                 loss_years=2, strict_second_year=True, loss_metric="operating",
                 min_peer_loss_ratio=0.5, min_peers=3, target_eps_multiple=5, **_) -> CycleResult | None:
    """3. 사이클 바닥: PSR<=max_psr, 적자 loss_years년차, 경쟁사 다수 적자 → 후보. 목표가 = 최고 EPS x 5.

    fin = {"revenue": {year: v}, "operating": {...}, "net": {...}, "eps": {...}}
    peer_profits = 같은 업종 다른 회사들의 {year: 이익} 목록 (loss_metric 기준)
    """
    profits = fin.get(loss_metric) or {}
    revenue = fin.get("revenue") or {}
    if not profits or not revenue or not market_cap:
        return None
    latest = max(profits)
    rev = revenue.get(latest)
    if not rev or rev <= 0:
        return None
    psr = market_cap / rev
    streak = loss_streak(profits)
    if psr > max_psr or streak < loss_years:
        return None
    if strict_second_year and streak != loss_years:
        return None
    peers = [p for p in peer_profits if p.get(latest) is not None]
    if len(peers) < min_peers:
        return None
    ratio = sum(1 for p in peers if p[latest] < 0) / len(peers)
    if ratio < min_peer_loss_ratio:
        return None
    eps_vals = [v for v in (fin.get("eps") or {}).values() if v is not None and v > 0]
    peak = max(eps_vals) if eps_vals else float("nan")
    target = peak * target_eps_multiple if eps_vals else float("nan")
    return CycleResult(psr, streak, ratio, len(peers), peak, target, latest)


# ---------------------------------------------------------------------------
# 4. 리스크 관리
# ---------------------------------------------------------------------------

@dataclass
class PositionPlan:
    entry: float
    qty: int
    amount: float
    stop: float
    take: float


def position_plan(price: float, capital: float, max_positions: int, stop_loss_pct=5, take_profit_pct=15) -> PositionPlan:
    """4-1 동일비중 매수 + 기계적 손절(-5%)/익절(+15%)."""
    amount = capital / max(max_positions, 1)
    qty = int(amount // price) if price > 0 else 0
    return PositionPlan(price, qty, qty * price, price * (1 - stop_loss_pct / 100), price * (1 + take_profit_pct / 100))


def market_regime(index_close: pd.Series, crash_drawdown_pct=15) -> dict:
    """4-2 시장 국면: RISK_ON / NEUTRAL / RISK_OFF."""
    s = index_close.dropna()
    if len(s) < 60:
        return {"state": "UNKNOWN", "reasons": ["지수 데이터 부족"]}
    c = float(s.iloc[-1])
    ma50 = float(s.rolling(50).mean().iloc[-1])
    ma200 = float(s.rolling(200).mean().iloc[-1]) if len(s) >= 200 else float("nan")
    ma50_prev = float(s.rolling(50).mean().iloc[-6])
    dd = float((c / s.iloc[-252:].max() - 1) * 100)
    reasons = []
    has200 = not math.isnan(ma200)
    if dd <= -crash_drawdown_pct:
        reasons.append(f"52주 고점 대비 {dd:.1f}% 하락")
    if has200 and c < ma200 and ma50 < ma200:
        reasons.append("지수 < 200일선, 50일선 < 200일선 (하락 추세)")
    if reasons:
        state = "RISK_OFF"
    elif c > ma50 and ma50 > ma50_prev and (not has200 or c > ma200):
        state = "RISK_ON"
        reasons.append("지수 > 50일선(상승 중)" + (" > 200일선" if has200 else ""))
    else:
        state = "NEUTRAL"
        reasons.append("추세 혼조")
    return {"state": state, "reasons": reasons, "close": c, "ma50": ma50, "ma200": ma200, "drawdown_52w": dd}
