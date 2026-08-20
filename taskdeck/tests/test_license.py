"""ライセンスキーの発行（Python）と検証（アプリ内の JavaScript）が一致することを確かめる。

  python taskdeck/tests/test_license.py

Node.js があれば JavaScript 側も実際に実行して突き合わせる。無い場合は Python 側だけ検証する。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import keygen  # noqa: E402
import p256  # noqa: E402

APP_HTML = ROOT / "app" / "taskdeck.html"
MARKER = re.compile(
    r"// === license-verify:start ===(.*?)// === license-verify:end ===", re.S
)

_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def make_key(private: int, payload: dict) -> str:
    body = keygen.canonical_payload(payload)
    signature = p256.sign(private, body)
    return f"TD1.{keygen.b64url_encode(body)}.{keygen.b64url_encode(signature)}"


def extract_js() -> str:
    match = MARKER.search(APP_HTML.read_text(encoding="utf-8"))
    if not match:
        sys.exit("アプリ内の検証コード（license-verify マーカー）が見つかりません。")
    return match.group(1)


def run_js_cases(js: str, cases: list[dict]) -> list[dict]:
    harness = (
        js
        + "\nconst cases = "
        + json.dumps(cases, ensure_ascii=False)
        + ";\n"
        + "const out = cases.map(c => TaskDeckLicense.verifyKey(c.key, c.pub, c.today));\n"
        + "console.log(JSON.stringify(out));\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "harness.mjs"
        script.write_text(harness, encoding="utf-8")
        result = subprocess.run(
            ["node", str(script)], capture_output=True, text=True, timeout=120
        )
    if result.returncode != 0:
        sys.exit(f"JavaScript の実行に失敗しました:\n{result.stderr}")
    return json.loads(result.stdout)


def main() -> None:
    print("ライセンス発行・検証のテスト")

    private, public = p256.generate_keypair()
    pub_hex = p256.public_to_hex(public)
    other_private, _ = p256.generate_keypair()

    valid = make_key(private, {"n": "テスト商事株式会社", "p": "business", "s": 5, "i": "2026-01-10"})
    expiring = make_key(private, {"n": "期限つき", "p": "personal", "s": 1, "i": "2026-01-10", "e": "2026-06-30"})
    forged = make_key(other_private, {"n": "偽造", "p": "site", "s": 999, "i": "2026-01-10"})
    head, body_b64, sig = valid.split(".")
    tampered_body = keygen.b64url_encode(
        keygen.canonical_payload({"n": "書き換え", "p": "site", "s": 999, "i": "2026-01-10"})
    )
    tampered = f"{head}.{tampered_body}.{sig}"

    # --- Python 側 ---
    body = keygen.b64url_decode(valid.split(".")[1])
    sig_bytes = keygen.b64url_decode(valid.split(".")[2])
    check(p256.verify(public, body, sig_bytes), "Python: 自分で発行したキーの署名が通る")
    check(
        not p256.verify(public, keygen.b64url_decode(tampered_body), sig_bytes),
        "Python: 中身を書き換えたキーは通らない",
    )
    check(json.loads(body)["n"] == "テスト商事株式会社", "Python: 日本語の購入者名がそのまま復元できる")
    check(len(sig_bytes) == 64, "Python: 署名は 64 バイト")

    # --- 実際のアプリに埋め込まれた JavaScript 側 ---
    if not shutil.which("node"):
        print("\n  ※ Node.js が無いため JavaScript 側の検証は省略しました")
    else:
        js = extract_js()
        cases = [
            {"key": valid, "pub": pub_hex, "today": "2026-08-20"},
            {"key": tampered, "pub": pub_hex, "today": "2026-08-20"},
            {"key": forged, "pub": pub_hex, "today": "2026-08-20"},
            {"key": expiring, "pub": pub_hex, "today": "2026-06-01"},
            {"key": expiring, "pub": pub_hex, "today": "2026-07-01"},
            {"key": "でたらめな文字列", "pub": pub_hex, "today": "2026-08-20"},
            {"key": valid, "pub": "__PUBLIC_KEY__", "today": "2026-08-20"},
            {"key": "  " + valid + "\n", "pub": pub_hex, "today": "2026-08-20"},
        ]
        got = run_js_cases(js, cases)
        check(got[0]["ok"] is True, "JS: Python が発行したキーを受け入れる")
        check(got[0]["payload"]["n"] == "テスト商事株式会社", "JS: 購入者名が文字化けせず読める")
        check(got[0]["payload"]["s"] == 5, "JS: 台数が読める")
        check(got[1]["ok"] is False, "JS: 中身を書き換えたキーを拒否する")
        check(got[2]["ok"] is False, "JS: 別の秘密鍵で作ったキーを拒否する")
        check(got[3]["ok"] is True, "JS: 有効期限内のキーは通る")
        check(got[4]["ok"] is False, "JS: 期限切れのキーは拒否する")
        check("2026-06-30" in got[4]["reason"], "JS: 期限切れの理由に日付が出る")
        check(got[5]["ok"] is False, "JS: 形式が違うキーを拒否する")
        check(got[6]["ok"] is False, "JS: 公開鍵が未設定なら拒否する")
        check(got[7]["ok"] is True, "JS: 前後の空白・改行が付いていても受け付ける")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
