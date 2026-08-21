#!/usr/bin/env python3
"""ページの中のリンクが切れていないか確かめる。

    python3 scripts/check_links.py

見るのは 2 種類です。

  参照リンク  [表示][id] … 対応する [id]: URL の定義があるか
  相対リンク  [表示](ページ.md) … その .md が存在するか
              （配置先の wiki にある前提のページは repos.json の
                expected_sibling_pages に書いておくと通ります）

参照リンクの定義漏れは、リンクにならず `[表示][id]` の文字列がそのまま出ます。
書いた本人は気づきにくく、読む人には壊れて見えます。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_failures: list[str] = []

# [表示][id] 形式。画像 ![...] と [id]: 定義行は除く
REF_LINK = re.compile(r"(?<!\!)\[[^\]\n]+\]\[([^\]\n]+)\]")
REL_LINK = re.compile(r"(?<!\!)\[[^\]\n]+\]\(([^)\n]+)\)")
DEFINITION = re.compile(r"^\[([^\]]+)\]:\s*\S+", re.M)


def strip_code(text: str) -> str:
    """``` で囲まれた中は対象外（説明のために書いた例が引っかかるため）。"""
    return re.sub(r"```.*?```", "", text, flags=re.S)


def check(condition: bool, message: str) -> None:
    print(f"  {'OK  ' if condition else 'NG  '} {message}")
    if not condition:
        _failures.append(message)


def main() -> int:
    config = ROOT / "repos.json"
    siblings = set()
    if config.exists():
        siblings = set(json.loads(config.read_text(encoding="utf-8")).get("expected_sibling_pages", []))

    pages = sorted(ROOT.glob("*.md")) + sorted(ROOT.glob("docs/*.md"))
    if not pages:
        print("確認するページがありません。", file=sys.stderr)
        return 1

    for page in pages:
        raw = page.read_text(encoding="utf-8")
        text = strip_code(raw)
        rel = page.relative_to(ROOT)
        print(f"\n{rel}")

        defined = set(DEFINITION.findall(raw))
        used = set(REF_LINK.findall(text))
        undefined = sorted(used - defined)
        check(not undefined,
              f"参照リンクに定義がある{'（定義が無い: ' + ', '.join(undefined) + '）' if undefined else ''}")

        broken = []
        for target in REL_LINK.findall(text):
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            name = target.split("#")[0]
            if not name:
                continue
            if name in siblings:
                continue
            if not (page.parent / name).exists():
                broken.append(target)
        check(not broken,
              f"相対リンクの先がある{'（無い: ' + ', '.join(broken) + '）' if broken else ''}")

    print()
    if _failures:
        print(f"{len(_failures)} 件のリンクの問題があります。")
        return 1
    print("リンクは切れていません。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
