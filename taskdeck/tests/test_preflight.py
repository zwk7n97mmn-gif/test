"""売り始める前の確認（preflight）を確かめる。

  python3 tests/test_preflight.py

一時フォルダに製品一式を写し、そこで「売れる状態」を作ってから確認を動かす。
⚠ 本番の鍵・販売ページ・法務ページには一切触れない。
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def run_preflight(work: Path) -> tuple[int, str]:
    result = subprocess.run([sys.executable, str(work / "tools" / "preflight.py"), "--quick"],
                            capture_output=True, text=True, timeout=120)
    return result.returncode, result.stdout + result.stderr


def build_sellable(work: Path) -> None:
    """「売れる状態」を作る。〔　〕を埋め、鍵を作る。"""
    shutil.copytree(ROOT, work, ignore=shutil.ignore_patterns(
        ".git", "keys", "dist", "node_modules", "__pycache__", "*.pyc"))

    subprocess.run([sys.executable, str(work / "tools" / "keygen.py"), "init"],
                   capture_output=True, text=True, timeout=120, check=True)

    fills = {
        "販売者名": "検証用テスト商店",
        "サポート窓口のメールアドレス": "support@test-shop.invalid",
        "YYYY": "2026",
    }
    for path in [work / "landing" / "index.html", *sorted((work / "legal").glob("*.md"))]:
        text = path.read_text(encoding="utf-8")
        # 決済・ダウンロード・法務の URL は本物の形にする（決済リンクの検査を通すため）
        text = re.sub(r"〔([^〕]*(?:URL|決済リンク)[^〕]*)〕",
                      lambda m: "https://test-shop.invalid/" + str(abs(hash(m.group(1))) % 1000), text)
        for needle, value in fills.items():
            text = text.replace(f"〔{needle}〕", value)
        text = re.sub(r"〔[^〕]*〕", "検証用", text)
        path.write_text(text, encoding="utf-8")


def main() -> None:
    print("売り始める前の確認")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "taskdeck"
        build_sellable(work)

        code, out = run_preflight(work)
        check(code == 0, "準備が済んでいれば通る")
        if code != 0:
            print(out)

        # --- 鍵 ---
        app = work / "app" / "taskdeck.html"
        saved = app.read_text(encoding="utf-8")
        app.write_text(re.sub(r'(const LICENSE_PUBLIC_KEY = ")[^"]*(")',
                              r"\1__PUBLIC_KEY__\2", saved), encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 1 and "アプリに公開鍵が入っている" in out, "公開鍵が未設定なら止める")
        app.write_text(saved, encoding="utf-8")

        private = work / "keys" / "private.json"
        kept = private.read_text(encoding="utf-8")
        private.unlink()
        code, out = run_preflight(work)
        check(code == 1 and "秘密鍵がある" in out, "秘密鍵が無ければ止める")
        private.write_text(kept, encoding="utf-8")

        # 🚨 別の鍵のバックアップを戻してしまった場合
        #    発行はできるのに購入者の手元で弾かれる、いちばん分かりにくい壊れ方
        import json as _json
        sys.path.insert(0, str(work / "tools"))
        import p256 as _p256
        other_private, _ = _p256.generate_keypair()
        data = _json.loads(private.read_text(encoding="utf-8"))
        data["private_key"] = f"{other_private:064x}"
        private.write_text(_json.dumps(data), encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 1 and "秘密鍵とアプリの公開鍵が対になっている" in out,
              "別の鍵のバックアップを戻したら止める")
        private.write_text(kept, encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 0, "正しい鍵に戻せば通る")

        # --- 差し替え漏れ ---
        landing = work / "landing" / "index.html"
        saved = landing.read_text(encoding="utf-8")
        landing.write_text(saved.replace("検証用テスト商店", "〔販売者名〕", 1), encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 1 and "〔　〕の置き換えが済んでいる" in out, "置き換え漏れを見つける")
        landing.write_text(saved, encoding="utf-8")

        eula = work / "legal" / "EULA.md"
        kept_eula = eula.read_text(encoding="utf-8")
        eula.write_text(kept_eula + "\nお問い合わせ: support@example.com\n", encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 1 and "見本のアドレスが残っていない" in out, "見本のアドレスを見つける")
        eula.write_text(kept_eula, encoding="utf-8")

        # --- 販売ページ ---
        landing.write_text(re.sub(r'href="https?://[^"]*"', 'href="#"', saved), encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 1 and "決済リンクが入っている" in out, "決済リンクが無ければ止める")

        landing.write_text(re.sub(r"<a\s[^>]*>使用許諾契約書</a>", "", saved), encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 1 and "「使用許諾契約書」へリンクしている" in out,
              "法務ページへの導線が無ければ止める")

        landing.write_text(saved.replace('href="#features"', 'href="無いページ.html"'),
                           encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 1 and "リンクが切れていない" in out, "リンク切れを見つける")
        landing.write_text(saved, encoding="utf-8")

        # --- 法務 ---
        privacy = work / "legal" / "PRIVACY.md"
        kept_privacy = privacy.read_text(encoding="utf-8")
        privacy.write_text("短すぎる中身\n", encoding="utf-8")
        code, out = run_preflight(work)
        check(code == 1 and "PRIVACY.md がある" in out, "法務ページが空なら止める")
        privacy.write_text(kept_privacy, encoding="utf-8")

        code, out = run_preflight(work)
        check(code == 0, "元に戻せばまた通る")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
