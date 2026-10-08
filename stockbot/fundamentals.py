"""사이클주(기법 3)용 연간 재무 데이터 수집. 주 1회 갱신 후 JSON 캐시.

- 한국: DART Open API '다중회사 주요계정'(fnlttMultiAcnt, 100개사씩 조회)
  * EPS는 '당기순이익 / 현재 상장주식수'로 근사합니다 (과거 증자·감자, 지배/비지배 구분 미반영).
- 미국: yfinance 연간 손익계산서 (최근 약 4년치만 제공 → '과거 전성기 EPS' 범위가 짧음)
"""
from __future__ import annotations

import io
import json
import logging
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import date
from pathlib import Path

import requests

log = logging.getLogger(__name__)
DART = "https://opendart.fss.or.kr/api"


def latest_fiscal_year(today: date | None = None) -> int:
    """사업보고서는 보통 3월 말까지 공시 → 4월부터 전년도 확정치 사용."""
    today = today or date.today()
    return today.year - 1 if today.month >= 4 else today.year - 2


def _num(s) -> float | None:
    if s is None:
        return None
    s = str(s).replace(",", "").strip()
    if s in ("", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# 한국 (DART)
# ---------------------------------------------------------------------------

def dart_corp_codes(api_key: str) -> dict[str, str]:
    """종목코드(6자리) -> DART 고유번호(8자리)."""
    r = requests.get(f"{DART}/corpCode.xml", params={"crtfc_key": api_key}, timeout=60)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        root = ET.fromstring(z.read(z.namelist()[0]))
    out = {}
    for el in root.iter("list"):
        sc = (el.findtext("stock_code") or "").strip()
        if sc:
            out[sc] = el.findtext("corp_code").strip()
    return out


ACCOUNTS = {"매출액": "revenue", "수익(매출액)": "revenue", "영업이익": "operating",
            "영업이익(손실)": "operating", "당기순이익": "net", "당기순이익(손실)": "net"}


def fetch_kr(api_key: str, tickers: list[str], shares: dict[str, float], years: int = 8) -> dict[str, dict]:
    codes = dart_corp_codes(api_key)
    pairs = [(t, codes[t]) for t in tickers if t in codes]
    by_corp = {c: t for t, c in pairs}
    data: dict[str, dict] = {t: {"revenue": {}, "operating": {}, "net": {}, "eps": {}} for t, _ in pairs}
    last = latest_fiscal_year()
    for year in range(last - years + 1, last + 1):
        for i in range(0, len(pairs), 100):
            chunk = ",".join(c for _, c in pairs[i:i + 100])
            try:
                r = requests.get(f"{DART}/fnlttMultiAcnt.json", timeout=30, params={
                    "crtfc_key": api_key, "corp_code": chunk, "bsns_year": str(year), "reprt_code": "11011"})
                j = r.json()
            except Exception as e:
                log.warning("DART 조회 실패 %s: %s", year, e)
                continue
            if j.get("status") != "000":
                if j.get("status") not in ("013",):  # 013 = 데이터 없음
                    log.warning("DART %s: %s", year, j.get("message"))
                continue
            # 연결재무제표(CFS) 우선, 없으면 별도(OFS)
            picked: dict[tuple, tuple] = {}
            for row in j.get("list", []):
                key = ACCOUNTS.get(row.get("account_nm", "").strip())
                t = by_corp.get(row.get("corp_code"))
                if not key or not t:
                    continue
                prio = 0 if row.get("fs_div") == "CFS" else 1
                k = (t, key)
                if k not in picked or prio < picked[k][0]:
                    picked[k] = (prio, _num(row.get("thstrm_amount")))
            for (t, key), (_, v) in picked.items():
                if v is not None:
                    data[t][key][year] = v
            time.sleep(0.2)
    for t, d in data.items():
        sh = shares.get(t)
        if sh:
            d["eps"] = {y: v / sh for y, v in d["net"].items()}
    return data


# ---------------------------------------------------------------------------
# 미국 (yfinance)
# ---------------------------------------------------------------------------

def _row(df, names):
    for n in names:
        if n in df.index:
            return df.loc[n]
    return None


def fetch_us(tickers: list[str]) -> dict[str, dict]:
    import yfinance as yf

    from .data import yf_symbol

    out = {}
    for t in tickers:
        try:
            tk = yf.Ticker(yf_symbol("US", t))
            inc = tk.income_stmt
            if inc is None or inc.empty:
                continue
            d = {}
            for key, names in {"revenue": ["Total Revenue", "Operating Revenue"],
                               "operating": ["Operating Income", "EBIT"],
                               "net": ["Net Income", "Net Income Common Stockholders"],
                               "eps": ["Diluted EPS", "Basic EPS"]}.items():
                row = _row(inc, names)
                d[key] = {} if row is None else {int(c.year): float(v) for c, v in row.items() if v == v}
            try:
                d["market_cap"] = float(tk.fast_info["marketCap"])
            except Exception:
                d["market_cap"] = None
            out[t] = d
            time.sleep(0.3)
        except Exception as e:
            log.debug("yfinance 재무 실패 %s: %s", t, e)
    return out


# ---------------------------------------------------------------------------
# 캐시
# ---------------------------------------------------------------------------

def cache_path(data_dir: Path, market: str) -> Path:
    return Path(data_dir) / f"fundamentals_{market}.json"


def save(data_dir: Path, market: str, data: dict):
    cache_path(data_dir, market).write_text(json.dumps({"updated": date.today().isoformat(), "data": data},
                                                       ensure_ascii=False))


def load(data_dir: Path, market: str) -> dict:
    p = cache_path(data_dir, market)
    if not p.exists():
        return {}
    raw = json.loads(p.read_text())["data"]
    # JSON 키(연도)가 문자열이 되므로 정수로 복원
    return {t: {k: ({int(y): v for y, v in vals.items()} if isinstance(vals, dict) else vals)
                for k, vals in d.items()} for t, d in raw.items()}


def refresh(cfg, market: str, universe) -> int:
    years = cfg.strat("cycle").get("history_years", 8)
    if market == "KR":
        if not cfg.secrets.dart_api_key:
            log.warning("DART_API_KEY 없음 → 국내 사이클주 스크리닝 생략")
            return 0
        shares = dict(zip(universe["Ticker"], universe["Shares"]))
        data = fetch_kr(cfg.secrets.dart_api_key, list(universe["Ticker"]), shares, years)
    else:
        data = fetch_us(list(universe["Ticker"]))
    save(cfg.data_dir, market, data)
    return len(data)
