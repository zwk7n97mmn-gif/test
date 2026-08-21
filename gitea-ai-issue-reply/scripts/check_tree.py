#!/usr/bin/env python3
"""ドキュメントに書かれたフォルダツリーが、実体と合っているか確かめる。

    python3 scripts/check_tree.py

同じツリーを複数のページに手で書いていると、片方だけ更新されて離れていきます
（ファイルを増やしたのにツリーに足し忘れる、消したのに残っている、など）。
読む人はツリーを信じるため、ズレたまま気づかれないのがいちばん困ります。

対象にするのは、``` で囲まれた中の 1 行目が 📦 で始まるブロックです。
📂（フォルダ）と 📜（ファイル）の名前を拾い、実体と突き合わせます。

ツリーに書きたくないもの（配置後の姿など、このリポジトリの実体ではないツリー）は、
ブロックの 1 行目を `📦<名前> ※照合しない` にすると飛ばします。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 実体の一覧から外すもの（テストの一時出力・隠しファイル・生成物）
IGNORE = {".git", "__pycache__", "node_modules"}
IGNORE_SUFFIX = (".log", ".pyc")

_failures: list[str] = []

# ┣ ┗ の後ろにある 📂 / 📜 の名前を拾う。名前の後ろの「… 説明」「※注記」は落とす
ENTRY = re.compile(r"[📂📜]\s*([^\s…※]+)")


def tree_blocks(text: str) -> list[tuple[str, list[str]]]:
    """(ブロックの見出し, 中の名前一覧) を返す。"""
    blocks = []
    for body in re.findall(r"```[a-zA-Z]*\n(.*?)```", text, re.S):
        lines = body.splitlines()
        if not lines or not lines[0].lstrip().startswith("📦"):
            continue
        header = lines[0].strip()
        names = []
        for line in lines[1:]:
            match = ENTRY.search(line)
            if match:
                names.append(match.group(1).rstrip("/"))
        blocks.append((header, names))
    return blocks


def actual_names() -> tuple[set[str], set[str]]:
    """(全階層の名前, 直下の名前) を返す。"""
    everything: set[str] = set()
    top: set[str] = set()
    for path in ROOT.rglob("*"):
        rel = path.relative_to(ROOT)
        if any(part in IGNORE for part in rel.parts):
            continue
        # 隠しディレクトリの中身は対象外（.git 配下などを数えない）
        if any(part.startswith(".") for part in rel.parts[:-1]):
            continue
        if path.name.endswith(IGNORE_SUFFIX):
            continue
        everything.add(path.name)
        # 直下でも、隠しファイルは「載せてもよいが、載せる義務はない」扱いにする
        if len(rel.parts) == 1 and not path.name.startswith("."):
            top.add(path.name)
    return everything, top


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  OK   {message}")
    else:
        print(f"  NG   {message}")
        _failures.append(message)


def main() -> int:
    everything, top = actual_names()
    docs = sorted(ROOT.glob("docs/*.md")) + [ROOT / "README.md"]

    checked = 0
    for doc in docs:
        if not doc.exists():
            continue
        for header, names in tree_blocks(doc.read_text(encoding="utf-8")):
            if "※照合しない" in header:
                continue
            checked += 1
            rel = doc.relative_to(ROOT)
            print(f"\n{rel} の {header}")

            missing = [n for n in names if n not in everything]
            check(not missing, f"ツリーに書かれたものが実体にある{'（無い: ' + ', '.join(missing) + '）' if missing else ''}")

            # 直下の実体が、そのツリーに載っているか（直下を描いたツリーだけを対象にする）
            listed = set(names)
            if top & listed:
                unlisted = sorted(t for t in top if t not in listed)
                check(not unlisted,
                      f"直下のものがツリーに載っている{'（載っていない: ' + ', '.join(unlisted) + '）' if unlisted else ''}")

    if checked == 0:
        print("照合できるツリーが見つかりませんでした（📦 で始まるブロックがありません）。")
        return 1

    print()
    if _failures:
        print(f"{len(_failures)} 件の食い違いがあります。ドキュメントのツリーを実体に合わせてください。")
        return 1
    print(f"ツリー {checked} 件は実体と一致しています。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
