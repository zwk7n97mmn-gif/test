"""豆知識コンテンツの読み込み・整形・選択。"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path

from textlen import describe, fits_bluesky, fits_x

CONTENT_DIR = Path(__file__).resolve().parent.parent / "content" / "tips"

# 本文に現れてよい文字の範囲。日本語・英数・一般的な約物のみ。
# キリル文字やハングルが紛れ込む事故を検出するためのホワイトリスト。
_ALLOWED_RANGES: tuple[tuple[int, int], ...] = (
    (0x0020, 0x007E),  # ASCII 記号・英数
    (0x00A0, 0x00FF),  # Latin-1 補助 (Latané の é など)
    (0x2000, 0x206F),  # 一般句読点 (— … 〜 など)
    (0x2190, 0x21FF),  # 矢印 (→)
    (0x2460, 0x24FF),  # 囲み数字
    (0x25A0, 0x26FF),  # 幾何学模様・記号
    (0x3000, 0x303F),  # CJK 記号・句読点 (。、「」〜)
    (0x3040, 0x30FF),  # ひらがな・カタカナ
    (0x3400, 0x4DBF),  # CJK 拡張A
    (0x4E00, 0x9FFF),  # CJK 統合漢字
    (0xFF00, 0xFFEF),  # 全角形
)


def _foreign_chars(text: str) -> list[str]:
    """想定外の文字体系が混入していないか調べる。"""
    return sorted(
        {
            ch
            for ch in text
            if ch not in "\n\t"
            and not any(lo <= ord(ch) <= hi for lo, hi in _ALLOWED_RANGES)
        }
    )


@dataclass(frozen=True)
class Tip:
    id: str
    category: str
    title: str
    body: str
    tags: tuple[str, ...]
    source: str

    def render(self) -> str:
        """実際に投稿されるテキスト。"""
        return f"{self.body}\n\n{' '.join(self.tags)}"


def load_all() -> list[Tip]:
    """content/tips/*.json をすべて読み込む。id 順で安定ソートして返す。"""
    tips: list[Tip] = []
    seen: dict[str, Path] = {}

    for path in sorted(CONTENT_DIR.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError(f"{path.name}: トップレベルは配列である必要がある")
        for entry in raw:
            tip = Tip(
                id=entry["id"],
                category=entry["category"],
                title=entry["title"],
                body=entry["body"],
                tags=tuple(entry.get("tags", [])),
                source=entry.get("source", ""),
            )
            if tip.id in seen:
                raise ValueError(f"id が重複: {tip.id} ({seen[tip.id].name} と {path.name})")
            seen[tip.id] = path
            tips.append(tip)

    if not tips:
        raise ValueError(f"{CONTENT_DIR} に豆知識が 1 件もない")
    return sorted(tips, key=lambda t: t.id)


def validate(tips: list[Tip]) -> list[str]:
    """壊れた投稿を本番前に止める。問題点のリストを返す (空なら健全)。"""
    problems: list[str] = []
    for tip in tips:
        text = tip.render()
        if not fits_x(text):
            problems.append(f"{tip.id} ({tip.title}): X の上限超過 — {describe(text)}")
        if not fits_bluesky(text):
            problems.append(f"{tip.id} ({tip.title}): Bluesky の上限超過 — {describe(text)}")
        if not tip.body.strip():
            problems.append(f"{tip.id}: 本文が空")
        if not tip.source.strip():
            problems.append(f"{tip.id} ({tip.title}): 出典が未記入")
        strays = _foreign_chars(tip.body + tip.title)
        if strays:
            problems.append(
                f"{tip.id} ({tip.title}): 想定外の文字が混入 {strays}"
            )
        for tag in tip.tags:
            if not tag.startswith("#"):
                problems.append(f"{tip.id}: タグ '{tag}' が # で始まっていない")
            if " " in tag:
                problems.append(f"{tip.id}: タグ '{tag}' に空白が含まれる")
    return problems


def rotation(tips: list[Tip], cycle: int) -> list[Tip]:
    """1 巡分の出題順。cycle ごとに違う順序になるが、同じ cycle なら常に同じ。

    決定的にすることで、状態ファイルが壊れても同じ順序を再現できる。
    """
    ordered = list(tips)
    random.Random(f"psych-tips-cycle-{cycle}").shuffle(ordered)
    return ordered


def pick_next(tips: list[Tip], cycle: int, done_ids: set[str], last_category: str) -> Tip:
    """次に投稿する 1 件を選ぶ。

    - 今の巡回で未投稿のものから選ぶ (全部出るまで再登場しない)
    - 直前と同じカテゴリは、他に候補があるなら避ける
    """
    remaining = [t for t in rotation(tips, cycle) if t.id not in done_ids]
    if not remaining:
        raise LookupError("この巡回の候補が尽きている")

    for tip in remaining:
        if tip.category != last_category:
            return tip
    return remaining[0]
