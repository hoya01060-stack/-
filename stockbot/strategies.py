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


def donchian_high(df: pd.DataFrame, period=20) -> pd.Series:
    """직전 period일(오늘 제외) 최고가."""
    return df["High"].rolling(period).max().shift(1)


def donchian_low(df: pd.DataFrame, period=10) -> pd.Series:
    """직전 period일(오늘 제외) 최저가."""
    return df["Low"].rolling(period).min().shift(1)


def high_breakout(df: pd.DataFrame, entry_period=20, **_) -> pd.Series:
    """2-4 매수: 종가가 최근 20일 최고가를 뚫은 날."""
    return (df["Close"] > donchian_high(df, entry_period)).fillna(False)


def low_breakdown(df: pd.DataFrame, exit_period=10, **_) -> pd.Series:
    """2-4 매도: 종가가 최근 10일 최저가를 깬 날 (장중 알림은 현재가 기준)."""
    return (df["Close"] < donchian_low(df, exit_period)).fillna(False)


def surge_hold(df: pd.DataFrame, surge_pct=20, surge_vol_mult=2.0, hold_days=3, hold_ratio=0.5,
               basis="low", require_pullback=True, rest_vol_mult=1.0, vol_base=20, **_) -> pd.DataFrame:
    """2-5 급등 후 절반 지지 매수.

    급등일(D): 전일 대비 +surge_pct% 이상 & 거래량 >= 직전 vol_base일 평균 x surge_vol_mult (주도주)
    지지선: 급등 전일 종가 + 급등폭 x hold_ratio (= 상승분의 절반)
    D+1 ~ D+hold_days 동안
      - 저가(basis=low) 또는 종가(basis=close)가 한 번도 지지선 아래로 안 내려감 (굳건히 지지)
      - require_pullback: 한 번이라도 급등일 종가 아래로 밀림 (= 차익 실현 물량이 실제로 나옴)
      - 평균 거래량 >= 급등 전 평균 x rest_vol_mult (매물이 나오는데도 버팀)
    → D+hold_days 종가에 signal=True. support=지지선.
    """
    c, l, v = df["Close"], df["Low"], df["Volume"]
    k = hold_days
    prev = c.shift(1)
    base_vol = v.shift(1).rolling(vol_base).mean()
    surge = ((c / prev - 1) >= surge_pct / 100) & (v >= surge_vol_mult * base_vol)
    s_close, s_prev = c.shift(k), prev.shift(k)
    support = s_prev + (s_close - s_prev) * hold_ratio
    floor = (l if basis == "low" else c).rolling(k).min()
    ok = surge.shift(k, fill_value=False) & (floor >= support)
    if require_pullback:
        ok &= l.rolling(k).min() < s_close
    if rest_vol_mult:
        ok &= v.rolling(k).mean() >= rest_vol_mult * base_vol.shift(k)
    return pd.DataFrame({"signal": ok.fillna(False).astype(bool), "support": support.where(ok)})


def surge_hold_progress(df: pd.DataFrame, surge_pct=20, surge_vol_mult=2.0, hold_days=3, hold_ratio=0.5,
                        basis="low", vol_base=20, **_) -> dict | None:
    """진행 중인 급등 종목: 급등 후 0~hold_days-1일째이고 아직 지지선을 지키는 중이면 정보 반환."""
    c, l, v = df["Close"], df["Low"], df["Volume"]
    n = len(df)
    for d in range(0, hold_days):          # d = 급등일로부터 지난 거래일 수 (0 = 오늘 급등)
        i = n - 1 - d
        if i < vol_base + 1:
            break
        prev = c.iloc[i - 1]
        base = v.iloc[i - vol_base:i].mean()
        if c.iloc[i] / prev - 1 >= surge_pct / 100 and v.iloc[i] >= surge_vol_mult * base:
            support = prev + (c.iloc[i] - prev) * hold_ratio
            after = (l if basis == "low" else c).iloc[i + 1:]
            if after.empty or after.min() >= support:
                lows = l.iloc[i + 1:]
                return {"support": float(support), "day": d, "surge_close": float(c.iloc[i]),
                        "surge_pct": float((c.iloc[i] / prev - 1) * 100),
                        "min_low": float(lows.min()) if len(lows) else None}
            return None
    return None


