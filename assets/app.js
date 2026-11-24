/* Steam 价格追踪 —— 纯静态单页。数据全部来自同仓库的 data/*.json。 */
(() => {
  'use strict';

  const GH_API = 'https://api.github.com';
  const CFG_KEY = 'spt.config';
  const THEME_KEY = 'spt.theme';
  const STALE_MS = 3 * 60 * 60 * 1000;

  const state = {
    config: readConfig(),
    prices: null,
    watchlist: null,
    catalog: [],
    catalogLoaded: false,
    filter: 'all',
    sort: 'lowfirst',
    query: '',
    loading: true,
    polling: false,
  };

  const el = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------ 存储

  function readConfig() {
    try {
      const raw = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      return {
        owner: raw.owner || '',
        repo: raw.repo || '',
        branch: raw.branch || 'main',
        token: raw.token || '',
      };
    } catch {
      return { owner: '', repo: '', branch: 'main', token: '' };
    }
  }

  function saveConfig(cfg) {
    state.config = cfg;
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  const hasWriteAccess = () => Boolean(state.config.owner && state.config.repo && state.config.token);

  // ------------------------------------------------------------ 工具

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const yen = (cents) => (Number.isFinite(cents) ? `¥${(cents / 100).toFixed(2)}` : '—');

  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_:·'’"()（）[\]【】]/g, '');

  function relativeTime(iso) {
    if (!iso) return '尚未抓取';
    const diff = Date.now() - Date.parse(iso);
    if (Number.isNaN(diff)) return '时间未知';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚更新';
    if (min < 60) return `${min} 分钟前更新`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前更新`;
    return `${Math.floor(hour / 24)} 天前更新`;
  }

  const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '');

  let toastTimer = 0;
  function toast(msg, kind = '') {
    const node = el('toast');
    node.textContent = msg;
    node.className = `toast is-on${kind === 'err' ? ' is-err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.className = 'toast';
    }, 2800);
  }

  const b64encode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  const b64decode = (b64) => {
    const bin = atob(String(b64).replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };

  // ------------------------------------------------------------ GitHub

  async function gh(path, options = {}) {
    const { token } = state.config;
    const res = await fetch(`${GH_API}${path}`, {
      ...options,
      // GitHub 的 GET 响应带 max-age=60，浏览器缓存会让我们拿着旧 sha 去写 → 409
      cache: 'no-store',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.message || '';
      } catch {}
      throw new Error(detail || `GitHub API ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** 把 GitHub 的英文报错翻成人话 */
  function ghErrorText(err) {
    const m = String(err?.message || err || '');
    if (/does not match/i.test(m)) return '列表刚被其它操作更新，已重试仍冲突，请再点一次';
    if (/Not Found/i.test(m)) return '找不到仓库或文件，检查设置里的用户名 / 仓库名 / 分支';
    if (/Bad credentials|401/i.test(m)) return 'Token 无效或已过期，请在设置里重新填写';
    if (/not accessible|Resource not accessible/i.test(m)) return 'Token 缺少 Contents 写入权限';
    if (/rate limit/i.test(m)) return 'GitHub API 触发限流，等一分钟再试';
    if (/Failed to fetch|NetworkError/i.test(m)) return '网络请求失败，检查网络后重试';
    return m || '未知错误';
  }

  // 串行化写操作：连点两次也不会互相抢 sha
  let writeQueue = Promise.resolve();
  function serializeWrite(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  }

  const watchlistPath = () =>
    `/repos/${state.config.owner}/${state.config.repo}/contents/data/watchlist.json`;

  /** 读改写 watchlist：串行执行 + 每次重试都绕过缓存重取最新 sha */
  async function mutateWatchlist(mutator, message) {
    if (!hasWriteAccess()) throw new Error('未配置 GitHub Token');
    const branch = state.config.branch || 'main';
    return serializeWrite(async () => {
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await sleep(300 + attempt * 350);
        // 带随机参数强制绕过 HTTP 缓存，避免拿着旧 sha 反复 409
        const file = await gh(
          `${watchlistPath()}?ref=${encodeURIComponent(branch)}&_=${Date.now()}${attempt}`,
        );
        const list = JSON.parse(b64decode(file.content));
        list.items = Array.isArray(list.items) ? list.items : [];
        mutator(list);
        list.updated = new Date().toISOString();
        try {
          await gh(watchlistPath(), {
            method: 'PUT',
            body: JSON.stringify({
              message,
              content: b64encode(`${JSON.stringify(list, null, 2)}\n`),
              sha: file.sha,
              branch,
            }),
          });
          state.watchlist = list;
          return list;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    });
  }

  async function dispatchRefresh() {
    if (!hasWriteAccess()) return false;
    try {
      await gh(`/repos/${state.config.owner}/${state.config.repo}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ event_type: 'refresh' }),
      });
      return true;
    } catch (err) {
      console.warn('[dispatch]', err.message);
      return false;
    }
  }

  // ------------------------------------------------------------ 加载

  async function loadJson(file) {
    const res = await fetch(`${file}?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function loadAll() {
    state.loading = true;
    render();
    const results = await Promise.allSettled([loadJson('data/prices.json'), loadJson('data/watchlist.json')]);
    if (results[0].status === 'fulfilled') state.prices = results[0].value;
    else console.warn('[load] prices.json 读取失败', results[0].reason);

    if (results[1].status === 'fulfilled') state.watchlist = results[1].value;
    else if (state.prices?.items?.length) state.watchlist = { items: state.prices.items };

    state.loading = false;
    render();
  }

  async function loadCatalog() {
    if (state.catalogLoaded) return;
    state.catalogLoaded = true;
    try {
      const json = await loadJson('data/catalog.json');
      state.catalog = Array.isArray(json.items) ? json.items : [];
      if (!state.catalog.length) console.warn('[catalog] 索引为空，只能按 AppID / 链接添加');
    } catch (err) {
      console.warn('[catalog] 读取失败', err.message);
      state.catalog = [];
    }
  }

  // ------------------------------------------------------------ 渲染

  const watchedIds = () => new Set((state.watchlist?.items ?? []).map((i) => i.appid));

  function currentItems() {
    const priced = state.prices?.items ?? [];
    if (!priced.length) {
      // 首次抓取前用 watchlist 占位，避免页面空白
      return (state.watchlist?.items ?? []).map((w) => ({
        appid: w.appid,
        name: w.name || `AppID ${w.appid}`,
        header: w.header || headerOf(w.appid),
        pending: true,
        flag: 'pending',
        pinned: w.pinned === true,
        note: w.note ?? '',
        cut: 0,
      }));
    }
    return priced.map((p) => {
      const w = (state.watchlist?.items ?? []).find((i) => i.appid === p.appid);
      return { ...p, pinned: p.pinned ?? w?.pinned ?? false, note: p.note ?? w?.note ?? '' };
    });
  }

  const headerOf = (appid) => `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;

  function applyFilter(items) {
    switch (state.filter) {
      case 'sale':
        return items.filter((i) => i.cut > 0 && !i.free);
      case 'low':
        return items.filter((i) => i.flag === 'new_low' || i.flag === 'equal_low');
      case 'pinned':
        return items.filter((i) => i.pinned);
      default:
        return items;
    }
  }

  const rankOf = (item) =>
    ({ new_low: 0, equal_low: 1, near_low: 2, free: 3, on_sale: 4, none: 5, no_data: 6, pending: 7 }[item.flag] ?? 6);

  function applySort(items) {
    const cmp = {
      lowfirst: (a, b) => rankOf(a) - rankOf(b) || (a.diff_pct ?? 999) - (b.diff_pct ?? 999),
      cut: (a, b) => (b.cut || 0) - (a.cut || 0),
      price: (a, b) => (a.now ?? Infinity) - (b.now ?? Infinity),
      gap: (a, b) => (a.diff_pct ?? 999) - (b.diff_pct ?? 999),
      name: (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'),
      updated: (a, b) => {
        const ta = a.series?.at(-1)?.t ?? '';
        const tb = b.series?.at(-1)?.t ?? '';
        return tb.localeCompare(ta);
      },
    }[state.sort];

    return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || cmp(a, b));
  }

  function flagBadges(item) {
    if (item.flag === 'pending') return '<span class="badge badge--muted">待抓取</span>';
    if (item.flag === 'new_low') return '<span class="badge badge--new">🔥 新史低</span>';
    if (item.flag === 'equal_low') return '<span class="badge badge--low">平史低</span>';
    if (item.flag === 'near_low') return `<span class="badge badge--near">接近史低 +${item.diff_pct}%</span>`;
    if (item.flag === 'free') return '<span class="badge badge--free">免费</span>';
    if (item.flag === 'no_data') {
      return `<span class="badge badge--muted">${state.prices?.itad ? '暂无史低数据' : '史低未启用'}</span>`;
    }
    // 原价没折扣时也给个中性徽标，避免封面一个标签都没有
    if (!item.free && !(item.cut > 0)) return '<span class="badge badge--muted">原价</span>';
    return '';
  }

  function priceBlock(item) {
    if (item.pending) return '<span class="price is-none">…</span>';
    if (item.free) return '<span class="price is-free">免费</span>';
    if (item.unavailable || !Number.isFinite(item.now)) {
      return '<span class="price is-none">国区不可售</span>';
    }
    const cut = item.cut > 0 ? `<span class="cut">-${item.cut}%</span>` : '';
    const was =
      item.cut > 0 && Number.isFinite(item.initial) && item.initial !== item.now
        ? `<span class="was">${yen(item.initial)}</span>`
        : '';
    return `<span class="price">${yen(item.now)}</span>${cut}${was}`;
  }

  function lowBlock(item) {
    if (item.pending) return '<div class="low-row">价格尚未抓取，等定时任务跑完即可</div>';
    if (item.free) return `<div class="low-row"><span>免费游戏，无需比价</span></div>`;

    const steam = item.steam_low;
    const global = item.global_low;

    if (!steam) {
      const alt = global
        ? `全站史低 <span class="low-val">${yen(global.price)}</span> <span class="low-date">${fmtDate(global.at)}</span>（${esc(global.shop || '其它商店')}）`
        : '暂无史低数据';
      return `<div class="low-row">${alt}</div>`;
    }

    const gapText = Number.isFinite(item.diff_pct)
      ? item.diff_pct > 0
        ? `高于史低 ${item.diff_pct}%`
        : item.diff_pct === 0
          ? '正在史低价'
          : `低于史低 ${Math.abs(item.diff_pct)}%`
      : '';

    // 刻度轴：左端史低、右端原价，指针是现价
    const top = Number.isFinite(item.initial) && item.initial > steam.price
      ? item.initial
      : Math.max(Number.isFinite(item.now) ? item.now : steam.price, steam.price);
    const range = top - steam.price;
    const pos = range > 0 && Number.isFinite(item.now)
      ? Math.min(100, Math.max(0, ((item.now - steam.price) / range) * 100))
      : 0;
    const scale = `
      <div class="price-scale" aria-hidden="true">
        <div class="price-scale-track">
          <span class="price-scale-fill" style="width:${pos.toFixed(1)}%"></span>
          <span class="price-scale-marker" style="left:${pos.toFixed(1)}%"></span>
        </div>
        <div class="price-scale-ends">
          <span>史低 ${yen(steam.price)}</span>
          <span>${Number.isFinite(item.initial) && item.initial > steam.price ? `原价 ${yen(item.initial)}` : ''}</span>
        </div>
      </div>`;

    const globalNote =
      global && global.price < steam.price
        ? `<div class="low-row" style="font-size:12px">全站史低 <span class="low-val">${yen(global.price)}</span> <span class="low-date">${fmtDate(global.at)}</span>（${esc(global.shop || '其它商店')}）</div>`
        : '';

    return `
      <div class="low-row">
        <span>Steam 史低</span>
        <span class="low-val">${yen(steam.price)}</span>
        <span class="low-date">${fmtDate(steam.at) || '—'}</span>
        <span class="gap">${gapText}</span>
      </div>
      ${scale}
      ${globalNote}`;
  }

  function sparkline(item) {
    const pts = (item.series ?? []).filter((p) => Number.isFinite(p.p));
    if (pts.length < 2) {
      // 只有 1 个点或还没记录时给虚线占位，让用户知道曲线在积累而不是坏了
      return `<div class="series series--empty"><span>${pts.length ? '价格曲线积累中' : '刚开始记录价格'}</span></div>`;
    }
    const values = pts.map((p) => p.p);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const w = 100;
    const h = 26;
    const step = w / (pts.length - 1);
    const path = pts
      .map((p, i) => `${(i * step).toFixed(2)},${(h - ((p.p - min) / span) * (h - 4) - 2).toFixed(2)}`)
      .join(' ');
    const dropped = values.at(-1) < values[0]
      ? 'var(--green)'
      : values.at(-1) > values[0]
        ? 'var(--orange)'
        : 'var(--muted)';
    return `<div class="series" aria-hidden="true"><svg viewBox="0 0 100 ${h}" preserveAspectRatio="none">
      <polyline points="${path}" fill="none" stroke="${dropped}" stroke-width="1.6" stroke-linejoin="round" />
    </svg></div>`;
  }

  function card(item) {
    const isNew = item.flag === 'new_low';
    const note = item.note ? `<div class="card-note" title="${esc(item.note)}">${esc(item.note)}</div>` : '';
    return `<article class="card${isNew ? ' is-newlow' : ''}" data-appid="${item.appid}">
      <div class="card-media">
        <div class="media-fallback" aria-hidden="true"><span>${esc(item.name)}</span></div>
        <img src="${esc(item.header)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />
        <div class="badges">${flagBadges(item)}</div>
      </div>
      <div class="card-body">
        <div class="card-title"><h2 title="${esc(item.name)}">${esc(item.name)}</h2></div>
        <div class="price-row">${priceBlock(item)}</div>
        ${lowBlock(item)}
        ${sparkline(item)}
        ${note}
        <div class="card-actions">
          <a href="https://store.steampowered.com/app/${item.appid}/" target="_blank" rel="noopener">去 Steam</a>
          <button type="button" data-act="pin" class="${item.pinned ? 'is-on' : ''}" data-appid="${item.appid}">${item.pinned ? '已置顶' : '置顶'}</button>
          <button type="button" data-act="note" data-appid="${item.appid}">备注</button>
          <button type="button" data-act="remove" class="danger" data-appid="${item.appid}">删除</button>
        </div>
      </div>
    </article>`;
  }

  function render() {
    const items = currentItems();
    const stats = state.prices?.stats ?? {};
    const total = items.length;
    const sale = items.filter((i) => i.cut > 0 && !i.free).length;
    const atLow = items.filter((i) => i.flag === 'new_low' || i.flag === 'equal_low').length;
    const newLow = items.filter((i) => i.flag === 'new_low').length;

    el('stat-total').textContent = total;
    el('stat-sale').textContent = sale;
    el('stat-low').textContent = atLow;
    el('stat-newlow').textContent = newLow;
    el('updated-at').textContent = relativeTime(state.prices?.generated);
    el('source-note').textContent = state.prices?.itad
      ? '史低口径：Steam 单店历史最低（ITAD）'
      : '未配置 ITAD Key，仅显示当前价';

    const staleBanner = el('banner-stale');
    const generated = state.prices?.generated;
    const age = generated ? Date.now() - Date.parse(generated) : null;
    const stale = !state.loading && Number.isFinite(age) && age > STALE_MS;
    if (stale) {
      staleBanner.hidden = false;
      staleBanner.innerHTML = `<span>数据已经 ${Math.round(age / 3600000)} 小时没有更新，定时任务可能失败了。</span><button type="button" id="stale-retry">重试</button>`;
      el('stale-retry')?.addEventListener('click', () => manualRefresh());
    } else {
      staleBanner.hidden = true;
      staleBanner.innerHTML = '';
    }

    el('banner-readonly').hidden = hasWriteAccess();

    const grid = el('grid');
    const empty = el('empty');
    const emptyAction = el('empty-action');

    if (state.loading && !items.length) {
      grid.innerHTML = Array.from({ length: 4 }, () => '<div class="skeleton"></div>').join('');
      empty.hidden = true;
      return;
    }

    const visible = applySort(applyFilter(items));
    grid.innerHTML = visible.map(card).join('');
    empty.hidden = Boolean(visible.length);
    if (!visible.length) {
      if (!items.length) {
        el('empty-title').textContent = '还没有关注任何游戏';
        el('empty-text').textContent = '在上方搜索框里添加，或者在设置里检查 GitHub Token。';
        emptyAction.hidden = false;
        emptyAction.textContent = '搜索并添加';
      } else {
        el('empty-title').textContent = '没有符合条件的游戏';
        el('empty-text').textContent = '换一个筛选条件试试。';
        emptyAction.hidden = true;
      }
    }
  }

  // ------------------------------------------------------------ 搜索

  function parseAppid(text) {
    const s = String(text).trim();
    if (/^\d{3,8}$/.test(s)) return Number(s);
    const m = /store\.steampowered\.com\/app\/(\d+)/.exec(s);
    return m ? Number(m[1]) : null;
  }

  function searchCatalog(query) {
    const q = norm(query);
    if (!q) return [];
    const scored = [];
    for (const item of state.catalog) {
      const name = norm(item.name);
      if (name.includes(q)) {
        scored.push({ item, score: name.startsWith(q) ? 0 : 1, len: name.length });
        if (scored.length > 400) break;
      }
    }
    scored.sort((a, b) => a.score - b.score || a.len - b.len);
    return scored.slice(0, 8).map((s) => s.item);
  }

  function renderSuggest() {
    const box = el('suggest');
    const raw = el('q').value.trim();
    if (!raw) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }

    const appid = parseAppid(raw);
    const watched = watchedIds();
    const rows = [];

    if (appid && !state.catalog.some((i) => i.appid === appid)) {
      rows.push(`<li data-add="${appid}" data-name="AppID ${appid}">
        <div class="meta"><strong>AppID ${appid}</strong><span>直接添加这个 AppID</span></div>
        <span class="tag">${watched.has(appid) ? '已关注' : '添加'}</span></li>`);
    }

    const hits = searchCatalog(raw);
    if (hits.length) {
      for (const hit of hits) {
        rows.push(`<li data-add="${hit.appid}" data-name="${esc(hit.name)}" data-header="${esc(hit.img || '')}">
          <img src="${esc(hit.img || headerOf(hit.appid))}" alt="" loading="lazy" onerror="this.remove()" />
          <div class="meta"><strong>${esc(hit.name)}</strong><span>${esc(hit.released || '')}${
            hit.free ? ' · 免费' : hit.price != null ? ` · ${yen(hit.price)}` : ''
          }</span></div>
          <span class="tag">${watched.has(hit.appid) ? '已关注' : '添加'}</span></li>`);
      }
    }

    if (!rows.length) {
      const hint = !state.catalogLoaded
        ? '正在加载本地索引…'
        : state.catalog.length
          ? '没找到匹配的游戏，可粘贴 Steam 商店链接或直接输入 AppID'
          : '搜索索引还没生成，请粘贴商店链接或输入 AppID';
      box.innerHTML = `<li class="hint">${hint}</li>`;
    } else {
      box.innerHTML = rows.join('');
    }
    box.hidden = false;
  }

  let searchTimer = 0;
  function onSearchInput() {
    el('q-clear').classList.toggle('is-on', Boolean(el('q').value));
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      await loadCatalog();
      renderSuggest();
    }, 300);
  }

  async function handleAdd(appid, name, header) {
    if (!hasWriteAccess()) {
      openSettings();
      toast('先在设置里配置 GitHub Token，才能保存关注列表', 'err');
      return;
    }
    if (watchedIds().has(appid)) {
      toast('这款游戏已经在关注列表里了');
      return;
    }
    try {
      await mutateWatchlist((list) => {
        if (list.items.some((i) => i.appid === appid)) throw new Error('DUPLICATE');
        list.items.push({
          appid,
          name: name || `AppID ${appid}`,
          header: header || headerOf(appid),
          added: new Date().toISOString(),
          note: '',
          pinned: false,
        });
      }, `feat(watchlist): add ${appid}`);

      el('q').value = '';
      el('q-clear').classList.remove('is-on');
      el('suggest').hidden = true;
      toast('已添加，正在排队抓取价格（约 1 分钟）');
      render();
      await dispatchRefresh();
      pollForUpdate();
    } catch (err) {
      if (err.message === 'DUPLICATE') toast('这款游戏已经在关注列表里了');
      else toast(`添加失败：${ghErrorText(err)}`, 'err');
    }
  }

  /** 应用内确认框，替掉原生 confirm 的系统弹窗 */
  function askConfirm({ title, text, okText = '确定' }) {
    const dlg = el('confirm-dialog');
    el('confirm-title').textContent = title;
    el('confirm-text').textContent = text;
    dlg.querySelector('.btn--danger').textContent = okText;
    return new Promise((resolve) => {
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  /** 应用内备注输入框，返回值：null=取消，''=清空 */
  function askNote(current) {
    const dlg = el('note-dialog');
    const input = el('note-input');
    input.value = current || '';
    return new Promise((resolve) => {
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok' ? input.value : null);
      };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      dlg.showModal();
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  async function handleRemove(appid) {
    if (!hasWriteAccess()) {
      openSettings();
      return;
    }
    const name = (state.prices?.items ?? []).find((i) => i.appid === appid)?.name || `AppID ${appid}`;
    const ok = await askConfirm({
      title: '移除关注',
      text: `确定把「${name}」移出关注列表？移掉后就不再抓它的价格了。`,
      okText: '移除',
    });
    if (!ok) return;
    try {
      await mutateWatchlist((list) => {
        list.items = list.items.filter((i) => i.appid !== appid);
      }, `chore(watchlist): remove ${appid}`);
      if (state.prices?.items) state.prices.items = state.prices.items.filter((i) => i.appid !== appid);
      toast('已移除');
      render();
    } catch (err) {
      toast(`移除失败：${ghErrorText(err)}`, 'err');
    }
  }

  async function handlePin(appid) {
    if (!hasWriteAccess()) {
      openSettings();
      return;
    }
    const target = (state.prices?.items ?? []).find((i) => i.appid === appid);
    const next = !target?.pinned;
    if (target) {
      target.pinned = next;
      render();
    }
    try {
      await mutateWatchlist((list) => {
        const item = list.items.find((i) => i.appid === appid);
        if (!item) throw new Error('NOT_WATCHED');
        item.pinned = next;
      }, `chore(watchlist): pin ${appid}`);
      toast(next ? '已置顶' : '已取消置顶');
    } catch (err) {
      if (target) {
        target.pinned = !next;
        render();
      }
      const msg = err.message === 'NOT_WATCHED' ? '这款游戏已不在关注列表里' : ghErrorText(err);
      toast(`操作失败：${msg}`, 'err');
    }
  }

  async function handleNote(appid) {
    if (!hasWriteAccess()) {
      openSettings();
      return;
    }
    const target = (state.prices?.items ?? []).find((i) => i.appid === appid);
    const value = await askNote(target?.note ?? '');
    if (value === null) return;
    const note = value.trim().slice(0, 60);
    const prev = target?.note ?? '';
    if (target && target.note !== note) {
      target.note = note;
      render();
    }
    try {
      await mutateWatchlist((list) => {
        const item = list.items.find((i) => i.appid === appid);
        if (!item) throw new Error('NOT_WATCHED');
        item.note = note;
      }, `chore(watchlist): note ${appid}`);
      toast(note ? '备注已保存' : '备注已清除');
    } catch (err) {
      if (target) {
        target.note = prev;
        render();
      }
      const msg = err.message === 'NOT_WATCHED' ? '这款游戏已不在关注列表里' : ghErrorText(err);
      toast(`保存失败：${msg}`, 'err');
    }
  }

  // ------------------------------------------------------------ 刷新

  async function manualRefresh() {
    if (!hasWriteAccess()) {
      await loadAll();
      toast('已重新读取数据（未配置 Token，无法主动触发抓取）');
      return;
    }
    const triggered = await dispatchRefresh();
    toast(triggered ? '已触发抓取，稍等 1 分钟左右' : '触发失败，请检查 Token 权限');
    if (triggered) pollForUpdate();
  }

  async function pollForUpdate() {
    if (state.polling) return;
    state.polling = true;
    const before = state.prices?.generated ?? '';
    const started = Date.now();
    try {
      while (Date.now() - started < 4 * 60 * 1000) {
        await sleep(20000);
        try {
          const json = await loadJson('data/prices.json');
          if (json?.generated && json.generated !== before) {
            state.prices = json;
            const wl = await loadJson('data/watchlist.json').catch(() => null);
            if (wl) state.watchlist = wl;
            render();
            toast('价格已更新');
            return;
          }
        } catch {
          // 忽略轮询中的临时错误
        }
      }
      toast('抓取还没跑完，稍后再看', 'err');
    } finally {
      state.polling = false;
    }
  }

  // ------------------------------------------------------------ 设置

  function openSettings() {
    const d = el('settings');
    el('cfg-owner').value = state.config.owner;
    el('cfg-repo').value = state.config.repo;
    el('cfg-branch').value = state.config.branch || 'main';
    el('cfg-token').value = state.config.token;
    el('cfg-status').textContent = '';
    el('cfg-status').className = 'status-line';
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }

  async function testConnection() {
    const cfg = {
      owner: el('cfg-owner').value.trim(),
      repo: el('cfg-repo').value.trim(),
      branch: el('cfg-branch').value.trim() || 'main',
      token: el('cfg-token').value.trim(),
    };
    const status = el('cfg-status');
    if (!cfg.owner || !cfg.repo || !cfg.token) {
      status.textContent = '用户名、仓库名、Token 都要填';
      status.className = 'status-line err';
      return;
    }
    status.textContent = '检测中…';
    status.className = 'status-line';
    saveConfig(cfg);
    try {
      const repo = await gh(`/repos/${cfg.owner}/${cfg.repo}`);
      const file = await gh(
        `/repos/${cfg.owner}/${cfg.repo}/contents/data/watchlist.json?ref=${encodeURIComponent(cfg.branch)}`
      );
      status.textContent = `连接成功：${repo.full_name}（${repo.private ? '私有' : '公开'}）· watchlist 可读写`;
      status.className = 'status-line ok';
      if (!state.watchlist && file) state.watchlist = JSON.parse(b64decode(file.content));
      render();
    } catch (err) {
      status.textContent = `连接失败：${err.message}`;
      status.className = 'status-line err';
    }
  }

  function saveSettings() {
    saveConfig({
      owner: el('cfg-owner').value.trim(),
      repo: el('cfg-repo').value.trim(),
      branch: el('cfg-branch').value.trim() || 'main',
      token: el('cfg-token').value.trim(),
    });
    el('settings').close();
    toast(hasWriteAccess() ? '设置已保存' : '已保存，但 Token 为空，仍为只读模式');
    render();
  }

  // ------------------------------------------------------------ 主题

  function applyTheme(theme) {
    const mode = theme || localStorage.getItem(THEME_KEY) || 'dark';
    document.documentElement.dataset.theme = mode;
    document.querySelector('meta[name="theme-color"]').content = mode === 'light' ? '#f2f5f9' : '#0e1217';
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  // ------------------------------------------------------------ 事件

  function bind() {
    el('btn-refresh').addEventListener('click', manualRefresh);
    el('btn-theme').addEventListener('click', toggleTheme);
    el('btn-settings').addEventListener('click', openSettings);
    el('q').addEventListener('input', onSearchInput);
    el('q').addEventListener('focus', async () => {
      await loadCatalog();
      renderSuggest();
    });
    el('q-clear').addEventListener('click', () => {
      el('q').value = '';
      el('q-clear').classList.remove('is-on');
      el('suggest').hidden = true;
      el('q').focus();
    });

    el('suggest').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-add]');
      if (!li) return;
      handleAdd(Number(li.dataset.add), li.dataset.name, li.dataset.header);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-box') && !e.target.closest('.suggest')) el('suggest').hidden = true;
      const openSettingsBtn = e.target.closest('[data-open-settings]');
      if (openSettingsBtn) openSettings();
    });

    el('filters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      for (const c of el('filters').querySelectorAll('.chip')) c.classList.toggle('is-on', c === chip);
      render();
    });

    el('sort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      render();
    });

    el('grid').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const appid = Number(btn.dataset.appid);
      if (btn.dataset.act === 'pin') handlePin(appid);
      if (btn.dataset.act === 'note') handleNote(appid);
      if (btn.dataset.act === 'remove') handleRemove(appid);
    });

    el('empty-action').addEventListener('click', () => {
      if (!currentItems().length && !hasWriteAccess()) openSettings();
      else el('q').focus();
    });

    el('settings').addEventListener('close', () => {});
    el('cfg-test').addEventListener('click', testConnection);
    el('cfg-clear').addEventListener('click', () => {
      saveConfig({ owner: '', repo: '', branch: 'main', token: '' });
      el('cfg-owner').value = '';
      el('cfg-repo').value = '';
      el('cfg-token').value = '';
      const status = el('cfg-status');
      status.textContent = '已清除本地配置';
      status.className = 'status-line';
      render();
    });
    el('settings').querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings();
    });

    const topbar = el('topbar');
    const onScroll = () => topbar.classList.toggle('is-stuck', window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    setInterval(() => {
      el('updated-at').textContent = relativeTime(state.prices?.generated);
    }, 60000);
  }

  // ------------------------------------------------------------ 启动

  applyTheme();
  bind();
  loadAll();
})();
