#!/usr/bin/env python3
"""売り始める前に、抜けが無いかを機械で確かめる。

    python3 tools/preflight.py              # 全部見る
    python3 tools/preflight.py --quick      # テストと ZIP 作成を飛ばす（速い）
    python3 tools/preflight.py --channel own-site   # 売り方を一時的に変えて見る

どこで売るかは sales.json の channel で決めます。
  booth    … BOOTH などのプラットフォームで売る（特商法はプラットフォーム側）
  own-site … 自分のサイトで売る（特商法の掲載もこちらの責任）

販売の準備は項目が多く、1 つ抜けただけで「買えない」「使えない」が起きます。
人が目で追う代わりに、確かめられるものはここで確かめます。

依存なし・Python 3.9 以上。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p256  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
APP_HTML = ROOT / "app" / "taskdeck.html"
KEYS_DIR = ROOT / "keys"
PRIVATE_KEY = KEYS_DIR / "private.json"
LANDING = ROOT / "landing" / "index.html"
BOOTH_TEXT = ROOT / "landing" / "BOOTH商品説明.md"
LEGAL_DIR = ROOT / "legal"
SALES_CONFIG = ROOT / "sales.json"

# 〔　〕は「ここを自分の情報に置き換える」印。売る前に消えていないといけない
PLACEHOLDER = re.compile(r"〔[^〕]*〕")
# 差し替え忘れの見本アドレス
SAMPLE = re.compile(r"example\.(com|jp)|your-domain|xxx@|yourname", re.I)
# 配布 ZIP に必ず入っているもの
REQUIRED_IN_ZIP = ["TaskDeck.html", "はじめにお読みください", "使い方", "使用許諾契約書"]

_problems: list[str] = []
_notes: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    print(f"  {'OK  ' if ok else 'NG  '} {label}")
    if not ok:
        _problems.append(label)
        for line in detail.splitlines():
            if line.strip():
                print(f"         {line}")
    return ok


def skip(label: str, why: str) -> None:
    print(f"  --   {label}（{why}）")
    _notes.append(label)


def git(*args: str) -> tuple[int, str]:
    try:
        result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return 127, ""
    return result.returncode, result.stdout.strip()


def in_git_repo() -> bool:
    return git("rev-parse", "--is-inside-work-tree")[0] == 0


def find_placeholders(path: Path) -> list[str]:
    if not path.exists():
        return []
    found = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        for hit in PLACEHOLDER.findall(line):
            found.append(f"{path.relative_to(ROOT)}:{number} {hit}")
    return found


# --- 1. 鍵 -------------------------------------------------------------

def check_keys() -> None:
    print("\n1. 鍵")
    text = APP_HTML.read_text(encoding="utf-8") if APP_HTML.exists() else ""
    match = re.search(r'const LICENSE_PUBLIC_KEY = "([^"]*)";', text)
    embedded = match.group(1) if match else ""
    check(bool(embedded) and embedded != "__PUBLIC_KEY__",
          "アプリに公開鍵が入っている",
          "まだ入っていません。`python3 tools/keygen.py init` を実行してください。")

    has_private = PRIVATE_KEY.exists()
    check(has_private, "秘密鍵がある",
          f"{PRIVATE_KEY} がありません。`python3 tools/keygen.py init` を実行してください。")

    # 🚨 バックアップから戻した鍵が別物だと、発行したキーが購入者の手元で弾かれる。
    #    「発行はできるのに使えない」という一番わかりにくい壊れ方をするので、ここで見る
    if has_private and embedded and embedded != "__PUBLIC_KEY__":
        try:
            private = int(json.loads(PRIVATE_KEY.read_text(encoding="utf-8"))["private_key"], 16)
            derived = p256.public_to_hex(p256.public_from_private(private))
        except Exception as error:
            derived = f"（読めませんでした: {error}）"
        check(derived == embedded, "秘密鍵とアプリの公開鍵が対になっている",
              "アプリに入っている公開鍵は、この秘密鍵のものではありません。\n"
              "別の鍵のバックアップを戻した可能性があります。\n"
              "⚠ このまま発行すると、購入者の手元で「正しくありません」と出ます。\n"
              f"  アプリの公開鍵 : {embedded}\n"
              f"  秘密鍵から作った公開鍵 : {derived}")

    if not in_git_repo():
        skip("秘密鍵が Git に入っていない", "Git 管理下ではない")
        return
    # 🚨 ここが漏れると、誰でもライセンスを発行できるようになる
    code, tracked = git("ls-files", "keys/")
    check(not tracked, "秘密鍵が Git に入っていない",
          f"Git が追いかけています:\n{tracked}\n"
          "`git rm -r --cached keys/` で外し、.gitignore に keys/ があるか確かめてください。")
    code, _ = git("check-ignore", "-q", "keys/private.json")
    check(code == 0, "keys/ が .gitignore で除外されている",
          "このリポジトリの .gitignore に keys/ を足してください。\n"
          "⚠ 親フォルダの .gitignore は、切り出した先には付いてきません。")


# --- 2. 差し替え -------------------------------------------------------

def load_channel(override: str | None) -> str:
    if override:
        return override
    if SALES_CONFIG.exists():
        try:
            return json.loads(SALES_CONFIG.read_text(encoding="utf-8")).get("channel", "own-site")
        except json.JSONDecodeError as error:
            sys.exit(f"{SALES_CONFIG} を読めませんでした: {error}")
    return "own-site"


def check_placeholders(channel: str) -> None:
    print("\n2. 自分の情報への差し替え")
    # ⚠ 売り方によって、置き換えが要るファイルが変わる。
    #   使わないページの〔　〕で止められても直しようがない
    if channel == "booth":
        targets = [BOOTH_TEXT, SALES_CONFIG, *sorted(LEGAL_DIR.glob("*.md"))]
    else:
        targets = [LANDING, *sorted(LEGAL_DIR.glob("*.md"))]
    remaining = [hit for path in targets for hit in find_placeholders(path)]
    check(not remaining, "〔　〕の置き換えが済んでいる", "\n".join(remaining[:15]))

    samples = []
    for path in targets:
        if not path.exists():
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if SAMPLE.search(line):
                samples.append(f"{path.relative_to(ROOT)}:{number} {line.strip()[:70]}")
    check(not samples, "見本のアドレスが残っていない", "\n".join(samples[:10]))


# --- 3. 販売ページ -----------------------------------------------------

def check_landing() -> None:
    print("\n3. 販売ページ")
    if not LANDING.exists():
        check(False, "販売ページがある", f"{LANDING} がありません。")
        return
    text = LANDING.read_text(encoding="utf-8")

    broken = []
    for target in re.findall(r'href="([^"#][^"]*)"', text):
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        # 〔　〕はひとつ上の検査で報告済み。同じことを二度言わない
        if PLACEHOLDER.search(target):
            continue
        if not (LANDING.parent / target).exists():
            broken.append(target)
    check(not broken, "販売ページからのリンクが切れていない", "\n".join(broken))

    # 決済リンクが 1 つも無いと、見た人が買えない
    payment = [url for url in re.findall(r'href="(https?://[^"]+)"', text)
               if not re.search(r"example\.|localhost", url)]
    check(bool(payment), "決済リンクが入っている",
          "landing/index.html に購入用の URL がありません。決済サービスで作った URL を入れてください。")

    # 法務ページへの導線。⚠ URL ではなく**リンクの文字**で見る。
    #   URL は差し替えられるが、リンクの文字は残るため
    anchors = re.findall(r"<a\s[^>]*href=\"([^\"]*)\"[^>]*>(.*?)</a>", text, re.S)
    for label, pattern in [("使用許諾契約書", "使用許諾"),
                           ("特定商取引法に基づく表記", "特定商取引法|特商法"),
                           ("プライバシーポリシー", "プライバシー")]:
        found = any(re.search(pattern, f"{href} {inner}") for href, inner in anchors)
        check(found, f"販売ページから「{label}」へリンクしている",
              f"{label} への導線が見つかりません。掲載したページへのリンクを footer に置いてください。")


# --- 4. 法務 -----------------------------------------------------------

def check_booth() -> None:
    """BOOTH で売るときの確認。特商法はプラットフォーム側なので、ここでは見ない。"""
    print("\n3. 商品ページ（BOOTH）")
    if not BOOTH_TEXT.exists():
        check(False, "商品説明の文面がある", f"{BOOTH_TEXT} がありません。")
        return
    text = BOOTH_TEXT.read_text(encoding="utf-8")

    # 🚨 手で発行する運用なので、待ち時間を先に伝えていないと必ず問い合わせになる
    check("ライセンスキーのお届けについて" in text, "キーが後から届くことを商品説明に書いている",
          "手でお送りする運用です。先に伝えていないと「キーが来ない」と言われます。")
    check("データの保存場所について" in text, "データが消える条件を商品説明に書いている",
          "ブラウザのデータを消すと復元できません。買う前に伝える必要があります。")
    check("動作環境" in text, "動作環境を商品説明に書いている")
    check("返金" in text, "返金の扱いを商品説明に書いている")

    if not SALES_CONFIG.exists():
        check(False, "商品ページの URL を控えてある", f"{SALES_CONFIG} がありません。")
        return
    urls = json.loads(SALES_CONFIG.read_text(encoding="utf-8")).get("product_urls", {})
    unset = [name for name, url in urls.items() if not url.startswith("http")]
    check(not unset, "商品ページの URL を控えてある",
          f"まだ置き換えていないもの: {'、'.join(unset)}\n"
          "BOOTH で出品し、商品ページの URL を sales.json に書いてください。")


def check_legal(channel: str) -> None:
    print("\n4. 法務")
    required = ["EULA.md", "PRIVACY.md"]
    if channel == "own-site":
        # 自分のサイトで売るなら、特商法の掲載はこちらの責任
        required.append("特定商取引法に基づく表記.md")
    else:
        skip("特定商取引法に基づく表記", "BOOTH 側の設定で行う")
    for name in required:
        path = LEGAL_DIR / name
        check(path.exists() and path.stat().st_size > 200, f"{name} がある（中身が入っている）",
              f"{path} が無いか、中身がほとんどありません。")


# --- 5. テストと配布物 -------------------------------------------------

def check_tests() -> None:
    print("\n5. テスト")
    script = ROOT / "tests" / "run_all.sh"
    result = subprocess.run(["bash", str(script)], cwd=ROOT, capture_output=True, text=True)
    check(result.returncode == 0, "テストが通る",
          "\n".join(result.stdout.strip().splitlines()[-12:]))


def check_build() -> None:
    print("\n6. 配布物")
    result = subprocess.run(["bash", str(ROOT / "tools" / "build.sh")],
                            cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        check(False, "配布 ZIP を作れる", "\n".join(result.stdout.strip().splitlines()[-12:]))
        return
    check(True, "配布 ZIP を作れる")

    zips = sorted((ROOT / "dist").glob("taskdeck-*.zip"))
    main_zip = next((path for path in zips if "-tax-" not in path.name), None)
    if not main_zip:
        check(False, "本体の ZIP がある", "dist/ に本体の ZIP が見当たりません。")
        return
    names = " ".join(zipfile.ZipFile(main_zip).namelist())
    missing = [item for item in REQUIRED_IN_ZIP if item not in names]
    check(not missing, f"{main_zip.name} に一式が入っている",
          f"入っていないもの: {'、'.join(missing)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="売り始める前の確認")
    parser.add_argument("--quick", action="store_true", help="テストと ZIP 作成を飛ばす")
    parser.add_argument("--channel", choices=["booth", "own-site"],
                        help="売り方（既定: sales.json の channel）")
    args = parser.parse_args()
    channel = load_channel(args.channel)

    print(f"売り始める前の確認（売り方: {'BOOTH などのプラットフォーム' if channel == 'booth' else '自分のサイト'}）")
    check_keys()
    check_placeholders(channel)
    if channel == "booth":
        check_booth()
    else:
        check_landing()
    check_legal(channel)
    if args.quick:
        print("\n5-6. テストと配布物")
        skip("テストと ZIP 作成", "--quick のため")
    else:
        check_tests()
        check_build()

    print()
    if _problems:
        print(f"{len(_problems)} 件、売り始める前に片付けるものがあります:")
        for item in _problems:
            print(f"  - {item}")
        print("\n手順は docs/SELLING-GUIDE.md にあります。")
        return 1
    print("確認できるものはすべて通りました。")
    print("残りは人にしか確かめられません（docs/OPERATIONS.md の「人の目で見る分」）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
