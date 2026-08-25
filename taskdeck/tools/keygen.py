#!/usr/bin/env python3
"""TaskDeck のライセンスキーを発行するツール（販売者専用）。

購入者に渡すキーはここでしか作れない。秘密鍵は keys/private.json に置き、
リポジトリにも配布 ZIP にも絶対に含めない（.gitignore と build.sh で除外済み）。

使い方:

    python tools/keygen.py init                    # 最初に一度だけ。鍵ペアを作る
    python tools/keygen.py issue --name "山田太郎" # 購入者ごとに発行する
    python tools/keygen.py verify "TD1.xxx.yyy"    # 発行したキーを確かめる
    python tools/keygen.py pubkey                  # 埋め込み済みの公開鍵を表示する

アプリ側（app/taskdeck.html）は公開鍵しか持たないため、
配布物を解析されてもキーを偽造されない。
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p256  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
APP_HTML = ROOT / "app" / "taskdeck.html"
KEYS_DIR = ROOT / "keys"
PRIVATE_KEY_PATH = KEYS_DIR / "private.json"
LEDGER_PATH = KEYS_DIR / "issued.csv"

# app/taskdeck.html の中で公開鍵を書いてある行。init はこの行だけを書き換える。
PUBKEY_LINE = re.compile(r'(const LICENSE_PUBLIC_KEY = ")([0-9a-fA-F]*|__PUBLIC_KEY__)(";)')

PLANS = {
    "personal": "パーソナル",
    "business": "ビジネス",
    "site": "サイトライセンス",
}


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_private_key() -> int:
    if not PRIVATE_KEY_PATH.exists():
        sys.exit(
            f"秘密鍵が見つかりません: {PRIVATE_KEY_PATH}\n"
            "先に `python tools/keygen.py init` を実行してください。"
        )
    data = json.loads(PRIVATE_KEY_PATH.read_text())
    return int(data["private_key"], 16)


def read_embedded_pubkey() -> str:
    match = PUBKEY_LINE.search(APP_HTML.read_text(encoding="utf-8"))
    if not match:
        sys.exit(f"{APP_HTML} に公開鍵の行が見つかりません。ファイルが壊れていないか確認してください。")
    return match.group(2)


def write_embedded_pubkey(pubkey_hex: str) -> None:
    text = APP_HTML.read_text(encoding="utf-8")
    patched, count = PUBKEY_LINE.subn(lambda m: m.group(1) + pubkey_hex + m.group(3), text)
    if count != 1:
        sys.exit("公開鍵の行を 1 か所だけ書き換えられませんでした。中断します。")
    APP_HTML.write_text(patched, encoding="utf-8")


def canonical_payload(payload: dict) -> bytes:
    """署名対象。キーの順序で署名が変わらないよう sort_keys で固定する。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def cmd_init(args: argparse.Namespace) -> None:
    if PRIVATE_KEY_PATH.exists() and not args.force:
        sys.exit(
            f"すでに秘密鍵があります: {PRIVATE_KEY_PATH}\n"
            "作り直すと発行済みのキーがすべて無効になります。本当にやり直すなら --force を付けてください。"
        )
    private, public = p256.generate_keypair()
    pubkey_hex = p256.public_to_hex(public)
    KEYS_DIR.mkdir(exist_ok=True)
    PRIVATE_KEY_PATH.write_text(
        json.dumps(
            {
                "curve": "P-256",
                "private_key": f"{private:064x}",
                "public_key": pubkey_hex,
                "created_at": dt.date.today().isoformat(),
            },
            indent=2,
        )
        + "\n"
    )
    PRIVATE_KEY_PATH.chmod(0o600)
    write_embedded_pubkey(pubkey_hex)
    print("鍵ペアを作りました。")
    print(f"  秘密鍵 : {PRIVATE_KEY_PATH}  ← バックアップを取り、絶対に配布しないでください")
    print(f"  公開鍵 : {pubkey_hex}")
    print(f"  {APP_HTML.relative_to(ROOT.parent)} に公開鍵を埋め込みました。")
    print("\n次は `python tools/keygen.py issue --name \"購入者名\"` でキーを発行できます。")


LEDGER_HEADER = ["発行日", "購入者", "プラン", "台数", "有効期限", "拡張", "メモ", "キー"]


def append_ledger(row: list) -> None:
    KEYS_DIR.mkdir(exist_ok=True)
    is_new = not LEDGER_PATH.exists()
    with LEDGER_PATH.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if is_new:
            writer.writerow(LEDGER_HEADER)
        writer.writerow(row)


def read_ledger() -> list[dict]:
    """発行の控えを読む。⚠ 見出し行が無い古い控えでも落ちないようにする。"""
    if not LEDGER_PATH.exists():
        return []
    with LEDGER_PATH.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    if not rows:
        return []
    if rows[0] == LEDGER_HEADER:
        rows = rows[1:]
    records = []
    for number, row in enumerate(rows, 1):
        padded = list(row) + [""] * (len(LEDGER_HEADER) - len(row))
        record = dict(zip(LEDGER_HEADER, padded))
        record["#"] = number
        records.append(record)
    return records


