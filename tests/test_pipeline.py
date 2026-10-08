import numpy as np
import pandas as pd

from stockbot import briefing, screener
from stockbot.config import load_config
from stockbot.monitor import check_position, run_intraday
from stockbot.realtime import Quote
from stockbot.store import Store

from .test_strategies import make


class FakeTG:
    def __init__(self):
        self.sent = []

    def send(self, text, chat_id=None):
        self.sent.append(text)


class FakeProvider:
    name = "fake"

    def __init__(self, prices):
        self.prices = prices

    def quotes(self, market, tickers, kr=None):
        return {t: Quote(self.prices[t]) for t in tickers if t in self.prices}


def setup(tmp_path):
    cfg = load_config(tmp_path / "none.yaml")
    cfg.raw["data_dir"] = str(tmp_path)
    cfg.raw["briefing"]["use_llm"] = False
    store = Store(tmp_path / "t.db")
    n = 200
    vol = np.full(n, 1e6)
    # A: 급등 후 2일 휴식 (돌파 대기)
    a = make([10000] * (n - 7) + [10400, 10900, 11400, 12000, 12600] + [12500, 12400])
    # B: 고점 대비 하락 + 거래량 5일 연속 감소
    b_close = list(np.linspace(10000, 13000, n - 20)) + list(np.linspace(12900, 10000, 20))
    b_vol = list(vol[:-6]) + [9e5, 8e5, 7e5, 6e5, 5e5, 4e5]
    b = make(b_close, b_vol)
    # C: 평범한 상승 종목
    c = make(np.linspace(10000, 12000, n))
    prices = {"000010": a, "000020": b, "000030": c}
    uni = pd.DataFrame({"Ticker": list(prices), "Name": ["알파", "베타", "감마"], "Market": "KOSPI",
                        "Sector": ["철강", "철강", "조선"], "Marcap": None, "Shares": None})
    index = pd.Series(np.linspace(2500, 2700, n), index=a.index)
    return cfg, store, uni, prices, index


def test_scan_watch_intraday_and_brief(tmp_path):
    cfg, store, uni, prices, index = setup(tmp_path)
    res = screener.scan(cfg, store, "KR", uni, prices, index)
    setups = {h["ticker"] for h in res["hits"]["breakout_setup"]}
    dry = {h["ticker"] for h in res["hits"]["volume_dryup"]}
    assert "000010" in setups and "000020" in dry
    watch = store.watch("KR")
    assert {"000010", "000020"} <= set(watch)
    pivot = watch["000010"]["pivot"]

    # 장중: A가 pivot 돌파 → 매수 알림 1회 (두 번째 점검에서는 중복 발송 안 함)
    tg = FakeTG()
    prov = FakeProvider({"000010": pivot * 1.01, "000020": 10000})
    assert run_intraday(cfg, store, tg, prov, "KR") >= 1
    assert "매수 타이밍" in tg.sent[0] and "알파" in tg.sent[0] and "손절" in tg.sent[0]
    assert run_intraday(cfg, store, tg, prov, "KR") == 0

    # 브리핑 생성
    idx = {"KOSPI": index, "KOSDAQ": index * 0.3}
    stats = briefing.market_stats(prices, uni, 1000, 1e9)
    text = briefing.build(cfg, store, "KR", res, idx, stats, [], [])
    assert "일일 브리핑" in text and "시장 국면" in text and "거래량 급감" in text
    assert store.get("regime_KR")["state"] == "RISK_ON"


def test_position_rules(tmp_path):
    cfg = load_config(tmp_path / "none.yaml")
    base = {"market": "KR", "ticker": "000010", "name": "알파", "entry_price": 10000, "adds_done": 0}
    fixed = {**base, "mode": "fixed", "stop": 9500, "take": 11500}
    assert check_position(cfg, fixed, 9400, None)[0][0] == "stop"
    assert check_position(cfg, fixed, 11600, None)[0][0] == "take"
    assert check_position(cfg, fixed, 10500, None) == []
    trend = {**base, "mode": "trend", "stop": 9500, "take": None}
    w = {"sum9": 9 * 10800, "n9": 9, "close": 10800, "ma10": 10700}
    keys = [k for k, _, _ in check_position(cfg, trend, 10600, w)]
    assert "pyramid1" in keys and "ma10_break" in keys       # +6% 이지만 10일선(10780) 아래
    upd = next(u for k, _, u in check_position(cfg, trend, 10600, w) if k == "pyramid1")
    assert upd == {"adds_done": 1, "stop": 10000}            # 손절가를 본전으로


def test_buy_command(tmp_path, monkeypatch):
    from stockbot import app as A

    cfg = load_config(tmp_path / "none.yaml")
    cfg.raw["data_dir"] = str(tmp_path)
    monkeypatch.setattr(A, "QuoteProvider", lambda c: FakeProvider({}))
    app = A.App(cfg)
    app.tg = FakeTG()
    out = app.handle("/buy 005930 70,000")
    assert "등록" in out and "66,500원" in out
    out = app.handle("/buy NVDA 100 3 trend")
    assert "$95.00" in out
    assert len(app.store.positions()) == 2
    assert "삼성" not in app.handle("/pos") and "NVDA" in app.handle("/pos")
    assert "1건 종료" in app.handle("/sell 005930")
    assert A.market_of("0001A0") == "KR" and A.market_of("AAPL") == "US"
