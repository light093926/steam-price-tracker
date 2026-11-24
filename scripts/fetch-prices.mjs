#!/usr/bin/env node
/**
 * 每小时抓取关注游戏的 Steam 国区价格与历史最低价，产出 data/prices.json。
 * 依赖：Steam appdetails（免 Key）、IsThereAnyDeal API（需 ITAD_API_KEY）。
 * 缺 Key 时降级为「只有当前价、没有史低」，不阻塞页面。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = (...p) => path.join(ROOT, ...p);

const STEAM_CC = process.env.STEAM_CC || 'cn';
const STEAM_LANG = process.env.STEAM_LANG || 'zh-CN';
const ITAD_KEY = (process.env.ITAD_API_KEY || '').trim();
const ITAD_BASE = 'https://api.isthereanydeal.com';
const UA = 'steam-price-tracker/1.0 (personal watchlist; GitHub Actions)';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 史低变化慢，一天一次足够
const SERIES_POINTS = 720; // 自建价格点上限
const SERIES_EMBED = 60; // 页面折线图只用最近 60 点

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, { method = 'GET', body, retries = 3, timeout = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        signal: ac.signal,
        headers: {
          'user-agent': UA,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------- Steam

/** 单次可取多个 appid；只取 price_overview，响应很小 */
async function steamPriceBatch(appids) {
  const url =
    `https://store.steampowered.com/api/appdetails?appids=${appids.join(',')}` +
    `&cc=${STEAM_CC}&l=${STEAM_LANG}&filters=price_overview`;
  const json = await fetchJson(url);
  const result = new Map();
  for (const id of appids) {
    const entry = json?.[String(id)];
    if (entry?.success) result.set(Number(id), entry.data ?? {});
    else if (entry?.success === false) result.set(Number(id), null);
  }
  return result;
}

async function steamPriceAll(appids) {
  const found = new Map();
  for (const group of chunk(appids, 10)) {
    try {
      for (const [id, data] of await steamPriceBatch(group)) found.set(id, data);
    } catch (err) {
      console.error(`[steam] 批量请求失败，改为逐个重试：${err.message}`);
      for (const id of group) {
        try {
          for (const [k, v] of await steamPriceBatch([id])) found.set(k, v);
        } catch (e2) {
          console.error(`[steam] appid ${id} 抓取失败：${e2.message}`);
        }
      }
    }
    await sleep(300); // 温和节流，远低于 300 次/5 分钟
  }
  return found;
}

/** 名称/封面/是否免费等元数据；payload 较大，只对需要的游戏调用一次 */
async function steamBasic(appid) {
  const url =
    `https://store.steampowered.com/api/appdetails?appids=${appid}` +
    `&cc=${STEAM_CC}&l=${STEAM_LANG}&filters=basic`;
  const json = await fetchJson(url, { retries: 2 });
  const entry = json?.[String(appid)];
  return entry?.success ? entry.data : null;
}

// ---------------------------------------------------------------- ITAD

const itadOn = ITAD_KEY.length > 0;

async function itadGet(pathname, params = {}) {
  const qs = new URLSearchParams({ ...params, key: ITAD_KEY });
  return fetchJson(`${ITAD_BASE}${pathname}?${qs}`, { retries: 2 });
}

async function itadPost(pathname, params, body) {
  const qs = new URLSearchParams({ ...params, key: ITAD_KEY });
  return fetchJson(`${ITAD_BASE}${pathname}?${qs}`, { method: 'POST', body, retries: 2 });
}

async function itadLookup(appid) {
  const json = await itadGet('/games/lookup/v1', { appid });
  return json?.found && json?.game?.id ? { uuid: json.game.id, title: json.game.title } : null;
}

/** 返回每款游戏的 Steam 商店当前价 + 商店内史低（storeLow，无日期） */
async function itadPrices(uuids) {
  if (!uuids.length) return new Map();
  const json = await itadPost('/games/prices/v3', { country: 'CN' }, uuids);
  const map = new Map();
  for (const entry of json ?? []) {
    const deals = entry?.deals ?? [];
    const steam =
      deals.find((d) => /steam/i.test(d?.shop?.name ?? '')) ??
      deals.find((d) => /store\.steampowered\.com/.test(d?.url ?? ''));
    map.set(entry.id, {
      shopId: steam?.shop?.id ?? null,
      low: steam?.storeLow?.amountInt ?? steam?.historyLow?.amountInt ?? null,
      price: steam?.price?.amountInt ?? null,
      cut: steam?.cut ?? null,
    });
  }
  return map;
}

/** 跨商店全站史低（含日期与商店名） */
async function itadGlobalLows(uuids) {
  if (!uuids.length) return new Map();
  const json = await itadPost('/games/historylow/v1', { country: 'CN' }, uuids);
  const map = new Map();
  for (const entry of json ?? []) {
    const low = entry?.low;
    if (!low) continue;
    map.set(entry.id, {
      price: low?.price?.amountInt ?? null,
      at: (low?.timestamp ?? '').slice(0, 10) || null,
      shop: low?.shop?.name ?? null,
    });
  }
  return map;
}

