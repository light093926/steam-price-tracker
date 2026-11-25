#!/usr/bin/env node
/**
 * 生成页面用的本地搜索索引 data/catalog.json。
 *
 * 浏览器的 fetch 拿不到 Steam（CORS），所以只能由 Actions 预先抓取。
 * 覆盖策略：热销/特惠/新品 榜单 + 「按发售日」深翻（近十年新游）+「按媒体评分」翻页（补经典老游），
 * 目标 3–4 万款。写成紧凑数组 [appid, 名称, 价格分] 控制体积（约 1.5MB）。
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

/** 榜单过滤：热销/特惠/新品，条目少但都是当前在售热门 */
const FILTERS = [
  { filter: 'topsellers', pages: 10, label: '畅销' },
  { filter: 'specials', pages: 2, label: '特惠' },
  { filter: 'newreleases', pages: 2, label: '新品' },
];

/** 排序深翻：发售日覆盖新游，媒体评分覆盖老经典 */
const SORTS = [
  { sort: 'Released_DESC', pages: 300, label: '按发售日' },
  { sort: 'Metacritic_DESC', pages: 80, label: '按评分' },
];

const PAGE_DELAY_MS = 1200;
const RETRY_DELAY_MS = 4000;
const MAX_RETRY = 2;
/** 低于这个数量就认为抓取异常，保留旧索引 */
const MIN_ITEMS = 5000;

const searchUrl = (page, opts) => {
  const start = page * 100;
  if (opts.filter) {
    return `https://store.steampowered.com/search/results/?query&start=${start}&count=100&infinite=1&filter=${opts.filter}&cc=cn&l=schinese`;
  }
  return `https://store.steampowered.com/search/results/?query&start=${start}&count=100&infinite=1&sort_by=${opts.sort}&category1=998&cc=cn&l=schinese`;
};

/** 拉一页；网络失败和非 JSON（被限流时返回整页 HTML）都退避重试 */
async function fetchPage(page, opts) {
  const url = searchUrl(page, opts);
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt) await sleep(RETRY_DELAY_MS * attempt);
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * 解析一行结果。appid 只从商店链接 `/app/<id>/` 里取：
 * 两套排序接口都会给 data-ds-appid，但它和行并不对齐（实测抓到的是邻行的套餐 id），不能用。
 */
function parseRows(html) {
  const rows = [];
  for (const block of html.split('store.steampowered.com/app/').slice(1)) {
    const appid = /^(\d+)/.exec(block)?.[1];
    const name = /<span class="title">([^<]+)<\/span>/.exec(block.slice(0, 4000))?.[1];
    if (!appid || !name) continue;
    const free = /discount_final_price free/.test(block);
    const price = /data-price-final="(\d+)"/.exec(block)?.[1];
    rows.push({
      appid: Number(appid),
      name: decodeEntities(name).trim(),
      price: free ? 0 : price ? Number(price) : null,
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

async function crawl(seen, opts) {
  let failed = 0;
  let streak = 0;
  for (let page = 0; page < opts.pages; page++) {
    try {
      const json = await fetchPage(page, opts);
      const rows = parseRows(json?.results_html ?? '');
      let added = 0;
      for (const row of rows) {
        if (!seen.has(row.appid)) {
          seen.set(row.appid, row);
          added++;
        }
      }
      // 每 20 页汇报一次，日志不至于刷屏
      if (page % 20 === 0 || page === opts.pages - 1) {
        console.log(`[catalog] ${opts.label} 第 ${page + 1}/${opts.pages} 页：${rows.length} 条，新增 ${added}，累计 ${seen.size}`);
      }
      if (!rows.length) failed++;
      streak = 0;
    } catch (err) {
      failed++;
      streak++;
      console.log(`[catalog] ${opts.label} 第 ${page + 1} 页失败：${err.message}`);
      // 连续失败说明被限流了，先冷却一阵再继续
      if (streak >= 5) {
        console.log(`[catalog] 连续 ${streak} 页失败，冷却 60 秒`);
        await sleep(60000);
        streak = 0;
      }
    }
    await sleep(PAGE_DELAY_MS);
    // 每 50 页歇一下，降低被限流的概率
    if (page && page % 50 === 0) await sleep(3000);
  }
  console.log(`[catalog] ${opts.label} 完成：失败 ${failed} 页，累计 ${seen.size}`);
}

async function main() {
  const seen = new Map();
  for (const opts of FILTERS) await crawl(seen, opts);
  for (const opts of SORTS) await crawl(seen, opts);

  const items = [...seen.values()].map((it) => [it.appid, it.name, it.price]);
  const prev = await readJson(FILE('data', 'catalog.json'), null);

  // 抓取结果异常时保留旧索引，避免把页面搜索打回空白
  if (items.length < MIN_ITEMS && prev?.items?.length) {
    console.error(`[catalog] 仅解析到 ${items.length} 条，保留旧索引（${prev.items.length} 条）`);
    return;
  }

  await mkdir(FILE('data'), { recursive: true });
  const body = `${JSON.stringify({ generated: new Date().toISOString(), format: 'compact-v1', count: items.length, items })}\n`;
  await writeFile(FILE('data', 'catalog.json'), body, 'utf8');
  console.log(`[catalog] 写入 ${items.length} 款，${(body.length / 1024 / 1024).toFixed(2)} MB`);
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
