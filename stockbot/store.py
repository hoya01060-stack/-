"""SQLite 저장소: 보유 포지션, 발송한 알림(중복 방지), 감시 목록, 스캔 결과."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import date, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT, ticker TEXT, name TEXT,
    entry_price REAL, qty REAL, entry_date TEXT,
    mode TEXT,                 -- fixed | trend | cycle
    stop REAL, take REAL,
    adds_done INTEGER DEFAULT 0,
    status TEXT DEFAULT 'open',
    exit_price REAL, exit_date TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
    day TEXT, market TEXT, ticker TEXT, signal TEXT, sent_at TEXT,
    PRIMARY KEY (day, market, ticker, signal)
);
CREATE TABLE IF NOT EXISTS watch (
    market TEXT, ticker TEXT, data TEXT, updated TEXT,
    PRIMARY KEY (market, ticker)
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated TEXT);
"""


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()
        with self._conn() as c:
            c.executescript(SCHEMA)

    def _conn(self):
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _exec(self, sql, args=()):
        with self.lock, self._conn() as c:
            return [dict(r) for r in c.execute(sql, args).fetchall()]

    # --- positions -------------------------------------------------------
    def open_position(self, market, ticker, name, price, qty, mode, stop, take, note=""):
        self._exec("INSERT INTO positions(market,ticker,name,entry_price,qty,entry_date,mode,stop,take,note)"
                   " VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (market, ticker, name, price, qty, date.today().isoformat(), mode, stop, take, note))

    def positions(self, market=None, status="open"):
        if market:
            return self._exec("SELECT * FROM positions WHERE status=? AND market=?", (status, market))
        return self._exec("SELECT * FROM positions WHERE status=?", (status,))

    def update_position(self, pid, **fields):
        cols = ", ".join(f"{k}=?" for k in fields)
        self._exec(f"UPDATE positions SET {cols} WHERE id=?", (*fields.values(), pid))

    def close_position(self, market, ticker, price=None):
        rows = self._exec("SELECT id FROM positions WHERE status='open' AND market=? AND ticker=?", (market, ticker))
        for r in rows:
            self.update_position(r["id"], status="closed", exit_price=price, exit_date=date.today().isoformat())
        return len(rows)

    # --- alerts (하루 1회 중복 방지) ---------------------------------------
    def mark_alert(self, market, ticker, signal, day: str | None = None) -> bool:
        """처음 보내는 알림이면 True (그리고 기록), 이미 보냈으면 False."""
        day = day or date.today().isoformat()
        with self.lock, self._conn() as c:
            cur = c.execute("INSERT OR IGNORE INTO alerts VALUES (?,?,?,?,?)",
                            (day, market, ticker, signal, datetime.now().isoformat(timespec="seconds")))
            return cur.rowcount == 1

    # --- watch list -----------------------------------------------------
    def replace_watch(self, market, items: dict[str, dict]):
        now = datetime.now().isoformat(timespec="seconds")
        with self.lock, self._conn() as c:
            c.execute("DELETE FROM watch WHERE market=?", (market,))
            c.executemany("INSERT INTO watch VALUES (?,?,?,?)",
                          [(market, t, json.dumps(d, ensure_ascii=False, default=float), now) for t, d in items.items()])

    def watch(self, market) -> dict[str, dict]:
        return {r["ticker"]: json.loads(r["data"]) for r in self._exec("SELECT * FROM watch WHERE market=?", (market,))}

    # --- key/value ------------------------------------------------------
    def put(self, key, value):
        self._exec("INSERT OR REPLACE INTO kv VALUES (?,?,?)",
                   (key, json.dumps(value, ensure_ascii=False, default=str), datetime.now().isoformat(timespec="seconds")))

    def get(self, key, default=None):
        rows = self._exec("SELECT value FROM kv WHERE key=?", (key,))
        return json.loads(rows[0]["value"]) if rows else default
