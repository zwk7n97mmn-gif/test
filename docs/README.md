# ドキュメント一覧

目的から引いてください。

| 読みたいこと | ファイル |
|---|---|
| 動かすまでの手順（最初にやる作業） | [SETUP.md](SETUP.md) |
| ふだんの運用・止め方・困ったとき | [OPERATIONS.md](OPERATIONS.md) |
| 中で何が起きているか（設計） | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 豆知識の書き方・採否の基準 | [EDITORIAL.md](EDITORIAL.md) |
| Issue で AI に質問する仕組み | [AI-ASSISTANT.md](AI-ASSISTANT.md) |

プロジェクト全体の概要は、リポジトリ直下の [README.md](../README.md) にあります。

---

## この構成について

資料は「読む目的」ごとに分けています。1 つのファイルに全部書くと、
知りたい 3 行を探すのに全体を読むことになるためです。

- **SETUP.md** は一度きりの作業だけ。読み終えたら二度と開かなくて済むように書く。
- **OPERATIONS.md** は動き始めた後に開くもの。困ったときの索引。
- **ARCHITECTURE.md** は中身を変えたい人向け。仕様の根拠を置く。
- **EDITORIAL.md** はコンテンツの判断基準。何を載せないかを含む。

この分け方は AI アシスタント（[AI-ASSISTANT.md](AI-ASSISTANT.md)）にもそのまま効きます。
アシスタントは `README.md`、`docs/*.md`、`src/*.py`、`.github/workflows/*.yml` を
毎回読んでから回答するので、**ここに資料を足せば、コードを触らずに回答の質が上がります。**
逆に、どこにも書かれていないことは「資料にありません」と返ってきます。
