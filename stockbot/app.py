"""작업(스캔·브리핑·장중감시·재무갱신), 텔레그램 명령, 스케줄러."""
from __future__ import annotations

import logging
import threading
from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

from . import briefing, fundamentals, screener
from . import data as D
from . import strategies as S
from .monitor import fmt_price, run_intraday
from .notifier import Telegram, esc
from .realtime import QuoteProvider
from .store import Store

log = logging.getLogger(__name__)
TZ = {"KR": ZoneInfo("Asia/Seoul"), "US": ZoneInfo("America/New_York")}
CAL = {"KR": "XKRX", "US": "XNYS"}


def is_trading_day(market: str, now: datetime | None = None) -> bool:
    now = now or datetime.now(TZ[market])
    try:
        import exchange_calendars as xc

        return bool(xc.get_calendar(CAL[market]).is_session(now.date().isoformat()))
    except Exception:  # 달력 범위 밖 등 → 평일 여부로 판단
        return now.weekday() < 5


class App:
    def __init__(self, cfg):
        self.cfg = cfg
        self.store = Store(cfg.data_dir / "stockbot.db")
        self.tg = Telegram(cfg.secrets.telegram_token, cfg.secrets.telegram_chat_id)
        self.prices = D.PriceStore(cfg.data_dir, cfg.get("history_days", 400))
        self.provider = QuoteProvider(cfg)
        self._lock = threading.Lock()   # 무거운 작업 동시 실행 방지

    # ------------------------------------------------------------------
    def daily(self, market: str, send=True) -> str:
        """장 마감 후: 데이터 갱신 → 기법 스캔 → 감시목록 저장 → 브리핑 발송."""
        with self._lock:
            ucfg = self.cfg["universe"][market]
            uni = D.load_universe(market, self.cfg, self.cfg.data_dir)
            prices = self.prices.update(market, uni)
            idx = {name: D.fetch_index(market, name) for name in D.INDEX_SYMBOLS[market]}
            result = screener.scan(self.cfg, self.store, market, uni, prices, idx[D.PRIMARY_INDEX[market]])
            stats = briefing.market_stats(prices, uni, ucfg["min_price"], ucfg["min_avg_value"])
            text = briefing.build(self.cfg, self.store, market, result, idx, stats, briefing.macro_summary(),
                                  briefing.positions_summary(self.store, market, prices))
        if send:
            self.tg.send(text)
        return text

    def intraday(self, market: str, force=False) -> int:
        if not force:
            now = datetime.now(TZ[market])
            sch = self.cfg["schedule"][market]
            start, end = (dtime.fromisoformat(sch["intraday_start"]), dtime.fromisoformat(sch["intraday_end"]))
            if not (is_trading_day(market, now) and start <= now.time() <= end):
                return 0
        return run_intraday(self.cfg, self.store, self.tg, self.provider, market)

    def refresh_fundamentals(self):
        for m in self.cfg["markets"]:
            try:
                uni = D.load_universe(m, self.cfg, self.cfg.data_dir)
                n = fundamentals.refresh(self.cfg, m, uni)
                log.info("%s 재무데이터 %d종목 갱신", m, n)
            except Exception:
                log.exception("%s 재무데이터 갱신 실패", m)

    # ------------------------------------------------------------------
    def handle(self, text: str) -> str | None:
        parts = text.split()
        cmd, args = parts[0].split("@")[0].lower(), parts[1:]
        if cmd in ("/start", "/help"):
            return HELP
        if cmd == "/buy":
            return self._buy(args)
        if cmd == "/sell":
            if not args:
                return "사용법: /sell 종목코드 [매도가]"
            t = args[0].upper()
            m = market_of(t)
            n = self.store.close_position(m, t, float(args[1]) if len(args) > 1 else None)
            return f"{t} 포지션 {n}건 종료" if n else f"{t} 보유 기록 없음"
        if cmd == "/pos":
            rows = self.store.positions()
            if not rows:
                return "보유 종목 없음"
            return "\n".join(f"• {esc(p['name'])}({p['ticker']}) {fmt_price(p['market'], p['entry_price'])} x{p['qty']:g} "
                             f"[{p['mode']}] 손절 {fmt_price(p['market'], p['stop'])} 목표 {fmt_price(p['market'], p['take'])}"
                             for p in rows)
        if cmd == "/watch":
            m = (args[0].upper() if args else "KR")
            w = self.store.watch(m)
            if not w:
                return f"{m} 감시목록 없음 (장 마감 스캔 후 생성)"
            return f"{m} 감시 {len(w)}종목\n" + "\n".join(
                f"• {esc(v['name'])}({t}) {'/'.join(screener.LABEL.get(s, s) for s in v['sources'])}"
                for t, v in list(w.items())[:40])
        if cmd in ("/scan", "/brief"):
            m = (args[0].upper() if args else "KR")
            if m not in ("KR", "US"):
                return "KR 또는 US"
            threading.Thread(target=self._safe, args=(self.daily, m), daemon=True).start()
            return f"{m} 스캔·브리핑을 시작합니다. 몇 분 걸립니다."
        if cmd == "/check":
            m = (args[0].upper() if args else "KR")
            n = self.intraday(m, force=True)
            return f"{m} 즉시 점검 완료: 알림 {n}건"
        return "알 수 없는 명령입니다. /help"

    def _buy(self, args) -> str:
        if len(args) < 2:
            return "사용법: /buy 종목코드 매수가 [수량] [fixed|trend|cycle]"
        t, price = args[0].upper(), float(args[1].replace(",", ""))
        m = market_of(t)
        mode = next((a for a in args[2:] if a in ("fixed", "trend", "cycle")), self.cfg["risk"]["default_exit_mode"])
        nums = [a for a in args[2:] if a.replace(".", "").isdigit()]
        plan = S.position_plan(price, self.cfg["capital"][m], self.cfg["max_positions"],
                               self.cfg["risk"]["stop_loss_pct"], self.cfg["risk"]["take_profit_pct"])
        qty = float(nums[0]) if nums else plan.qty
        w = self.store.watch(m).get(t, {})
        name = w.get("name") or t
        stop, take = plan.stop, plan.take
        if mode == "trend":
            take = None
        if mode == "cycle":
            stop, take = None, w.get("target")
        self.store.open_position(m, t, name, price, qty, mode, stop, take)
        return (f"✅ 등록: {esc(name)}({t}) {fmt_price(m, price)} x{qty:g} [{mode}]\n"
                f"손절 {fmt_price(m, stop)} · 목표 {fmt_price(m, take)}"
                + ("\n10일선 이탈 시 매도 알림 + 상승 시 불타기 알림" if mode == "trend" else ""))

    def _safe(self, fn, *a):
        try:
            fn(*a)
        except Exception as e:
            log.exception("작업 실패")
            self.tg.send(f"⚠️ 작업 실패: {esc(e)}")

    # ------------------------------------------------------------------
    def run_forever(self):
        from apscheduler.schedulers.blocking import BlockingScheduler
        from apscheduler.triggers.cron import CronTrigger

        sched = BlockingScheduler()
        for m in self.cfg["markets"]:
            sch = self.cfg["schedule"][m]
            hh, mm = sch["scan_time"].split(":")
            sched.add_job(lambda m=m: is_trading_day(m) and self._safe(self.daily, m),
                          CronTrigger(day_of_week="mon-fri", hour=int(hh), minute=int(mm), timezone=TZ[m]),
                          id=f"daily_{m}", misfire_grace_time=3600, coalesce=True)
            step = int(self.cfg["intraday"]["interval_min"])
            sh, eh = int(sch["intraday_start"][:2]), int(sch["intraday_end"][:2])
            sched.add_job(lambda m=m: self._safe(self.intraday, m),
                          CronTrigger(day_of_week="mon-fri", hour=f"{sh}-{eh}", minute=f"*/{step}", timezone=TZ[m]),
                          id=f"intraday_{m}", max_instances=1, coalesce=True, misfire_grace_time=120)
        f = self.cfg["schedule"]["fundamentals"]
        fh, fm = f["time"].split(":")
        sched.add_job(lambda: self._safe(self.refresh_fundamentals),
                      CronTrigger(day_of_week=f["day_of_week"], hour=int(fh), minute=int(fm), timezone=TZ["KR"]),
                      id="fundamentals", misfire_grace_time=6 * 3600)
        stop = threading.Event()
        threading.Thread(target=self.tg.poll_commands, args=(self.handle, stop), daemon=True).start()
        self.tg.send(f"🤖 주식 알림 봇 시작 · 시장 {', '.join(self.cfg['markets'])} · 시세 {self.provider.name}\n/help 로 명령어 확인")
        log.info("스케줄러 시작: %s", [j.id for j in sched.get_jobs()])
        try:
            sched.start()
        finally:
            stop.set()


def market_of(ticker: str) -> str:
    return "KR" if ticker[:6].isdigit() or (len(ticker) == 6 and ticker[:4].isdigit()) else "US"


HELP = """<b>📈 주식 알림 봇 명령어</b>
/buy 종목 매수가 [수량] [fixed|trend|cycle] — 매수 등록
   fixed: -5% 손절 / +15% 익절 (기본)
   trend: -5% 손절 + 10일선 이탈 매도 + 불타기 알림
   cycle: 사이클주 목표가(최고 EPS x5) 도달 알림
   예) /buy 005930 72000 10   ·   /buy NVDA 120.5 5 trend
/sell 종목 [매도가] — 보유 종료
/pos — 보유 종목
/watch KR|US — 장중 감시 목록
/scan KR|US — 지금 스캔 + 브리핑 실행
/check KR|US — 지금 장중 점검 실행"""
