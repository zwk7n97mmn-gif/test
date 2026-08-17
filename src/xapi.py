"""X (Twitter) API v2 への投稿クライアント。標準ライブラリのみ。

必要な認証情報 (X Developer Portal のアプリ設定から取得):
  X_API_KEY              Consumer Key
  X_API_SECRET           Consumer Secret
  X_ACCESS_TOKEN         Access Token (該当アカウントのもの)
  X_ACCESS_TOKEN_SECRET  Access Token Secret

アプリの User authentication settings で App permissions を
"Read and write" にしてからアクセストークンを再発行すること。
Read only のまま発行したトークンでは 403 になる。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

TWEETS_URL = "https://api.x.com/2/tweets"
_TIMEOUT = 30


class XError(RuntimeError):
    pass


class XRateLimited(XError):
    """無料枠の上限に達した場合。運用上は「失敗」ではなく「今回は見送り」。"""


def _quote(value: str) -> str:
    """RFC 3986 準拠のパーセントエンコード (OAuth の要求仕様)。"""
    return urllib.parse.quote(str(value), safe="~")


def _sign(
    method: str,
    url: str,
    oauth_params: dict[str, str],
    consumer_secret: str,
    token_secret: str,
) -> str:
    """HMAC-SHA1 で署名を作る。

    ボディが JSON の場合、署名対象に含めるのは oauth_* パラメータのみ。
    (application/x-www-form-urlencoded のときだけボディも含める仕様)
    """
    normalized = "&".join(
        f"{_quote(k)}={_quote(v)}" for k, v in sorted(oauth_params.items())
    )
    base = "&".join([method.upper(), _quote(url), _quote(normalized)])
    key = f"{_quote(consumer_secret)}&{_quote(token_secret)}".encode()
    digest = hmac.new(key, base.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def _auth_header(
    method: str,
    url: str,
    api_key: str,
    api_secret: str,
    access_token: str,
    access_token_secret: str,
) -> str:
    params = {
        "oauth_consumer_key": api_key,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": access_token,
        "oauth_version": "1.0",
    }
    params["oauth_signature"] = _sign(method, url, params, api_secret, access_token_secret)
    joined = ", ".join(f'{_quote(k)}="{_quote(v)}"' for k, v in sorted(params.items()))
    return f"OAuth {joined}"


def post(
    text: str,
    api_key: str,
    api_secret: str,
    access_token: str,
    access_token_secret: str,
) -> str:
    """ツイートして、作成された Tweet ID を返す。"""
    header = _auth_header(
        "POST", TWEETS_URL, api_key, api_secret, access_token, access_token_secret
    )
    body = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        TWEETS_URL,
        data=body,
        headers={
            "Authorization": header,
            "Content-Type": "application/json",
            "User-Agent": "psych-tips-bot/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            payload: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        if exc.code == 429:
            raise XRateLimited(f"レート制限 (無料枠の上限): {detail}") from exc
        raise XError(f"HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise XError(f"接続失敗: {exc.reason}") from exc

    tweet_id = payload.get("data", {}).get("id")
    if not tweet_id:
        raise XError(f"レスポンスに id がない: {payload}")
    return tweet_id
