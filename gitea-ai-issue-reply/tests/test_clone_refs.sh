#!/usr/bin/env bash
# 参照リポジトリの取得を、偽の git を使って確かめる（外部への通信はしない）。
#   bash tests/test_clone_refs.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../scripts/clone_refs.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
check() { if [ "$2" = "true" ]; then echo "  OK   $1"; else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi; }
contains() { case "$1" in *"$2"*) echo true;; *) echo false;; esac; }

# --- 偽の git。通信せず、呼ばれた引数を記録する ---
mkdir -p "$TMP/bin"
cat > "$TMP/bin/git" <<'FAKE'
#!/usr/bin/env bash
echo "git $*" >> "$GIT_LOG"
case "$1" in
  clone)
    # 最後の引数が配置先。URL に "missing" を含むリポジトリは失敗させる
    for a in "$@"; do url="$prev"; prev="$a"; done
    dest="$prev"
    for a in "$@"; do case "$a" in *missing*) echo "remote: Not found." >&2; exit 128;; esac; done
    mkdir -p "$dest/.git"
    echo "token=$(echo "$*" | grep -o 'x-access-token:[^@]*' || true)" > "$dest/.git/config"
    echo "content" > "$dest/README.md"
    ;;
  -C) shift; d="$1"; shift; [ -d "$d" ] || exit 1 ;;
esac
exit 0
FAKE
chmod +x "$TMP/bin/git"

run_case() { # run_case <refs.json の中身>
  rm -rf "$TMP/work"; mkdir -p "$TMP/work"
  printf '%s' "$1" > "$TMP/work/refs.json"
  export GIT_LOG="$TMP/work/git.log"; : > "$GIT_LOG"
  ( cd "$TMP/work" && PATH="$TMP/bin:$PATH" GITEA_SERVER=https://gitea.example.com \
      REF_TOKEN=SECRETTOKEN bash "$SCRIPT" 2>&1 )
}

echo "参照リポジトリの取得"

OUT=$(run_case '{"repos":[{"path":"src","repo":"org/app","ref":"main"}]}')
check "取得できたら ok と表示する" "$(contains "$OUT" 'ok      src')"
check "clone は --depth 1 で浅く取る" "$(contains "$(cat "$TMP/work/git.log")" -- '--depth 1')"
check "ref をブランチとして渡す" "$(contains "$(cat "$TMP/work/git.log")" -- '--branch main')"
check "取得したディレクトリが残る" "$([ -f "$TMP/work/src/README.md" ] && echo true || echo false)"
check "トークンが残る .git を消している" "$([ ! -e "$TMP/work/src/.git" ] && echo true || echo false)"
check "トークンを出力に出さない" "$([ "$(contains "$OUT" SECRETTOKEN)" = false ] && echo true || echo false)"

OUT=$(run_case '{"repos":[
  {"path":"ng","repo":"org/missing-repo","ref":"main"},
  {"path":"ok1","repo":"org/app","ref":"main"}]}')
check "1 つ失敗しても残りを取得する" "$(contains "$OUT" 'ok      ok1')"
check "失敗したものは MISSING と表示する" "$(contains "$OUT" 'MISSING ng')"
check "失敗を警告として出す" "$(contains "$OUT" '::warning::')"
check "失敗したディレクトリは残さない" "$([ ! -e "$TMP/work/ng" ] && echo true || echo false)"
check "結果が refs-status.txt に残る" "$(contains "$(cat "$TMP/work/refs-status.txt")" 'MISSING ng')"

OUT=$(run_case '{"repos":[{"path":"doc","repo":"org/doc","ref":"main","sparse":["/*","!*.xlsx"]}]}')
LOG=$(cat "$TMP/work/git.log")
check "sparse 指定があれば --no-checkout で取る" "$(contains "$LOG" -- '--no-checkout')"
check "sparse-checkout を cone なしで設定する" "$(contains "$LOG" 'sparse-checkout set --no-cone')"
check "除外パターンを渡している" "$(contains "$LOG" '!*.xlsx')"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL 件失敗しました。"; exit 1; fi
echo "すべて通りました。"
