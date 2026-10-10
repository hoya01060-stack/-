import numpy as np
import pytest
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


def test_turtle_intraday_and_exit(tmp_path):
    cfg, store, uni, prices, index = setup(tmp_path)
    screener.scan(cfg, store, "KR", uni, prices, index)
    w = store.watch("KR")
    assert "high20" in w["000010"] and "low10" in w["000010"]
    tg = FakeTG()
    # C(감마)는 꾸준히 상승 → 20일 신고가 임박 목록 → 장중 돌파 시 알림
    assert "000030" in w and "high20_near" in w["000030"]["sources"]
    run_intraday(cfg, store, tg, FakeProvider({"000030": w["000030"]["high20"] * 1.005}), "KR")
    assert any("20일 최고가" in m and "turtle" in m for m in tg.sent)
    pos = {"market": "KR", "ticker": "000030", "name": "감마", "entry_price": 12000, "adds_done": 0,
           "mode": "turtle", "stop": 9000, "take": None}
    keys = [k for k, _, _ in check_position(cfg, pos, w["000030"]["low10"] * 0.99, w["000030"])]
    assert keys == ["low10_break"]


def test_buy_two_percent_warning(tmp_path, monkeypatch):
    from stockbot import app as A

    cfg = load_config(tmp_path / "none.yaml")
    cfg.raw["data_dir"] = str(tmp_path)
    monkeypatch.setattr(A, "QuoteProvider", lambda c: FakeProvider({}))
    app = A.App(cfg)
    out = app.handle("/buy 005930 10000 500")       # 500만원어치: -5%면 계좌 -2.5% → 2% 한도가 먼저
    assert "9,600원" in out and "먼저 옵니다" in out and "-2.0%" in out
    out = app.handle("/buy 000660 10000 50 turtle")
    assert "최저가" in out


def test_surge_hold_intraday(tmp_path):
    from stockbot.monitor import check_surge_hold

    cfg = load_config(tmp_path / "none.yaml")
    w = {"name": "급등주", "half_support": 112.5, "surge_day": 2, "surge_close": 125, "min_low_since": 114.8,
         "sources": ["surge_hold"]}
    ok = check_surge_hold(cfg, "KR", "123450", w, Quote(119, 121, 117), closing=True)
    assert ok[0][0] == "surge_hold_buy" and "stop=" in ok[0][1] and "절반" in ok[0][1]
    assert check_surge_hold(cfg, "KR", "123450", w, Quote(119, 121, 117), closing=False) == []
    broken = check_surge_hold(cfg, "KR", "123450", w, Quote(113, 118, 111), closing=False)
    assert broken[0][0] == "half_broken"


def test_scan_finds_surge_hold(tmp_path):
    cfg, store, uni, prices, index = setup(tmp_path)
    n = 200
    close = [10000] * (n - 4) + [12500, 12000, 11600, 11900]
    vol = [1e6] * (n - 4) + [3e6, 1.5e6, 1.5e6, 1.5e6]
    prices["000040"] = make(close, vol)
    uni = pd.concat([uni, pd.DataFrame({"Ticker": ["000040"], "Name": ["델타"], "Market": "KOSPI",
                                        "Sector": ["조선"], "Marcap": None, "Shares": None})])
    res = screener.scan(cfg, store, "KR", uni, prices, index)
    rec = next(r for r in res["recommendations"] if r["ticker"] == "000040")
    assert rec["method_stop"] == 11250 and rec["stop"] == 11250 and "절반 지지" in rec["signals"][0]
    assert store.watch("KR")["000040"]["half_support"] == 11250


def test_buy_with_explicit_stop(tmp_path, monkeypatch):
    from stockbot import app as A

    cfg = load_config(tmp_path / "none.yaml")
    cfg.raw["data_dir"] = str(tmp_path)
    monkeypatch.setattr(A, "QuoteProvider", lambda c: FakeProvider({}))
    app = A.App(cfg)
    out = app.handle("/buy 000040 11900 stop=11250")
    pos = app.store.positions()[0]
    assert pos["stop"] == 11250 and "11,250원" in out
    assert "낮아야" in app.handle("/buy 000040 11900 stop=12000")


def test_box_scan_intraday_and_stop(tmp_path):
    from .test_strategies import _box

    cfg, store, uni, prices, index = setup(tmp_path)
    prices["000050"] = _box(last=10900)                       # 박스 상단(11,000) 근처, 아직 돌파 전
    prices["000060"] = _box(last=11500)                       # 오늘 박스 돌파
    idx = pd.Series(np.linspace(2500, 2700, 520), index=prices["000050"].index)
    uni = pd.concat([uni, pd.DataFrame({"Ticker": ["000050", "000060"], "Name": ["박스A", "박스B"],
                                        "Market": "KOSPI", "Sector": ["화학", "화학"], "Marcap": None, "Shares": None})])
    res = screener.scan(cfg, store, "KR", uni, prices, idx)
    rec = next(r for r in res["recommendations"] if r["ticker"] == "000060")
    assert rec["mode"] == "box" and rec["amount"] / 10_000_000 == pytest.approx(0.2, abs=0.01)
    assert rec["risk_pct"] <= 2.0
    w = store.watch("KR")["000050"]
    assert w["box_top"] == pytest.approx(11000, rel=1e-3) and 10 <= w["box_weight"] <= 20

    tg = FakeTG()
    run_intraday(cfg, store, tg, FakeProvider({"000050": 11100}), "KR")
    msg = next(m for m in tg.sent if "박스권" in m)
    assert msg.count("매수 타이밍") == 1                     # 박스 돌파와 20일 신고가 중복 알림 없음
    assert "계좌의 2" in msg or "계좌의 1" in msg
    assert "/buy 000050 11100" in msg and "box" in msg

    pos = {"market": "KR", "ticker": "000050", "name": "박스A", "entry_price": 11100, "qty": 170, "adds_done": 0,
           "mode": "box", "stop": 10670, "take": None}
    out = check_position(cfg, pos, 10650, w)
    assert out[0][0] == "stop" and "돌파 실패" in out[0][1]


