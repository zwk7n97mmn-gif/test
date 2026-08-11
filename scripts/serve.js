#!/usr/bin/env node
/** 依存ゼロの静的ファイルサーバ（開発用）。 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const relative = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(ROOT, relative);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('見つかりません');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Kirinuki Studio → http://localhost:${PORT}`);
});
