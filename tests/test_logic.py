"""投稿ロジックの自動テスト。外部通信は一切しない。

  python tests/test_logic.py
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import ai_assist  # noqa: E402
import bluesky  # noqa: E402
import tips as tips_mod  # noqa: E402
import xapi  # noqa: E402
from textlen import x_weighted_length  # noqa: E402

_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    if condition:
        print(f"  OK   {label}")
    else:
        print(f"  FAIL {label}")
        _failures.append(label)


# X 公式ドキュメントのサンプル値。署名の検証用。
_OAUTH_URL = "https://api.twitter.com/1.1/statuses/update.json"
_OAUTH_PARAMS = {
    "status": "Hello Ladies + Add Yourself!",
    "include_entities": "true",
    "oauth_consumer_key": "xvz1evFS4wEEPTGEFPHBog",
    "oauth_nonce": "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    "oauth_signature_method": "HMAC-SHA1",
    "oauth_timestamp": "1318622958",
    "oauth_token": "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    "oauth_version": "1.0",
}
_OAUTH_CONSUMER_SECRET = "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw"
_OAUTH_TOKEN_SECRET = "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"

# 上記入力に対して署名ベース文字列はこうなる (RFC 5849 の正規化規則)。
_EXPECTED_BASE = (
    "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json"
    "&include_entities%3Dtrue"
    "%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog"
    "%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"
    "%26oauth_signature_method%3DHMAC-SHA1"
    "%26oauth_timestamp%3D1318622958"
    "%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"
    "%26oauth_version%3D1.0"
    "%26status%3DHello%2520Ladies%2520%252B%2520Add%2520Yourself%2521"
)

# 上の入力に対する正しい署名。oauthlib の実装と突き合わせて確定させた値。
_EXPECTED_SIGNATURE = "cGfmHX2eA5NADdSQNaRCqKPPf7I="


def test_oauth_signature() -> None:
    """HMAC-SHA1 署名を検証する。

    ここが 1 バイトでもずれると本番で 401 になる。パーセントエンコードの
    規則 (RFC 3986: '~' は非エスケープ、'/' や '!' はエスケープ) を
    間違えやすいので、ベース文字列と最終署名の両方を固定値で確認する。
    """
    print("OAuth 1.0a 署名:")

    normalized = "&".join(
        f"{xapi._quote(k)}={xapi._quote(v)}" for k, v in sorted(_OAUTH_PARAMS.items())
    )
    base = "&".join(["POST", xapi._quote(_OAUTH_URL), xapi._quote(normalized)])
    check(base == _EXPECTED_BASE, "署名ベース文字列が RFC 5849 の正規化と一致")

    signature = xapi._sign(
        "POST", _OAUTH_URL, _OAUTH_PARAMS, _OAUTH_CONSUMER_SECRET, _OAUTH_TOKEN_SECRET
    )
    check(signature == _EXPECTED_SIGNATURE, f"署名が期待値と一致 ({signature})")

    # oauthlib が入っていれば、独立実装を正解として突き合わせる。
    # 本番コードは oauthlib に依存しないので、無ければ黙って飛ばす。
    try:
        from oauthlib.oauth1.rfc5849.signature import sign_hmac_sha1
    except ImportError:
        print("  SKIP oauthlib 未インストールのため相互検証は省略")
        return
    reference = sign_hmac_sha1(base, _OAUTH_CONSUMER_SECRET, _OAUTH_TOKEN_SECRET)
    check(signature == reference, "独立実装 (oauthlib) と一致")


def test_facets() -> None:
    """日本語本文でハッシュタグのバイト位置が正しく取れるか。"""
    print("Bluesky facet:")
    text = "記憶は出力で定着する。\n\n#心理学 #勉強法"
    facets = bluesky.build_facets(text)
    encoded = text.encode("utf-8")
    check(len(facets) == 2, f"タグを2個検出 (実際 {len(facets)})")
    tags = [
        encoded[f["index"]["byteStart"] : f["index"]["byteEnd"]].decode("utf-8")
        for f in facets
    ]
    check(tags == ["#心理学", "#勉強法"], f"オフセットが正しい {tags}")

    # 句読点がタグに巻き込まれないこと
    facets2 = bluesky.build_facets("本文です。#心理学、そして続き")
    check(len(facets2) == 0, "文中の # は空白直後でないので拾わない")

    # URL も facet 化されること
    facets3 = bluesky.build_facets("詳しくは https://example.com を参照")
    check(
        len(facets3) == 1 and facets3[0]["features"][0]["uri"] == "https://example.com",
        "URL を link facet にする",
    )


def test_rotation() -> None:
    """1 巡の間に同じ豆知識が二度出ないこと。"""
    print("ローテーション:")
    all_tips = tips_mod.load_all()
    total = len(all_tips)

    seen: list[str] = []
    done: set[str] = set()
    last_category = ""
    for _ in range(total):
        tip = tips_mod.pick_next(all_tips, 1, done, last_category)
        seen.append(tip.id)
        done.add(tip.id)
        last_category = tip.category

    check(len(set(seen)) == total, f"1巡で全{total}件が重複なく出る")

    # 巡回が変われば順序も変わる
    first = [t.id for t in tips_mod.rotation(all_tips, 1)]
    second = [t.id for t in tips_mod.rotation(all_tips, 2)]
    check(first != second, "巡回ごとに順序が変わる")
    check(sorted(first) == sorted(second), "順序が変わっても件数と中身は同じ")
    check(
        [t.id for t in tips_mod.rotation(all_tips, 1)] == first,
        "同じ巡回番号なら順序は再現される",
    )


def test_category_spacing() -> None:
    """同じカテゴリが連続しないこと。"""
    print("カテゴリの散らばり:")
    all_tips = tips_mod.load_all()
    done: set[str] = set()
    last_category = ""
    consecutive = 0
    for _ in range(len(all_tips)):
        tip = tips_mod.pick_next(all_tips, 3, done, last_category)
        if tip.category == last_category:
            consecutive += 1
        done.add(tip.id)
        last_category = tip.category

    # 終盤は残りが1カテゴリに偏るため、ゼロにはできない。
    # 全体の1割未満に収まっていれば体感上は十分ばらけている。
    limit = len(all_tips) // 10
    check(consecutive <= limit, f"連続は{consecutive}回 (許容 {limit}回以下)")


def test_lengths() -> None:
    """全件が両プラットフォームの上限に収まること。"""
    print("文字数:")
    all_tips = tips_mod.load_all()
    problems = tips_mod.validate(all_tips)
    check(not problems, f"検証エラーなし ({len(problems)} 件)")
    longest = max(x_weighted_length(t.render()) for t in all_tips)
    check(longest <= 280, f"最長 {longest}/280")

    categories = Counter(t.category for t in all_tips)
    check(len(categories) >= 5, f"カテゴリ数 {len(categories)}")


def _issue(number: int, body: str, login: str = "owner") -> dict:
    return {"number": number, "title": "テスト", "body": body, "user": {"login": login}}


def _comment(login: str, body: str) -> dict:
    return {"user": {"login": login}, "body": body}


def test_ai_assist() -> None:
    """Issue の会話履歴組み立て。ネットワークにも Claude にも触らない。"""
    print("AI アシスタント:")

    bot = ai_assist.BOT_LOGIN

    # Issue 本文だけ
    msgs = ai_assist.build_messages(_issue(1, "X で 403 が出ます"), [])
    check(len(msgs) == 1 and msgs[0]["role"] == "user", "Issue 本文が最初の user 発言")
    check("403" in msgs[0]["content"], "本文が引き継がれる")

    # 人 → bot → 人 が交互になる
    msgs = ai_assist.build_messages(
        _issue(2, "質問です"),
        [_comment("owner", "補足です"), _comment(bot, "回答です"), _comment("owner", "追加で")],
    )
    roles = [m["role"] for m in msgs]
    check(roles == ["user", "assistant", "user"], f"役割が交互 {roles}")
    check("補足です" in msgs[0]["content"], "連続する user 発言がまとまる")

    # 末尾が bot のままだと「書きかけの続き」を求める形になるので user を足す
    msgs = ai_assist.build_messages(
        _issue(3, "質問です"), [_comment(bot, "回答です")]
    )
    check(msgs[-1]["role"] == "user", "末尾が user になる")

    # 空コメントは履歴に入れない
    msgs = ai_assist.build_messages(_issue(4, "質問です"), [_comment("owner", "   ")])
    check(len(msgs) == 1, "空コメントは無視される")

    # 自分の署名を会話履歴に持ち込まない
    signed = "回答です" + ai_assist.FOOTER
    check(ai_assist.strip_footer(signed) == "回答です", "署名を取り除く")
    check(ai_assist.strip_footer("署名なし") == "署名なし", "署名がなければそのまま")

    # 資料が実際に集まる
    reference = ai_assist.load_reference()
    for name in ("README.md", "docs/SETUP.md", "src/post.py"):
        check(f"===== {name} =====" in reference, f"資料に {name} が入る")
    check(ai_assist.context_size(reference, msgs) > len(reference), "文字数を数えられる")


def main() -> int:
    for test in (
        test_oauth_signature,
        test_facets,
        test_rotation,
        test_category_spacing,
        test_lengths,
        test_ai_assist,
    ):
        test()

    if _failures:
        print(f"\n{len(_failures)} 件失敗")
        return 1
    print("\n全テスト通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
