"""発行の控え（台帳）まわりを確かめる。

  python3 tests/test_ledger.py

⚠ 本番の鍵（keys/private.json）と控えには一切触れない。
  一時フォルダを作り、keygen が見る場所をそこへ向け替えて動かす。
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import keygen  # noqa: E402
import p256  # noqa: E402

_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def run(*argv: str) -> tuple[int, str]:
    """keygen をコマンドとして動かし、終了コードと出力を返す。"""
    out = io.StringIO()
    code = 0
    saved = sys.argv
    sys.argv = ["keygen.py", *argv]
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            keygen.main()
    except SystemExit as exit_signal:
        # ⚠ sys.exit("メッセージ") のとき、code は文字列で中身が捨てられる。
        #   本物のコマンドでは stderr に出るので、テストでも出力として扱う
        if isinstance(exit_signal.code, int) or exit_signal.code is None:
            code = exit_signal.code or 0
        else:
            code = 1
            out.write(str(exit_signal.code) + "\n")
    finally:
        sys.argv = saved
    return code, out.getvalue()


def main() -> None:
    print("発行の控え（台帳）")
    with tempfile.TemporaryDirectory() as tmp:
        keys = Path(tmp) / "keys"
        keys.mkdir()
        keygen.KEYS_DIR = keys
        keygen.PRIVATE_KEY_PATH = keys / "private.json"
        keygen.LEDGER_PATH = keys / "issued.csv"

        private, public = p256.generate_keypair()
        keygen.PRIVATE_KEY_PATH.write_text(
            json.dumps({"private_key": f"{private:064x}", "public_key": p256.public_to_hex(public)}),
            encoding="utf-8")

        # --- 何も発行していないとき ---
        code, out = run("list")
        check(code == 0 and "まだ 1 件も発行していません" in out, "控えが無くても落ちない")

        # --- 発行して一覧する ---
        run("issue", "--name", "株式会社サンプル", "--plan", "business", "--seats", "5",
            "--note", "注文 1001")
        run("issue", "--name", "個人 太郎", "--note", "注文 1002")
        run("issue", "--name", "確定申告ユーザー", "--ext", "tax", "--note", "注文 1003")

        code, out = run("list")
        check(code == 0 and "株式会社サンプル" in out and "3 件" in out, "発行した分が一覧に出る")
        check("ビジネス" in out, "プランは日本語で出す")

        code, out = run("list")
        check(out.count("TD1.") == 0, "既定ではキーの本文を出さない（画面共有で漏れないため）")
        code, out = run("list", "--keys")
        check(out.count("TD1.") == 3, "--keys ならキーの本文も出す")

        # --- 絞り込み ---
        code, out = run("list", "--find", "1002")
        check("個人 太郎" in out and "株式会社サンプル" not in out, "メモで絞り込める")
        code, out = run("list", "--ext", "tax")
        check("確定申告ユーザー" in out and "1 件" in out, "拡張で絞り込める")
        code, out = run("list", "--find", "存在しない購入者")
        check(code == 0 and "あてはまる発行はありません" in out, "見つからなくても落ちない")

        # --- 期限切れの目印 ---
        run("issue", "--name", "期限切れ会社", "--expires", "2020-01-01", "--note", "注文 1004")
        code, out = run("list", "--find", "期限切れ会社")
        check("[期限切れ]" in out, "期限を過ぎた発行に目印を付ける")

        # --- 再発行 ---
        code, out = run("reissue", "--row", "1")
        check(code == 0 and "株式会社サンプル" in out, "番号を指定して作り直せる")
        check("前のキーは使えなくなりません" in out, "古いキーが残ることを伝える")

        code, out = run("list", "--find", "株式会社サンプル")
        check("再発行" in out, "作り直した分も控えに残る")

        # 作り直したキーが本物か（プランと拡張が引き継がれているか）
        _, out = run("list", "--find", "株式会社サンプル", "--keys")
        key = [line.strip() for line in out.splitlines() if line.strip().startswith("TD1.")][-1]
        payload = json.loads(keygen.b64url_decode(key.split(".")[1]))
        check(payload["n"] == "株式会社サンプル" and payload["p"] == "business" and payload["s"] == 5,
              "作り直したキーに元の内容が入っている")
        check(p256.verify(public, keygen.canonical_payload(payload),
                          keygen.b64url_decode(key.split(".")[2])), "作り直したキーの署名が正しい")

        code, out = run("reissue", "--find", "確定申告ユーザー", "--keys")
        code, out = run("list", "--find", "確定申告ユーザー", "--keys")
        key = [line.strip() for line in out.splitlines() if line.strip().startswith("TD1.")][-1]
        payload = json.loads(keygen.b64url_decode(key.split(".")[1]))
        check(payload.get("x") == ["tax"], "拡張の権利も引き継ぐ")

        # --- 迷ったときは止まる ---
        run("issue", "--name", "同名 商事", "--note", "注文 2001")
        run("issue", "--name", "同名 商事", "--note", "注文 2002")
        code, out = run("reissue", "--find", "同名 商事")
        check(code == 1 and "番号で指定してください" in out, "候補が複数なら作り直さずに止まる")

        code, out = run("reissue", "--row", "999")
        check(code != 0 and "999 番の発行はありません" in out, "無い番号を指定したら止まる")

        # --- 見出し行の無い古い控えでも読める ---
        keygen.LEDGER_PATH.write_text("2026-01-01,昔の購入者,personal,1,無期限,,注文 0001,TD1.x.y\n",
                                      encoding="utf-8")
        code, out = run("list")
        check(code == 0 and "昔の購入者" in out, "見出し行の無い控えでも読める")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
