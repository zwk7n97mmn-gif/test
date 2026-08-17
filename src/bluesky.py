"""Bluesky (AT Protocol) への投稿クライアント。標準ライブラリのみ。

必要な認証情報:
  BLUESKY_HANDLE       例) psych-tips.bsky.social
  BLUESKY_APP_PASSWORD アプリパスワード (設定 > プライバシーとセキュリティ > アプリパスワード)

本アカウントのパスワードではなく、必ずアプリパスワードを使うこと。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

PDS_HOST = "https://bsky.social"
_TIMEOUT = 30

# ハッシュタグ: 行頭または空白の直後から。末尾の句読点は含めない。
_TAG_RE = re.compile(r"(?:^|(?<=\s))#([^\s#。、，．！？]+)")
_URL_RE = re.compile(r"https?://[^\s]+")


class BlueskyError(RuntimeError):
    pass


def _request(url: str, payload: dict[str, Any] | None, token: str | None = None) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json", "User-Agent": "psych-tips-bot/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise BlueskyError(f"HTTP {exc.code} from {url}: {body}") from exc
    except urllib.error.URLError as exc:
        raise BlueskyError(f"接続失敗 {url}: {exc.reason}") from exc


def build_facets(text: str) -> list[dict[str, Any]]:
    """ハッシュタグと URL をリッチテキスト facet に変換する。

    facet のオフセットは「UTF-8 バイト位置」であって文字位置ではない。
    日本語では両者が大きくずれるので、必ずバイト単位で数える。
    """
    facets: list[dict[str, Any]] = []

    def byte_span(match: re.Match[str]) -> tuple[int, int]:
        start = len(text[: match.start()].encode("utf-8"))
        end = len(text[: match.end()].encode("utf-8"))
        return start, end

    for m in _TAG_RE.finditer(text):
        start, end = byte_span(m)
        facets.append(
            {
                "index": {"byteStart": start, "byteEnd": end},
                "features": [{"$type": "app.bsky.richtext.facet#tag", "tag": m.group(1)}],
            }
        )

    for m in _URL_RE.finditer(text):
        start, end = byte_span(m)
        facets.append(
            {
                "index": {"byteStart": start, "byteEnd": end},
                "features": [{"$type": "app.bsky.richtext.facet#link", "uri": m.group(0)}],
            }
        )

    facets.sort(key=lambda f: f["index"]["byteStart"])
    return facets


def post(handle: str, app_password: str, text: str) -> str:
    """投稿して、作成されたレコードの AT URI を返す。"""
    session = _request(
        f"{PDS_HOST}/xrpc/com.atproto.server.createSession",
        {"identifier": handle, "password": app_password},
    )
    token = session.get("accessJwt")
    did = session.get("did")
    if not token or not did:
        raise BlueskyError(f"セッション作成に失敗: {session}")

    record = {
        "$type": "app.bsky.feed.post",
        "text": text,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "langs": ["ja"],
    }
    facets = build_facets(text)
    if facets:
        record["facets"] = facets

    result = _request(
        f"{PDS_HOST}/xrpc/com.atproto.repo.createRecord",
        {"repo": did, "collection": "app.bsky.feed.post", "record": record},
        token=token,
    )
    uri = result.get("uri")
    if not uri:
        raise BlueskyError(f"投稿レスポンスに uri がない: {result}")
    return uri