def cmd_issue(args: argparse.Namespace) -> None:
    private = load_private_key()
    payload = {
        "n": args.name,
        "p": args.plan,
        "s": args.seats,
        "i": dt.date.today().isoformat(),
    }
    extensions = sorted({name.strip() for name in (args.ext or []) if name.strip()})
    if extensions:
        payload["x"] = extensions
    if args.expires:
        try:
            dt.date.fromisoformat(args.expires)
        except ValueError:
            sys.exit("--expires は YYYY-MM-DD の形式で指定してください。")
        payload["e"] = args.expires

    body = canonical_payload(payload)
    signature = p256.sign(private, body)
    key = f"TD1.{b64url_encode(body)}.{b64url_encode(signature)}"

    append_ledger([payload["i"], args.name, args.plan, args.seats, args.expires or "無期限",
                   " ".join(extensions), args.note or "", key])

    print(f"購入者   : {args.name}")
    print(f"プラン   : {PLANS.get(args.plan, args.plan)}")
    print(f"台数     : {args.seats}")
    print(f"有効期限 : {args.expires or '無期限'}")
    print(f"拡張     : {'、'.join(extensions) if extensions else 'なし（基本のタスク管理のみ）'}")
    print(f"控え     : {LEDGER_PATH}")
    print("\n--- ここから下をそのまま購入者に渡してください ---")
    print(key)


def cmd_verify(args: argparse.Namespace) -> None:
    pubkey_hex = read_embedded_pubkey()
    if not pubkey_hex or pubkey_hex == "__PUBLIC_KEY__":
        sys.exit("アプリにまだ公開鍵が入っていません。先に init を実行してください。")
    public = p256.public_from_hex(pubkey_hex)
    try:
        prefix, body_b64, sig_b64 = args.key.strip().split(".")
        assert prefix == "TD1"
        body = b64url_decode(body_b64)
        signature = b64url_decode(sig_b64)
    except Exception:
        sys.exit("キーの形式が壊れています。")
    if not p256.verify(public, body, signature):
        sys.exit("署名が一致しません。このキーは無効です。")
    payload = json.loads(body)
    print("署名は正しいキーです。")
    print(f"  購入者   : {payload.get('n')}")
    print(f"  プラン   : {PLANS.get(payload.get('p'), payload.get('p'))}")
    print(f"  台数     : {payload.get('s')}")
    print(f"  発行日   : {payload.get('i')}")
    print(f"  有効期限 : {payload.get('e', '無期限')}")
    granted = payload.get("x") or []
    print(f"  拡張     : {'、'.join(granted) if granted else 'なし（基本のタスク管理のみ）'}")


def match_records(records: list[dict], needle: str) -> list[dict]:
    """購入者名・メモ・発行日のどれかに含まれていれば拾う。大小文字は区別しない。"""
    lowered = needle.lower()
    return [record for record in records
            if lowered in f"{record['購入者']} {record['メモ']} {record['発行日']}".lower()]


def cmd_list(args: argparse.Namespace) -> None:
    records = read_ledger()
    if not records:
        print(f"まだ 1 件も発行していません（控え: {LEDGER_PATH}）")
        return
    if args.find:
        records = match_records(records, args.find)
    if args.ext:
        records = [record for record in records if args.ext in record["拡張"].split()]
    if not records:
        print("あてはまる発行はありません。")
        return

    today = dt.date.today().isoformat()
    print(f"{'#':>3}  {'発行日':<10}  {'購入者':<20}  {'プラン':<8}  {'台数':>4}  "
          f"{'有効期限':<10}  {'拡張':<10}  メモ")
    for record in records:
        expires = record["有効期限"]
        # ⚠ 期限切れは目印を付ける。色は使わない（環境によっては消えるため）
        mark = " [期限切れ]" if expires not in ("", "無期限") and expires < today else ""
        print(f"{record['#']:>3}  {record['発行日']:<10}  {record['購入者']:<20}  "
              f"{PLANS.get(record['プラン'], record['プラン']):<8}  {record['台数']:>4}  "
              f"{expires:<10}  {record['拡張'] or '—':<10}  {record['メモ']}{mark}")
        if args.keys:
            print(f"      {record['キー']}")
    print(f"\n{len(records)} 件（控え: {LEDGER_PATH}）")


