"""ツリー照合の動きを確かめる。

  python3 tests/test_check_tree.py

一時ディレクトリに偽のリポジトリを作って動かします。外部への通信はしません。
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "check_tree.py"
_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def make(work: Path, files: list[str], readme: str, config: dict | None = None,
         git: bool = False, commit: bool = True) -> None:
    work.mkdir(parents=True, exist_ok=True)
    (work / "tools").mkdir(exist_ok=True)
    (work / "tools" / "check_tree.py").write_text(CHECKER.read_text(encoding="utf-8"), encoding="utf-8")
    for name in files:
        path = work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("dummy\n", encoding="utf-8")
    (work / "README.md").write_text(readme, encoding="utf-8")
    if config is not None:
        (work / "check-tree.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    if git:
        run_git = lambda *a: subprocess.run(["git", "-C", str(work), *a],
                                            capture_output=True, text=True)
        run_git("init", "-q")
        run_git("config", "user.email", "t@example.com")
        run_git("config", "user.name", "t")
        if commit:
            run_git("add", "-A")
            run_git("commit", "-qm", "init")


def run(work: Path, *args: str) -> tuple[int, str]:
    result = subprocess.run([sys.executable, str(work / "tools" / "check_tree.py"), *args],
                            capture_output=True, text=True, timeout=60, cwd=str(work))
    return result.returncode, result.stdout + result.stderr


def tree(*extra: str, name: str = "kit") -> str:
    """テスト用のツリー。直下に置くものを漏れなく書く（照合の対象になるため）。"""
    lines = [" ┣ 📂tools", " ┣ 📂src", " ┃ ┗ 📜a.py", *extra, " ┗ 📜README.md"]
    return "# R\n\n```\n📦" + name + "\n" + "\n".join(lines) + "\n```\n"


# 設定ファイルを置く場合のツリー（既定の使い方）
TREE = tree(" ┣ 📜check-tree.json")
# 設定ファイルを置かない場合
TREE_NOCONFIG = tree()


def main() -> None:
    print("ツリー照合")
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)

        # --- 基本 ---
        w = base / "ok"; make(w, ["src/a.py"], TREE, config={})
        code, out = run(w)
        check(code == 0, "ツリーと実体が一致していれば通る")

        w = base / "ghost"; make(w, [], TREE, config={})
        code, out = run(w)
        check(code == 1 and "a.py" in out, "実体に無いものがツリーにあれば失敗する")

        w = base / "unlisted"; make(w, ["src/a.py", "extra.txt"], TREE, config={})
        code, out = run(w)
        check(code == 1 and "extra.txt" in out, "直下に増えたものがツリーに無ければ失敗する")

        # --- 書き方の許容 ---
        w = base / "annotated"
        make(w, ["src/a.py"],
             "# R\n\n```\n📦kit\n ┣ 📂tools　※要uv sync\n ┣ 📂src\n ┃ ┗ 📜a.py … 説明\n"
             " ┣ 📜check-tree.json\n ┗ 📜README.md\n```\n",
             config={})
        code, out = run(w)
        check(code == 0, "「… 説明」「※注記」が付いていても名前を拾える")

        w = base / "skip"
        make(w, ["src/a.py"],
             "# R\n\n```\n📦例 ※照合しない\n ┗ 📜無いファイル.txt\n```\n\n" + TREE.split("\n\n", 1)[1],
             config={})
        code, out = run(w)
        check(code == 0 and "無いファイル" not in out, "※照合しない のツリーは対象外にする")

        # --- 設定 ---
        w = base / "ignore"
        make(w, ["src/a.py", "_output/gen.sql"], TREE, config={"ignore": ["_output/**", "_output"]})
        code, out = run(w)
        check(code == 0, "ignore に書いたものは実体から外れる")

        w = base / "nolisted"
        make(w, ["src/a.py", "extra.txt"], TREE, config={"require_listed": False})
        code, out = run(w)
        check(code == 0, "require_listed が false なら、載っていなくても通る")

        w = base / "notree"
        make(w, ["src/a.py"], "# R\n\nツリーなし\n", config={"require_tree": False})
        code, out = run(w)
        check(code == 0, "require_tree が false なら、ツリーが無くても通る")

        w = base / "notree2"
        make(w, ["src/a.py"], "# R\n\nツリーなし\n", config={})
        code, out = run(w)
        check(code == 1, "既定では、ツリーが無ければ失敗にする")

        w = base / "docsglob"
        make(w, ["src/a.py"], "# R\n\nここにツリーは無い\n", config={"docs": ["docs/*.md"]})
        (w / "docs").mkdir()
        (w / "docs" / "構成.md").write_text(tree(" ┣ 📂docs", " ┣ 📜check-tree.json"), encoding="utf-8")
        code, out = run(w)
        check(code == 0 and "構成.md" in out, "docs で探す場所を変えられる")

        # --- git の扱い ---
        w = base / "gitrepo"
        make(w, ["src/a.py"], TREE, config={}, git=True)
        (w / ".gitignore").write_text("生成物/\n", encoding="utf-8")
        (w / "生成物").mkdir()
        (w / "生成物" / "out.sql").write_text("x\n", encoding="utf-8")
        code, out = run(w)
        check(code == 0 and "git で取得" in out, "git があれば .gitignore されたものを実体から外す")

        w = base / "gitnew"
        make(w, ["src/a.py"], TREE, config={}, git=True)
        (w / "配置直後.txt").write_text("x\n", encoding="utf-8")
        code, out = run(w)
        check(code == 1 and "配置直後.txt" in out,
              "コミット前のファイルも実体として数える（配置直後に誤検出しない）")

        code, out = run(base / "gitrepo", "--root", str(base / "gitrepo"))
        check(code == 0, "--root で対象を指定できる")

        w2 = base / "gitfiles"
        make(w2, ["src/a.py"], TREE, config={"source": "files"}, git=True)
        (w2 / ".gitignore").write_text("生成物/\n", encoding="utf-8")
        (w2 / "生成物").mkdir()
        (w2 / "生成物" / "out.sql").write_text("x\n", encoding="utf-8")
        code, out = run(w2)
        check(code == 1 and "生成物" in out, "source が files なら .gitignore されたものも実体として数える")

        w3 = base / "gitempty"
        make(w3, ["src/a.py"], TREE, config={}, git=True, commit=False)
        code, out = run(w3)
        check(code == 0, "まだコミットが無いリポジトリでも誤検出しない")

        # --- 一覧の出力 ---
        w = base / "listing"; make(w, ["src/a.py", "b.txt"], TREE, config={})
        code, out = run(w, "--list")
        check(code == 0 and "b.txt" in out and "src" in out, "--list で実体の一覧を出せる")

        # --- 設定ファイルが無くても動く ---
        w = base / "noconfig"; make(w, ["src/a.py"], TREE_NOCONFIG)
        code, out = run(w)
        check(code == 0, "設定ファイルが無くても既定値で動く")

        # --- 壊れた設定 ---
        w = base / "badconfig"; make(w, ["src/a.py"], TREE_NOCONFIG)
        (w / "check-tree.json").write_text("{壊れた", encoding="utf-8")
        code, out = run(w)
        check(code != 0 and "読めませんでした" in out, "設定ファイルが壊れていたら理由を出して止まる")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
