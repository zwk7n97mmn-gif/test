/* ============================================================
   確定申告データ管理（TaskDeck 拡張 / 複式簿記）
   ------------------------------------------------------------
   個人事業主の青色申告を想定した帳簿です。仕訳を貸借で記録し、
   総勘定元帳・試算表・損益計算書・貸借対照表まで自動で集計します。

   使えるのは api（TaskDeck が渡す窓口）だけで、
   本体のタスクデータには api.tasks 経由でしか触れません。
   ============================================================ */

/* ---------- 既定の勘定科目（個人事業主向け） ---------- */
const DEFAULT_ACCOUNTS = [
  { code: "101", name: "現金",         type: "asset" },
  { code: "102", name: "普通預金",     type: "asset" },
  { code: "103", name: "売掛金",       type: "asset" },
  { code: "104", name: "前払費用",     type: "asset" },
  { code: "105", name: "工具器具備品", type: "asset" },
  { code: "110", name: "事業主貸",     type: "asset" },
  { code: "201", name: "買掛金",       type: "liability" },
  { code: "202", name: "未払金",       type: "liability" },
  { code: "203", name: "預り金",       type: "liability" },
  { code: "210", name: "事業主借",     type: "liability" },
  { code: "301", name: "元入金",       type: "equity" },
  { code: "401", name: "売上高",       type: "revenue" },
  { code: "402", name: "雑収入",       type: "revenue" },
  { code: "501", name: "仕入高",       type: "expense" },
  { code: "502", name: "租税公課",     type: "expense" },
  { code: "503", name: "荷造運賃",     type: "expense" },
  { code: "504", name: "水道光熱費",   type: "expense" },
  { code: "505", name: "旅費交通費",   type: "expense" },
  { code: "506", name: "通信費",       type: "expense" },
  { code: "507", name: "広告宣伝費",   type: "expense" },
  { code: "508", name: "接待交際費",   type: "expense" },
  { code: "509", name: "損害保険料",   type: "expense" },
  { code: "510", name: "修繕費",       type: "expense" },
  { code: "511", name: "消耗品費",     type: "expense" },
  { code: "512", name: "減価償却費",   type: "expense" },
  { code: "513", name: "福利厚生費",   type: "expense" },
  { code: "514", name: "外注工賃",     type: "expense" },
  { code: "515", name: "地代家賃",     type: "expense" },
  { code: "516", name: "支払手数料",   type: "expense" },
  { code: "517", name: "支払利息",     type: "expense" },
  { code: "519", name: "雑費",         type: "expense" },
];

const TYPE_LABEL = { asset: "資産", liability: "負債", equity: "資本", revenue: "収益", expense: "費用" };
// 借方が増加になる科目（残高の向きを決める）
const DEBIT_POSITIVE = { asset: true, expense: true, liability: false, equity: false, revenue: false };

/* ---------- 保存データ ---------- */
function defaultState() {
  return {
    version: 1,
    settings: { businessName: "", fiscalYear: new Date().getFullYear() },
    accounts: DEFAULT_ACCOUNTS.map(account => ({ ...account })),
    entries: [],
  };
}

