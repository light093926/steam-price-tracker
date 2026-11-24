#!/usr/bin/env node
/**
 * 生成页面用的本地搜索索引 data/catalog.json。
 * 数据来自 Steam 商店搜索结果 JSON（results_html），覆盖畅销/特惠/新品约 1000 款。
 * 浏览器无法直连 Steam（CORS），所以搜索只能查这份预生成索引。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = (...p) => path.join(ROOT, ...p);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 商店的搜索接口会校验 UA / 语言 Cookie，缺了会被重置连接
const HEADERS = {
  'user-agent': UA,
  accept: 'application/json',
  'accept-language': 'zh-CN,zh;q=0.9',
  referer: 'https://store.steampowered.com/search/?filter=topsellers',
  cookie: 'birthtime=28800001; mature_content=1; Steam_Language=schinese',
};

const SOURCES = [
  { filter: 'topsellers', pages: 10, label: '畅销' },
  { filter: 'specials', pages: 2, label: '特惠' },
  { filter: 'newreleases', pages: 2, label: '新品' },
];

async function fetchPage(filter, start) {
  const url =
    'https://store.steampowered.com/search/results/?' +
    `query&start=${start}&count=100&infinite=1&filter=${filter}&cc=cn&l=schinese`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json?.results_html ?? '';
}

/** 逐条解析 search_result_row，字段缺失则跳过该条 */
function parseRows(html) {
  const rows = [];
  const blocks = html.split('<a href="https://store.steampowered.com/app/').slice(1);
  for (const block of blocks) {
    const head = block.slice(0, 4000);
    const appid = /\/(\d+)/.exec(head)?.[1];
    const name = /<span class="title">([^<]+)<\/span>/.exec(block)?.[1];
    if (!appid || !name) continue;
    const released = /class="search_released responsive_secondrow">\s*([^<]*?)\s*<\/div>/.exec(block)?.[1] ?? '';
    const price = /data-price-final="(\d+)"/.exec(block)?.[1];
    const free = /discount_final_price free/.test(block);
    rows.push({
      appid: Number(appid),
      name: decodeEntities(name),
      // 统一用主 CDN 的 header 图，避免各区域返回的 CDN 域名在别的网络不可达
      img: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
      released: released.replace(/\s+/g, ' ').trim(),
      price: free ? 0 : price ? Number(price) : null,
      free,
    });
  }
  return rows;
}

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&trade;/g, '™')
    .replace(/&reg;/g, '®');

async function main() {
  const seen = new Map();
  for (const src of SOURCES) {
    for (let page = 0; page < src.pages; page++) {
      try {
        const html = await fetchPage(src.filter, page * 100);
        const rows = parseRows(html);
        let added = 0;
        for (const row of rows) {
          if (!seen.has(row.appid)) {
            seen.set(row.appid, row);
            added++;
          }
        }
        console.log(`[catalog] ${src.label} 第 ${page + 1} 页：${rows.length} 条，新增 ${added}`);
      } catch (err) {
        console.error(`[catalog] ${src.label} 第 ${page + 1} 页失败：${err.message}`);
      }
      await sleep(1200);
    }
  }

  const items = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  const prev = await readJson(FILE('data', 'catalog.json'), null);

  // 抓取结果异常时保留旧索引，避免把页面搜索打回空白
  if (items.length < 200 && prev?.items?.length) {
    console.error(`[catalog] 仅解析到 ${items.length} 条，保留旧索引（${prev.items.length} 条）`);
    return;
  }

  await mkdir(FILE('data'), { recursive: true });
  await writeFile(
    FILE('data', 'catalog.json'),
    `${JSON.stringify({ generated: new Date().toISOString(), count: items.length, items })}\n`,
    'utf8'
  );
  console.log(`[catalog] 写入 ${items.length} 款`);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
