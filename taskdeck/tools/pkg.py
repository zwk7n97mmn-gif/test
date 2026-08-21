#!/usr/bin/env python3
"""拡張パッケージ（.tdpkg）を作る・確かめるツール（販売者・拡張開発者用）。

    python taskdeck/tools/pkg.py build extensions/tax     # パッケージを作る
    python taskdeck/tools/pkg.py verify dist/tax-1.0.0.tdpkg
    python taskdeck/tools/pkg.py info   dist/tax-1.0.0.tdpkg

パッケージはライセンスキーと同じ秘密鍵で署名する。
アプリ側は公開鍵で確かめてから読み込むため、署名のないコードは実行されない。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import keygen  # noqa: E402
import p256  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FORMAT = "taskdeck-package/1"
API_VERSION = "1"
REQUIRED = ["id", "name", "version", "apiVersion"]


def canonical(payload: dict) -> bytes:
    """アプリ内の canonicalJson() と同じ並びの JSON。署名の対象を一致させる。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def signature_body(package: dict) -> bytes:
    return canonical({"code": package["code"], "manifest": package["manifest"]})


def load_manifest(source: Path) -> dict:
    manifest_path = source / "manifest.json"
    if not manifest_path.exists():
        sys.exit(f"{manifest_path} がありません。")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for field in REQUIRED:
        if not isinstance(manifest.get(field), str) or not manifest[field]:
            sys.exit(f"manifest.json の {field} が足りません。")
    if manifest["apiVersion"] != API_VERSION:
        sys.exit(f"apiVersion は \"{API_VERSION}\" にしてください（いまは \"{manifest['apiVersion']}\"）。")
    return manifest


def cmd_build(args: argparse.Namespace) -> None:
    source = Path(args.source)
    manifest = load_manifest(source)
    code_path = source / "main.js"
    if not code_path.exists():
        sys.exit(f"{code_path} がありません。")
    code = code_path.read_text(encoding="utf-8")

    private = keygen.load_private_key()
    package = {"format": FORMAT, "manifest": manifest, "code": code}
    package["signature"] = keygen.b64url_encode(p256.sign(private, signature_body(package)))

    outdir = Path(args.out) if args.out else ROOT / "dist"
    outdir.mkdir(parents=True, exist_ok=True)
    out = outdir / f"{manifest['id']}-{manifest['version']}.tdpkg"
    out.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"{manifest['name']} {manifest['version']} を署名しました。")
    print(f"  出力     : {out}")
    print(f"  大きさ   : {out.stat().st_size // 1024} KB")
    print(f"  権利名   : {manifest.get('entitlement', manifest['id'])}")
    print(f"  評価上限 : {manifest.get('trialLimit', 'なし')}")
    print("\nこのファイルを購入者に渡すと、アプリの「拡張」から読み込めます。")


def read_package(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"{path} がありません。")
    return json.loads(path.read_text(encoding="utf-8"))


def cmd_verify(args: argparse.Namespace) -> None:
    package = read_package(Path(args.file))
    pubkey_hex = keygen.read_embedded_pubkey()
    if not pubkey_hex or pubkey_hex == "__PUBLIC_KEY__":
        sys.exit("アプリに公開鍵が入っていません。先に keygen.py init を実行してください。")
    if package.get("format") != FORMAT:
        sys.exit("TaskDeck の拡張パッケージではありません。")
    public = p256.public_from_hex(pubkey_hex)
    signature = keygen.b64url_decode(package["signature"])
    if not p256.verify(public, signature_body(package), signature):
        sys.exit("署名が一致しません。このパッケージはアプリに読み込めません。")
    print("署名は正しいパッケージです。アプリに読み込めます。")
    cmd_info(args)


def cmd_info(args: argparse.Namespace) -> None:
    package = read_package(Path(args.file))
    manifest = package.get("manifest", {})
    print(f"  名前     : {manifest.get('name')}")
    print(f"  ID       : {manifest.get('id')}")
    print(f"  版       : {manifest.get('version')}")
    print(f"  拡張API  : v{manifest.get('apiVersion')}")
    print(f"  提供元   : {manifest.get('vendor', '（未設定）')}")
    print(f"  権利名   : {manifest.get('entitlement', manifest.get('id'))}")
    print(f"  評価上限 : {manifest.get('trialLimit', 'なし')}")
    print(f"  プログラム: {len(package.get('code', ''))} 文字")


def main() -> None:
    parser = argparse.ArgumentParser(description="TaskDeck 拡張パッケージのツール")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="拡張のフォルダから署名済みパッケージを作る")
    build.add_argument("source", help="manifest.json と main.js があるフォルダ")
    build.add_argument("--out", help="出力先フォルダ（既定: taskdeck/dist）")
    build.set_defaults(func=cmd_build)

    verify = sub.add_parser("verify", help="パッケージの署名を確かめる")
    verify.add_argument("file")
    verify.set_defaults(func=cmd_verify)

    info = sub.add_parser("info", help="パッケージの中身を表示する")
    info.add_argument("file")
    info.set_defaults(func=cmd_info)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