def updown_volume_ratio(df: pd.DataFrame, window=120) -> pd.Series:
    """오른 날 평균 거래량 / 내린 날 평균 거래량 (window일). 1보다 클수록 '오를 때 터지고 내릴 때 죽는' 패턴."""
    c, v = df["Close"], df["Volume"]
    chg = c.diff()
    up, dn = (chg > 0).astype(float), (chg < 0).astype(float)
    up_avg = (v * up).rolling(window).sum() / up.rolling(window).sum().replace(0, np.nan)
    dn_avg = (v * dn).rolling(window).sum() / dn.rolling(window).sum().replace(0, np.nan)
    return up_avg / dn_avg


def box_weight(ratio: float, min_ratio=1.3, strong_ratio=2.0, weight_min_pct=10, weight_max_pct=20, **_) -> float:
    """매집 강도(거래량 비율)에 따라 계좌 비중 10%~20% 사이로 결정."""
    if ratio != ratio or ratio <= min_ratio:
        return float(weight_min_pct)
    if ratio >= strong_ratio:
        return float(weight_max_pct)
    return weight_min_pct + (weight_max_pct - weight_min_pct) * (ratio - min_ratio) / (strong_ratio - min_ratio)


def box_range(df: pd.DataFrame, lookback=480, max_range_pct=50, max_net_change_pct=15, accum_window=120,
              min_ratio=1.3, fail_buffer_pct=3, **_) -> pd.DataFrame:
    """2-6 24개월 박스권 + 세력 매집 (해당 날짜 종가까지 기준 → 다음 날 돌파 감시용).

    - 박스: 최근 lookback 거래일(약 24개월) 종가 최고/최저 (꼬리 제외 위해 종가 사용)
    - 횡보: 최고/최저 폭 <= max_range_pct% 이고, 시작 대비 현재 등락 <= max_net_change_pct%
    - 매집: 최근 accum_window일 '오른 날 평균 거래량 / 내린 날 평균 거래량' >= min_ratio
    - 돌파 실패선 = 박스 상단 x (1 - fail_buffer_pct%)
    """
    c = df["Close"]
    top = c.rolling(lookback, min_periods=lookback).max()
    bottom = c.rolling(lookback, min_periods=lookback).min()
    net = (c / c.shift(lookback - 1) - 1).abs()
    ratio = updown_volume_ratio(df, accum_window)
    ok = ((top / bottom - 1 <= max_range_pct / 100) & (net <= max_net_change_pct / 100)
          & (ratio >= min_ratio)).fillna(False)
    return pd.DataFrame({"setup": ok, "top": top, "bottom": bottom, "ratio": ratio,
                         "fail": top * (1 - fail_buffer_pct / 100)})


def box_breakout(df: pd.DataFrame, **params) -> pd.DataFrame:
    """2-6 매수: 어제까지 박스권+매집이었고 오늘 종가가 박스 상단을 돌파. stop=돌파 실패선."""
    b = box_range(df, **params)
    prev = b.shift(1)
    sig = (prev["setup"].fillna(False).astype(bool) & (df["Close"] > prev["top"])).fillna(False)
    return pd.DataFrame({"signal": sig, "support": prev["fail"].where(sig), "top": prev["top"],
                         "ratio": prev["ratio"]})