def test_buy_box_mode_uses_watch(tmp_path, monkeypatch):
    from stockbot import app as A

    cfg = load_config(tmp_path / "none.yaml")
    cfg.raw["data_dir"] = str(tmp_path)
    monkeypatch.setattr(A, "QuoteProvider", lambda c: FakeProvider({}))
    app = A.App(cfg)
    app.store.replace_watch("KR", {"000050": {"name": "박스A", "sources": ["box_accum"], "box_top": 11000,
                                              "box_fail": 10670, "box_weight": 20, "box_ratio": 2.0}})
    out = app.handle("/buy 000050 11100 box")
    pos = app.store.positions()[0]
    assert pos["mode"] == "box" and pos["stop"] == 10670 and pos["qty"] == 180     # 계좌 20% = 200만원 / 11,100
    assert "돌파 실패" in out


def test_box_mode_low10_exit(tmp_path):
    cfg = load_config(tmp_path / "none.yaml")
    w = {"low10": 12000, "box_fail": 10670}
    pos = {"market": "KR", "ticker": "000050", "name": "박스A", "entry_price": 11100, "qty": 180, "adds_done": 0,
           "mode": "box", "stop": 10670, "take": None}
    assert [k for k, _, _ in check_position(cfg, pos, 11900, w)] == ["low10_break"]   # 상승 후 10일 최저가 이탈
    assert [k for k, _, _ in check_position(cfg, pos, 10600, w)] == ["stop"]          # 돌파 실패선이 먼저
    assert check_position(cfg, pos, 12500, w) == []


def test_pullback_scan_and_intraday(tmp_path, monkeypatch):
    from stockbot import monitor
    from .test_strategies import _leader

    cfg, store, uni, prices, index = setup(tmp_path)
    ready = _leader().iloc[:-1].copy()                             # 돌파 전날까지 = 눌림 방어 상태
    ready[["Open", "High", "Low", "Close"]] *= 100                 # 1,000원 이상 (유동성 필터 통과)
    prices["000070"] = ready
    uni = pd.concat([uni, pd.DataFrame({"Ticker": ["000070"], "Name": ["리더"], "Market": "KOSPI",
                                        "Sector": ["반도체"], "Marcap": None, "Shares": None})])
    res = screener.scan(cfg, store, "KR", uni, prices, index)
    assert any(h["ticker"] == "000070" for h in res["hits"]["pullback"])
    w = store.watch("KR")["000070"]
    assert w["pb_pivot"] == pytest.approx(14140) and w["pb_defense"] == pytest.approx(12375)

    monkeypatch.setattr(monitor, "session_fraction", lambda m, now=None: 0.5)
    tg = FakeTG()

    class P(FakeProvider):
        def quotes(self, market, tickers, kr=None):
            return {"000070": Quote(14300, 14350, 14100, volume=self.prices["vol"])}

    run_intraday(cfg, store, tg, P({"vol": 5e5}), "KR")              # 반나절 50만주 → 하루 100만주 추정: 부족
    assert not any("주도주 눌림(조정" in m for m in tg.sent)
    run_intraday(cfg, store, tg, P({"vol": 1.5e6}), "KR")            # 하루 300만주 추정: 거래량 붙음
    msg = next(m for m in tg.sent if "주도주 눌림(조정" in m)
    assert "조정 최저가(방어선)" in msg and "stop=" in msg and msg.count("매수 타이밍") == 1


def test_base_scan_intraday_and_stop(tmp_path, monkeypatch):
    from stockbot import monitor
    from .test_strategies import _base

    cfg, store, uni, prices, index = setup(tmp_path)
    prices["000080"] = _base(n=83).iloc[:-1]                       # 돌파 전날까지 10주 횡보, 상단 근처에서 마감
    uni = pd.concat([uni, pd.DataFrame({"Ticker": ["000080"], "Name": ["횡보주"], "Market": "KOSPI",
                                        "Sector": ["기계"], "Marcap": None, "Shares": None})])
    res = screener.scan(cfg, store, "KR", uni, prices, index)
    assert any(h["ticker"] == "000080" for h in res["hits"]["base"])
    w = store.watch("KR")["000080"]
    top = w["base_top"]
    assert w["base_weeks"] == 10

    monkeypatch.setattr(monitor, "session_fraction", lambda m, now=None: 0.5)

    class P(FakeProvider):
        def quotes(self, market, tickers, kr=None):
            return {"000080": Quote(top * 1.01, top * 1.012, top * 0.99, volume=self.prices["vol"])}

    tg = FakeTG()
    run_intraday(cfg, store, tg, P({"vol": 1.0e6}), "KR")           # 하루 200만주 추정 → 3배 미달
    assert not any("횡보 박스권 상단" in m for m in tg.sent)
    run_intraday(cfg, store, tg, P({"vol": 2.0e6}), "KR")           # 하루 400만주 추정 → 3배 이상
    msg = next(m for m in tg.sent if "횡보 박스권 상단" in m)
    assert "돌파 가격(박스 상단)" in msg and msg.count("매수 타이밍") == 1

    pos = {"market": "KR", "ticker": "000080", "name": "횡보주", "entry_price": top * 1.01, "qty": 90,
           "adds_done": 0, "mode": "fixed", "stop": top, "take": top * 1.01 * 1.15}
    assert check_position(cfg, pos, top * 0.999, w)[0][0] == "stop"   # 돌파 가격 아래로 → 즉시 매도
