#!/usr/bin/env node
/**
 * 描画確認ページを実ブラウザで開き、スクリーンショットを保存する。
 * キャラクター描画・合成処理が視覚的に壊れていないかを確認するための開発ツール。
 *
 *   npm run check:visual            … dev サーバーを自前で起動して撮影
 *   npm run check:visual -- <url>   … 起動済みサーバーの URL を指定
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Playwright が同梱するリビジョンと、環境に置かれているブラウザのリビジョンが
 * ずれている場合に備え、PLAYWRIGHT_BROWSERS_PATH 配下の実行ファイルを探す。
 * 見つからなければ Playwright の既定解決に任せる。
 */
async function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;
  const entries = await readdir(base);
  const candidates = entries
    .filter((name) => name.startsWith('chromium-'))
    .map((name) => join(base, name, 'chrome-linux', 'chrome'))
    .filter((path) => existsSync(path));
  return candidates.sort().pop();
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.render-check');
const explicitUrl = process.argv[2];

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* まだ起動していない */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`開発サーバーが ${timeoutMs}ms 以内に起動しませんでした: ${url}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  let server = null;
  let baseUrl = explicitUrl;

  if (!baseUrl) {
    const port = 5199;
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
      cwd: root,
      stdio: 'ignore',
    });
    await waitForServer(baseUrl);
  }

  // CI やコンテナでは root 実行になることがあるため sandbox を無効化する
  const executablePath = await findChromium();
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`${baseUrl}/render-check.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.renderComplete === 'true', { timeout: 30_000 });
    await page.screenshot({ path: join(outDir, 'render-check.png'), fullPage: true });

    // 実際に描画されたかを検査する（真っ黒/空のキャンバスを見逃さない）
    const stats = await page.evaluate(() =>
      Array.from(document.querySelectorAll('canvas')).map((canvas) => {
        const ctx = canvas.getContext('2d');
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const seen = new Set();
        let opaque = 0;
        for (let i = 0; i < data.length; i += 4 * 37) {
          if (data[i + 3] > 8) opaque++;
          seen.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
        }
        return {
          label: canvas.parentElement?.querySelector('figcaption')?.textContent ?? '?',
          filledRatio: opaque / (data.length / (4 * 37)),
          distinctColors: seen.size,
        };
      }),
    );

    console.log('描画されたキャンバス:');
    let failed = 0;
    for (const stat of stats) {
      const ok = stat.filledRatio > 0.05 && stat.distinctColors >= 4;
      if (!ok) failed++;
      console.log(
        `  ${ok ? '✓' : '✗'} ${stat.label} — 描画率 ${(stat.filledRatio * 100).toFixed(1)}% / 色数 ${stat.distinctColors}`,
      );
    }

    // アプリ本体も起動できることを確認する
    const appPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    appPage.on('pageerror', (err) => errors.push(`[app] ${String(err)}`));
    appPage.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`[app] ${msg.text()}`);
    });
    await appPage.goto(baseUrl, { waitUntil: 'load' });
    await appPage.waitForSelector('#main-content', { timeout: 30_000 });
    await appPage.screenshot({ path: join(outDir, 'app.png'), fullPage: false });

    if (errors.length > 0) {
      console.error('\nコンソールエラー:');
      for (const err of errors) console.error(`  ✗ ${err}`);
    }

    console.log(`\nスクリーンショット: ${outDir}`);
    if (failed > 0 || errors.length > 0) {
      process.exitCode = 1;
    } else {
      console.log('すべてのキャンバスが正常に描画されました。');
    }
  } finally {
    await browser.close();
    server?.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