const persist = () => api.storage.set(state);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const toAmount = value => {
  const number = Math.round(Number(String(value ?? "").replace(/[,，\s円]/g, "")) || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
};
const yen = value => "¥" + Number(value || 0).toLocaleString("ja-JP");
const esc = api.ui.escapeHtml;
const accountOf = code => state.accounts.find(a => a.code === code) || null;
const accountName = code => (accountOf(code) ? `${accountOf(code).name}` : `不明(${code})`);

let state = normalizeState(api.storage.get(null));
let container = null;              // いま描いている場所
let tab = "journal";               // journal / ledger / trial / report / settings
let ledgerAccount = "401";
let draft = null;                  // 入力中の仕訳
let notice = null;                 // 画面上部の一言

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  const accounts = Array.isArray(raw.accounts) && raw.accounts.length
    ? raw.accounts.filter(a => a && a.code && a.name && TYPE_LABEL[a.type])
      .map(a => ({ code: String(a.code).slice(0, 8), name: String(a.name).slice(0, 30), type: a.type }))
    : base.accounts;
  const codes = new Set(accounts.map(a => a.code));
  const entries = Array.isArray(raw.entries) ? raw.entries.filter(entry => {
    if (!entry || !isDate(entry.date) || !Array.isArray(entry.lines)) return false;
    return entry.lines.every(line => codes.has(String(line.code)));
  }).map(entry => ({
    id: String(entry.id || newId()),
    date: entry.date,
    description: String(entry.description || "").slice(0, 200),
    memo: String(entry.memo || "").slice(0, 500),
    taskId: entry.taskId || null,
    lines: entry.lines.map(line => ({
      code: String(line.code),
      debit: toAmount(line.debit),
      credit: toAmount(line.credit),
    })),
    createdAt: entry.createdAt || new Date().toISOString(),
  })) : [];
  const settings = Object.assign(base.settings, raw.settings || {});
  settings.fiscalYear = Number(settings.fiscalYear) || base.settings.fiscalYear;
  return { version: 1, settings, accounts, entries };
}

/* ---------- 年度と集計 ---------- */
const yearOf = entry => Number(entry.date.slice(0, 4));
function entriesOfYear(year = state.settings.fiscalYear) {
  return state.entries
    .filter(entry => yearOf(entry) === year)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}
function availableYears() {
  const years = new Set(state.entries.map(yearOf));
  years.add(state.settings.fiscalYear);
  return [...years].sort((a, b) => b - a);
}

