"""wiki の決まりごと検査を確かめる。

  python3 tests/test_wiki_lint.py

一時ディレクトリに、わざと規約を破った wiki を作って動かします。通信はしません。
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINT = ROOT / "scripts" / "wiki_lint.py"
_failures: list[str] = []


def check(condition: bool, label: str) -> None:
    print(f"  {'OK  ' if condition else 'FAIL'} {label}")
    if not condition:
        _failures.append(label)


def build(work: Path, readme: str, pages: dict[str, str], config: dict | None = None,
          files: list[str] | None = None) -> None:
    work.mkdir(parents=True, exist_ok=True)
    (work / "scripts").mkdir(exist_ok=True)
    (work / "scripts" / "wiki_lint.py").write_text(LINT.read_text(encoding="utf-8"), encoding="utf-8")
    (work / "wiki-lint.json").write_text(json.dumps(config or {}, ensure_ascii=False), encoding="utf-8")
    (work / "README.md").write_text(readme, encoding="utf-8")
    for name, body in pages.items():
        path = work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    for name in files or []:
        path = work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")


def run(work: Path, *args: str) -> tuple[int, str]:
    result = subprocess.run([sys.executable, str(work / "scripts" / "wiki_lint.py"), *args],
                            capture_output=True, text=True, timeout=60, cwd=str(work))
    return result.returncode, result.stdout + result.stderr


def page(title: str, crumb: str = "🏠ホーム", body: str = "") -> str:
    return f"# {title}\n\n📍`{crumb} > {title}`\n\n---\n\n{body}\n"


CLEAN_README = """# ホーム

