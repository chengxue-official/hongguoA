# 红果TV 热更新迁移方案（Cloudflare 封号后）

> 2026-10-22 · 背景：CF 账号被封，原「hongguo.kdns.fr → CF Worker（静态分发 + 日志 API + KV）」整条链失效。
> 实测：`hongguo.kdns.fr` DNS 解析仍正常（返回 CF 边缘 IP），但 `GET /update.json` 返回 **403**——
> 即域名活着、后端死了。**窗口期内所有已装客户端的更新检查都是失败的**（静默失败，不弹窗）。

**当前进度（2026-10-22）**
- 服务端：`functions/api/log.js`、`functions/log/[token].js` 已按 EdgeOne 规范写好（KV key 字符集、无 TTL 等差异已处理）。
- 客户端：v1.0.18 (118) 已构建——多源 + 清单自举 + `mirrors`/`logApi`/`sha256` 全部落地，编译/单测/lint 全绿。
- 产物：`public/hongguo-1.0.18.apk`（10.92 MB，sha256 `6e5b9657…ac3979`）、`public/update.json`（v2）。
- 发版：`release.ps1` 一条命令完成构建→拷包→sha256→清单→推送。
- **待你提供**：EdgeOne 项目域名（填进 `UpdateChecker.NEW_HOST` 与清单 `logApi`），以及域名走路径 A 还是 B（见第三节）。

---

## 一、总体思路：三层解耦

| 层 | 旧方案 | 新方案 |
|---|---|---|
| 托管 | CF Worker + KV（免费、需科学对抗封锁风险） | **腾讯 EdgeOne Pages + Pages Functions + EdgeOne KV**（国内可达、免费额度、Pages 与 CF 用法近乎 1:1） |
| 域名 | KataBump 免费二级域名 NS→CF | 同一域名 NS 改到 EdgeOne（救回，推荐）；救不回则用新域名 |
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
- 函数路由：`/functions/api/log.js` → `/api/log`；动态路由 `functions/log/[token].js` → `/log/<token>`（`params.token`）。
- KV 通过**绑定变量名全局访问**（如 `LOGS.get/put/delete/list`），不是 CF 的 `env.LOGS`（代码里两者兼容写法）。
- **KV key 只允许字母/数字/下划线** → 前缀用 `log_` / `rate_`，不能用冒号。
- **KV put 无 TTL 参数** → 旧「未读 24h 自动清理 / 读后续 30 天」策略退化为**永久保留**（1GB 容量 ≈ 300+ 条 3MB 日志，量级足够；限流改用「存时间戳 + 计算剩余」实现，效果等价）。
- KV 遵循最终一致性（60s 全球同步）→ 限流是软限制（客户端本地还有 15 分钟节流兜底，双保险仍在）。
- 部署：Git 集成（push 到 GitHub 自动构建）或 `edgeone pages deploy`；本地调试 `edgeone pages init / link / dev`。

---

## 三、域名策略（二选一，可先 A 后悔再 B）

### 路径 A：救回 hongguo.kdns.fr（推荐）
KataBump 只是免费二级域名商，**它没被封**——之前是你把 NS 指到 CF 才被牵连。
1. EdgeOne Pages 项目上线（先用默认域名验证可用）；
2. EdgeOne 控制台「自定义域名」添加 `hongguo.kdns.fr`，按提示在 KataBump 侧把 NS/DNS 改指 EdgeOne；
3. 域名生效后，**已装的 1.0.17 客户端无需任何操作，自动恢复更新**（它们只认这个域名）。

### 路径 B：换新域名（KataBump 账号也没了时）
1. EdgeOne 项目用默认域名（或再申请一个免费二级域名绑定过去）；
2. 已装客户端只能**手动安装一次 v1.0.18**（内置新源），此后靠清单自举永不重装；
3. 与历史上 workers.dev→kdns.fr 迁移的教训同构（那批 v1.0.1 用户就是手动救回来的）。

> 顺序建议：先把 EdgeOne 项目上线跑通 → 再去 KataBump 改 NS（路径 A）。即使 NS 改到一半失败，
> 新 APK（v1.0.18）里 kdns.fr 与新源都在源列表里，两边都能收。

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
├── functions/
│   ├── api/log.js        POST /api/log     上传日志（限流 15 分钟/设备）
│   └── log/[token].js    GET /log/<token>  在线查看；/log/<token>.txt 下载
├── public/               update.json + APK（静态，直接由 Pages 分发）
└── legacy/               旧 CF Worker（已死，保留仅作历史参考）
```

控制台步骤（一次性）：
1. 注册 EdgeOne（国内站需实名；国际版 pages.edgeone.ai 免实名，二选一）；
2. Pages → 创建项目 → 关联 GitHub 仓库 `chengxue-official/hongguoA`（Git 集成，push 即部署）；
3. Pages → KV 存储 → 开通账户 → 创建命名空间（如 `hongguo-logs`）→ 绑定到项目，**变量名填 `LOGS`**（代码按此名访问）；
4. 测试 `https://<默认域名>/update.json`、`/api/log`、电视端国内可达性；
5. （路径 A）自定义域名绑定 `hongguo.kdns.fr`，KataBump 改 NS。

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
| 新域名国内不可达 | 上线后先电视实测（`/update.json` 200）再发版；不行走路径 A 换回 kdns.fr |
| 下载被劫持/损坏 | sha256 校验 + 多源逐个降级 |
| 日志 API 挂 | 客户端自动降级飞书分片卡片（原有逻辑），日志不丢 |
| KV 无 TTL 日志堆积 | 1GB 上限前在控制台手动清；量大再加定期清理函数 |

## 九、你需要做的一件事清单

1. 注册 EdgeOne，按第六节控制台步骤建项目 + KV 绑定（变量名 `LOGS`）；
2. 把项目默认域名（形如 `https://<project>.mof.icu` 或 `*.edgeone.site`）发我，我填进
   `UpdateChecker.NEW_HOST`、`release.ps1` 的 `logApi/mirrors`，出 v1.0.18 正式 APK；
3. 决定域名路径 A/B（A：去 KataBump 改 NS；B：手动给电视装一次新 APK）。