/** 科目ごとの借方合計・貸方合計・残高。 */
function trialBalance(year) {
  const totals = new Map();
  for (const entry of entriesOfYear(year)) {
    for (const line of entry.lines) {
      const row = totals.get(line.code) || { code: line.code, debit: 0, credit: 0 };
      row.debit += line.debit;
      row.credit += line.credit;
      totals.set(line.code, row);
    }
  }
  return [...totals.values()]
    .map(row => {
      const account = accountOf(row.code);
      const type = account ? account.type : "asset";
      const balance = DEBIT_POSITIVE[type] ? row.debit - row.credit : row.credit - row.debit;
      return { ...row, name: accountName(row.code), type, balance };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

function summary(year) {
  const rows = trialBalance(year);
  const sumOf = type => rows.filter(row => row.type === type).reduce((total, row) => total + row.balance, 0);
  const revenue = sumOf("revenue");
  const expense = sumOf("expense");
  return {
    rows,
    revenue,
    expense,
    profit: revenue - expense,
    asset: sumOf("asset"),
    liability: sumOf("liability"),
    equity: sumOf("equity"),
    debitTotal: rows.reduce((total, row) => total + row.debit, 0),
    creditTotal: rows.reduce((total, row) => total + row.credit, 0),
  };
}

/* ---------- 仕訳の追加・削除 ---------- */
const trialReached = () => api.trialLimit !== null && state.entries.length >= api.trialLimit;

function addEntry(entry) {
  if (trialReached()) {
    return { ok: false, message: `評価中に登録できる仕訳は ${api.trialLimit} 件までです。ライセンスキーを登録すると制限がなくなります。` };
  }
  const problem = validateEntry(entry);
  if (problem) return { ok: false, message: problem };
  state.entries.push({
    id: newId(),
    date: entry.date,
    description: entry.description.trim(),
    memo: (entry.memo || "").trim(),
    taskId: entry.taskId || null,
    lines: entry.lines.map(line => ({ code: line.code, debit: toAmount(line.debit), credit: toAmount(line.credit) })),
    createdAt: new Date().toISOString(),
  });
  persist();
  return { ok: true, message: "仕訳を登録しました。" };
}

function validateEntry(entry) {
  if (!isDate(entry.date)) return "日付を入れてください。";
  if (!entry.description || !entry.description.trim()) return "摘要を入れてください。";
  const lines = entry.lines.filter(line => toAmount(line.debit) > 0 || toAmount(line.credit) > 0);
  if (lines.length < 2) return "借方と貸方に、それぞれ 1 行以上の金額を入れてください。";
  for (const line of lines) {
    if (!accountOf(line.code)) return "勘定科目を選んでください。";
    if (toAmount(line.debit) > 0 && toAmount(line.credit) > 0) return "1 行のなかで借方と貸方の両方には入れられません。";
  }
  const debit = lines.reduce((total, line) => total + toAmount(line.debit), 0);
  const credit = lines.reduce((total, line) => total + toAmount(line.credit), 0);
  if (debit === 0 || credit === 0) return "借方と貸方の両方に金額が必要です。";
  if (debit !== credit) {
    return `借方の合計（${yen(debit)}）と貸方の合計（${yen(credit)}）が違います。差額は ${yen(Math.abs(debit - credit))} です。`;
  }
  return null;
}

function deleteEntry(id) {
  const entry = state.entries.find(item => item.id === id);
  if (!entry) return;
  if (!api.ui.confirm(`${entry.date}「${entry.description}」の仕訳を削除します。よろしいですか？`)) return;
  state.entries = state.entries.filter(item => item.id !== id);
  persist();
  notice = { ok: true, text: "仕訳を削除しました。" };
  rerender();
}

/* ---------- 入力中の仕訳 ---------- */
function emptyDraft(seed) {
  return Object.assign({
    date: api.ui.todayStr(),
    description: "",
    memo: "",
    taskId: null,
    lines: [{ code: "102", debit: "", credit: "" }, { code: "401", debit: "", credit: "" }],
  }, seed || {});
}
function ensureDraft() {
  if (!draft) draft = emptyDraft();
  return draft;
}

/* ============================================================
   画面
   ============================================================ */
api.ui.injectStyle(`
.tax-wrap{display:flex;flex-direction:column;gap:14px}
.tax-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tax-tabs{display:flex;gap:2px;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:2px}
.tax-tabs button{padding:5px 13px;border-radius:6px;font-size:13px;color:var(--muted);background:none;border:none;cursor:pointer}
.tax-tabs button.on{background:var(--panel);color:var(--text);font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.tax-panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.tax-grid{display:grid;gap:10px}
.tax-row{display:grid;grid-template-columns:1fr 130px 130px 30px;gap:8px;align-items:center}
.tax-row.head{font-size:11px;font-weight:700;color:var(--faint);letter-spacing:.06em}
.tax-in{width:100%;padding:7px 9px;border:1px solid var(--line-strong);border-radius:8px;background:var(--panel-2);color:inherit;font:inherit}
.tax-in.num{text-align:right;font-variant-numeric:tabular-nums}
.tax-sum{display:flex;gap:18px;justify-content:flex-end;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.tax-sum b{color:var(--text)}
.tax-sum .bad{color:var(--danger)}
.tax-table{width:100%;border-collapse:collapse;font-size:14px}
.tax-table th{font-size:11px;color:var(--faint);text-align:left;font-weight:700;letter-spacing:.06em;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
.tax-table td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.tax-table tr:last-child td{border-bottom:none}
.tax-table td.num,.tax-table th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tax-table tbody tr:hover{background:var(--panel-2)}
.tax-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.tax-card{border:1px solid var(--line);border-radius:10px;padding:14px;background:var(--panel-2)}
.tax-card .k{font-size:11px;color:var(--faint);font-weight:700;letter-spacing:.06em}
.tax-card .v{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:2px}
.tax-note{font-size:12.5px;color:var(--muted)}
.tax-del{color:var(--faint);border:none;background:none;cursor:pointer;font-size:14px}
.tax-del:hover{color:var(--danger)}
.tax-msg{padding:9px 11px;border-radius:8px;font-size:13px}
.tax-msg.ok{background:var(--ok-soft);color:var(--ok)}
.tax-msg.ng{background:var(--danger-soft);color:var(--danger)}
@media (max-width:720px){ .tax-row{grid-template-columns:1fr 100px 100px 26px} }
`);

const TABS = [
  ["journal",  "仕訳の入力"],
  ["list",     "仕訳帳"],
  ["ledger",   "総勘定元帳"],
  ["trial",    "試算表"],
  ["report",   "決算のまとめ"],
  ["settings", "設定"],
];

api.registerView({
  id: "book",
  label: "確定申告",
  icon: "¥",
  render(box) {
    container = box;
    paint();
  },
});

function rerender() {
  if (container) paint();
}

function paint() {
  const year = state.settings.fiscalYear;
  container.innerHTML = `
    <div class="tax-wrap">
      <div class="tax-head">
        <div class="tax-tabs">
          ${TABS.map(([id, label]) => `<button data-tab="${id}" class="${tab === id ? "on" : ""}">${label}</button>`).join("")}
        </div>
        <span style="flex:1"></span>
        <label class="tax-note">年度
          <select class="tax-in" id="taxYear" style="width:auto;display:inline-block;margin-left:6px">
            ${availableYears().map(y => `<option value="${y}"${y === year ? " selected" : ""}>${y} 年</option>`).join("")}
          </select>
        </label>
      </div>
      ${notice ? `<div class="tax-msg ${notice.ok ? "ok" : "ng"}">${esc(notice.text)}</div>` : ""}
      ${api.entitled ? "" : `<div class="tax-msg ng">評価中です。仕訳は ${api.trialLimit} 件まで登録できます（いま ${state.entries.length} 件）。</div>`}
      <div class="tax-panel" id="taxBody"></div>
    </div>`;
  notice = null;

  container.querySelectorAll("[data-tab]").forEach(button => {
    button.onclick = () => { tab = button.dataset.tab; paint(); };
  });
  container.querySelector("#taxYear").onchange = event => {
    state.settings.fiscalYear = Number(event.target.value);
    persist();
    paint();
  };

  const body = container.querySelector("#taxBody");
  ({ journal: paintJournal, list: paintList, ledger: paintLedger,
     trial: paintTrial, report: paintReport, settings: paintSettings }[tab] || paintJournal)(body);
}

/* ---------- 仕訳の入力 ---------- */
/** 合計と差額だけを描く。入力のたびにここだけ書き換える。 */
function totalsHtml(entry) {
  const debit = entry.lines.reduce((total, line) => total + toAmount(line.debit), 0);
  const credit = entry.lines.reduce((total, line) => total + toAmount(line.credit), 0);
  const gap = debit === credit ? "" : "bad";
  return `<span>借方合計 <b>${yen(debit)}</b></span>
    <span>貸方合計 <b>${yen(credit)}</b></span>
    <span class="${gap}">差額 <b class="${gap}">${yen(Math.abs(debit - credit))}</b></span>`;
}

function paintJournal(body) {
  const entry = ensureDraft();
  const options = code => state.accounts.map(account =>
    `<option value="${account.code}"${account.code === code ? " selected" : ""}>${esc(account.name)}（${TYPE_LABEL[account.type]}）</option>`).join("");
  const openTasks = api.tasks.list().filter(task => task.status !== "done");

  body.innerHTML = `
    <div class="tax-grid">
      <div style="display:grid;grid-template-columns:150px 1fr;gap:8px">
        <input class="tax-in" type="date" id="taxDate" value="${esc(entry.date)}" aria-label="日付">
        <input class="tax-in" type="text" id="taxDesc" value="${esc(entry.description)}" placeholder="摘要（例: A社 6月分 制作費）" aria-label="摘要">
      </div>
      <div class="tax-row head"><span>勘定科目</span><span style="text-align:right">借方</span><span style="text-align:right">貸方</span><span></span></div>
      ${entry.lines.map((line, index) => `
        <div class="tax-row" data-line="${index}">
          <select class="tax-in" data-field="code">${options(line.code)}</select>
          <input class="tax-in num" data-field="debit" inputmode="numeric" value="${esc(line.debit)}" placeholder="0" aria-label="借方金額">
          <input class="tax-in num" data-field="credit" inputmode="numeric" value="${esc(line.credit)}" placeholder="0" aria-label="貸方金額">
          <button class="tax-del" data-remove="${index}" title="この行を消す" aria-label="この行を消す">✕</button>
        </div>`).join("")}
      <div><button class="btn ghost" id="taxAddLine" type="button">＋ 行を足す</button></div>
      <div class="tax-sum" id="taxTotals">${totalsHtml(entry)}</div>
      <input class="tax-in" type="text" id="taxMemo" value="${esc(entry.memo)}" placeholder="メモ（証憑の保管場所など）" aria-label="メモ">
      <label class="tax-note">関連するタスク
        <select class="tax-in" id="taxTask" style="margin-top:4px">
          <option value="">（なし）</option>
          ${openTasks.map(task => `<option value="${task.id}"${task.id === entry.taskId ? " selected" : ""}>${esc(task.title)}</option>`).join("")}
        </select>
      </label>
      <div style="display:flex;gap:8px">
        <button class="btn primary" id="taxSave" type="button">この仕訳を登録する</button>
        <button class="btn ghost" id="taxClear" type="button">入力を消す</button>
      </div>
      <p class="tax-note">よく使う形：売上を掛けで計上 → 借方「売掛金」／貸方「売上高」。
        入金されたら → 借方「普通預金」／貸方「売掛金」。</p>
    </div>`;

  const totals = body.querySelector("#taxTotals");
  body.querySelectorAll("[data-line]").forEach(row => {
    const index = Number(row.dataset.line);
    row.querySelectorAll("[data-field]").forEach(input => {
      // 入力のたびに作り直すと、保存ボタンを押した瞬間にボタンが消えてしまう。
      // ここでは下書きを更新し、合計欄だけを書き換える。
      const apply = () => {
        entry.lines[index][input.dataset.field] = input.value;
        totals.innerHTML = totalsHtml(entry);
      };
      input.oninput = apply;
      input.onchange = apply;
    });
    const remove = row.querySelector("[data-remove]");
    remove.onclick = () => {
      if (entry.lines.length <= 2) { notice = { ok: false, text: "行は 2 つ以上必要です。" }; paint(); return; }
      entry.lines.splice(index, 1);
      paintJournal(body);
    };
  });
  body.querySelector("#taxAddLine").onclick = () => {
    entry.lines.push({ code: state.accounts[0].code, debit: "", credit: "" });
    paintJournal(body);
  };
  body.querySelector("#taxDate").onchange = event => { entry.date = event.target.value; };
  body.querySelector("#taxDesc").oninput = event => { entry.description = event.target.value; };
  body.querySelector("#taxMemo").oninput = event => { entry.memo = event.target.value; };
  body.querySelector("#taxTask").onchange = event => { entry.taskId = event.target.value || null; };
  body.querySelector("#taxClear").onclick = () => { draft = emptyDraft(); paintJournal(body); };
  body.querySelector("#taxSave").onclick = () => {
    const result = addEntry(entry);
    notice = { ok: result.ok, text: result.message };
    if (result.ok) draft = emptyDraft({ date: entry.date });
    paint();
  };
}

/* ---------- 仕訳帳 ---------- */
function paintList(body) {
  const entries = entriesOfYear();
  if (!entries.length) {
    body.innerHTML = `<p class="tax-note">${state.settings.fiscalYear} 年の仕訳はまだありません。「仕訳の入力」から登録してください。</p>`;
    return;
  }
  body.innerHTML = `
    <table class="tax-table">
      <thead><tr><th>日付</th><th>摘要</th><th>借方</th><th class="num">金額</th><th>貸方</th><th class="num">金額</th><th></th></tr></thead>
      <tbody>${entries.map(entry => {
        const debits = entry.lines.filter(line => line.debit > 0);
        const credits = entry.lines.filter(line => line.credit > 0);
        const rows = Math.max(debits.length, credits.length);
        const task = entry.taskId ? api.tasks.get(entry.taskId) : null;
        return Array.from({ length: rows }).map((_, index) => `
          <tr>
            ${index === 0 ? `<td rowspan="${rows}">${esc(entry.date.slice(5))}</td>
              <td rowspan="${rows}">${esc(entry.description)}
                ${task ? `<div class="tax-note">🔗 ${esc(task.title)}</div>` : ""}
                ${entry.memo ? `<div class="tax-note">${esc(entry.memo)}</div>` : ""}</td>` : ""}
            <td>${debits[index] ? esc(accountName(debits[index].code)) : ""}</td>
            <td class="num">${debits[index] ? yen(debits[index].debit) : ""}</td>
            <td>${credits[index] ? esc(accountName(credits[index].code)) : ""}</td>
            <td class="num">${credits[index] ? yen(credits[index].credit) : ""}</td>
            ${index === 0 ? `<td rowspan="${rows}"><button class="tax-del" data-del="${entry.id}" title="削除" aria-label="この仕訳を削除">✕</button></td>` : ""}
          </tr>`).join("");
      }).join("")}</tbody>
    </table>
    <p class="tax-note" style="margin-top:10px">${entries.length} 件（${state.settings.fiscalYear} 年）</p>`;
  body.querySelectorAll("[data-del]").forEach(button => {
    button.onclick = () => deleteEntry(button.dataset.del);
  });
}

/* ---------- 総勘定元帳 ---------- */
function paintLedger(body) {
  const entries = entriesOfYear();
  const account = accountOf(ledgerAccount) || state.accounts[0];
  ledgerAccount = account.code;
  let balance = 0;
  const rows = [];
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.code !== account.code) continue;
      balance += DEBIT_POSITIVE[account.type] ? line.debit - line.credit : line.credit - line.debit;
      const other = entry.lines.find(item => item.code !== account.code);
      rows.push({ entry, line, balance, other });
    }
  }
  body.innerHTML = `
    <label class="tax-note">勘定科目
      <select class="tax-in" id="taxLedgerAccount" style="margin-top:4px">
        ${state.accounts.map(item => `<option value="${item.code}"${item.code === account.code ? " selected" : ""}>${esc(item.name)}（${TYPE_LABEL[item.type]}）</option>`).join("")}
      </select>
    </label>
    ${rows.length ? `<table class="tax-table" style="margin-top:12px">
      <thead><tr><th>日付</th><th>摘要</th><th>相手科目</th><th class="num">借方</th><th class="num">貸方</th><th class="num">残高</th></tr></thead>
      <tbody>${rows.map(row => `<tr>
        <td>${esc(row.entry.date.slice(5))}</td>
        <td>${esc(row.entry.description)}</td>
        <td>${row.other ? esc(accountName(row.other.code)) : ""}</td>
        <td class="num">${row.line.debit ? yen(row.line.debit) : ""}</td>
        <td class="num">${row.line.credit ? yen(row.line.credit) : ""}</td>
        <td class="num">${yen(row.balance)}</td></tr>`).join("")}</tbody>
    </table>` : `<p class="tax-note" style="margin-top:12px">この科目の記録はまだありません。</p>`}`;
  body.querySelector("#taxLedgerAccount").onchange = event => {
    ledgerAccount = event.target.value;
    paintLedger(body);
  };
}