def pullback_setup_at(h, l, c, v, e: int, lookback=60, min_pullback_days=5, surge_window=15, surge_pct=30,
                      surge_vol_mult=3.0, vol_base=50, dry_ratio=0.5, max_retrace=0.5, max_drawdown_pct=25,
                      **_) -> dict | None:
    """2-7 주도주 눌림 방어 (e일 종가 기준 → 다음 날 재돌파 감시용). numpy 배열을 받음.

    ① 급등: 고점(p) 이전 surge_window일 최저 종가 대비 고점 고가 +surge_pct% 이상,
            그 구간 최대 거래량 >= 급등 전 vol_base일 평균 x surge_vol_mult (거래량 폭발)
    ② 조정: 고점 이후 min_pullback_days일 이상, 고점을 넘지 않음
            조정 기간 평균 거래량 <= 급등 구간 평균 x dry_ratio (거래량 급감)
            조정 최저가 >= 고점 - 상승폭 x max_retrace, 고점 대비 낙폭 <= max_drawdown_pct% (가격 방어)
    반환: pivot(이전 고점), defense(조정 최저가), base, surge_vol, pullback_vol, days
    """
    start = max(e - lookback + 1, 0)
    p = start + int(np.argmax(h[start:e + 1]))
    days = e - p
    if days < min_pullback_days or p == start:   # p == start 면 진짜 고점이 탐색기간 밖일 수 있음
        return None
    s0 = p - surge_window
    if s0 - vol_base < 0:                        # 급등 전 평균 거래량을 계산할 데이터 부족
        return None
    base = float(np.min(c[s0:p]))
    peak = float(h[p])
    if base <= 0 or peak / base - 1 < surge_pct / 100:
        return None
    pre_vol = float(np.mean(v[s0 - vol_base:s0]))
    run_vol = v[s0:p + 1]
    if pre_vol <= 0 or float(np.max(run_vol)) < surge_vol_mult * pre_vol:
        return None
    pb_vol = float(np.mean(v[p + 1:e + 1]))
    if pb_vol > dry_ratio * float(np.mean(run_vol)):
        return None
    low = float(np.min(l[p + 1:e + 1]))
    if low < peak - (peak - base) * max_retrace or (peak - low) / peak > max_drawdown_pct / 100:
        return None
    return {"pivot": peak, "defense": low, "base": base, "surge_pct": (peak / base - 1) * 100,
            "surge_vol": float(np.mean(run_vol)), "pullback_vol": pb_vol, "days": days,
            "avg_vol": float(np.mean(v[e - vol_base + 1:e + 1]))}


def pullback_signal_at(h, l, c, v, t: int, breakout_vol_mult=1.5, min_close_strength=0.5, **params) -> dict | None:
    """2-7 매수 (t일 종가 기준): 어제까지 '급등 → 거래량 급감 조정 → 방어' 상태였고 오늘
    종가가 이전 고점을 넘고, 거래량 >= 최근 평균 x breakout_vol_mult, 종가가 당일 범위 상단(강한 돌파)."""
    if t < 1:
        return None
    st = pullback_setup_at(h, l, c, v, t - 1, **params)
    if not st or c[t] <= st["pivot"]:
        return None
    rng = h[t] - l[t]
    strength = (c[t] - l[t]) / rng if rng > 0 else 1.0
    if v[t] >= breakout_vol_mult * st["avg_vol"] and strength >= min_close_strength:
        return st
    return None


def pullback_breakout(df: pd.DataFrame, **params) -> pd.DataFrame:
    """pullback_signal_at 을 모든 날짜에 적용 (백테스트용)."""
    h, l, c, v = (df[k].to_numpy(float) for k in ("High", "Low", "Close", "Volume"))
    n = len(df)
    sig, sup = np.zeros(n, bool), np.full(n, np.nan)
    for t in range(1, n):
        st = pullback_signal_at(h, l, c, v, t, **params)
        if st:
            sig[t], sup[t] = True, st["defense"]
    return pd.DataFrame({"signal": sig, "support": sup}, index=df.index)


def base_range(df: pd.DataFrame, min_len=40, max_len=50, max_range_pct=15, vol_base=50, **_) -> pd.DataFrame:
    """2-8 8~10주 횡보(박스권) — 해당 날짜 종가까지 기준.

    최근 min_len 거래일(8주) 종가 최고/최저 폭이 max_range_pct% 이내면 박스권.
    top = 박스 상단(저항선, 최근 min_len일 최고 종가), avg_vol = 최근 vol_base일 평균 거래량(=평소 거래량)
    """
    c, v = df["Close"], df["Volume"]
    top = c.rolling(min_len).max()
    bottom = c.rolling(min_len).min()
    setup = ((top / bottom - 1) <= max_range_pct / 100).fillna(False)
    return pd.DataFrame({"setup": setup, "top": top, "bottom": bottom,
                         "avg_vol": v.rolling(vol_base).mean()})


