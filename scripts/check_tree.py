#!/usr/bin/env python3
"""ドキュメントに書かれたフォルダツリーが、実体と合っているか確かめる。

    python3 check_tree.py            # 設定を自動で探して実行
    python3 check_tree.py --root .   # 対象のリポジトリを指定
    python3 check_tree.py --list     # 実体の一覧だけ表示（ツリーを書くときの下敷き）

同じツリーを手で書いて放置すると、ファイルを増やしたり消したりしたときに
ドキュメントだけが取り残されます。読む人はツリーを信じるため、
ズレたまま気づかれないのがいちばん困ります。

## 何を見るか

``` で囲まれた中の 1 行目が 📦 で始まるブロックを「ツリー」とみなし、
📂（フォルダ）と 📜（ファイル）の名前を拾って実体と突き合わせます。

    📦リポジトリ名
     ┣ 📂フォルダ
     ┃ ┗ 📜ファイル.sh      … 説明を書いてもよい（照合では無視される）
     ┗ 📜README.md

実体ではないツリー（配置後の姿、書き方の例など）は、1 行目を
`📦名前 ※照合しない` にすると飛ばします。

## 設定

リポジトリ直下に check-tree.json を置くと変えられます（無くても既定値で動きます）。

    {
      "docs": ["*.md", "docs/**/*.md"],
      "ignore": ["_output/**", "*.xlsx"],
      "source": "git",
      "require_listed": true,
      "require_tree": true
    }

依存なし・Python 3.9 以上。1 ファイルで完結するので、各リポジトリに置いて構いません。
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path

CONFIG_NAME = "check-tree.json"

DEFAULTS = {
    # ツリーを探すファイル（リポジトリ直下からの glob）
    "docs": ["*.md", "docs/**/*.md"],
    # 実体の一覧から外すもの
    "ignore": ["**/__pycache__/**", "**/node_modules/**", "**/.venv/**", "*.pyc", "*.log"],
    # "git": git が見ているものを実体とみなす（追跡中＋未追跡。.gitignore されたものは除く）
    # "files": ファイルシステムをそのまま歩く
    # "auto": .git があれば git、無ければ files（既定）
    "source": "auto",
    # 直下のものがツリーに載っているかも確かめるか
    "require_listed": True,
    # ツリーが 1 つも無いときに失敗にするか
    # （段階的に入れていく途中は false にしておく）
    "require_tree": True,
}

# ┣ ┗ の後ろの 📂 / 📜 の名前を拾う。後ろの「… 説明」「※注記」は落とす
ENTRY = re.compile(r"[📂📜]\s*([^\s…※]+)")
FENCE = re.compile(r"```[a-zA-Z]*\n(.*?)```", re.S)


def find_root(start: Path) -> Path:
    """設定ファイル、無ければ .git のある場所を探す。どちらも無ければ 1 つ上。"""
    for parent in [start, *start.parents]:
        if (parent / CONFIG_NAME).exists():
            return parent
    for parent in [start, *start.parents]:
        if (parent / ".git").exists():
            return parent
    return start.parent if start.parent != start else start


def load_config(root: Path) -> dict:
    config = dict(DEFAULTS)
    path = root / CONFIG_NAME
    if path.exists():
        try:
            config.update(json.loads(path.read_text(encoding="utf-8")))
        except json.JSONDecodeError as error:
            sys.exit(f"{path} を読めませんでした: {error}")
    return config


def tree_blocks(text: str) -> list[tuple[str, list[str]]]:
    blocks = []
    for body in FENCE.findall(text):
        lines = body.splitlines()
        if not lines or not lines[0].lstrip().startswith("📦"):
            continue
        names = [m.group(1).rstrip("/") for line in lines[1:] if (m := ENTRY.search(line))]
        blocks.append((lines[0].strip(), names))
    return blocks


def git_files(root: Path) -> list[str] | None:
    # --cached --others --exclude-standard で「追跡中＋未追跡（.gitignore されたものを除く）」。
    # ⚠ --cached だけにしない。配置した直後のファイルがまだコミットされておらず、
    #    「実体に無い」と誤検出される（実際に踏んだ）
    # ⚠ -z を付ける。付けないと git が日本語のパスを "\343\203\225..." の形で
    #    クォートして返し、名前が壊れる（core.quotePath の既定が true のため）
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return [item for item in result.stdout.split("\0") if item]


def collect(root: Path, config: dict) -> tuple[set[str], set[str], str]:
    """(全階層の名前, 直下の名前, 使った方式) を返す。"""
    ignore = config["ignore"]
    source = config["source"]
    paths: list[str] = []
    used = "files"

    if source in ("git", "auto"):
        listed = git_files(root)
        # ⚠ 空のときは git を使わない。まだ 1 つもコミットしていないリポジトリで、
        #    全ファイルが「実体に無い」と出てしまうため（実際に踏んだ）
        if listed is not None and not listed and source == "auto":
            print("※ git の管理対象が 0 件のため、ファイルシステムを見ます"
                  "（まだコミットしていないリポジトリのようです）")
            listed = None
        if listed is not None:
            used = "git"
            # git は「ファイル」しか返さないので、途中のフォルダを補う
            expanded = set(listed)
            for item in listed:
                parts = Path(item).parts
                for i in range(1, len(parts)):
                    expanded.add("/".join(parts[:i]))
            paths = sorted(expanded)
        elif source == "git":
            sys.exit("git の管理情報を読めませんでした（source を \"files\" にしてください）。")

    if used == "files":
        for path in root.rglob("*"):
            rel = path.relative_to(root)
            if ".git" in rel.parts:
                continue
            paths.append(rel.as_posix())

    everything: set[str] = set()
    top: set[str] = set()
    for rel in paths:
        if any(fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(Path(rel).name, pattern)
               for pattern in ignore):
            continue
        name = Path(rel).name
        everything.add(name)
        if "/" not in rel and not name.startswith("."):
            top.add(name)
    return everything, top, used


def main() -> int:
    parser = argparse.ArgumentParser(description="ドキュメントのツリーと実体を照合する")
    parser.add_argument("--root", help="対象のリポジトリ（既定: 設定ファイルか .git のある場所）")
    parser.add_argument("--list", action="store_true", help="実体の一覧だけ表示する")
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    root = Path(args.root).resolve() if args.root else find_root(here)
    config = load_config(root)
    everything, top, used = collect(root, config)

    if args.list:
        print(f"# {root} の直下（{used} で取得）")
        for name in sorted(top):
            print(name)
        return 0

    docs: list[Path] = []
    for pattern in config["docs"]:
        docs.extend(sorted(root.glob(pattern)))
    docs = sorted(set(docs))

    failures: list[str] = []

    def check(condition: bool, message: str) -> None:
        print(f"  {'OK  ' if condition else 'NG  '} {message}")
        if not condition:
            failures.append(message)

    checked = 0
    for doc in docs:
        for header, names in tree_blocks(doc.read_text(encoding="utf-8")):
            if "※照合しない" in header:
                continue
            checked += 1
            print(f"\n{doc.relative_to(root)} の {header}")

            missing = [n for n in names if n not in everything]
            check(not missing,
                  "ツリーに書かれたものが実体にある"
                  + (f"（無い: {', '.join(missing)}）" if missing else ""))

            listed = set(names)
            if config["require_listed"] and (top & listed):
                unlisted = sorted(t for t in top if t not in listed)
                check(not unlisted,
                      "直下のものがツリーに載っている"
                      + (f"（載っていない: {', '.join(unlisted)}）" if unlisted else ""))

    if checked == 0:
        print(f"照合できるツリーが {root} に見つかりませんでした。")
        print(f"（探した場所: {', '.join(config['docs'])} ／ 📦 で始まる ``` ブロック）")
        if not config["require_tree"]:
            print("require_tree が false のため、これは失敗として扱いません。")
            return 0
        return 1

    print()
    if failures:
        print(f"{len(failures)} 件の食い違いがあります。ドキュメントのツリーを実体に合わせてください。")
        print("実体の一覧は `python3 check_tree.py --list` で出せます。")
        return 1
    print(f"ツリー {checked} 件は実体と一致しています（{used} で取得）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
