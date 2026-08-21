#!/usr/bin/env python3
"""リポジトリ一覧（repos.json）と、入口ページの表・リンク定義が一致しているか確かめる。

    python3 scripts/check_repos.py

リポジトリが増減したとき、直す場所が 3 つあります。
片方だけ直すとページと実態が離れ、読む人が存在しないリポジトリを探すことになります。

  repos.json          一覧の正
  リポジトリ全体像.md   表とリンク定義
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPOS = ROOT / "repos.json"
PAGE = ROOT / "リポジトリ全体像.md"

_failures: list[str] = []


def check(condition: bool, message: str) -> None:
    print(f"  {'OK  ' if condition else 'NG  '} {message}")
    if not condition:
        _failures.append(message)


def main() -> int:
    if not REPOS.exists() or not PAGE.exists():
        print(f"{REPOS.name} と {PAGE.name} が必要です。", file=sys.stderr)
        return 1

    data = json.loads(REPOS.read_text(encoding="utf-8"))
    text = PAGE.read_text(encoding="utf-8")
    declared = [r for g in data["groups"] for r in g["repos"]]
    ids = [r["id"] for r in declared]

    print(f"repos.json のリポジトリ: {len(ids)} 件")

    # ① 表に載っているか
    missing = [r["id"] for r in declared if f"[{r['name']}][{r['id']}]" not in text]
    check(not missing, f"すべて表に載っている{'（無い: ' + ', '.join(missing) + '）' if missing else ''}")

    # ② リンク定義があるか
    defined = set(re.findall(r"^\[([^\]]+)\]:\s*\S+", text, re.M))
    undefined = [i for i in ids if i not in defined]
    check(not undefined, f"すべてリンク定義がある{'（無い: ' + ', '.join(undefined) + '）' if undefined else ''}")

    # ③ 余分なリンク定義が無いか（消したリポジトリの定義が残っていないか）
    extra = sorted(defined - set(ids))
    check(not extra, f"余分なリンク定義が無い{'（余分: ' + ', '.join(extra) + '）' if extra else ''}")

    # ④ id の重複
    check(len(set(ids)) == len(ids), "id が重複していない")

    # ⑤ 必須項目
    lacking = [r.get("id", "(id なし)") for r in declared
               if not all(r.get(k) for k in ("id", "name", "summary", "users"))]
    check(not lacking, f"必須項目が揃っている{'（不足: ' + ', '.join(lacking) + '）' if lacking else ''}")

    print()
    if _failures:
        print(f"{len(_failures)} 件の食い違いがあります。repos.json と入口ページを同じコミットで直してください。")
        return 1
    print("一覧とページは一致しています。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
