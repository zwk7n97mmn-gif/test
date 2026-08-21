"""参照リポジトリ一覧の食い違い検査を確かめる。

  python3 tests/test_check_sync.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "check_sync.py"
_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def run_in(work: Path) -> tuple[int, str]:
    """work をキットのルートに見立てて検査を走らせる。"""
    result = subprocess.run(
        [sys.executable, str(work / "scripts" / "check_sync.py")],
        capture_output=True, text=True, timeout=60,
    )
    return result.returncode, result.stdout + result.stderr


def build(work: Path, paths: list[str], skill_paths: list[str], doc_paths: list[str]) -> None:
    (work / "scripts").mkdir(parents=True, exist_ok=True)
    (work / "skills" / "issue-ai-reply").mkdir(parents=True, exist_ok=True)
    (work / "docs").mkdir(parents=True, exist_ok=True)
    (work / "scripts" / "check_sync.py").write_text(CHECKER.read_text(encoding="utf-8"), encoding="utf-8")
    (work / "refs.json").write_text(
        json.dumps({"repos": [{"path": p, "repo": f"org/{p}", "ref": "main"} for p in paths]},
                   ensure_ascii=False), encoding="utf-8")
    skill = "# スキル\n\n| ディレクトリ | 内容 |\n| --- | --- |\n"
    skill += "".join(f"| `{p}` | 説明 |\n" for p in skill_paths)
    skill += "\n```\nコードブロック内の `src` は数えない\n```\n"
    (work / "skills" / "issue-ai-reply" / "SKILL.md").write_text(skill, encoding="utf-8")
    doc = "# 運用仕様\n\n" + "".join(f"- `{p}` … 説明\n" for p in doc_paths)
    (work / "docs" / "運用仕様.md").write_text(doc, encoding="utf-8")


def main() -> None:
    print("参照リポジトリ一覧の食い違い検査")

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "kit"
        build(work, ["src", "docs"], ["src", "docs"], ["src", "docs"])
        code, out = run_in(work)
        check(code == 0, "3 か所が一致していれば通る")
        check("一致しています" in out, "一致した旨を表示する")

        build(work, ["src", "docs", "wiki"], ["src", "docs"], ["src", "docs", "wiki"])
        code, out = run_in(work)
        check(code == 1, "SKILL.md に載っていない参照先があれば失敗する")
        check("wiki" in out and "SKILL.md" in out, "どのファイルに何が足りないかを示す")

        build(work, ["src", "docs"], ["src", "docs"], ["src"])
        code, out = run_in(work)
        check(code == 1, "運用仕様.md に載っていない参照先があれば失敗する")
        check("docs" in out, "不足している path 名を出す")

        build(work, ["src", "src"], ["src"], ["src"])
        code, out = run_in(work)
        check(code == 1, "path が重複していれば失敗する")
        check("重複" in out, "重複を理由として示す")

        build(work, ["a/b"], ["a/b"], ["a/b"])
        code, out = run_in(work)
        check(code == 1, "path にスラッシュが入っていれば失敗する")

        # コードブロック内の記述は根拠にしない
        build(work, ["src"], [], ["src"])
        code, out = run_in(work)
        check(code == 1, "コードブロック内の記述は「載っている」と数えない")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
