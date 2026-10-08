"""장중 현재가 조회.

- KIS: 한국투자증권 Open API (REST). 실시간 시세. 계좌 개설 + API 신청 필요.
- yfinance: 키 없이 사용 가능하지만 지연 시세(특히 한국은 약 15~20분 지연)이며 비공식 API.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

from .data import yf_symbol

log = logging.getLogger(__name__)


@dataclass
class Quote:
    price: float
    high: float | None = None
    low: float | None = None
    volume: float | None = None
    change_pct: float | None = None
    source: str = ""


class KISClient:
    REAL = "https://openapi.koreainvestment.com:9443"
    PAPER = "https://openapivts.koreainvestment.com:29443"

    def __init__(self, app_key: str, app_secret: str, env: str, cache_dir: Path, rps: float = 8):
        self.key, self.secret = app_key, app_secret
        self.base = self.PAPER if env == "paper" else self.REAL
        self.token_file = Path(cache_dir) / "kis_token.json"
        self.min_gap = 1.0 / max(rps, 0.5)
        self._last = 0.0
        self._token = None
        self._excd: dict[str, str] = {}   # 미국 종목 거래소 코드 캐시
        excd_file = Path(cache_dir) / "kis_excd.json"
        self.excd_file = excd_file
        if excd_file.exists():
            self._excd = json.loads(excd_file.read_text())

    def _get_token(self) -> str:
        # 접근토큰은 발급 횟수 제한이 있으므로 파일에 저장해 재사용 (유효기간 약 24시간)
        if self._token:
            return self._token
        if self.token_file.exists():
            d = json.loads(self.token_file.read_text())
            if datetime.fromisoformat(d["expires"]) > datetime.now() + timedelta(minutes=10):
                self._token = d["token"]
                return self._token
        r = requests.post(f"{self.base}/oauth2/tokenP", timeout=10,
                          json={"grant_type": "client_credentials", "appkey": self.key, "appsecret": self.secret})
        r.raise_for_status()
        j = r.json()
        self._token = j["access_token"]
        exp = datetime.now() + timedelta(seconds=int(j.get("expires_in", 86400)))
        self.token_file.write_text(json.dumps({"token": self._token, "expires": exp.isoformat()}))
        return self._token

    def _get(self, path: str, tr_id: str, params: dict) -> dict:
        wait = self.min_gap - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()
        r = requests.get(f"{self.base}{path}", params=params, timeout=10, headers={
            "authorization": f"Bearer {self._get_token()}", "appkey": self.key, "appsecret": self.secret,
            "tr_id": tr_id, "custtype": "P", "content-type": "application/json; charset=utf-8"})
        r.raise_for_status()
        j = r.json()
        if j.get("rt_cd") not in (None, "0"):
            raise RuntimeError(f"KIS {tr_id}: {j.get('msg1')}")
        return j.get("output") or {}

    def kr_quote(self, code: str) -> Quote:
        o = self._get("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
                      {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code})
        return Quote(float(o["stck_prpr"]), float(o["stck_hgpr"]), float(o["stck_lwpr"]),
                     float(o["acml_vol"]), float(o["prdy_ctrt"]), "KIS")

    def us_quote(self, ticker: str) -> Quote:
        sym = ticker.replace("-", "/")  # KIS 는 BRK/B 형태
        order = [self._excd[ticker]] if ticker in self._excd else ["NAS", "NYS", "AMS"]
        for ex in order:
            o = self._get("/uapi/overseas-price/v1/quotations/price", "HHDFS00000300",
                          {"AUTH": "", "EXCD": ex, "SYMB": sym})
            if o.get("last") not in (None, "", "0", "0.0000"):
                if self._excd.get(ticker) != ex:
                    self._excd[ticker] = ex
                    self.excd_file.write_text(json.dumps(self._excd))
                return Quote(float(o["last"]), None, None, float(o.get("tvol") or 0),
                             float(o.get("rate") or 0), "KIS")
        raise RuntimeError(f"KIS 해외시세 없음: {ticker}")


def yf_quotes(market: str, tickers: list[str], kr_markets: dict[str, str] | None = None) -> dict[str, Quote]:
    import yfinance as yf

    kr_markets = kr_markets or {}
    sym = {t: yf_symbol(market, t, kr_markets.get(t)) for t in tickers}
    out: dict[str, Quote] = {}
    syms = list(sym.values())
    for i in range(0, len(syms), 100):
        raw = yf.download(syms[i:i + 100], period="1d", interval="1m", group_by="ticker",
                          progress=False, threads=True, auto_adjust=False)
        if raw is None or raw.empty:
            continue
        for t, s in sym.items():
            try:
                sub = raw[s] if isinstance(raw.columns, pd.MultiIndex) else raw
                sub = sub.dropna(subset=["Close"])
                if sub.empty:
                    continue
                out[t] = Quote(float(sub["Close"].iloc[-1]), float(sub["High"].max()), float(sub["Low"].min()),
                               float(sub["Volume"].sum()), None, "yfinance(지연)")
            except KeyError:
                continue
    return out


class QuoteProvider:
    def __init__(self, cfg):
        s = cfg.secrets
        mode = cfg["intraday"].get("provider", "auto")
        self.kis = None
        if mode in ("auto", "kis") and s.kis_app_key and s.kis_app_secret:
            self.kis = KISClient(s.kis_app_key, s.kis_app_secret, s.kis_env, cfg.data_dir,
                                 cfg["intraday"].get("kis_requests_per_sec", 8))
        elif mode == "kis":
            log.warning("provider=kis 이지만 KIS_APP_KEY/SECRET 이 없어 yfinance 로 대체합니다.")

    @property
    def name(self) -> str:
        return "한국투자증권(실시간)" if self.kis else "yfinance(지연 시세)"

    def quotes(self, market: str, tickers: list[str], kr_markets: dict[str, str] | None = None) -> dict[str, Quote]:
        if not tickers:
            return {}
        if not self.kis:
            return yf_quotes(market, tickers, kr_markets)
        out, failed = {}, []
        for t in tickers:
            try:
                out[t] = self.kis.kr_quote(t) if market == "KR" else self.kis.us_quote(t)
            except Exception as e:
                log.debug("KIS 시세 실패 %s: %s", t, e)
                failed.append(t)
        if failed:  # KIS 실패분은 yfinance 로 보완
            try:
                out.update(yf_quotes(market, failed, kr_markets))
            except Exception as e:
                log.warning("yfinance 보완 실패: %s", e)
        return out
