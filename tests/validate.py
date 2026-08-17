"""コンテンツ全件の検証。CI と pre-commit の両方から呼ばれる。

  python tests/validate.py          # 問題があれば終了コード 1
  python tests/validate.py --report # 全件の長さ内訳を表示
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import bluesky  # noqa: E402
import tips as tips_mod  # noqa: E402
from textlen import X_LIMIT, x_weighted_length  # noqa: E402


def main() -> int:
    report = "--report" in sys.argv
    all_tips = tips_mod.load_all()
    problems = tips_mod.validate(all_tips)

    # facet のバイトオフセットが実際のタグ文字列と一致するか確認する。
    # ここがずれると Bluesky 上でハッシュタグの範囲が壊れる。
    for tip in all_tips:
        text = tip.render()
        encoded = text.encode("utf-8")
        for facet in bluesky.build_facets(text):
            start = facet["index"]["byteStart"]
            end = facet["index"]["byteEnd"]
            fragment = encoded[start:end].decode("utf-8")
            feature = facet["features"][0]
            if feature["$type"].endswith("#tag") and fragment != f"#{feature['tag']}":
                problems.append(
                    f"{tip.id}: facet のオフセット不一致 '{fragment}' != '#{feature['tag']}'"
                )

    if report:
        widest = max(all_tips, key=lambda t: x_weighted_length(t.render()))
        by_category = Counter(t.category for t in all_tips)
        print(f"総数: {len(all_tips)} 件 (1日2回で {len(all_tips) / 2:.0f} 日分)")
        print("カテゴリ別:")
        for category, count in by_category.most_common():
            print(f"  {category}: {count}")
        print(
            f"最長: {widest.id}「{widest.title}」"
            f"{x_weighted_length(widest.render())}/{X_LIMIT}"
        )
        print("上限に近い順 (X 重み):")
        for tip in sorted(all_tips, key=lambda t: -x_weighted_length(t.render()))[:10]:
            print(f"  {x_weighted_length(tip.render()):>3}/{X_LIMIT}  {tip.id} {tip.title}")

    if problems:
        print(f"\n検証エラー {len(problems)} 件:")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(f"\n検証OK: {len(all_tips)} 件すべて X / Bluesky の両方に投稿可能")
    return 0


if __name__ == "__main__":
    sys.exit(main())
