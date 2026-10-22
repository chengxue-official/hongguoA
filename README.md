# hongguoA — 红果TV 热更新分发仓库

红果短剧 TV 版 —— 热更新分发仓库（**腾讯 EdgeOne Pages** 托管：静态资源 + Pages Functions + EdgeOne Blob）。

> 本仓库**只存放分发文件**，不存放 App 源码（源码在 HougTime 仓库）。
> 原 Cloudflare Workers 链路因账号被封已作废，迁移方案见 [HOTUPDATE-PLAN.md](HOTUPDATE-PLAN.md)。

## 目录结构

```
├── edge-functions/         # EdgeOne Pages Functions（动态 API，必须叫这个目录名）
│   ├── api/log.js          # POST /api/log        日志上传（限流 15 分钟/设备，写日期索引）
│   ├── api/cron/cleanup.js # POST /api/cron/cleanup  每日清理 30 天前的日志（schedules 触发）
│   └── log/[token].js      # GET  /log/<token>    在线查看；/log/<token>.txt 下载
├── public/                 # 静态资源（对外可直接访问）
│   ├── update.json         # 版本清单（v2：含 sha256 / mirrors / logApi）
│   ├── hongguo-<版本>.apk  # 热更新包
│   └── index.html          # 落地页
├── legacy/                 # 旧 Cloudflare Worker（已死，仅历史参考）
├── package.json            # 仅声明 @edgeone/pages-blob（日志存储 SDK）
├── release.ps1             # 一键发版脚本
└── HOTUPDATE-PLAN.md       # 迁移方案与运维手册
```

线上地址：`https://www.hongguo.kdns.fr`（EdgeOne 自定义域名 + 免费证书）

- `GET  /update.json`
- `GET  /hongguo-1.0.18.apk`
- `POST /api/log`
- `GET  /log/<token>`、`GET /log/<token>.txt`

## update.json 格式（v2，向后兼容）

```json
{
  "versionCode": 118,
  "versionName": "1.0.18",
  "apk": "hongguo-1.0.18.apk",
  "notes": "更新说明",
  "sha256": "APK 的 SHA-256（非空则客户端强校验）",
  "mirrors": ["https://其它源/update.json"],
  "logApi": "https://<你的域名>/api/log"
}
```

| 字段 | 说明 |
|---|---|
| `versionCode` | 整数。App 的 versionCode 小于它才会提示更新 |
| `versionName` | 展示用版本号 |
| `apk` | 包文件名，与 `update.json` 同在 `public/` 下 |
| `sha256` | 非空时客户端下载后强校验，损坏自动换源重下 |
| `mirrors` | 清单镜像，客户端下次检查自动并入源列表（**换托管零发版**的关键） |
| `logApi` | 日志上传地址，客户端随清单热切换 |

## 发版方式

一条命令（在仓库根目录）：

```powershell
.\release.ps1 -Notes "修复xxx"          # 构建→拷包删旧包→sha256→update.json
.\release.ps1 -Notes "修复xxx" -Push    # 以上全部 + git commit/push
```

EdgeOne Pages 关联本仓库后（Git 集成），`git push` 自动构建部署，几秒后新版本即可访问。
不连 Git 也可手动 `edgeone pages deploy`。

## EdgeOne 配置要点（控制台一次性）

1. Pages → 创建项目 → 关联本仓库（`chengxue-official/hongguoA`）；
2. 输出目录无需手动配置——仓库根的 `edgeone.json` 已锁定 `"outputDirectory": "public"`（踩坑：EdgeOne 默认输出目录是仓库根 `/`，不锁定的话 `/` 和 `/update.json` 全 404「页面不存在」）；
3. **无需配置任何存储**：日志走 Blob（`@edgeone/pages-blob`），`getStore('hougtime')` 首次调用自动建命名空间，免开通免审核（KV 需人工审核，故不用）；
4. **无需配置定时任务**：`edgeone.json` 的 `schedules` 已声明每天 04:30 触发 `/api/cron/cleanup` 清理 30 天前的日志（平台部署时自动注册，新部署中移除的任务会自动停止）；
5. 测试 `https://<默认域名>/update.json`、`/api/log` 与电视端国内可达性；
6. 绑定自定义域名：添加 `www.hongguo.kdns.fr` → TXT 归属验证（同父域子域继承）→ 按弹窗加 CNAME（目标形如 `www.hongguo.kdns.fr.pages.dnsoe6.com`，每个域名独立生成）→ 平台懒激活并签发免费证书。
   注意：**根域 `hongguo.kdns.fr` 不能放 CNAME**（apex 与 SOA/NS 冲突），只能用 `www` 子域；平台默认域名（`*.edgeone.site`）国内不可匿名访问，必须走自定义域名。
