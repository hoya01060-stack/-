"""종목 목록과 일봉 데이터 수집 (캐시 포함).

- 한국: FinanceDataReader (종목목록: KRX, 일봉: 네이버 금융)
- 미국: FinanceDataReader (S&P500 목록: 위키백과) + yfinance (일봉)
- 지수/환율/금: yfinance
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

log = logging.getLogger(__name__)

OHLCV = ["Open", "High", "Low", "Close", "Volume"]

INDEX_SYMBOLS = {
    "KR": {"KOSPI": "^KS11", "KOSDAQ": "^KQ11"},
    "US": {"S&P500": "^GSPC", "NASDAQ": "^IXIC"},
}
PRIMARY_INDEX = {"KR": "KOSPI", "US": "S&P500"}
MACRO_SYMBOLS = {"USD/KRW": "KRW=X", "금(Gold)": "GC=F", "달러인덱스": "DX-Y.NYB",
                 "美10년물(%)": "^TNX", "VIX": "^VIX", "WTI": "CL=F"}
# 위키백과 S&P500 목록은 '.'를 제거해서 주므로 yfinance 표기로 되돌림
_US_FIX = {"BRKB": "BRK-B", "BFB": "BF-B"}


def yf_symbol(market: str, ticker: str, kr_market: str | None = None) -> str:
    if market == "KR":
        return f"{ticker}.KQ" if kr_market == "KOSDAQ" else f"{ticker}.KS"
    return _US_FIX.get(ticker, ticker).replace(".", "-")


# ---------------------------------------------------------------------------
# 종목 목록
# ---------------------------------------------------------------------------

def load_universe(market: str, cfg, cache_dir: Path) -> pd.DataFrame:
    """columns: Ticker, Name, Market, Sector, Marcap, Shares"""
    cache = cache_dir / f"universe_{market}.pkl"
    try:
        df = _fetch_universe(market, cfg)
        df.to_pickle(cache)
        return df
    except Exception as e:  # 네트워크 장애 시 마지막 캐시 사용
        if cache.exists():
            log.warning("종목목록 수집 실패(%s) → 캐시 사용: %s", market, e)
            return pd.read_pickle(cache)
        raise


def _fetch_universe(market: str, cfg) -> pd.DataFrame:
    import FinanceDataReader as fdr

    ucfg = cfg["universe"][market]
    if market == "KR":
        lst = fdr.StockListing("KRX")
        lst = lst[lst["Market"].isin(ucfg.get("markets", ["KOSPI", "KOSDAQ"]))]
        try:
            desc = fdr.StockListing("KRX-DESC")[["Code", "Sector"]]
            lst = lst.merge(desc, on="Code", how="left")
        except Exception as e:
            log.warning("업종 정보 수집 실패: %s", e)
            lst["Sector"] = None
        if ucfg.get("exclude_preferred", True):
            lst = lst[lst["Code"].str[-1] == "0"]
        if ucfg.get("exclude_spac", True):
            lst = lst[~lst["Name"].str.contains("스팩")]
        out = pd.DataFrame({
            "Ticker": lst["Code"], "Name": lst["Name"], "Market": lst["Market"],
            "Sector": lst.get("Sector"), "Marcap": lst.get("Marcap"), "Shares": lst.get("Stocks"),
        })
    else:
        src = ucfg.get("source", "SP500").upper()
        if src in ("SP500", "S&P500"):
            lst = fdr.StockListing("S&P500")
            out = pd.DataFrame({"Ticker": lst["Symbol"].map(lambda s: _US_FIX.get(s, s)), "Name": lst["Name"],
                                "Market": "US", "Sector": lst["Sector"], "Industry": lst.get("Industry")})
        else:
            lst = fdr.StockListing(src)
            out = pd.DataFrame({"Ticker": lst["Symbol"], "Name": lst["Name"], "Market": src,
                                "Sector": lst.get("Industry")})
        extra = [t for t in ucfg.get("extra_tickers", []) if t not in set(out["Ticker"])]
        if extra:
            out = pd.concat([out, pd.DataFrame({"Ticker": extra, "Name": extra, "Market": "US"})])
        out["Marcap"], out["Shares"] = None, None
    return out.dropna(subset=["Ticker"]).drop_duplicates("Ticker").reset_index(drop=True)


# ---------------------------------------------------------------------------
# 일봉
# ---------------------------------------------------------------------------

def _clean(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=OHLCV)
    df = df[[c for c in OHLCV if c in df.columns]].copy()
    df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df.dropna(subset=["Close"])
    return df[(df["Close"] > 0)].astype(float)


def _fetch_kr_daily(ticker: str, start: date) -> pd.DataFrame:
    import FinanceDataReader as fdr

    return _clean(fdr.DataReader(ticker, start.isoformat()))


def _fetch_yf_daily(symbols: list[str], start: date) -> dict[str, pd.DataFrame]:
    import yfinance as yf

    out = {}
    for i in range(0, len(symbols), 100):
        chunk = symbols[i:i + 100]
        raw = yf.download(chunk, start=start.isoformat(), auto_adjust=True, group_by="ticker",
                          progress=False, threads=True)
        if raw is None or raw.empty:
            continue
        for s in chunk:
            try:
                sub = raw[s] if isinstance(raw.columns, pd.MultiIndex) else raw
                out[s] = _clean(sub)
            except KeyError:
                pass
    return out


class PriceStore:
    """종목별 일봉을 pickle로 캐시하고, 실행 때마다 최근 구간만 추가로 받아 갱신."""

    def __init__(self, data_dir: Path, history_days: int = 800):
        self.dir = Path(data_dir) / "prices"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.history_days = history_days

    def _path(self, market: str, ticker: str) -> Path:
        d = self.dir / market
        d.mkdir(exist_ok=True)
        return d / f"{ticker.replace('/', '_').replace('^', '_')}.pkl"

    def load(self, market: str, ticker: str) -> pd.DataFrame | None:
        p = self._path(market, ticker)
        return pd.read_pickle(p) if p.exists() else None

    def save(self, market: str, ticker: str, df: pd.DataFrame):
        cutoff = pd.Timestamp(date.today() - timedelta(days=int(self.history_days * 1.6)))
        df[df.index >= cutoff].to_pickle(self._path(market, ticker))

    def _start_for(self, old: pd.DataFrame | None) -> date:
        full = date.today() - timedelta(days=int(self.history_days * 1.5))
        # 캐시가 없거나, 보관기간을 늘려서 과거 데이터가 모자라면 처음부터 다시 받음
        if old is None or old.empty or old.index[0].date() > full + timedelta(days=60):
            return full
        return (old.index[-1] - timedelta(days=7)).date()

    def _merge(self, old, new):
        if old is None or old.empty or (new is not None and not new.empty and new.index[0] <= old.index[0]):
            return new
        if new is None or new.empty:
            return old
        return pd.concat([old[old.index < new.index[0]], new])

    def update(self, market: str, universe: pd.DataFrame, workers: int = 8) -> dict[str, pd.DataFrame]:
        """universe 전체의 일봉 갱신 후 {ticker: df} 반환."""
        tickers = list(universe["Ticker"])
        olds = {t: self.load(market, t) for t in tickers}
        result: dict[str, pd.DataFrame] = {}
        if market == "KR":
            def job(t):
                return t, _fetch_kr_daily(t, self._start_for(olds[t]))

            with ThreadPoolExecutor(workers) as ex:
                futs = [ex.submit(job, t) for t in tickers]
                for f in as_completed(futs):
                    try:
                        t, new = f.result()
                        result[t] = self._merge(olds[t], new)
                    except Exception as e:
                        log.debug("일봉 실패: %s", e)
        else:
            groups: dict[date, list[str]] = {}
            for t in tickers:
                groups.setdefault(self._start_for(olds[t]), []).append(t)
            for start, ts in groups.items():
                fetched = _fetch_yf_daily([yf_symbol("US", t) for t in ts], start)
                for t in ts:
                    new = fetched.get(yf_symbol("US", t))
                    result[t] = self._merge(olds[t], new)
        for t, df in list(result.items()):
            if df is None or df.empty:
                result.pop(t)
                continue
            self.save(market, t, df)
        failed = len(tickers) - len(result)
        if failed:
            log.warning("%s 일봉 수집 실패 %d/%d 종목 (캐시가 있으면 캐시 사용)", market, failed, len(tickers))
            for t in tickers:
                if t not in result and olds[t] is not None:
                    result[t] = olds[t]
        return result


def fetch_series(symbol: str, days: int = 400) -> pd.Series:
    """yfinance 심볼의 종가 시계열 (지수/환율/금)."""
    import yfinance as yf

    df = yf.download(symbol, start=(date.today() - timedelta(days=days)).isoformat(),
                     auto_adjust=True, progress=False)
    if df is None or df.empty:
        return pd.Series(dtype=float)
    close = df["Close"]
    if isinstance(close, pd.DataFrame):
        close = close.iloc[:, 0]
    close.index = pd.to_datetime(close.index).tz_localize(None).normalize()
    return close.dropna().astype(float)


def fetch_index(market: str, name: str | None = None, days: int = 600) -> pd.Series:
    name = name or PRIMARY_INDEX[market]
    s = fetch_series(INDEX_SYMBOLS[market][name], days)
    if s.empty and market == "KR":  # yfinance 실패 시 FDR(KRX) 시도
        try:
            import FinanceDataReader as fdr

            sym = "KS11" if name == "KOSPI" else "KQ11"
            s = _clean(fdr.DataReader(sym, (date.today() - timedelta(days=days)).isoformat()))["Close"]
        except Exception as e:
            log.warning("지수 수집 실패 %s: %s", name, e)
    return s


def liquid(df: pd.DataFrame, min_price: float, min_avg_value: float) -> bool:
    if df is None or len(df) < 60:
        return False
    last = df.iloc[-20:]
    return float(last["Close"].iloc[-1]) >= min_price and float((last["Close"] * last["Volume"]).mean()) >= min_avg_value