/* ---------- 試算表 ---------- */
function paintTrial(body) {
  const result = summary(state.settings.fiscalYear);
  if (!result.rows.length) {
    body.innerHTML = `<p class="tax-note">この年度の仕訳がまだありません。</p>`;
    return;
  }
  const balanced = result.debitTotal === result.creditTotal;
  body.innerHTML = `
    <table class="tax-table">
      <thead><tr><th>コード</th><th>勘定科目</th><th>区分</th><th class="num">借方合計</th><th class="num">貸方合計</th><th class="num">残高</th></tr></thead>
      <tbody>${result.rows.map(row => `<tr>
        <td>${esc(row.code)}</td><td>${esc(row.name)}</td><td>${TYPE_LABEL[row.type]}</td>
        <td class="num">${yen(row.debit)}</td><td class="num">${yen(row.credit)}</td><td class="num">${yen(row.balance)}</td>
      </tr>`).join("")}</tbody>
      <tfoot><tr style="font-weight:700;border-top:2px solid var(--line-strong)">
        <td colspan="3">合計</td><td class="num">${yen(result.debitTotal)}</td><td class="num">${yen(result.creditTotal)}</td><td></td>
      </tr></tfoot>
    </table>
    <p class="tax-msg ${balanced ? "ok" : "ng"}" style="margin-top:12px">
      ${balanced ? "借方合計と貸方合計が一致しています。帳簿の記録に計算上の食い違いはありません。"
                 : `借方と貸方が ${yen(Math.abs(result.debitTotal - result.creditTotal))} 食い違っています。`}
    </p>`;
}

