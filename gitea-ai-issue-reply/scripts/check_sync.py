#!/usr/bin/env python3
"""参照リポジトリの一覧が、3 か所で食い違っていないか確かめる。

    python3 scripts/check_sync.py

参照先を増やしたり減らしたりするとき、次の 3 つは同時に直す必要がある。
片方だけ直すと、次のどちらかのズレが起きる。

  - refs.json にだけ足した   … clone はされるが、AI が参照先として知らず調査に使われない
  - SKILL.md にだけ足した    … AI が存在しないディレクトリを読もうとして無駄に試行する

対象:
  refs.json                          取得する参照リポジトリ
  skills/issue-ai-reply/SKILL.md     AI に「どこに何があるか」を教える表
  docs/運用仕様.md                    人向けの一覧
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REFS = ROOT / "refs.json"
TARGETS = [
    ROOT / "skills" / "issue-ai-reply" / "SKILL.md",
    ROOT / "docs" / "運用仕様.md",
]


def declared_paths() -> list[str]:
    data = json.loads(REFS.read_text(encoding="utf-8"))
    return [entry["path"] for entry in data.get("repos", [])]


def mentioned_paths(text: str, known: list[str]) -> set[str]:
    """`path` の形で書かれているものを拾う。

    ``` で囲まれたブロックは先に落とす。中に含まれるバッククォートが
    インラインコードの対応をずらし、本文全体が 1 つの塊として拾われてしまうため。
    """
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    quoted = set(re.findall(r"`([^`\n]+)`", text))
    found = set()
    for name in known:
        if name in quoted or any(item.startswith(name + "/") for item in quoted):
            found.add(name)
    return found


def main() -> int:
    if not REFS.exists():
        print(f"{REFS} がありません。", file=sys.stderr)
        return 1

    paths = declared_paths()
    print(f"refs.json の参照リポジトリ: {', '.join(paths) or '（なし）'}")

    problems: list[str] = []
    for target in TARGETS:
        if not target.exists():
            problems.append(f"{target.relative_to(ROOT)} がありません")
            continue
        text = target.read_text(encoding="utf-8")
        found = mentioned_paths(text, paths)
        missing = [p for p in paths if p not in found]
        rel = target.relative_to(ROOT)
        if missing:
            problems.append(f"{rel} に載っていない参照先: {', '.join(missing)}")
        else:
            print(f"  OK   {rel}")

    # 重複と、空の path も見ておく
    if len(set(paths)) != len(paths):
        problems.append("refs.json の path が重複しています")
    if any(not p or "/" in p or p.startswith(".") for p in paths):
        problems.append("refs.json の path に使えない文字が含まれています（単一のディレクトリ名にしてください）")

    if problems:
        print()
        print("食い違いがあります:")
        for item in problems:
            print(f"  - {item}")
        print()
        print("参照先を増減したときは、refs.json・SKILL.md・docs/運用仕様.md を同じコミットで直してください。")
        return 1

    print("\n3 か所の一覧は一致しています。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