/** Steam 单店历史调价日志 → 史低价与发生日期 */
async function itadSteamHistory(uuid, shopId) {
  const params = { id: uuid, country: 'CN', since: '2011-01-01T00:00:00Z' };
  if (shopId) params.shops = String(shopId);
  const log = await itadGet('/games/history/v2', params);
  let best = null;
  for (const point of log ?? []) {
    if (shopId && point?.shop?.id !== shopId) continue;
    const price = point?.deal?.price?.amountInt;
    if (!Number.isFinite(price)) continue;
    if (!best || price < best.price) {
      best = { price, at: (point.timestamp ?? '').slice(0, 10) || null };
    }
  }
  return best;
}

// ---------------------------------------------------------------- 判定

/**
 * 史低打标。单位统一为「分」，避免浮点误差。
 * now < low → 新史低；now == low → 平史低；差值 ≤10% → 接近史低。
 */
function classify({ now, low, cut, free }) {
  if (free) return { flag: 'free', diffPct: null };
  if (!Number.isFinite(now)) return { flag: 'no_data', diffPct: null };
  if (!Number.isFinite(low) || low <= 0) return { flag: 'no_data', diffPct: null };
  if (now < low) return { flag: 'new_low', diffPct: Math.round((now / low - 1) * 100) };
  if (now === low) return { flag: 'equal_low', diffPct: 0 };
  const diffPct = Math.round((now / low - 1) * 100);
  if (diffPct <= 10) return { flag: 'near_low', diffPct };
  return { flag: cut > 0 ? 'on_sale' : 'none', diffPct };
}

