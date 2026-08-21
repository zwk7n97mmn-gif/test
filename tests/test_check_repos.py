"""リポジトリ一覧とページの照合を確かめる。

  python3 tests/test_check_repos.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "check_repos.py"
_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def build(work: Path, repos: list[dict], rows: list[dict], defs: list[str]) -> None:
    (work / "scripts").mkdir(parents=True, exist_ok=True)
    (work / "scripts" / "check_repos.py").write_text(CHECKER.read_text(encoding="utf-8"), encoding="utf-8")
    (work / "repos.json").write_text(json.dumps(
        {"gitea_base": "〔URL〕", "groups": [{"id": "g", "label": "g", "repos": repos}]},
        ensure_ascii=False), encoding="utf-8")
    table = "\n".join(f"| **[{r['name']}][{r['id']}]** | x | y | |" for r in rows)
    links = "\n".join(f"[{d}]: 〔URL〕/{d}" for d in defs)
    (work / "リポジトリ全体像.md").write_text(
        f"# リポジトリ全体像\n\n## 📦 リポジトリ一覧\n\n{table}\n\n{links}\n", encoding="utf-8")


def run(work: Path) -> tuple[int, str]:
    r = subprocess.run([sys.executable, str(work / "scripts" / "check_repos.py")],
                       capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout + r.stderr


def main() -> None:
    print("リポジトリ一覧とページの照合")
    A = {"id": "app", "name": "app", "summary": "s", "users": "u"}
    B = {"id": "doc", "name": "doc", "summary": "s", "users": "u"}

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)

        work = base / "ok"; build(work, [A, B], [A, B], ["app", "doc"])
        code, out = run(work)
        check(code == 0, "一覧・表・リンク定義が揃っていれば通る")

        work = base / "notable"; build(work, [A, B], [A], ["app", "doc"])
        code, out = run(work)
        check(code == 1 and "doc" in out, "表に載っていないリポジトリを検出する")

        work = base / "nolink"; build(work, [A, B], [A, B], ["app"])
        code, out = run(work)
        check(code == 1 and "リンク定義" in out, "リンク定義が無いリポジトリを検出する")

        work = base / "extra"; build(work, [A], [A], ["app", "消したはずのもの"])
        code, out = run(work)
        check(code == 1 and "消したはずのもの" in out, "消したリポジトリのリンク定義の残りを検出する")

        work = base / "dup"; build(work, [A, dict(A)], [A], ["app"])
        code, out = run(work)
        check(code == 1 and "重複" in out, "id の重複を検出する")

        work = base / "lack"
        build(work, [{"id": "app", "name": "app", "summary": "", "users": "u"}], [A], ["app"])
        code, out = run(work)
        check(code == 1 and "必須項目" in out, "説明が空のリポジトリを検出する")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
