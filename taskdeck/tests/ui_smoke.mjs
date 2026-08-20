/**
 * アプリを実際のブラウザで動かして確かめる。
 *
 *   npm i playwright && node taskdeck/tests/ui_smoke.mjs
 *
 * 画面の見た目ではなく「操作したら期待どおりの結果になるか」を見る。
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../app/taskdeck.html");
const failures = [];

function check(condition, label) {
  console.log(`  ${condition ? "OK  " : "FAIL"} ${label}`);
  if (!condition) failures.push(label);
}

// テスト専用の鍵でビルドし直した HTML を一時ファイルに用意する
const fixture = JSON.parse(
  execFileSync("python3", [join(here, "issue_test_key.py")], { encoding: "utf-8" })
);
const work = mkdtempSync(join(tmpdir(), "taskdeck-ui-"));
const buildPath = join(work, "taskdeck.html");
const original = readFileSync(appPath, "utf-8");
if (!original.includes('const LICENSE_PUBLIC_KEY = "__PUBLIC_KEY__";')) {
  throw new Error("公開鍵の行が想定と違います。keygen.py init 済みのファイルではテストできません。");
}
writeFileSync(
  buildPath,
  original.replace('const LICENSE_PUBLIC_KEY = "__PUBLIC_KEY__";', `const LICENSE_PUBLIC_KEY = "${fixture.pubkey}";`)
);
const url = pathToFileURL(buildPath).href;

// この環境に入っている Chromium を使う（用意されていれば executablePath で指定する）
const localChromium = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
  .find(candidate => existsSync(candidate));
const browser = await chromium.launch(localChromium ? { executablePath: localChromium } : {});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

console.log("画面操作のテスト");
await page.goto(url);

// --- 初期表示 ---
check(await page.locator(".card").count() === 3, "初期サンプルのタスクが 3 件表示される");
check((await page.locator("#editionTag").textContent()) === "評価版", "未登録なら評価版と表示される");
check(await page.locator("#trialBar").isVisible(), "評価版の案内バーが出ている");

// --- 追加と入力の解釈 ---
await page.fill("#quickAddInput", "見積書を送る #経理 !1 @今日");
await page.press("#quickAddInput", "Enter");
const added = page.locator(".card", { hasText: "見積書を送る" }).first();
check(await added.count() === 1, "入力した内容がカードとして追加される");
check((await added.textContent()).includes("#経理"), "#タグ が取り出される");
check((await added.textContent()).includes("高"), "!1 が優先度「高」になる");
check((await added.textContent()).includes("今日"), "@今日 が期限になる");
check((await added.textContent()).includes("#経理") && !(await added.locator(".title").textContent()).includes("#経理"),
  "タイトルからは記号の指定が取り除かれる");
check((await page.locator("#quickAddInput").inputValue()) === "", "追加すると入力欄が空になる");
check((await page.locator('#tagNav .navitem', { hasText: "経理" }).count()) === 1, "サイドバーにタグが増える");

// --- 完了の切り替え ---
await added.locator(".check").click();
check(await page.locator(".column[data-status=done] .card", { hasText: "見積書を送る" }).count() === 1,
  "チェックすると完了列へ移る");
check(await page.locator('#smartNav .navitem', { hasText: "完了済み" }).textContent().then(t => t.includes("1")),
  "完了済みの件数が増える");

// --- 詳細パネル ---
await page.locator(".card").first().click();
check(await page.locator("#drawer.open").count() === 1, "カードを押すと詳細パネルが開く");
await page.fill("#dTitle", "書き換えたタイトル");
await page.waitForTimeout(60);
check(await page.locator(".card", { hasText: "書き換えたタイトル" }).count() === 1, "詳細で直すと一覧にも即反映される");
await page.fill("#dTagInput", "至急");
await page.press("#dTagInput", "Enter");
check(await page.locator("#dTags .chip", { hasText: "至急" }).count() === 1, "詳細からタグを足せる");
await page.click("#dAddSub");
await page.fill("#dSubtasks .txt >> nth=-1", "下書きを作る");
await page.waitForTimeout(60);
check((await page.locator("#dSubCount").textContent()).length > 0, "サブタスクの進捗が出る");
await page.press("#dTitle", "Escape");
check(await page.locator("#drawer.open").count() === 0, "Esc で詳細パネルが閉じる");

// --- 検索 ---
await page.fill("#searchInput", "書き換えた");
await page.waitForTimeout(60);
check(await page.locator(".card").count() === 1, "検索すると一致するタスクだけになる");
await page.fill("#searchInput", "そんな語はない");
await page.waitForTimeout(60);
check(await page.locator(".empty").count() === 1, "一致しないときは案内が出る");
await page.fill("#searchInput", "");
await page.waitForTimeout(60);

// --- リスト表示と並べ替え ---
await page.click('.viewtabs button[data-mode="list"]');
check(await page.locator("table.list tbody tr").count() >= 3, "リスト表示に切り替わる");
await page.click('th[data-sort="priority"]');
const firstPriority = await page.locator("table.list tbody tr td .prio").first().textContent();
check(firstPriority.trim() === "高", "優先度で並べ替えると「高」が先頭に来る");
await page.click('.viewtabs button[data-mode="board"]');

// --- プロジェクト ---
await page.click("#addProjectBtn");
await page.fill("#pName", "新製品リリース");
await page.click("#pSave");
check(await page.locator("#projectNav .navitem", { hasText: "新製品リリース" }).count() === 1, "プロジェクトを追加できる");
check((await page.locator("#viewTitle").textContent()) === "新製品リリース", "追加したプロジェクトが選択される");
await page.fill("#quickAddInput", "サイトの文言を決める");
await page.press("#quickAddInput", "Enter");
await page.waitForTimeout(200);
check(await page.locator(".card").count() === 1, "選択中のプロジェクトにタスクが入る");

// --- 保存の永続化 ---
await page.reload();
check(await page.locator(".card", { hasText: "サイトの文言を決める" }).count() === 1, "再読み込みしても内容が残る");

// --- 評価版の上限 ---
await page.evaluate(async (limit) => {
  for (let i = 0; i < limit + 5; i++) {
    document.getElementById("quickAddInput").value = "テスト" + i;
    document.getElementById("quickAddForm").dispatchEvent(new Event("submit", { cancelable: true }));
  }
  return null;
}, 30);
await page.waitForTimeout(250);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("taskdeck.data.v1")).tasks.length);
check(stored === 30, `評価版では ${stored} 件で頭打ちになる（上限 30 件）`);
check(await page.locator("#licenseModal.open").count() === 1, "上限に達するとライセンス登録の案内が開く");

// --- ライセンス登録 ---
await page.fill("#licenseKey", fixture.key);
await page.click("#licenseApply");
await page.waitForTimeout(120);
check((await page.locator("#licenseStatus").textContent()).includes("登録"), "正しいキーは受け付けられる");
check((await page.locator("#editionTag").textContent()) === "ビジネス", "プラン名が表示に反映される");
check((await page.locator("#licenseState").textContent()).includes("製品版として登録済み"),
  "登録するとダイアログの表示もその場で切り替わる");
check((await page.locator("#licenseState").textContent()).includes("検証用テスト株式会社"), "ライセンス名義が表示される");
await page.waitForTimeout(1000);
await page.fill("#quickAddInput", "上限解除後のタスク");
await page.press("#quickAddInput", "Enter");
check(await page.locator(".card", { hasText: "上限解除後のタスク" }).count() === 1, "登録後は 30 件を超えて追加できる");
check(await page.locator("#trialBar").isVisible() === false, "登録すると評価版バーが消える");

await page.reload();
check((await page.locator("#editionTag").textContent()) === "ビジネス", "再読み込みしても登録状態が続く");

// --- 誤ったキー ---
await page.click("#licenseBtn");
await page.click("#licenseRemove");
await page.fill("#licenseKey", "TD1.aaaa.bbbb");
await page.click("#licenseApply");
check((await page.locator("#licenseStatus").textContent()).length > 5, "誤ったキーには理由が表示される");
check((await page.locator("#editionTag").textContent()) === "評価版", "誤ったキーでは登録されない");

// --- 書き出し ---
await page.press("body", "Escape");
await page.click("#dataBtn");
const [csv] = await Promise.all([
  page.waitForEvent("download"),
  page.click("#exportCsv"),
]);
check((await csv.suggestedFilename()).endsWith(".csv"), "CSV を書き出せる");
const [json] = await Promise.all([
  page.waitForEvent("download"),
  page.click("#exportJson"),
]);
check((await json.suggestedFilename()).startsWith("taskdeck-backup-"), "JSON を書き出せる");

check(errors.length === 0, `JavaScript のエラーが出ない${errors.length ? "（" + errors[0] + "）" : ""}`);

await browser.close();
console.log();
if (failures.length) {
  console.log(`${failures.length} 件失敗しました:`);
  failures.forEach(item => console.log("  - " + item));
  process.exit(1);
}
console.log("すべて通りました。");