/* ---------- 決算のまとめ ---------- */
function paintReport(body) {
  const result = summary(state.settings.fiscalYear);
  const group = type => result.rows.filter(row => row.type === type && row.balance !== 0);
  const table = (title, rows, total) => `
    <div>
      <div style="font-weight:700;margin-bottom:6px">${title}</div>
      ${rows.length ? `<table class="tax-table">
        <tbody>${rows.map(row => `<tr><td>${esc(row.name)}</td><td class="num">${yen(row.balance)}</td></tr>`).join("")}</tbody>
        <tfoot><tr style="font-weight:700;border-top:2px solid var(--line-strong)"><td>合計</td><td class="num">${yen(total)}</td></tr></tfoot>
      </table>` : `<p class="tax-note">記録がありません。</p>`}
    </div>`;

  body.innerHTML = `
    <div class="tax-cards">
      <div class="tax-card"><div class="k">売上・収益</div><div class="v">${yen(result.revenue)}</div></div>
      <div class="tax-card"><div class="k">経費</div><div class="v">${yen(result.expense)}</div></div>
      <div class="tax-card"><div class="k">所得（利益）</div>
        <div class="v" style="color:${result.profit >= 0 ? "var(--ok)" : "var(--danger)"}">${yen(result.profit)}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:18px" class="tax-two">
      ${table("損益計算書：収益", group("revenue"), result.revenue)}
      ${table("損益計算書：費用", group("expense"), result.expense)}
      ${table("貸借対照表：資産", group("asset"), result.asset)}
      ${table("貸借対照表：負債・資本", [...group("liability"), ...group("equity")], result.liability + result.equity)}
    </div>
    <p class="tax-note" style="margin-top:16px">
      ${state.settings.fiscalYear} 年（1月1日〜12月31日）の集計です。
      青色申告決算書の各欄へ、この金額を転記してお使いください。<br>
      減価償却・家事按分・棚卸などの調整は、この集計には含まれません。申告前に必ずご確認ください。
    </p>`;
}

