#!/usr/bin/env python3
"""wiki リポジトリの決まりごとを検査する。

    python3 scripts/wiki_lint.py            # 全部を確かめる
    python3 scripts/wiki_lint.py --only links,images
    python3 scripts/wiki_lint.py --root ../your-wiki

目次（README）とページが数百に育つと、人手では守り切れなくなります。
規約そのものは CLAUDE.md に書いてあるので、ここでは**守れているか**だけを見ます。

## 見るもの

| 検査 | 見つかるもの |
| --- | --- |
| links       | リンク先のページが無い（消した・改名した） |
| wrapping    | 括弧や空白を含むリンクを <> で囲んでいない（表示が壊れる） |
| anchors     | 目次のジャンプ先 <a id="..."> が無い／使われていない |
| filenames   | 目次の表記とファイル名が食い違う |
| orphans     | どこからも辿れないページ |
| breadcrumbs | ページ先頭の見出し・パンくずが無い |
| images      | 画像・動画の参照先が無い／ルート起点の絶対パスになっている |

設定は wiki-lint.json（無くても既定値で動く）。依存なし・Python 3.9 以上。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

CONFIG_NAME = "wiki-lint.json"

DEFAULTS = {
    "readme": "README.md",
    "image_dir": "_image",
    # 検査の対象から外すページ（規約の説明そのものなど）
    "exclude": ["CLAUDE.md", "templates/**", ".github/**", ".gitea/**"],
    # 目次から辿れなくてよいページ
    "allow_orphan": [],
    "checks": {
        "links": True, "wrapping": True, "anchors": True,
        "filenames": True, "orphans": True, "breadcrumbs": True, "images": True,
    },
    # 1 つの検査で並べる件数の上限（多すぎると読めないため）
    "max_report": 10,
}

# リンク: [表示](<パス>) と [表示](パス)
LINK_ANGLE = re.compile(r"(?<!\!)\[([^\]\n]+)\]\(<([^>\n]+)>\)")
LINK_PLAIN = re.compile(r"(?<!\!)\[([^\]\n]+)\]\(([^<>()\s]+)\)")
IMAGE_ANGLE = re.compile(r"!\[[^\]\n]*\]\(<([^>\n]+)>\)")
IMAGE_PLAIN = re.compile(r"!\[[^\]\n]*\]\(([^<>()\s]+)\)")
SRC_TAG = re.compile(r'<(?:img|video)[^>]*\ssrc="([^"]+)"')
ANCHOR_DEF = re.compile(r'<a id="([^"]+)">')
ANCHOR_USE = re.compile(r"\]\(#([^)\n]+)\)")
FENCE = re.compile(r"```.*?```", re.S)

# 絵文字・異体字セレクタ・ZWJ。ファイル名からは落とす決まり
EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF←-⇿⌀-➿⬀-⯿️‍⃣™ℹ]"
)
# Windows で使えない文字。ファイル名では ・ に置き換える決まり
FORBIDDEN = '/\\:*?"<>|'


def find_root(start: Path) -> Path:
    for parent in [start, *start.parents]:
        if (parent / CONFIG_NAME).exists():
            return parent
    for parent in [start, *start.parents]:
        if (parent / ".git").exists():
            return parent
    return start.parent if start.parent != start else start


def load_config(root: Path) -> dict:
    config = json.loads(json.dumps(DEFAULTS))
    path = root / CONFIG_NAME
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            sys.exit(f"{path} を読めませんでした: {error}")
        checks = {**config["checks"], **loaded.pop("checks", {})}
        config.update(loaded)
        config["checks"] = checks
    return config


def normalize_name(text: str) -> str:
    """目次の表記 → ファイル名（拡張子なし）。

    絵文字と装飾（`` **）を落とし、Windows で使えない文字を ・ に置き換える。
    装飾はファイル名に入らないため、比較の前に外す。
    ⚠ アンダースコアは落とさない。`jinkyu_tools` `_system定義値` のように、
      ファイル名そのものに含まれるため。
    """
    name = EMOJI.sub("", text)
    name = re.sub(r"[`*]+", "", name).strip()
    for char in FORBIDDEN:
        name = name.replace(char, "・")
    return name.strip()


def is_external(target: str) -> bool:
    return target.startswith(("http://", "https://", "mailto:", "#"))


class Linter:
    def __init__(self, root: Path, config: dict):
        self.root = root
        self.config = config
        self.max = config["max_report"]
        self.failures: list[str] = []
        self.pages = self._pages()

    def _excluded(self, rel: Path) -> bool:
        return any(rel.match(pattern) or rel.as_posix().startswith(pattern.rstrip("*/"))
                   for pattern in self.config["exclude"])

    def _pages(self) -> list[Path]:
        pages = []
        for path in sorted(self.root.rglob("*.md")):
            rel = path.relative_to(self.root)
            if ".git" in rel.parts or self._excluded(rel):
                continue
            pages.append(path)
        return pages

    def report(self, ok: bool, label: str, details: list[str] | None = None) -> None:
        print(f"  {'OK  ' if ok else 'NG  '} {label}")
        if not ok:
            self.failures.append(label)
            for line in (details or [])[: self.max]:
                print(f"         {line}")
            if details and len(details) > self.max:
                print(f"         … 他 {len(details) - self.max} 件")

    # --- 個々の検査 ---

    def check_links(self) -> None:
        broken = []
        for page in self.pages:
            text = FENCE.sub("", page.read_text(encoding="utf-8"))
            for _, target in [*LINK_ANGLE.findall(text), *LINK_PLAIN.findall(text)]:
                if is_external(target):
                    continue
                name = target.split("#")[0]
                if name and not (page.parent / name).exists():
                    broken.append(f"{page.relative_to(self.root)} → {target}")
        self.report(not broken, f"リンク先のページがある（{len(broken)} 件切れ）", broken)

    def check_wrapping(self) -> None:
        risky = []
        for page in self.pages:
            text = FENCE.sub("", page.read_text(encoding="utf-8"))
            # <> で囲っていないのに、パスに括弧や空白が入っているもの
            for match in re.finditer(r"(?<!\!)\[([^\]\n]+)\]\(([^<)\n][^)\n]*)\)", text):
                target = match.group(2)
                if is_external(target):
                    continue
                if "(" in target or " " in target or "　" in target:
                    risky.append(f"{page.relative_to(self.root)} → {target}")
        self.report(not risky,
                    f"括弧や空白を含むリンクを <> で囲んでいる（{len(risky)} 件）", risky)

    def check_anchors(self) -> None:
        problems = []
        for page in self.pages:
            text = page.read_text(encoding="utf-8")
            defined = set(ANCHOR_DEF.findall(text))
            used = set(ANCHOR_USE.findall(FENCE.sub("", text)))
            for anchor in sorted(used - defined):
                problems.append(f"{page.relative_to(self.root)}: #{anchor} の飛び先が無い")
            for anchor in sorted(defined - used):
                problems.append(f"{page.relative_to(self.root)}: id=\"{anchor}\" はどこからも使われていない")
        self.report(not problems, f"目次のジャンプ先がそろっている（{len(problems)} 件）", problems)

    def check_filenames(self) -> None:
        mismatched = []
        readme = self.root / self.config["readme"]
        if not readme.exists():
            self.report(False, f"{self.config['readme']} がある")
            return
        text = FENCE.sub("", readme.read_text(encoding="utf-8"))
        # 同じページを別の表記で参照することがある（本文中からの言及など）。
        # 1 つでもファイル名と揃った表記があれば、そのページは登録済みとみなす。
        labels: dict[str, list[str]] = {}
        for label, target in [*LINK_ANGLE.findall(text), *LINK_PLAIN.findall(text)]:
            if is_external(target) or not target.endswith(".md"):
                continue
            labels.setdefault(target, []).append(label)
        for target, texts in labels.items():
            actual = Path(target).stem
            if any(normalize_name(label) == actual for label in texts):
                continue
            shown = "／".join(f"「{label}」" for label in dict.fromkeys(texts))
            mismatched.append(f"{target} … 目次の表記 {shown}（期待: {actual}）")
        self.report(not mismatched,
                    f"目次の表記とファイル名がそろっている（{len(mismatched)} 件）", mismatched)

    def check_orphans(self) -> None:
        referenced = set()
        for page in self.pages:
            text = FENCE.sub("", page.read_text(encoding="utf-8"))
            for _, target in [*LINK_ANGLE.findall(text), *LINK_PLAIN.findall(text)]:
                if is_external(target):
                    continue
                name = target.split("#")[0]
                if name:
                    resolved = (page.parent / name).resolve()
                    referenced.add(resolved)
        allow = {(self.root / p).resolve() for p in self.config["allow_orphan"]}
        allow.add((self.root / self.config["readme"]).resolve())
        orphans = [str(p.relative_to(self.root)) for p in self.pages
                   if p.resolve() not in referenced and p.resolve() not in allow]
        self.report(not orphans, f"どのページも目次から辿れる（{len(orphans)} 件孤立）", orphans)

    def check_breadcrumbs(self) -> None:
        problems = []
        readme = (self.root / self.config["readme"]).resolve()
        for page in self.pages:
            if page.resolve() == readme:
                continue
            head = page.read_text(encoding="utf-8").split("\n", 6)[:6]
            rel = page.relative_to(self.root)
            if not head or not head[0].startswith("# "):
                problems.append(f"{rel}: 1 行目が「# タイトル」でない")
            elif not any("📍" in line for line in head):
                problems.append(f"{rel}: パンくず（📍）が先頭付近に無い")
        self.report(not problems, f"見出しとパンくずがある（{len(problems)} 件）", problems)

    def check_images(self) -> None:
        problems = []
        for page in self.pages:
            # 書き方の例として貼った画像で落ちないよう、コードブロックの中は見ない
            text = FENCE.sub("", page.read_text(encoding="utf-8"))
            targets = [*IMAGE_ANGLE.findall(text), *IMAGE_PLAIN.findall(text), *SRC_TAG.findall(text)]
            for target in targets:
                if target.startswith(("http://", "https://", "data:")):
                    continue
                rel = page.relative_to(self.root)
                if target.startswith("/"):
                    problems.append(f"{rel}: {target} … ルート起点の絶対パスは Gitea で表示されない")
                    continue
                if not (page.parent / target).exists():
                    problems.append(f"{rel}: {target} … 参照先が無い")
        self.report(not problems, f"画像・動画の参照先がある（{len(problems)} 件）", problems)

    def run(self, only: set[str] | None) -> int:
        checks = {
            "links": self.check_links, "wrapping": self.check_wrapping,
            "anchors": self.check_anchors, "filenames": self.check_filenames,
            "orphans": self.check_orphans, "breadcrumbs": self.check_breadcrumbs,
            "images": self.check_images,
        }
        print(f"{self.root} を検査します（ページ {len(self.pages)} 件）\n")
        ran = 0
        for name, func in checks.items():
            if only is not None and name not in only:
                continue
            if only is None and not self.config["checks"].get(name, True):
                print(f"  --   {name}（設定で無効）")
                continue
            func()
            ran += 1
        if ran == 0:
            print("実行する検査がありません。")
            return 1
        print()
        if self.failures:
            print(f"{len(self.failures)} 件の検査で問題が見つかりました。")
            print("決まりごとは CLAUDE.md にあります。")
            return 1
        print("すべての検査を通りました。")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="wiki リポジトリの決まりごとを検査する")
    parser.add_argument("--root", help="対象の wiki（既定: 設定ファイルか .git のある場所）")
    parser.add_argument("--only", help="実行する検査をカンマ区切りで指定する")
    args = parser.parse_args()

    root = Path(args.root).resolve() if args.root else find_root(Path(__file__).resolve().parent)
    config = load_config(root)
    only = {name.strip() for name in args.only.split(",")} if args.only else None
    return Linter(root, config).run(only)


if __name__ == "__main__":
    sys.exit(main())
