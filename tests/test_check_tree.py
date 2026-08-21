"""ドキュメントのツリーと実体の食い違い検査を確かめる。

  python3 tests/test_check_tree.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "check_tree.py"
_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def build(work: Path, files: list[str], tree: str, extra_doc: str = "") -> None:
    """work をキットのルートに見立てて、実体とドキュメントを用意する。"""
    for name in files:
        path = work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("dummy\n", encoding="utf-8")
    (work / "scripts").mkdir(parents=True, exist_ok=True)
    (work / "scripts" / "check_tree.py").write_text(CHECKER.read_text(encoding="utf-8"), encoding="utf-8")
    (work / "docs").mkdir(parents=True, exist_ok=True)
    (work / "docs" / "フォルダ構成.md").write_text(
        f"# フォルダ構成\n\n```\n{tree}```\n{extra_doc}", encoding="utf-8")


def run(work: Path) -> tuple[int, str]:
    result = subprocess.run([sys.executable, str(work / "scripts" / "check_tree.py")],
                            capture_output=True, text=True, timeout=60)
    return result.returncode, result.stdout + result.stderr


def main() -> None:
    print("ツリーと実体の食い違い検査")

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)

        # 一致している場合
        work = base / "ok"
        build(work, ["tools/a.bat", "tools/b.bat", "README.md"],
              "📦kit\n ┣ 📂tools\n ┃ ┣ 📜a.bat\n ┃ ┗ 📜b.bat\n ┣ 📂scripts\n ┣ 📂docs\n ┗ 📜README.md\n")
        code, out = run(work)
        check(code == 0, "ツリーと実体が一致していれば通る")
        check("一致しています" in out, "一致した旨を表示する")

        # ツリーにあるのに実体が無い（消したのに書き残している）
        work = base / "ghost"
        build(work, ["tools/a.bat", "README.md"],
              "📦kit\n ┣ 📂tools\n ┃ ┣ 📜a.bat\n ┃ ┗ 📜b.bat\n ┣ 📂scripts\n ┣ 📂docs\n ┗ 📜README.md\n")
        code, out = run(work)
        check(code == 1, "実体に無いものがツリーにあれば失敗する")
        check("b.bat" in out, "どの名前が実体に無いかを出す")

        # 実体にあるのにツリーに無い（増やしたのに書き足し忘れ）
        # ＝いただいた 2 ページで起きていた「11.（番号指定）〜.bat が片方に無い」と同じ形
        work = base / "unlisted"
        build(work, ["tools/a.bat", "README.md", "extra.txt"],
              "📦kit\n ┣ 📂tools\n ┃ ┗ 📜a.bat\n ┣ 📂scripts\n ┣ 📂docs\n ┗ 📜README.md\n")
        code, out = run(work)
        check(code == 1, "直下に増えたものがツリーに無ければ失敗する")
        check("extra.txt" in out, "どの名前が載っていないかを出す")

        # ※照合しない を付けたツリーは飛ばす
        work = base / "skipped"
        build(work, ["README.md"],
              "📦other ※照合しない\n ┣ 📂存在しないフォルダ\n ┗ 📜存在しないファイル.txt\n",
              extra_doc="\n```\n📦kit\n ┣ 📂scripts\n ┣ 📂docs\n ┗ 📜README.md\n```\n")
        code, out = run(work)
        check(code == 0, "※照合しない のツリーは対象外にする")
        check("存在しないフォルダ" not in out, "対象外のツリーの中身は報告しない")

        # 説明つきの行も名前だけを拾う
        work = base / "annotated"
        build(work, ["tools/a.bat", "README.md"],
              "📦kit\n ┣ 📂tools　　　　※要uv sync\n ┃ ┗ 📜a.bat … 何かをするバッチ\n"
              " ┣ 📂scripts\n ┣ 📂docs\n ┗ 📜README.md\n")
        code, out = run(work)
        check(code == 0, "「… 説明」や「※注記」が付いていても名前を拾える")

        # ツリーが 1 つも無ければ、通したことにしない
        work = base / "notree"
        build(work, ["README.md"], "")
        (work / "docs" / "フォルダ構成.md").write_text("# 見出しだけ\n", encoding="utf-8")
        code, out = run(work)
        check(code == 1, "ツリーが見つからなければ失敗として扱う")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