/* ---------- 設定 ---------- */
function paintSettings(body) {
  body.innerHTML = `
    <div class="tax-grid" style="max-width:520px">
      <label class="tax-note">屋号・氏名
        <input class="tax-in" id="taxBiz" type="text" value="${esc(state.settings.businessName)}" placeholder="例）山田デザイン事務所" style="margin-top:4px">
      </label>
      <div>
        <div style="font-weight:700;margin:10px 0 6px">勘定科目（${state.accounts.length} 件）</div>
        <table class="tax-table">
          <thead><tr><th>コード</th><th>名称</th><th>区分</th><th></th></tr></thead>
          <tbody>${state.accounts.map(account => `<tr>
            <td>${esc(account.code)}</td><td>${esc(account.name)}</td><td>${TYPE_LABEL[account.type]}</td>
            <td><button class="tax-del" data-account-del="${esc(account.code)}" title="削除" aria-label="この科目を削除">✕</button></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:90px 1fr 110px auto;gap:8px;align-items:center">
        <input class="tax-in" id="taxAccCode" placeholder="コード" aria-label="コード">
        <input class="tax-in" id="taxAccName" placeholder="科目名" aria-label="科目名">
        <select class="tax-in" id="taxAccType" aria-label="区分">
          ${Object.entries(TYPE_LABEL).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
        </select>
        <button class="btn" id="taxAccAdd" type="button">追加</button>
      </div>
      <p class="tax-note">使っている仕訳がある科目は削除できません。</p>
    </div>`;

  body.querySelector("#taxBiz").oninput = event => {
    state.settings.businessName = event.target.value.slice(0, 60);
    persist();
  };
  body.querySelector("#taxAccAdd").onclick = () => {
    const code = body.querySelector("#taxAccCode").value.trim();
    const name = body.querySelector("#taxAccName").value.trim();
    const type = body.querySelector("#taxAccType").value;
    if (!code || !name) { notice = { ok: false, text: "コードと科目名を入れてください。" }; paint(); return; }
    if (accountOf(code)) { notice = { ok: false, text: "そのコードはすでに使われています。" }; paint(); return; }
    state.accounts.push({ code, name: name.slice(0, 30), type });
    state.accounts.sort((a, b) => a.code.localeCompare(b.code));
    persist();
    notice = { ok: true, text: `「${name}」を追加しました。` };
    paint();
  };
  body.querySelectorAll("[data-account-del]").forEach(button => {
    button.onclick = () => {
      const code = button.dataset.accountDel;
      const used = state.entries.some(entry => entry.lines.some(line => line.code === code));
      if (used) { notice = { ok: false, text: "この科目を使った仕訳があるため削除できません。" }; paint(); return; }
      state.accounts = state.accounts.filter(account => account.code !== code);
      persist();
      notice = { ok: true, text: "科目を削除しました。" };
      paint();
    };
  });
}

/* ============================================================
   タスクとのつながり
   ============================================================ */
api.registerTaskPanel({
  id: "entries",
  title: "この仕事の記帳",
  render(box, task) {
    const linked = state.entries.filter(entry => entry.taskId === task.id)
      .sort((a, b) => a.date.localeCompare(b.date));
    const total = linked.reduce((sum, entry) =>
      sum + entry.lines.reduce((lineSum, line) => lineSum + line.debit, 0), 0);
    box.innerHTML = `
      ${linked.length
        ? `<div class="tax-note">${linked.map(entry =>
            `${esc(entry.date.slice(5))}　${esc(entry.description)}　${yen(entry.lines.reduce((s, l) => s + l.debit, 0))}`).join("<br>")}
           <div style="margin-top:4px">合計 ${yen(total)}</div></div>`
        : `<div class="tax-note">まだ記帳されていません。</div>`}
      <button class="btn" id="taxFromTask" type="button" style="margin-top:8px">このタスクから仕訳を作る</button>`;
    box.querySelector("#taxFromTask").onclick = () => {
      draft = emptyDraft({
        description: task.title.slice(0, 100),
        taskId: task.id,
        lines: [{ code: "103", debit: "", credit: "" }, { code: "401", debit: "", credit: "" }],
      });
      tab = "journal";
      notice = { ok: true, text: "このタスクの内容で仕訳の下書きを作りました。金額を入れて登録してください。" };
      // 拡張の画面へ移動する
      api.ui.toast("「確定申告」の画面で続けて入力できます");
      rerender();
    };
  },
});

/* ============================================================
   書き出し
   ============================================================ */
function csv(rows) {
  const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return "﻿" + rows.map(row => row.map(quote).join(",")).join("\r\n");
}

api.registerExport({
  id: "journal-csv",
  label: "仕訳帳CSV",
  run() {
    const year = state.settings.fiscalYear;
    const rows = [["日付", "摘要", "勘定科目", "借方金額", "貸方金額", "メモ", "関連タスク"]];
    for (const entry of entriesOfYear(year)) {
      const task = entry.taskId ? api.tasks.get(entry.taskId) : null;
      for (const line of entry.lines) {
        rows.push([entry.date, entry.description, accountName(line.code),
          line.debit || "", line.credit || "", entry.memo, task ? task.title : ""]);
      }
    }
    api.ui.download(`shiwake-${year}.csv`, csv(rows), "text/csv");
  },
});

api.registerExport({
  id: "trial-csv",
  label: "試算表CSV",
  run() {
    const year = state.settings.fiscalYear;
    const result = summary(year);
    const rows = [["コード", "勘定科目", "区分", "借方合計", "貸方合計", "残高"]];
    for (const row of result.rows) {
      rows.push([row.code, row.name, TYPE_LABEL[row.type], row.debit, row.credit, row.balance]);
    }
    rows.push([]);
    rows.push(["", "収益合計", "", "", "", result.revenue]);
    rows.push(["", "費用合計", "", "", "", result.expense]);
    rows.push(["", "所得（利益）", "", "", "", result.profit]);
    api.ui.download(`shisanhyo-${year}.csv`, csv(rows), "text/csv");
  },
});
