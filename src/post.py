"""定期投稿のエントリポイント。

  python src/post.py            # 本番投稿
  python src/post.py --dry-run  # 投稿せず、何が出るかだけ表示
  python src/post.py --only bluesky

認証情報が揃っているプラットフォームにだけ投稿する。
片方だけ設定した状態でも動く。
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

import bluesky
import state as state_mod
import tips as tips_mod
import xapi
from textlen import describe

BLUESKY_ENV = ("BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD")
X_ENV = ("X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET")


def _env(names: tuple[str, ...]) -> list[str] | None:
    """全部揃っていれば値を、1 つでも欠けていれば None を返す。"""
    values = [os.environ.get(n, "").strip() for n in names]
    return values if all(values) else None


def _log(message: str) -> None:
    print(message, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="心理学の豆知識を定期投稿する")
    parser.add_argument("--dry-run", action="store_true", help="投稿せず内容だけ表示")
    parser.add_argument(
        "--only",
        choices=["bluesky", "x"],
        help="片方のプラットフォームだけに投稿する",
    )
    args = parser.parse_args()

    all_tips = tips_mod.load_all()
    problems = tips_mod.validate(all_tips)
    if problems:
        _log("コンテンツの検証に失敗したため投稿を中止します:")
        for p in problems:
            _log(f"  - {p}")
        return 1

    data = state_mod.load()
    cycle = data.get("cycle", 1)
    done_ids = set(data.get("done_ids", []))

    try:
        tip = tips_mod.pick_next(all_tips, cycle, done_ids, data.get("last_category", ""))
    except LookupError:
        # 状態と件数がずれた場合のフォールバック: 次の巡回を始める
        cycle += 1
        data["cycle"] = cycle
        data["done_ids"] = []
        done_ids = set()
        tip = tips_mod.pick_next(all_tips, cycle, done_ids, data.get("last_category", ""))

    text = tip.render()
    _log(f"巡回 {cycle} / 進捗 {len(done_ids) + 1}/{len(all_tips)}")
    _log(f"選択: {tip.id} 「{tip.title}」({tip.category})")
    _log(f"出典: {tip.source}")
    _log(f"長さ: {describe(text)}")
    _log("--- 投稿内容 ---")
    _log(text)
    _log("----------------")

    if args.dry_run:
        _log("dry-run のため投稿しませんでした。")
        return 0

    results: dict[str, str] = {}
    failures: list[str] = []
    attempted = 0

    bsky_creds = _env(BLUESKY_ENV)
    if bsky_creds and args.only != "x":
        attempted += 1
        handle, app_password = bsky_creds
        try:
            uri = bluesky.post(handle, app_password, text)
            results["bluesky"] = uri
            _log(f"Bluesky: 投稿成功 {uri}")
        except Exception as exc:  # noqa: BLE001 - 片方の失敗で全体を止めない
            failures.append(f"Bluesky: {exc}")
            _log(f"Bluesky: 投稿失敗 — {exc}")
    elif args.only != "x":
        _log("Bluesky: 認証情報が未設定のためスキップ")

    x_creds = _env(X_ENV)
    if x_creds and args.only != "bluesky":
        attempted += 1
        api_key, api_secret, access_token, access_secret = x_creds
        try:
            tweet_id = xapi.post(text, api_key, api_secret, access_token, access_secret)
            results["x"] = tweet_id
            _log(f"X: 投稿成功 id={tweet_id}")
        except xapi.XRateLimited as exc:
            # 無料枠の上限。異常ではないので失敗として扱わない。
            _log(f"X: レート制限のため今回は見送り — {exc}")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"X: {exc}")
            _log(f"X: 投稿失敗 — {exc}")
    elif args.only != "bluesky":
        _log("X: 認証情報が未設定のためスキップ")

    if attempted == 0:
        _log("投稿先が 1 つも設定されていません。GitHub Secrets を確認してください。")
        return 1

    if not results:
        # どこにも出せていない。この豆知識は消費せず、次回に持ち越す。
        _log("すべての投稿先で失敗したため、状態を更新せず次回に持ち越します。")
        return 1

    results["at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    state_mod.record(data, tip.id, tip.title, tip.category, len(all_tips), results)
    state_mod.save(data)
    _log("状態を更新しました。")

    if failures:
        _log("一部の投稿先で失敗しました: " + " / ".join(failures))
    return 0


if __name__ == "__main__":
    sys.exit(main())
