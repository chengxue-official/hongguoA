# 红果TV 热更新迁移方案（Cloudflare 封号后）

> 2026-10-22 · 背景：CF 账号被封，原「hongguo.kdns.fr → CF Worker（静态分发 + 日志 API + KV）」整条链失效。
> 实测：`hongguo.kdns.fr` DNS 解析仍正常（返回 CF 边缘 IP），但 `GET /update.json` 返回 **403**——
> 即域名活着、后端死了。**窗口期内所有已装客户端的更新检查都是失败的**（静默失败，不弹窗）。

**当前进度（2026-10-22，已上线）**
- 服务端：`edge-functions/api/log.js`、`edge-functions/log/[token].js` 已按 EdgeOne 规范写好，**存储用 Blob 而非 KV**（KV 需人工审核，Blob 免开通即用，详见第二节）。
- 客户端：v1.0.18 (118) 已构建——多源 + 清单自举 + `mirrors`/`logApi`/`sha256` 全部落地，编译/单测/lint 全绿。
- 产物：`public/hongguo-1.0.18.apk`（10.98 MB，sha256 `e6f079059a6b…b1f33`）、`public/update.json`（v2）。
- 发版：`release.ps1` 一条命令完成构建→拷包→sha256→清单→推送。
- 已上线：`https://www.hongguo.kdns.fr`（EdgeOne 自定义域名 + 免费证书），`/update.json` 200、APK 200、`POST /api/log` 200、`/log/<token>` 与 `.txt` 均 200、重复上传 429 限流生效。
- **域名结论**：根域 `hongguo.kdns.fr` 无法指向 EdgeOne（KataBump 禁止 apex 放 CNAME），实际接入的是 `www` 子域，见第三节。

---

## 一、总体思路：三层解耦

| 层 | 旧方案 | 新方案 |
|---|---|---|
| 托管 | CF Worker + KV（免费、需科学对抗封锁风险） | **腾讯 EdgeOne Pages + Pages Functions + Blob**（国内可达、免费额度、Pages 与 CF 用法近乎 1:1） |
| 域名 | KataBump 免费二级域名 NS→CF | 同一域名加 TXT 验证 + CNAME 到 EdgeOne（子域 `www`，根域不行） |
| 客户端 | 单源硬编码，换域名必须重装 APK | **多源 + 清单自举**：`update.json` 里带 `mirrors`/`logApi`，以后换托管**不再需要发新 APK** |

核心原则：**域名与平台彻底解耦**——清单（update.json）里声明镜像与日志地址，客户端持久化并在下次检查时合并，
任何一层再被封，只需改清单，零客户端发版。

---

## 二、托管选型对比

| 方案 | 国内可达 | 免费 | 动态 API | 结论 |
|---|---|---|---|---|
| **EdgeOne Pages**（推荐） | 好（腾讯 3200+ 国内节点） | 长期免费套餐 | Pages Functions + EdgeOne KV | CF Pages 的对位替代，函数路由 `/functions` 目录、`onRequest({request,params,env})`、KV 全局变量访问，迁移成本低 |
| Vercel / Netlify | 差/不稳（默认域名被污染，自定义域名可绕） | 有 | 有 | 备选，不稳定不推荐 |
| GitHub Releases + jsDelivr | jsDelivr 国内已不稳，`objects.githubusercontent.com` 时通时断 | 有 | 无 | 只能当 update.json 的应急镜像（清单小文件），**不能**当 APK 主源 |
| 国内 OSS/COS + CDN | 好 | 需实名+备案域名+少量费用 | 需另配函数 | 最稳但要花钱，EdgeOne 失败后再考虑 |

