"""The product's name, site and bot, read from config/brand.json: the one place they are written down."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@lru_cache(maxsize=1)
def brand() -> dict:
    return json.loads((ROOT / "config" / "brand.json").read_text())


def name() -> str:
    return brand()["name"]
