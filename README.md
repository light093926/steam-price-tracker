# Steam 价格追踪

个人用的 Steam 国区价格追踪 H5。关注列表里的游戏每小时自动抓一次价，出现史低/新史低时在页面上高亮标注。纯静态页面 + GitHub Actions 定时任务，无需服务器。

## 它是怎么跑的

```
GitHub Actions（每小时） ──► 抓 Steam 价格 / ITAD 史低 ──► 提交 data/*.json
                                                              │
                                        GitHub Pages 静态页面 ─┘（只读 JSON）
```

页面不直连任何第三方接口：Steam Store 接口没有 CORS 头，ITAD 的 Key 也不能放进前端。所有外部请求都发生在 Actions 里，前端只读同仓库的 JSON。

## 部署（一次性）

1. 新建 **Public** 仓库（Private 仓库用 Pages 需要付费计划），把本目录推到 `main` 分支。
2. `Settings → Secrets and variables → Actions` 新增 `ITAD_API_KEY`：
   - 到 isthereanydeal.com 注册免费账号 → `Apps` → `Register App` → 复制 **API Key**（不是 OAuth 的 Client ID）。
   - 不配也能跑，但页面只有当前价，没有史低。
3. `Settings → Pages` → Source 选 `Deploy from a branch`，Branch 选 `main`、目录 `/ (root)`，保存。
4. 打开 `https://<用户名>.github.io/<仓库名>/`，点右上角**设置**填：
   - GitHub 用户名、仓库名、分支（`main`）
   - 细粒度 PAT：GitHub → Settings → Developer settings → Fine-grained tokens → 只授权本仓库、权限只勾 **Contents: Read and write**
5. 点「测试连接」确认可读写，保存。之后在页面里搜索添加游戏即可，提交 watchlist 会自动触发一次抓取。

> PAT 只存在浏览器的 localStorage，不会写进仓库；只在本机自用，公用电脑别填，随时可在 GitHub 撤销。

## 目录

| 路径 | 作用 |
| --- | --- |
| `index.html` / `assets/` | 单页前端，零构建、零 CDN 依赖 |
| `data/prices.json` | 页面唯一数据源（每小时被 Actions 覆盖） |
| `data/watchlist.json` | 关注列表，页面通过 GitHub API 读写 |
| `data/catalog.json` | 本地搜索索引（每天重建约 1000 款热门游戏） |
| `data/history.json` | 自建价格序列，只存价格变化点，供卡片折线图 |
| `data/itad-cache.json` | ITAD 的 uuid / 史低缓存，24 小时过期 |
| `scripts/fetch-prices.mjs` | 抓价主脚本 |
| `scripts/build-catalog.mjs` | 生成搜索索引 |
| `.github/workflows/` | 每小时抓价（第 5 分钟跑） + 每天建索引 |

## 史低口径

- **Steam 史低（主）**：ITAD `games/history` 里 Steam 单店历史调价的最小值，附发生日期。
- **全站史低（辅）**：ITAD `games/historylow`，可能来自 Fanatical 等授权商店，价格常比 Steam 更低，卡片上单独一行标注店铺。
- 判定：`当前价 < 史低` → 新史低；`相等` → 平史低；`高出 ≤10%` → 接近史低。金额统一按「分」比较，避免浮点误差。

## 手动操作

- 立即抓一次：页面「刷新」按钮（走 `repository_dispatch`），或 Actions 页面 `Run workflow`。
- 重建搜索索引：Actions 页面跑 `build-catalog`。
- 改抓取频率：改 `.github/workflows/refresh-prices.yml` 的 `cron`。注意 GitHub 定时任务在整点附近排队最堵，建议错开整点。

## 常见问题

**页面显示「数据已经 N 小时没有更新」**
去 Actions 看最近一次 `refresh-prices` 是否失败。多数是 ITAD Key 失效或 Steam 接口偶发限流，重新 Run 一次即可。

**搜索搜不到某款游戏**
索引只覆盖畅销/特惠/新品约 1000 款。直接粘贴 Steam 商店链接或输入 AppID（如 `1245620`）就能添加。

**史低价格和 SteamDB 上的不一样**
SteamDB 的史低是它自己统计的口径；本页用 ITAD 的 Steam 单店历史，两者在个别地区/捆绑包上会有差异。

**国内访问 GitHub Pages 慢或打不开**
代码不依赖 Pages 特性，可以直接把整个目录丢到 Cloudflare Pages 或任意静态托管，改托管即可，无需改代码。

## 范围之外

多用户 / 登录、降价推送、跨区比价、Steam 愿望单自动导入、SteamDB 抓取都不在 v1 里。
