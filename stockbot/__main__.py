"""실행: python -m stockbot <명령>

  run                     스케줄러 + 텔레그램 봇 상시 실행
  daily KR|US [--no-send] 장 마감 스캔 + 브리핑 1회 실행
  intraday KR|US          장중 점검 1회 실행 (시간 제한 무시)
  fundamentals            사이클주 재무데이터 갱신
  backtest KR|US          기법별 백테스트
  test-telegram           텔레그램 연결 테스트
"""
from __future__ import annotations

import argparse
import logging

from .config import load_config


def main():
    ap = argparse.ArgumentParser(prog="stockbot")
    ap.add_argument("command", choices=["run", "daily", "intraday", "fundamentals", "backtest", "test-telegram"])
    ap.add_argument("market", nargs="?", default="KR", choices=["KR", "US"])
    ap.add_argument("--config", default=None)
    ap.add_argument("--no-send", action="store_true", help="텔레그램 대신 화면에 출력")
    ap.add_argument("--strategy", default="all",
                    help="backtest: volume_dryup|price_defense|volume_surge_sideways|ma10|breakout|donchian|surge_hold|box|pullback|all")
    ap.add_argument("--limit", type=int, default=0, help="backtest: 종목 수 제한(0=전체)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config(a.config)

    from .app import App

    app = App(cfg)
    if a.command == "run":
        app.run_forever()
    elif a.command == "daily":
        text = app.daily(a.market, send=not a.no_send)
        if a.no_send:
            print(text)
    elif a.command == "intraday":
        print(f"알림 {app.intraday(a.market, force=True)}건")
    elif a.command == "fundamentals":
        app.refresh_fundamentals()
    elif a.command == "test-telegram":
        app.tg.send("✅ 텔레그램 연결 성공! 주식 알림 봇이 이 채팅으로 알림을 보냅니다.")
    elif a.command == "backtest":
        _backtest(cfg, app, a)


def _backtest(cfg, app, a):
    from . import backtest as B
    from . import data as D

    uni = D.load_universe(a.market, cfg, cfg.data_dir)
    if a.limit:
        uni = uni.head(a.limit)
    prices = app.prices.update(a.market, uni)
    ucfg = cfg["universe"][a.market]
    prices = {t: df for t, df in prices.items() if D.liquid(df, ucfg["min_price"], ucfg["min_avg_value"])}
    names = ["volume_dryup", "price_defense", "volume_surge_sideways", "ma10", "breakout", "donchian", "surge_hold", "box", "pullback"] \
        if a.strategy == "all" else [a.strategy]
    print(f"\n{a.market} 백테스트 · {len(prices)}종목 · 왕복비용 0.3% 차감 · 생존편향 있음(상장폐지 종목 제외)\n")
    print(f"{'전략':<24}{'청산':<8}{'거래수':>7}{'승률%':>8}{'평균%':>8}{'평균이익%':>10}{'평균손실%':>10}{'PF':>6}{'보유일':>7}")
    for n in names:
        for mode in ("fixed", "trend", "turtle") + (("box",) if n == "box" else ()):
            s, _ = B.run(cfg, prices, n, mode)
            if not s["trades"]:
                print(f"{n:<24}{mode:<8}{0:>7}")
                continue
            print(f"{n:<24}{mode:<8}{s['trades']:>7}{s['win_rate']:>8.1f}{s['avg_ret']:>8.2f}{s['avg_win']:>10.2f}"
                  f"{s['avg_loss']:>10.2f}{s['profit_factor']:>6.2f}{s['avg_days']:>7.1f}")
    print("\nfixed = -5% 손절/+15% 익절, trend = -5% 손절 + 10일선 이탈 매도, turtle = 10일 최저가 이탈 매도,")
    print("box = 돌파 실패선 손절 + 10일 최저가 이탈 매도.")
    print("수익률은 '종목 기준'입니다. 실제 계좌 손실은 2% 규칙에 따른 수량 조절로 1회 최대 2% 이내로 제한됩니다.")
    print("PF(총이익/총손실) > 1 이면 수익.")


if __name__ == "__main__":
    main()