EdgeOne 已实测确认的接口形态（与 CF 的差异）：
- 函数路由：**`/edge-functions/api/log.js` → `/api/log`**（目录名必须是 edge-functions，踩坑：写成 functions 会导致函数不生效）；动态路由 `edge-functions/log/[token].js` → `/log/<token>`（`params.token`）。
- **存储选型：Blob 而非 KV**。KV 要走「控制台申请开通 → 人工审核 → 建命名空间 → 绑定项目」，审核周期长（社区有人 20+ 天仍在审批）；Blob 是 `getStore('name')` 即用即得，首次调用平台自动创建命名空间，**无需开通/审核/绑定**。
- Blob SDK：`@edgeone/pages-blob`（当前 `0.0.18`），API `getStore / set / get / delete / list`；单值上限 25 MB，免费额度 1 GB；`get` 不存在返回 `null`；key 无字符集限制（本仓库仍沿用 `log_` / `rate_` 前缀）。
- Blob 默认最终一致，可传 `{ consistency: 'strong' }` 走强一致读——**限流判定与查看页必须用强一致**，否则「刚传完立刻点链接」会读到旧值/空值。
- Blob 无 TTL → 旧「未读 24h 自动清理 / 读后续 30 天」策略改由**定时清理函数**实现：`edgeone.json` 的 `schedules`（cron `30 4 * * *`，Asia/Shanghai）每天触发 `/api/cron/cleanup`，按 `idx_<yyyymmdd>_<token>` 日期索引回收 30 天前的日志与限流键（`list` 不返回写入时间，所以日期必须放进 key 名）。
- 请求 body 上限 1 MB（平台硬限制）→ 函数侧单次上传上限 900 KB，客户端同步截断。
- 部署：Git 集成（push 到 GitHub 自动构建，含 `npm install`）或 `edgeone pages deploy`；本地调试 `edgeone pages init / link / dev`。

---

## 三、域名策略（已落地：`www` 子域 + CNAME）

### 实际接入流程（EdgeOne Pages 自定义域名）
1. 项目 → 域名管理 → 添加自定义域名 `www.hongguo.kdns.fr`；
2. **TXT 归属验证**：同一父域的子域会继承验证结果，已验证过根域时自动跳过；
3. 按弹窗在 KataBump 加 **CNAME**，目标**按域名逐个生成**：
   - 根域 `hongguo.kdns.fr` → `hongguo.kdns.fr.pages.dnsoe4.com`
   - `www` → `www.hongguo.kdns.fr.pages.dnsoe6.com`（**以控制台弹窗为准，不要套用其它域名的 dnsoe 编号**）
4. CNAME 指过去后平台才**懒激活**目标（指之前目标本身 NXDOMAIN），随后解析出 `43.174.246.66 / 43.174.247.66` 并签发免费证书（TrustAsia DV，`CN=www.hongguo.kdns.fr`，90 天）。

### 两个硬约束（踩过坑）
- **根域不能放 CNAME**：KataBump 的 zone 是 `hongguo.kdns.fr`，apex（@）放 CNAME 与 SOA/NS 冲突（RFC 1034），所以根域**无法**指向 EdgeOne，只能用 `www` 子域。因此客户端 `NEW_HOST` 必须写 `https://www.hongguo.kdns.fr`。
- **默认域名国内不可匿名访问**：`*.edgeone.site` 等平台默认域名受合规限制，国内网络直接访问会失败；必须走自定义域名（加速区域选「全球可用区（不含中国大陆）」免备案）。`.fr` 无法工信部备案，绝不能选含大陆区域。

### 旧域与救回
- `hongguo.kdns.fr`（CF 时代）仍在客户端 `HOSTS` 首位，快速失败后自动切到 `NEW_HOST`；已装 1.0.17 客户端装上 v1.0.18 后即靠多源自愈。
- EdgeOne 控制台里那个无法生效的根域自定义域名可直接删掉，避免误配。

---

## 四、update.json v2 清单 schema

```json
{
  "versionCode": 118,
  "versionName": "1.0.18",
  "apk": "hongguo-1.0.18.apk",
  "sha256": "（发版脚本自动计算填入，64 位十六进制）",
  "notes": "……",
  "mirrors": [
    "https://<EdgeOne域名或其它源>/update.json",
    "https://hongguo.kdns.fr/update.json"
  ],
  "logApi": "https://<EdgeOne域名>/api/log"
}
```

- **向后兼容**：v1.0.17 及更早客户端忽略不认识的字段，照常读 `versionCode/apk/notes`。
- `mirrors`：**完整清单 URL 列表**。客户端成功读到任何一份清单后，把其中 mirrors 持久化，
  下次检查把它们并入源列表（与命中源去重）→ **源清单自举**，未来换托管零发版。
- `logApi`：日志上传地址热切换，随清单下发。
- `sha256`：非空则强校验；为空（老清单）只做长度校验，行为不变。

---

## 五、客户端改造（v1.0.18，已实施）

1. `UpdateChecker`：
   - 源列表 = 硬编码 HOSTS（kdns.fr + 新源占位）∪ 上次清单里的 `mirrors` ∪ 上次命中源，去重后按序尝试；
   - 成功的清单原文落 SharedPreferences（`update_checker/manifest`），供自举与日志地址读取；
   - `download()` 候选地址扩展到所有源；每个候选下完做 sha256 校验，不一致视为损坏换下一个源；
   - `check()` 增加 `context` 参数（持久化需要），调用点 MainActivity / UpdateDialog 同步更新。
