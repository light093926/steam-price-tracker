#!/usr/bin/env node
/**
 * 本地预览服务：静态托管 + 可用 dev/prices.json 覆盖 data/prices.json，
 * 便于在没有真实抓取数据时调试 UI。仅本机使用，dev/ 已 gitignore。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = decodeURIComponent(url.pathname);

  if (rel.startsWith('/data/')) {
    // dev/prices.json 覆盖 data/prices.json，其余 data 文件照常读仓库
    const mock = await readIfExists(path.join(ROOT, 'dev', rel.replace(/^\/data\//, '')));
    if (mock) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(mock);
      return;
    }
  }

  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    await stat(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
}).listen(PORT, () => console.log(`preview: http://localhost:${PORT}/`));
