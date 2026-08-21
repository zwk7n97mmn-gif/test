/* ============================================================
   見本：カウンタ（TaskDeck 拡張の最小例）
   ------------------------------------------------------------
   新しい拡張を作るときは、このフォルダを写して始めてください。
   拡張 API の使いかたは taskdeck-docs/docs/仕様/拡張API仕様.md を参照。
   ============================================================ */

// 保存領域は拡張ごとに分かれている。無ければ既定値が返る。
const state = api.storage.get({ count: 0, history: [] });

// 本体の CSS 変数をそのまま使える（明暗テーマにも自動で追従する）
api.ui.injectStyle(`
.counter-box{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.counter-num{font-size:40px;font-weight:800;font-variant-numeric:tabular-nums}
`);

api.registerView({
  id: "main",
  label: "カウンタ",
  icon: "◍",
  render(box) {
    // 描き直しのたびに呼ばれるので、中身は毎回作り直す
    box.innerHTML = `
      <div class="plugin-host counter-box">
        <div class="counter-num">${state.count}</div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="inc">数える</button>
          <button class="btn" id="reset">0 に戻す</button>
        </div>
        <div style="color:var(--muted);font-size:13px">
          ${api.entitled ? "製品版です。上限はありません。" : `評価中です。${api.trialLimit} 回まで数えられます。`}
        </div>
        ${state.history.length ? `<div style="color:var(--faint);font-size:12px">
          最後に数えた時刻: ${api.ui.escapeHtml(api.ui.formatStamp(state.history[state.history.length - 1]))}</div>` : ""}
      </div>`;

    box.querySelector("#inc").onclick = () => {
      if (!api.entitled && state.count >= api.trialLimit) {
        api.ui.toast(`評価中は ${api.trialLimit} 回までです`);
        return;
      }
      state.count += 1;
      state.history.push(new Date().toISOString());
      api.storage.set(state);
      api.ui.refresh();
    };

    box.querySelector("#reset").onclick = () => {
      if (!api.ui.confirm("0 に戻します。よろしいですか？")) return;
      state.count = 0;
      state.history = [];
      api.storage.set(state);
      api.ui.refresh();
    };
  },
});

// タスクの詳細にも小さな欄を足せる
api.registerTaskPanel({
  id: "hint",
  title: "カウンタ（見本）",
  render(box, task) {
    box.innerHTML = `<div style="color:var(--muted);font-size:13px">
      いまのカウンタは ${state.count} です。（このタスク: ${api.ui.escapeHtml(task.title)}）</div>`;
  },
});