## <a id="setup"></a>💻手順
- [手順](#setup)
- [🔰はじめに](はじめに.md)
- [検索コンポーネント(searchCond)](<機能/検索コンポーネント(searchCond).md>)
"""
CLEAN_PAGES = {
    "はじめに.md": page("はじめに"),
    "機能/検索コンポーネント(searchCond).md": page("検索コンポーネント(searchCond)"),
}


def main() -> None:
    print("wiki の決まりごと検査")
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)

        w = base / "clean"; build(w, CLEAN_README, CLEAN_PAGES)
        code, out = run(w)
        check(code == 0, "規約どおりの wiki は通る")

        # links
        w = base / "broken"
        build(w, CLEAN_README + "- [消したページ](消えた.md)\n", CLEAN_PAGES)
        code, out = run(w, "--only", "links")
        check(code == 1 and "消えた.md" in out, "リンク先が無いページを見つける")

        # wrapping
        w = base / "wrap"
        build(w, "# ホーム\n\n- [部品(x)](機能/部品(x).md)\n",
              {"機能/部品(x).md": page("部品(x)")})
        code, out = run(w, "--only", "wrapping")
        check(code == 1 and "部品(x" in out, "括弧つきパスを <> で囲んでいないと知らせる")

        # anchors
        w = base / "anchor"
        build(w, "# ホーム\n\n- [飛び先なし](#nowhere)\n", {})
        code, out = run(w, "--only", "anchors")
        check(code == 1 and "nowhere" in out, "飛び先の無いアンカーを見つける")

        w = base / "anchor2"
        build(w, '# ホーム\n\n## <a id="unused"></a>使われない見出し\n', {})
        code, out = run(w, "--only", "anchors")
        check(code == 1 and "unused" in out, "どこからも使われていないアンカーを見つける")

        # filenames
        w = base / "name"
        build(w, "# ホーム\n\n- [画面設計手順](設計.md)\n", {"設計.md": page("画面設計手順")})
        code, out = run(w, "--only", "filenames")
        check(code == 1 and "設計" in out, "目次の表記とファイル名の食い違いを見つける")

        w = base / "name_emoji"
        build(w, "# ホーム\n\n- [👀画面設計手順](画面設計手順.md)\n",
              {"画面設計手順.md": page("画面設計手順")})
        code, out = run(w, "--only", "filenames")
        check(code == 0, "絵文字はファイル名に含めない扱いにする")

        w = base / "name_slash"
        build(w, "# ホーム\n\n- [時刻/時間隔(time)](<時刻・時間隔(time).md>)\n",
              {"時刻・時間隔(time).md": page("時刻・時間隔(time)")})
        code, out = run(w, "--only", "filenames")
        check(code == 0, "使えない文字（/）は ・ に置き換える扱いにする")

        w = base / "name_code"
        build(w, "# ホーム\n\n- [メニュー - `main_menu_no`](<メニュー - main_menu_no.md>)\n",
              {"メニュー - main_menu_no.md": page("メニュー - main_menu_no")})
        code, out = run(w, "--only", "filenames")
        check(code == 0, "インラインコードの記号はファイル名に含めない扱いにする")

        w = base / "name_underscore"
        build(w, "# ホーム\n\n- [jinkyu_tools](jinkyu_tools.md)\n",
              {"jinkyu_tools.md": page("jinkyu_tools")})
        code, out = run(w, "--only", "filenames")
        check(code == 0, "アンダースコアは名前の一部として残す")

        w = base / "name_alias"
        build(w, "# ホーム\n\n- [超概要情報](概要/超概要情報.md)\n- 詳しくは [CMGEN951](概要/超概要情報.md) を参照\n",
              {"概要/超概要情報.md": page("超概要情報")})
        code, out = run(w, "--only", "filenames")
        check(code == 0, "同じページへの別表記の言及では落ちない")

        # orphans
        w = base / "orphan"
        build(w, CLEAN_README, {**CLEAN_PAGES, "迷子.md": page("迷子")})
        code, out = run(w, "--only", "orphans")
        check(code == 1 and "迷子.md" in out, "どこからも辿れないページを見つける")

        w = base / "orphan_allow"
        build(w, CLEAN_README, {**CLEAN_PAGES, "迷子.md": page("迷子")},
              config={"allow_orphan": ["迷子.md"]})
        code, out = run(w, "--only", "orphans")
        check(code == 0, "allow_orphan に書けば孤立を許す")

        # breadcrumbs
        w = base / "crumb"
        build(w, CLEAN_README, {**CLEAN_PAGES, "はじめに.md": "# はじめに\n\n本文だけ\n"})
        code, out = run(w, "--only", "breadcrumbs")
        check(code == 1 and "パンくず" in out, "パンくずが無いページを見つける")

        w = base / "crumb2"
        build(w, CLEAN_README, {**CLEAN_PAGES, "はじめに.md": "見出しから始まっていない\n"})
        code, out = run(w, "--only", "breadcrumbs")
        check(code == 1 and "1 行目" in out, "見出しから始まっていないページを見つける")

        # images
        w = base / "img"
        build(w, "# ホーム\n\n![図](_image/_HOME/無い.png)\n", {})
        code, out = run(w, "--only", "images")
        check(code == 1 and "参照先が無い" in out, "画像の参照先が無いのを見つける")

        w = base / "img_abs"
        build(w, "# ホーム\n\n![図](/_image/_HOME/01.png)\n", {},
              files=["_image/_HOME/01.png"])
        code, out = run(w, "--only", "images")
        check(code == 1 and "絶対パス" in out, "ルート起点の絶対パスを見つける")

        w = base / "img_ok"
        build(w, "# ホーム\n\n![図](_image/_HOME/01.png)\n"
                 '<video src="_image/_HOME/00.mp4" controls="true"></video>\n', {},
              files=["_image/_HOME/01.png", "_image/_HOME/00.mp4"])
        code, out = run(w, "--only", "images")
        check(code == 0, "img と video の src も見る")

        # 設定・オプション
        w = base / "disabled"
        build(w, CLEAN_README + "- [消したページ](消えた.md)\n", CLEAN_PAGES,
              config={"checks": {"links": False, "filenames": False}})
        code, out = run(w)
        check(code == 0 and "設定で無効" in out, "checks で個別に切れる")

        w = base / "fence"
        build(w, CLEAN_README + "\n```\n[書き方の例](存在しない.md)\n```\n", CLEAN_PAGES)
        code, out = run(w, "--only", "links")
        check(code == 0, "コードブロック内の例は見ない")

        w = base / "cap"
        many = "\n".join(f"- [ページ{i}](無い{i}.md)" for i in range(30))
        build(w, "# ホーム\n\n" + many, {}, config={"max_report": 3})
        code, out = run(w, "--only", "links")
        check(code == 1 and "他 27 件" in out, "報告件数の上限を超えたら件数だけ出す")

        # --- 画像の置き場 ---
        w = base / "imglayout_ok"
        build(w, "# ホーム\n\n- [部品](機能/部品.md)\n",
              {"機能/部品.md": page("部品", body="![図](../_image/機能/部品/01.png)")},
              files=["_image/機能/部品/01.png"])
        code, out = run(w, "--only", "image_layout")
        check(code == 0, "ページごとの置き場にある画像は通る")

        w = base / "imglayout_shared"
        build(w, "# ホーム\n\n- [部品](機能/部品.md)\n",
              {"機能/部品.md": page("部品", body="![図](../_image/機能/共通.png)")},
              files=["_image/機能/共通.png"])
        code, out = run(w, "--only", "image_layout")
        check(code == 0, "上の階層に置いた共有画像は通す")

        w = base / "imglayout_ng"
        build(w, "# ホーム\n\n- [部品](機能/部品.md)\n",
              {"機能/部品.md": page("部品", body="![図](../_image/別の機能/別ページ/01.png)")},
              files=["_image/別の機能/別ページ/01.png"])
        code, out = run(w, "--only", "image_layout")
        check(code == 1 and "置き場が違う" in out, "別のページの画像フォルダを参照しているのを見つける")

        w = base / "imglayout_outside"
        build(w, "# ホーム\n\n![図](画像/01.png)\n", {}, files=["画像/01.png"])
        code, out = run(w, "--only", "image_layout")
        check(code == 1 and "_image/ の外" in out, "_image/ の外に置かれた画像を見つける")

        # --- <details> ---
        w = base / "details_ng"
        build(w, "# ホーム\n\n<details>\n  <summary>開く</summary>\n\n| 表 |\n| --- |\n\n</details>\n", {})
        code, out = run(w, "--only", "details")
        check(code == 1 and "<div>" in out, "<details> が <div> で囲まれていないのを見つける")

        w = base / "details_ok"
        build(w, "# ホーム\n\n<details>\n  <summary>開く</summary>\n  <div>\n\n| 表 |\n| --- |\n\n  </div>\n</details>\n", {})
        code, out = run(w, "--only", "details")
        check(code == 0, "<div> で囲まれていれば通る")

        # --- アンカーの位置 ---
        w = base / "anchor_pos"
        build(w, '# ホーム\n\n<a id="x"></a>\n## 見出し\n\n- [飛ぶ](#x)\n', {})
        code, out = run(w, "--only", "anchor_placement")
        check(code == 1 and "見出し行の内側" in out, "アンカーが別行にあるのを見つける")

        w = base / "anchor_pos_ok"
        build(w, '# ホーム\n\n## <a id="x"></a>見出し\n\n- [飛ぶ](#x)\n', {})
        code, out = run(w, "--only", "anchor_placement")
        check(code == 0, "見出し行の内側にあれば通る")

        # --- 覆う範囲（今回踏んだところ） ---
        w = base / "mask_inline"
        build(w, '# ホーム\n\n書き方: `## <a id="例"></a>見出し` のように書く\n', {})
        code, out = run(w, "--only", "anchors,anchor_placement")
        check(code == 0, "インラインコードで書いた「書き方の例」は拾わない")

        w = base / "mask_lineno"
        build(w, '# ホーム\n\n```\n例\n例\n```\n\n<a id="y"></a>\n\n[飛ぶ](#y)\n', {})
        code, out = run(w, "--only", "anchor_placement")
        check(code == 1 and ":8" in out, "コードブロックがあっても指摘の行番号がずれない")

        w = base / "fence_quote"
        build(w, "# ホーム\n\n> 書き方:\n> ```md\n> ![図](_image/_HOME/無い.png)\n> ```\n", {})
        code, out = run(w, "--only", "images")
        check(code == 0, "引用の中のコードブロックも対象外にする")

        w = base / "fence_inline"
        build(w, "# ホーム\n\n| mermaid | ` ```mermaid ` で囲む |\n| --- | --- |\n\n"
                 "```md\n![図](_image/_HOME/無い.png)\n```\n", {})
        code, out = run(w, "--only", "images")
        check(code == 0, "行の途中にバッククォート3つがあってもコードブロックの対応が狂わない")

        w = base / "img_inline"
        build(w, '# ホーム\n\n`<img src="...">` はHTML属性なので囲み不要\n', {})
        code, out = run(w, "--only", "images")
        check(code == 0, "インラインコードで書いた img の説明は拾わない")

        # ⚠ バッククォート 2 つで囲む書き方。1 つ決め打ちだと囲みがずれて中身が素通りする
        w = base / "img_double_tick"
        build(w, '# ホーム\n\n`` `<img src="...">` `` のような説明を拾わない\n', {})
        code, out = run(w, "--only", "images")
        check(code == 0, "バッククォート2つで囲んだ img の説明も拾わない")

        w = base / "double_tick_link"
        build(w, "# ホーム\n\n`` `[表示](消えたページ.md)` `` は書き方の例\n", {})
        code, out = run(w, "--only", "anchors")
        check(code == 0, "バッククォート2つで囲んだ中身は本物の定義として数えない")

        # --- 色で意味を表さない ---
        w = base / "style_color"
        build(w, '# ホーム\n\n<span style="color: red; background: white;">重要</span>\n', {})
        code, out = run(w, "--only", "styling")
        check(code == 1 and "色は消える" in out, "色で意味を表しているのを見つける")

        w = base / "style_font"
        build(w, "# ホーム\n\n<font color=\"red\">重要</font>\n", {})
        code, out = run(w, "--only", "styling")
        check(code == 1 and "<font>" in out, "<font> を見つける")

        w = base / "style_ok"
        build(w, '# ホーム\n\n> 🚨 **重要**\n\n<img width="900" src="_image/_HOME/01.png" alt="図">\n',
              {}, files=["_image/_HOME/01.png"])
        code, out = run(w, "--only", "styling")
        check(code == 0, "色以外の属性（width）は咎めない")

        w = base / "style_example"
        build(w, '# ホーム\n\n書いてはいけない例: `<span style="color: red;">`\n', {})
        code, out = run(w, "--only", "styling")
        check(code == 0, "書き方の例として貼った色指定は拾わない")

        w = base / "cross_repo"
        build(w, "# ホーム\n\n- [別のツール](../other/README.md)\n", {})
        (base / "other").mkdir(parents=True, exist_ok=True)
        (base / "other" / "README.md").write_text("# 別\n", encoding="utf-8")
        code, out = run(w, "--only", "filenames")
        check(code == 0, "別リポジトリへのリンクは命名規約の対象にしない")

    print()
    if _failures:
        print(f"{len(_failures)} 件失敗しました:")
        for item in _failures:
            print(f"  - {item}")
        sys.exit(1)
    print("すべて通りました。")


if __name__ == "__main__":
    main()