def cmd_reissue(args: argparse.Namespace) -> None:
    """同じ内容でキーを作り直す。PC の入れ替え・キーの紛失に使う。

    ⚠ 古いキーは**使えなくならない**。アプリは通信しないため、
      発行済みのキーを後から失効させる手段が無い。
    """
    records = read_ledger()
    if not records:
        sys.exit(f"発行の控えがありません: {LEDGER_PATH}")

    if args.row is not None:
        found = [record for record in records if record["#"] == args.row]
        if not found:
            sys.exit(f"{args.row} 番の発行はありません。`list` で番号を確かめてください。")
    else:
        found = match_records(records, args.find)
        if not found:
            sys.exit(f"「{args.find}」にあてはまる発行はありません。")
        if len(found) > 1:
            print(f"「{args.find}」に {len(found)} 件あてはまります。番号で指定してください。")
            for record in found:
                print(f"  {record['#']:>3}  {record['発行日']}  {record['購入者']}  {record['メモ']}")
            sys.exit(1)
    source = found[0]

    payload = {
        "n": source["購入者"],
        "p": source["プラン"],
        "s": int(source["台数"] or 1),
        "i": dt.date.today().isoformat(),
    }
    extensions = sorted(name for name in source["拡張"].split() if name)
    if extensions:
        payload["x"] = extensions
    if source["有効期限"] not in ("", "無期限"):
        payload["e"] = source["有効期限"]

    body = canonical_payload(payload)
    key = f"TD1.{b64url_encode(body)}.{b64url_encode(p256.sign(load_private_key(), body))}"
    note = args.note or f"再発行（元: {source['発行日']} {source['メモ']})".rstrip()
    append_ledger([payload["i"], source["購入者"], source["プラン"], source["台数"],
                   source["有効期限"], " ".join(extensions), note, key])

    print(f"{source['#']} 番（{source['発行日']} {source['購入者']}）と同じ内容で作り直しました。")
    print(f"購入者   : {source['購入者']}")
    print(f"プラン   : {PLANS.get(source['プラン'], source['プラン'])}")
    print(f"台数     : {source['台数']}")
    print(f"有効期限 : {source['有効期限'] or '無期限'}")
    print(f"拡張     : {'、'.join(extensions) if extensions else 'なし（基本のタスク管理のみ）'}")
    print("\n⚠ 前のキーは使えなくなりません。アプリは通信しないため、"
          "発行済みのキーを後から止める手段がありません。")
    print("\n--- ここから下をそのまま購入者に渡してください ---")
    print(key)


def cmd_pubkey(_: argparse.Namespace) -> None:
    pubkey_hex = read_embedded_pubkey()
    if not pubkey_hex or pubkey_hex == "__PUBLIC_KEY__":
        sys.exit("アプリにまだ公開鍵が入っていません。`init` を実行してください。")
    print(pubkey_hex)


def main() -> None:
    parser = argparse.ArgumentParser(description="TaskDeck ライセンスキー発行ツール")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="鍵ペアを作ってアプリに公開鍵を埋め込む（最初に一度だけ）")
    init.add_argument("--force", action="store_true", help="既存の鍵を捨てて作り直す")
    init.set_defaults(func=cmd_init)

    issue = sub.add_parser("issue", help="購入者向けのライセンスキーを発行する")
    issue.add_argument("--name", required=True, help="購入者名または会社名（キーに表示される）")
    issue.add_argument("--plan", default="personal", choices=sorted(PLANS), help="プラン種別")
    issue.add_argument("--seats", type=int, default=1, help="利用可能な台数")
    issue.add_argument("--expires", help="有効期限 YYYY-MM-DD（省略すると無期限）")
    issue.add_argument(
        "--ext", action="append",
        help="この購入者が使える拡張の権利名（例: --ext tax）。複数指定できる",
    )
    issue.add_argument("--note", help="控えに残すメモ（注文番号など）")
    issue.set_defaults(func=cmd_issue)

    verify = sub.add_parser("verify", help="発行したキーが有効か確かめる")
    verify.add_argument("key", help="TD1. から始まるライセンスキー")
    verify.set_defaults(func=cmd_verify)

    listing = sub.add_parser("list", help="これまでに発行したキーの控えを一覧する")
    listing.add_argument("--find", help="購入者名・メモ・発行日で絞り込む")
    listing.add_argument("--ext", help="この拡張を含む発行だけを見る（例: --ext tax）")
    listing.add_argument("--keys", action="store_true", help="キーの本文も表示する")
    listing.set_defaults(func=cmd_list)

    reissue = sub.add_parser("reissue", help="控えを元に、同じ内容でキーを作り直す")
    target = reissue.add_mutually_exclusive_group(required=True)
    target.add_argument("--row", type=int, help="`list` に出る番号")
    target.add_argument("--find", help="購入者名・メモで探す（1 件に絞れるとき）")
    reissue.add_argument("--note", help="控えに残すメモ（既定: 再発行（元: …））")
    reissue.set_defaults(func=cmd_reissue)

    pubkey = sub.add_parser("pubkey", help="アプリに埋め込まれている公開鍵を表示する")
    pubkey.set_defaults(func=cmd_pubkey)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
