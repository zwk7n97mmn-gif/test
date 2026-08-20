"""テスト用に、その場かぎりの鍵ペアとライセンスキーを 1 組作って JSON で出力する。

ui_smoke.mjs から呼ばれる。本番の鍵（keys/private.json）には一切触れない。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import keygen  # noqa: E402
import p256  # noqa: E402

private, public = p256.generate_keypair()
payload = {"n": "検証用テスト株式会社", "p": "business", "s": 5, "i": "2026-01-01"}
body = keygen.canonical_payload(payload)
key = f"TD1.{keygen.b64url_encode(body)}.{keygen.b64url_encode(p256.sign(private, body))}"
print(json.dumps({"pubkey": p256.public_to_hex(public), "key": key, "payload": payload}, ensure_ascii=False))