const headerFor = (item, appid) =>
  item.header || `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;

const yen = (cents) =>
  Number.isFinite(cents) ? `¥${(cents / 100).toFixed(2)}` : '—';

// ---------------------------------------------------------------- 主流程

async function main() {
  const watchlist = await readJson(FILE('data', 'watchlist.json'), { items: [] });
  const watch = (watchlist.items ?? []).filter((i) => Number.isFinite(i?.appid));
  if (!watch.length) {
    console.log('[main] watchlist 为空，写入空数据文件后退出');
    await writeJson(FILE('data', 'prices.json'), {
      generated: new Date().toISOString(),
      currency: 'CNY',
      itad: itadOn,
      items: [],
      stats: { total: 0, on_sale: 0, at_low: 0 },
    });
    return;
  }
  console.log(`[main] 关注 ${watch.length} 款游戏｜ITAD ${itadOn ? '已启用' : '未配置，史低将缺失'}`);

  const appids = watch.map((w) => w.appid);
  const prices = await steamPriceAll(appids);

  // 元数据补全：没有价格信息、或 watchlist 里没存名称的，拉一次 basic
  const meta = new Map();
  const needMeta = watch.filter((w) => {
    const data = prices.get(w.appid);
    const hasPrice = data?.price_overview;
    return !hasPrice || !w.name;
  });
  await mapLimit(needMeta, 2, async (w) => {
    try {
      const basic = await steamBasic(w.appid);
      if (basic) meta.set(w.appid, basic);
    } catch (err) {
      console.error(`[steam] basic ${w.appid} 失败：${err.message}`);
    }
    await sleep(250);
  });

  // ITAD：缓存 24h，减少无意义调用
  const cache = await readJson(FILE('data', 'itad-cache.json'), {});
  const nowMs = Date.now();
  const stale = new Map();
  const fresh = new Map();

  if (itadOn) {
    for (const w of watch) {
      const entry = cache[String(w.appid)];
      // 只有「史低也抓过」的缓存才算新鲜，避免史低缺失时被缓存卡住 24 小时
      if (entry?.uuid && entry.lowChecked && entry.checked && nowMs - Date.parse(entry.checked) < CACHE_TTL_MS) {
        fresh.set(w.appid, entry);
      } else {
        stale.set(w.appid, entry ?? {});
      }
    }
    console.log(`[itad] 缓存命中 ${fresh.size}｜待更新 ${stale.size}`);
  }

  if (itadOn && stale.size) {
    // 1) appid → ITAD uuid
    await mapLimit([...stale.keys()], 2, async (appid) => {
      try {
        const hit = await itadLookup(appid);
        if (hit) {
          const entry = stale.get(appid);
          entry.uuid = hit.uuid;
          entry.title = hit.title;
        }
        await sleep(200);
      } catch (err) {
        console.error(`[itad] lookup ${appid} 失败：${err.message}`);
      }
    });

    const uuids = [...stale.entries()].filter(([, e]) => e.uuid).map(([, e]) => e.uuid);

    // 2) Steam 当前价 + 商店内史低（批次）
    try {
      const p = await itadPrices(uuids);
      for (const [, e] of stale) {
        const hit = e.uuid && p.get(e.uuid);
        if (hit) {
          e.shopId = hit.shopId ?? e.shopId ?? null;
          e.steamLowFlat = hit.low ?? e.steamLowFlat ?? null;
        }
      }
    } catch (err) {
      console.error(`[itad] prices 失败：${err.message}`);
    }

    // 3) Steam 单店史低 + 日期（逐款，缓存 24h）
    await mapLimit([...stale.entries()].filter(([, e]) => e.uuid), 2, async ([appid, e]) => {
      try {
        const low = await itadSteamHistory(e.uuid, e.shopId);
        if (low) e.steamLow = low;
        else if (Number.isFinite(e.steamLowFlat)) e.steamLow = { price: e.steamLowFlat, at: null };
        await sleep(200);
      } catch (err) {
        console.error(`[itad] history ${appid} 失败：${err.message}`);
        if (Number.isFinite(e.steamLowFlat) && !e.steamLow) e.steamLow = { price: e.steamLowFlat, at: null };
      }
      if (e.steamLow) e.lowChecked = true;
    });

    // 4) 全站史低（批次）
    try {
      const g = await itadGlobalLows(uuids);
      for (const [, e] of stale) {
        const hit = e.uuid && g.get(e.uuid);
        if (hit && Number.isFinite(hit.price)) e.globalLow = hit;
      }
    } catch (err) {
      console.error(`[itad] historylow 失败：${err.message}`);
    }

    for (const [appid, e] of stale) e.checked = new Date().toISOString();
  }

  // 自建价格序列，供页面画折线
  const series = await readJson(FILE('data', 'history.json'), {});
  const stamp = new Date().toISOString();

  const items = watch.map((w) => {
    const data = prices.get(w.appid);
    const po = data?.price_overview;
    const b = meta.get(w.appid);
    const c = fresh.get(w.appid) ?? stale.get(w.appid) ?? null;

    const free = b?.is_free === true;
    const now = po?.final ?? null;
    const initial = po?.initial ?? null;
    const cut = po?.discount_percent ?? 0;
    const steamLow = Number.isFinite(c?.steamLow?.price)
      ? { price: c.steamLow.price, at: c.steamLow.at ?? null }
      : null;
    const globalLow =
      Number.isFinite(c?.globalLow?.price)
        ? { price: c.globalLow.price, at: c.globalLow.at ?? null, shop: c.globalLow.shop ?? null }
        : null;

    const verdict = classify({ now: free ? 0 : now, low: steamLow?.price, cut, free });

    // 序列：价格变化时才追加，避免每小时刷一个重复点
    const key = String(w.appid);
    const points = Array.isArray(series[key]) ? series[key] : [];
    if (Number.isFinite(now) && points.at(-1)?.p !== now) {
      points.push({ t: stamp, p: now });
      if (points.length > SERIES_POINTS) points.splice(0, points.length - SERIES_POINTS);
    }
    if (Number.isFinite(now)) series[key] = points;

    return {
      appid: w.appid,
      name: b?.name || w.name || `AppID ${w.appid}`,
      name_en: c?.title || w.name_en || null,
      header: b?.header_image || headerFor(w, w.appid),
      store_url: `https://store.steampowered.com/app/${w.appid}/`,
      free,
      unavailable: !po && !free,
      now,
      initial,
      cut,
      currency: po?.currency ?? 'CNY',
      steam_low: steamLow,
      global_low: globalLow,
      low_source: steamLow ? 'steam' : null,
      flag: verdict.flag,
      diff_pct: verdict.diffPct,
      stale: !data, // 本次没拿到数据，沿用旧快照
      note: w.note ?? '',
      pinned: w.pinned === true,
      series: points.slice(-SERIES_EMBED),
    };
  });

  await mkdir(FILE('data'), { recursive: true });
  await writeJson(FILE('data', 'history.json'), series);
  if (itadOn) await writeJson(FILE('data', 'itad-cache.json'), Object.fromEntries([...fresh, ...stale]));

  const stats = {
    total: items.length,
    on_sale: items.filter((i) => i.cut > 0 && !i.free).length,
    at_low: items.filter((i) => i.flag === 'equal_low' || i.flag === 'new_low').length,
    new_low: items.filter((i) => i.flag === 'new_low').length,
  };

  await writeJson(FILE('data', 'prices.json'), {
    generated: stamp,
    currency: 'CNY',
    itad: itadOn,
    items,
    stats,
  });

  for (const i of items) {
    const tag = i.flag === 'new_low' ? '🔥新史低' : i.flag === 'equal_low' ? '平史低' : '';
    console.log(
      `[data] ${String(i.appid).padStart(7)} ${i.name} ${yen(i.now)}` +
        `${i.cut ? ` (-${i.cut}%)` : ''} 史低${yen(i.steam_low?.price)} ${tag}`
    );
  }
  console.log(`[data] 写入 prices.json：${stats.total} 款，在促 ${stats.on_sale}，史低 ${stats.at_low}`);
}

async function writeJson(file, data) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
