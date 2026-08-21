"""リンク切れ検査を確かめる。

  python3 tests/test_check_links.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "check_links.py"
_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def build(work: Path, page: str, siblings: list[str] | None = None, others: list[str] | None = None) -> None:
    (work / "scripts").mkdir(parents=True, exist_ok=True)
    (work / "scripts" / "check_links.py").write_text(CHECKER.read_text(encoding="utf-8"), encoding="utf-8")
    (work / "repos.json").write_text(json.dumps(
        {"groups": [], "expected_sibling_pages": siblings or []}, ensure_ascii=False), encoding="utf-8")
    (work / "ページ.md").write_text(page, encoding="utf-8")
    for name in others or []:
        (work / name).write_text("# あるページ\n", encoding="utf-8")


def run(work: Path) -> tuple[int, str]:
    r = subprocess.run([sys.executable, str(work / "scripts" / "check_links.py")],
                       capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout + r.stderr


def main() -> None:
    print("リンク切れ検査")
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)

        work = base / "ok"
        build(work, "# ページ\n\n[表示][app] と [別ページ](別.md)\n\n[app]: https://example.com/app\n",
              others=["別.md"])
        code, out = run(work)
        check(code == 0, "定義済みの参照リンクと、存在する相対リンクは通る")

        work = base / "undefined"
        build(work, "# ページ\n\n[表示][app] と [別][doc]\n\n[app]: https://example.com/app\n")
        code, out = run(work)
        check(code == 1 and "doc" in out, "定義の無い参照リンクを検出する")

        work = base / "broken"
        build(work, "# ページ\n\n[無い](存在しない.md)\n")
        code, out = run(work)
        check(code == 1 and "存在しない.md" in out, "存在しない相対リンクを検出する")

        work = base / "sibling"
        build(work, "# ページ\n\n[配置先にある](フォルダ構成.md)\n", siblings=["フォルダ構成.md"])
        code, out = run(work)
        check(code == 0, "配置先にある前提のページは通す")

        work = base / "external"
        build(work, "# ページ\n\n[外部](https://example.com) [見出し](#anchor)\n")
        code, out = run(work)
        check(code == 0, "URL とページ内アンカーは対象外")

        work = base / "code"
        build(work, "# ページ\n\n```\n[書き方の例][ここは定義しない]\n```\n")
        code, out = run(work)
        check(code == 0, "コードブロック内の例は対象外")

        work = base / "image"
        build(work, "# ページ\n\n![図](画像.png)\n")
        code, out = run(work)
        check(code == 0, "画像は対象外（.md ではないため）")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
