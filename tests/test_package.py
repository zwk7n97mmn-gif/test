"""拡張パッケージの署名（Python）と検証（アプリ内の JavaScript）が一致することを確かめる。

  python taskdeck/tests/test_package.py

署名の対象は「並び順を固定した JSON」なので、Python と JavaScript で
1 バイトでも食い違うと正しいパッケージが弾かれてしまう。そこを実際に突き合わせる。
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
import pkg as pkgtool  # noqa: E402

APP_HTML = ROOT / "app" / "taskdeck.html"
BLOCKS = ["license-verify", "package-canonical"]

_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def extract_js() -> str:
    text = APP_HTML.read_text(encoding="utf-8")
    parts = []
    for name in BLOCKS:
        match = re.search(rf"// === {name}:start ===(.*?)// === {name}:end ===", text, re.S)
        if not match:
            sys.exit(f"アプリ内の {name} ブロックが見つかりません。")
        parts.append(match.group(1))
    return "\n".join(parts)


def make_package(private: int, manifest: dict, code: str) -> dict:
    package = {"format": pkgtool.FORMAT, "manifest": manifest, "code": code}
    package["signature"] = keygen.b64url_encode(p256.sign(private, pkgtool.signature_body(package)))
    return package


def main() -> None:
    print("拡張パッケージの署名と検証のテスト")

    private, public = p256.generate_keypair()
    pub_hex = p256.public_to_hex(public)
    other_private, _ = p256.generate_keypair()

    manifest = {
        "id": "tax",
        "name": "確定申告データ管理",
        "version": "1.0.0",
        "apiVersion": "1",
        "vendor": "〔販売者名〕",
        "description": "複式簿記の仕訳を記録し、試算表と決算の集計まで出せます。",
        "entitlement": "tax",
        "trialLimit": 30,
    }
    # 改行・引用符・日本語・記号が混ざっても両者が一致することを見る
    code = 'api.registerView({\n  id: "x",\n  label: "テスト\\"引用\\"",\n  render(box) { box.textContent = "こんにちは — 100% 動く"; },\n});\n'
    package = make_package(private, manifest, code)

    check(p256.verify(public, pkgtool.signature_body(package), keygen.b64url_decode(package["signature"])),
          "Python: 署名したパッケージを自分で検証できる")

    tampered_code = json.loads(json.dumps(package))
    tampered_code["code"] += "\napi.ui.toast('のっとり');"
    check(not p256.verify(public, pkgtool.signature_body(tampered_code), keygen.b64url_decode(package["signature"])),
          "Python: プログラムを書き換えると署名が合わなくなる")

    if not shutil.which("node"):
        print("\n  ※ Node.js が無いため JavaScript 側の検証は省略しました")
    else:
        js = extract_js()
        tampered_manifest = json.loads(json.dumps(package))
        tampered_manifest["manifest"]["trialLimit"] = 99999
        forged = make_package(other_private, manifest, code)

        cases = {
            "valid": package,
            "tamperedCode": tampered_code,
            "tamperedManifest": tampered_manifest,
            "forged": forged,
        }
        harness = (
            js
            + "\nconst cases = " + json.dumps(cases, ensure_ascii=False) + ";\n"
            + "const pub = " + json.dumps(pub_hex) + ";\n"
            + "const out = {};\n"
            + "for (const [name, pkg] of Object.entries(cases)) {\n"
            + "  out[name] = {\n"
            + "    body: packageSignatureBody(pkg),\n"
            + "    ok: TaskDeckLicense.verifyDetached(pub, packageSignatureBody(pkg), pkg.signature),\n"
            + "  };\n"
            + "}\n"
            + "console.log(JSON.stringify(out));\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "harness.mjs"
            script.write_text(harness, encoding="utf-8")
            result = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            sys.exit(f"JavaScript の実行に失敗しました:\n{result.stderr}")
        got = json.loads(result.stdout)

        check(got["valid"]["body"] == pkgtool.signature_body(package).decode("utf-8"),
              "JS: 署名対象の JSON が Python と 1 文字も違わない")
        check(got["valid"]["ok"] is True, "JS: 正しく署名されたパッケージを受け入れる")
        check(got["tamperedCode"]["ok"] is False, "JS: プログラムを書き換えたパッケージを拒否する")
        check(got["tamperedManifest"]["ok"] is False, "JS: manifest を書き換えたパッケージを拒否する")
        check(got["forged"]["ok"] is False, "JS: 別の秘密鍵で署名したパッケージを拒否する")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
