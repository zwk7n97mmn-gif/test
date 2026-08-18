"""投稿テキストの長さ計算.

X と Bluesky で数え方が違うため、両方の基準を実装する。

- X: "weighted length". 全角圏の文字は 2、それ以外は 1 で数え、上限 280。
  つまり日本語だけなら実質 140 文字。
- Bluesky: 書記素クラスタ数 300 かつ UTF-8 バイト数 3000。

X のほうが常に厳しいので、X を通れば Bluesky も通る。
"""

from __future__ import annotations

import unicodedata

# X の twitter-text 設定 v3 で weight 2 が割り当てられるコードポイント範囲。
# ここに入らない文字はすべて weight 1。
_HEAVY_RANGES: tuple[tuple[int, int], ...] = (
    (0x1100, 0x115F),    # ハングル字母
    (0x2E80, 0x303E),    # CJK 部首補助 〜 CJK 記号
    (0x3041, 0x33FF),    # かな 〜 CJK 互換
    (0x3400, 0x4DBF),    # CJK 拡張A
    (0x4E00, 0x9FFF),    # CJK 統合漢字
    (0xA000, 0xA4CF),    # イ文字
    (0xA960, 0xA97F),    # ハングル字母拡張A
    (0xAC00, 0xD7A3),    # ハングル音節
    (0xF900, 0xFAFF),    # CJK 互換漢字
    (0xFE30, 0xFE4F),    # CJK 互換形
    (0xFF00, 0xFF60),    # 全角英数・記号
    (0xFFE0, 0xFFE6),    # 全角通貨記号
    (0x1F300, 0x1F9FF),  # 絵文字
    (0x20000, 0x3FFFD),  # CJK 拡張B以降
)

X_LIMIT = 280
BLUESKY_GRAPHEME_LIMIT = 300
BLUESKY_BYTE_LIMIT = 3000


def _is_heavy(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in _HEAVY_RANGES)


def x_weighted_length(text: str) -> int:
    """X の重み付き文字数を返す。280 が上限。"""
    return sum(2 if _is_heavy(ord(ch)) else 1 for ch in text)


def grapheme_length(text: str) -> int:
    """書記素クラスタ数の近似。

    標準ライブラリだけでは完全な UAX #29 は実装できないため、
    結合文字 (Mn/Mc/Me) と ZWJ 連結を前の文字にくっつける近似を使う。
    絵文字の合字を含まない通常の日本語テキストでは正確に一致する。
    """
    count = 0
    prev_zwj = False
    for ch in text:
        if ch == "‍":  # ZERO WIDTH JOINER
            prev_zwj = True
            continue
        if prev_zwj:
            prev_zwj = False
            continue
        if unicodedata.category(ch) in ("Mn", "Mc", "Me"):
            continue
        if ch in ("️", "︎"):  # 異体字セレクタ
            continue
        count += 1
    return count


def fits_x(text: str) -> bool:
    return x_weighted_length(text) <= X_LIMIT


def fits_bluesky(text: str) -> bool:
    return (
        grapheme_length(text) <= BLUESKY_GRAPHEME_LIMIT
        and len(text.encode("utf-8")) <= BLUESKY_BYTE_LIMIT
    )


def describe(text: str) -> str:
    """検証エラー用の内訳文字列。"""
    return (
        f"X重み={x_weighted_length(text)}/{X_LIMIT} "
        f"書記素={grapheme_length(text)}/{BLUESKY_GRAPHEME_LIMIT} "
        f"bytes={len(text.encode('utf-8'))}/{BLUESKY_BYTE_LIMIT}"
    )