2. `LogUploader`：上传地址 = 已存清单的 `logApi` → 回退硬编码默认；服务器挂了自动降级飞书分片模式（原有逻辑不变）。

## 六、服务端迁移（本地目录 hongguoTV-release → GitHub `chengxue-official/hongguoA`）

```
（本目录，已推送为 GitHub 仓库 chengxue-official/hongguoA）
├── edge-functions/          # ⚠ 目录名必须是 edge-functions（不是 functions）
│   ├── api/log.js        POST /api/log     上传日志（限流 15 分钟/设备，body ≤900KB，写日期索引）
│   ├── api/cron/cleanup.js POST /api/cron/cleanup  每日回收 30 天前日志（schedules 触发）
│   └── log/[token].js    GET /log/<token>  在线查看；/log/<token>.txt 下载
├── public/               update.json + APK（静态，直接由 Pages 分发）
└── legacy/               旧 CF Worker（已死，保留仅作历史参考）
```

控制台步骤（一次性）：
1. 注册 EdgeOne（国内站需实名；国际版 pages.edgeone.ai 免实名，二选一）；
2. Pages → 创建项目 → 关联 GitHub 仓库 `chengxue-official/hongguoA`（Git 集成，push 即部署）；
3. 输出目录无需手动配置——仓库根 `edgeone.json` 已写死 `"outputDirectory": "public"`（踩坑：默认输出目录是仓库根 `/`，导致 `/` 与 `/update.json` 全 404；控制台若改过此项请与配置文件保持一致）；
4. **无需任何存储控制台配置**：Blob 由 `getStore('hougtime')` 首次调用自动建命名空间（KV 需人工审核，不用）；
5. 测试 `https://<默认域名>/update.json`、`/api/log`、电视端国内可达性；
6. 自定义域名绑定 `www.hongguo.kdns.fr`（TXT 验证 + CNAME，见第三节）。

---

## 七、发版流程（release.ps1，已实施）

```powershell
cd d:\hongguo\hongguoTV-release
.\release.ps1 -Notes "修复xxx"          # 构建→拷包→删旧包→sha256→update.json
.\release.ps1 -Notes "修复xxx" -Push    # 以上全部 + git commit/push（EdgeOne 自动部署）
```

脚本自动：读 `app/build.gradle.kts` 版本 → `assembleDebug`（debug keystore 指纹不变，可覆盖安装）→
拷 `public/hongguo-<v>.apk` 并删旧包 → 计算 sha256 → 生成含 `mirrors/logApi/sha256` 的 update.json。
（旧五步手册在 MIGRATION-README.md，`wrangler deploy` 一步作废，其余四步被脚本吸收。）

---

## 八、风险与兜底

| 风险 | 兜底 |
|---|---|
| EdgeOne 也封/收费 | 清单自举：新源写进 update.json 的 mirrors 即可热切，客户端零改动 |
| 新域名国内不可达 | 上线后先电视实测（`/update.json` 200）再发版；已验证 `www.hongguo.kdns.fr` 可用 |
| 下载被劫持/损坏 | sha256 校验 + 多源逐个降级 |
| 日志 API 挂 | 客户端自动降级飞书分片卡片（原有逻辑），日志不丢 |
| Blob 无 TTL 日志堆积 | 已内置自动清理：上传时写 `idx_<yyyymmdd>_<token>` 日期索引，`edgeone.json` schedules 每天 04:30 触发 `/api/cron/cleanup` 回收 30 天前的日志与限流键（6 小时限频防刷） |

## 九、已完成事项

1. EdgeOne 项目已建（Git 集成 `chengxue-official/hongguoA`），输出目录 `public`；
2. 存储走 Blob（`@edgeone/pages-blob`，命名空间 `hougtime`），无需审核；
3. 自定义域名 `www.hongguo.kdns.fr` 已生效（CNAME + 免费证书），`/update.json`、APK、`/api/log`、`/log/<token>` 全部线上验证通过；
4. v1.0.18 正式包已发布（`NEW_HOST` / `LOG_API` 均指向新域名）；
5. 待办：EdgeOne 控制台删除无法生效的根域自定义域名；真机 1.0.17→1.0.18 无感更新回归。
