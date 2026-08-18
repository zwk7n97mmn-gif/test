"""投稿履歴の永続化。

状態は state/posted.json に置き、投稿のたびに GitHub Actions が
コミットして戻す。リポジトリ自体が投稿ログを兼ねる構成。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

STATE_PATH = Path(__file__).resolve().parent.parent / "state" / "posted.json"

_EMPTY: dict[str, Any] = {"cycle": 1, "done_ids": [], "last_category": "", "history": []}

# 履歴は無限に伸ばさず直近のみ保持する (差分レビューを読める大きさに保つため)
HISTORY_LIMIT = 400


def load() -> dict[str, Any]:
    if not STATE_PATH.exists():
        return dict(_EMPTY, done_ids=[], history=[])
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # 壊れていても運用は止めない。巡回は決定的なので順序は復元できる。
        return dict(_EMPTY, done_ids=[], history=[])
    for key, default in _EMPTY.items():
        data.setdefault(key, default if not isinstance(default, list) else [])
    return data


def save(data: dict[str, Any]) -> None:
    data["history"] = data.get("history", [])[-HISTORY_LIMIT:]
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def record(
    data: dict[str, Any],
    tip_id: str,
    title: str,
    category: str,
    total_tips: int,
    results: dict[str, str],
) -> None:
    """1 件の投稿結果を状態に反映する。"""
    done = list(data.get("done_ids", []))
    if tip_id not in done:
        done.append(tip_id)

    data["last_category"] = category
    data["history"] = data.get("history", []) + [
        {"id": tip_id, "title": title, "results": results}
    ]

    # 全件出し切ったら次の巡回へ。順序は cycle 番号で変わる。
    if len(done) >= total_tips:
        data["cycle"] = data.get("cycle", 1) + 1
        data["done_ids"] = []
    else:
        data["done_ids"] = done