def base_weeks(df: pd.DataFrame, min_len=40, max_len=50, max_range_pct=15, **_) -> float:
    """오늘 기준 박스가 몇 주째 이어졌는지 (min_len~max_len 범위에서 가장 긴 기간, 주 단위)."""
    c = df["Close"]
    best = 0
    for n in range(min_len, max_len + 1):
        w = c.iloc[-n:]
        if len(w) == n and w.max() / w.min() - 1 <= max_range_pct / 100:
            best = n
    return best / 5


def base_breakout(df: pd.DataFrame, vol_mult=3.0, min_close_strength=0.5, **params) -> pd.DataFrame:
    """2-8 매수: 어제까지 8주 이상 박스권이었고 오늘 종가가 박스 상단을 돌파,
    거래량 >= 평소(직전 50일 평균) x vol_mult, 종가가 당일 범위 상단(강한 돌파). stop = 박스 상단(돌파 가격)."""
    b = base_range(df, **params).shift(1)
    h, l, c = df["High"], df["Low"], df["Close"]
    rng = (h - l).replace(0, np.nan)
    strength = ((c - l) / rng).fillna(1.0)
    sig = (b["setup"].fillna(False).astype(bool) & (c > b["top"]) & (df["Volume"] >= vol_mult * b["avg_vol"])
           & (strength >= min_close_strength)).fillna(False)
    return pd.DataFrame({"signal": sig, "support": b["top"].where(sig)})


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
    take: float | None
    risk_pct: float = 0.0        # 손절 시 계좌 대비 손실률(%)


def account_stop(entry: float, qty: float, capital: float, account_risk_pct=2) -> float:
    """4-3 계좌 2% 손실 한도: 이 가격까지 떨어지면 손실이 계좌의 2%가 됨."""
    if qty <= 0:
        return 0.0
    return entry - capital * account_risk_pct / 100 / qty


def position_plan(price: float, capital: float, max_positions: int, stop_loss_pct=5, take_profit_pct=15,
                  stop_price: float | None = None, account_risk_pct=2, weight_pct: float | None = None) -> PositionPlan:
    """4-1 동일비중 매수 + 기계적 손절/익절, 4-3 계좌 2% 손실 한도.

    수량 = min(동일비중 수량, 계좌의 account_risk_pct% / 1주당 손절폭)
    손절가 = max(기법 손절가, 계좌 2% 손실 가격)  → 둘 중 먼저 닿는 가격에서 판다.
    stop_price 를 주면(예: 10일 최저가) 그것을 기법 손절가로, 없으면 -stop_loss_pct%.
    take_profit_pct=None 이면 익절가 없음.
    """
    stop = stop_price if stop_price is not None else price * (1 - stop_loss_pct / 100)
    amount = capital * weight_pct / 100 if weight_pct else capital / max(max_positions, 1)
    qty = int(amount // price) if price > 0 else 0
    per_share = price - stop
    if per_share > 0:
        qty = min(qty, int(capital * account_risk_pct / 100 // per_share))
    if qty > 0:
        stop = max(stop, account_stop(price, qty, capital, account_risk_pct))
    take = price * (1 + take_profit_pct / 100) if take_profit_pct is not None else None
    risk = (price - stop) * qty / capital * 100 if capital and qty else 0.0
    return PositionPlan(price, qty, qty * price, stop, take, risk)


def plan_for(cfg, market: str, price: float, mode: str = "fixed", exit_low: float | None = None,
             stop_price: float | None = None, weight_pct: float | None = None) -> PositionPlan:
    """설정값으로 매수 계획 산출. mode=turtle 이면 손절=10일 최저가, 익절 없음.
    stop_price 를 주면(예: 급등 후 절반 지지선) 그 가격을 기법 손절가로 사용."""
    r = cfg["risk"]
    if stop_price is None or stop_price >= price:
        stop_price = exit_low if mode == "turtle" and exit_low is not None and exit_low < price else None
    risk = cfg.strat("box")["max_account_loss_pct"] if mode == "box" else r.get("account_risk_pct", 2)
    return position_plan(price, cfg["capital"][market], cfg["max_positions"], r["stop_loss_pct"],
                         None if mode in ("turtle", "trend", "cycle", "box") else r["take_profit_pct"],
                         stop_price=stop_price, account_risk_pct=risk, weight_pct=weight_pct)


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
