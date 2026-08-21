/**
 * 拡張のしくみを、実際のブラウザで端から端まで確かめる。
 *
 *   npm i playwright && node taskdeck/tests/ui_extension.mjs
 *
 * 使い捨ての鍵で「アプリの組み立て → 拡張パッケージの署名 → 読み込み → 記帳」までを通す。
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const failures = [];
const check = (condition, label) => {
  console.log(`  ${condition ? "OK  " : "FAIL"} ${label}`);
  if (!condition) failures.push(label);
};
const py = (args, cwd) => execFileSync("python3", args, { cwd, encoding: "utf-8" });

// --- 使い捨ての販売者環境を作る ---
const work = mkdtempSync(join(tmpdir(), "taskdeck-ext-"));
const kit = join(work, "taskdeck");
cpSync(repo, kit, { recursive: true, filter: src => !src.includes("node_modules") });
py(["tools/keygen.py", "init"], kit);
const issued = py(["tools/keygen.py", "issue", "--name", "記帳テスト事務所", "--plan", "business", "--ext", "tax"], kit);
const licenseKey = issued.trim().split("\n").pop().trim();
py(["tools/pkg.py", "build", "extensions/tax", "--out", "dist"], kit);
const packageText = readFileSync(join(kit, "dist", "tax-1.0.0.tdpkg"), "utf-8");
const appUrl = pathToFileURL(join(kit, "app", "taskdeck.html")).href;

const localChromium = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
  .find(candidate => existsSync(candidate));
const browser = await chromium.launch(localChromium ? { executablePath: localChromium } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

console.log("拡張のしくみのテスト");
await page.goto(appUrl);

// --- 拡張が無いときは、これまでどおりのタスク管理 ---
check(await page.locator("#pluginNavSection").isVisible() === false, "拡張が無いときサイドバーに拡張の欄は出ない");
check(await page.locator(".board").count() === 1, "拡張が無くてもタスクのボードはそのまま動く");

// --- 署名の無いものは拒否 ---
await page.click("#extBtn");
await page.click("#extPasteToggle");
await page.fill("#extPaste", JSON.stringify({ format: "taskdeck-package/1", manifest: { id: "evil", name: "偽物", version: "1.0.0", apiVersion: "1" }, code: "api.ui.toast('のっとり')", signature: "AAAA" }));
await page.click("#extPasteToggle");
check((await page.locator("#extStatus").textContent()).includes("署名"), "署名が正しくないパッケージは追加できない");

// --- 書き換えたパッケージも拒否 ---
const tampered = JSON.parse(packageText);
tampered.code += "\napi.ui.toast('書き換え');";
await page.fill("#extPaste", JSON.stringify(tampered));
await page.click("#extPasteToggle");
check((await page.locator("#extStatus").textContent()).includes("署名"), "中身を書き換えたパッケージも追加できない");

// --- 正しいパッケージを読み込む ---
await page.fill("#extPaste", packageText);
await page.click("#extPasteToggle");
check((await page.locator("#extStatus").textContent()).includes("確定申告データ管理"), "署名済みのパッケージを追加できる");
check((await page.locator(".extcard .pill").textContent()).includes("評価中"), "ライセンス未登録なら評価中と表示される");
await page.click('[data-close="extModal"]');
check(await page.locator("#pluginNav .navitem", { hasText: "確定申告" }).count() === 1, "サイドバーに拡張の画面が増える");

// --- 拡張の画面 ---
await page.click('#pluginNav .navitem:has-text("確定申告")');
check(await page.locator(".tax-tabs button", { hasText: "仕訳の入力" }).count() === 1, "拡張の画面が描かれる");
check(await page.locator("#quickAddForm").isVisible() === false, "拡張の画面ではタスクの入力欄が隠れる");

// --- 貸借が合わない仕訳は弾く ---
await page.fill("#taxDesc", "A社 6月分 制作費");
await page.fill('[data-line="0"] [data-field="debit"]', "110000");
await page.selectOption('[data-line="0"] [data-field="code"]', "103");
await page.fill('[data-line="1"] [data-field="credit"]', "100000");
await page.click("#taxSave");
check((await page.locator(".tax-msg.ng").first().textContent()).includes("差額"), "借方と貸方が合わない仕訳は登録できない");

// --- 合わせて登録する ---
await page.fill('[data-line="1"] [data-field="credit"]', "110000");
await page.click("#taxSave");
check((await page.locator(".tax-msg.ok").first().textContent()).includes("登録"), "貸借が一致した仕訳は登録できる");

// もう 1 件（経費）
await page.fill("#taxDesc", "クラウド利用料");
await page.selectOption('[data-line="0"] [data-field="code"]', "506");
await page.fill('[data-line="0"] [data-field="debit"]', "3300");
await page.selectOption('[data-line="1"] [data-field="code"]', "102");
await page.fill('[data-line="1"] [data-field="credit"]', "3300");
await page.click("#taxSave");

// --- 仕訳帳 ---
await page.click('.tax-tabs button:has-text("仕訳帳")');
check((await page.locator(".tax-table tbody").textContent()).includes("A社 6月分 制作費"), "登録した仕訳が仕訳帳に並ぶ");
check((await page.locator(".tax-table tbody").textContent()).includes("売掛金"), "勘定科目名で表示される");

// --- 試算表 ---
await page.click('.tax-tabs button:has-text("試算表")');
check((await page.locator(".tax-msg.ok").textContent()).includes("一致"), "試算表の借方合計と貸方合計が一致する");

// --- 決算のまとめ ---
await page.click('.tax-tabs button:has-text("決算のまとめ")');
const cards = await page.locator(".tax-card .v").allTextContents();
check(cards[0].includes("110,000"), "収益が集計される");
check(cards[1].includes("3,300"), "経費が集計される");
check(cards[2].includes("106,700"), "所得（収益 − 経費）が計算される");

// --- 総勘定元帳 ---
await page.click('.tax-tabs button:has-text("総勘定元帳")');
await page.selectOption("#taxLedgerAccount", "103");
check((await page.locator(".tax-table tbody").textContent()).includes("110,000"), "総勘定元帳に科目別の明細が出る");

// --- タスクとのつながり ---
await page.click('#smartNav .navitem:has-text("すべて")');
await page.locator(".card").first().click();
check(await page.locator("#dExtPanels", { hasText: "この仕事の記帳" }).count() === 1, "タスクの詳細に拡張の欄が足される");
await page.click("#taxFromTask");
await page.click("#drawerClose");
await page.click('#pluginNav .navitem:has-text("確定申告")');
check((await page.locator("#taxDesc").inputValue()).length > 0, "タスクから仕訳の下書きが作られる");

// --- 保存されているか ---
await page.reload();
await page.click('#pluginNav .navitem:has-text("確定申告")');
await page.click('.tax-tabs button:has-text("仕訳帳")');
check((await page.locator(".tax-table tbody").textContent()).includes("クラウド利用料"), "再読み込みしても仕訳が残る");

// --- 評価の上限 ---
await page.evaluate(() => {
  const key = "taskdeck.ext.tax.v1";
  const saved = JSON.parse(localStorage.getItem(key));
  const base = saved.entries[0];
  while (saved.entries.length < 30) {
    saved.entries.push({ ...base, id: "seed" + saved.entries.length, description: "詰め物" + saved.entries.length });
  }
  localStorage.setItem(key, JSON.stringify(saved));
});
await page.reload();
await page.click('#pluginNav .navitem:has-text("確定申告")');
await page.fill("#taxDesc", "上限を超える仕訳");
await page.fill('[data-line="0"] [data-field="debit"]', "1000");
await page.fill('[data-line="1"] [data-field="credit"]', "1000");
await page.click("#taxSave");
check((await page.locator(".tax-msg.ng").first().textContent()).includes("30 件"), "評価中は仕訳 30 件で頭打ちになる");

// --- ライセンスキーで制限が外れる ---
await page.click("#licenseBtn");
await page.fill("#licenseKey", licenseKey);
await page.click("#licenseApply");
await page.waitForTimeout(1200);
await page.click("#extBtn");
check((await page.locator(".extcard .pill").textContent()).includes("製品版"), "拡張の権利つきキーで製品版になる");
await page.click('[data-close="extModal"]');
await page.click('#pluginNav .navitem:has-text("確定申告")');
await page.fill("#taxDesc", "上限解除後の仕訳");
await page.fill('[data-line="0"] [data-field="debit"]', "1000");
await page.fill('[data-line="1"] [data-field="credit"]', "1000");
await page.click("#taxSave");
check((await page.locator(".tax-msg.ok").first().textContent()).includes("登録"), "権利があれば 30 件を超えて登録できる");

// --- 書き出し ---
await page.click("#dataBtn");
check((await page.locator("#extExports").textContent()).includes("仕訳帳CSV"), "拡張の書き出しがデータ画面に並ぶ");
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.click('#extExports button:has-text("仕訳帳CSV")'),
]);
check((await download.suggestedFilename()).startsWith("shiwake-"), "仕訳帳CSVを書き出せる");
await page.click('[data-close="dataModal"]');

// --- 停止と取り外し ---
await page.click("#extBtn");
await page.uncheck('[data-ext-toggle="tax"]');
check(await page.locator("#pluginNav .navitem").count() === 0, "停止すると拡張の画面が消える");
await page.check('[data-ext-toggle="tax"]');
check(await page.locator("#pluginNav .navitem").count() === 1, "もう一度使うにすると戻る");
page.once("dialog", dialog => dialog.accept());
await page.click('[data-ext-remove="tax"]');
await page.waitForTimeout(200);
check(await page.locator(".extempty").count() === 1, "取り外すと一覧から消える");
check(await page.evaluate(() => localStorage.getItem("taskdeck.ext.tax.v1")) === null, "取り外すと拡張のデータも消える");
await page.click('[data-close="extModal"]');
check(await page.locator(".board").count() === 1, "拡張を外してもタスク管理はそのまま動く");

check(errors.length === 0, `JavaScript のエラーが出ない${errors.length ? "（" + errors[0] + "）" : ""}`);

await browser.close();
console.log();
if (failures.length) {
  console.log(`${failures.length} 件失敗しました:`);
  failures.forEach(item => console.log("  - " + item));
  process.exit(1);
}
console.log("すべて通りました。");
