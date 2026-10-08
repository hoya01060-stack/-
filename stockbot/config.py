"""설정 로드: config.yaml + .env 환경변수."""
from __future__ import annotations

import copy
import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


@dataclass
class Secrets:
    telegram_token: str = ""
    telegram_chat_id: str = ""
    kis_app_key: str = ""
    kis_app_secret: str = ""
    kis_env: str = "real"
    dart_api_key: str = ""
    anthropic_api_key: str = ""

    @classmethod
    def from_env(cls) -> "Secrets":
        try:
            from dotenv import load_dotenv

            load_dotenv(ROOT / ".env")
        except ImportError:
            pass
        g = os.environ.get
        return cls(
            telegram_token=g("TELEGRAM_BOT_TOKEN", ""),
            telegram_chat_id=g("TELEGRAM_CHAT_ID", ""),
            kis_app_key=g("KIS_APP_KEY", ""),
            kis_app_secret=g("KIS_APP_SECRET", ""),
            kis_env=g("KIS_ENV", "real"),
            dart_api_key=g("DART_API_KEY", ""),
            anthropic_api_key=g("ANTHROPIC_API_KEY", ""),
        )


@dataclass
class Config:
    raw: dict
    secrets: Secrets = field(default_factory=Secrets)

    def __getitem__(self, key):
        return self.raw[key]

    def get(self, key, default=None):
        return self.raw.get(key, default)

    def strat(self, name: str) -> dict:
        return self.raw["strategies"][name]

    @property
    def data_dir(self) -> Path:
        p = Path(self.raw.get("data_dir", "data"))
        return p if p.is_absolute() else ROOT / p


def load_config(path: str | os.PathLike | None = None) -> Config:
    with open(ROOT / "config.example.yaml", encoding="utf-8") as f:
        base = yaml.safe_load(f)
    path = Path(path) if path else ROOT / "config.yaml"
    if path.exists():
        with open(path, encoding="utf-8") as f:
            base = _deep_merge(base, yaml.safe_load(f) or {})
    cfg = Config(raw=base, secrets=Secrets.from_env())
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return cfg
