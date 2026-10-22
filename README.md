# hongguoA — 红果TV 热更新分发仓库

红果短剧 TV 版 —— 热更新分发仓库（**腾讯 EdgeOne Pages** 托管：静态资源 + Pages Functions + EdgeOne KV）。

> 本仓库**只存放分发文件**，不存放 App 源码（源码在 HougTime 仓库）。
> 原 Cloudflare Workers 链路因账号被封已作废，迁移方案见 [HOTUPDATE-PLAN.md](HOTUPDATE-PLAN.md)。

## 目录结构

```
├── edge-functions/         # EdgeOne Pages Functions（动态 API，必须叫这个目录名）
│   ├── api/log.js          # POST /api/log        日志上传（限流 15 分钟/设备）
│   └── log/[token].js      # GET  /log/<token>    在线查看；/log/<token>.txt 下载
├── public/                 # 静态资源（对外可直接访问）
│   ├── update.json         # 版本清单（v2：含 sha256 / mirrors / logApi）
│   ├── hongguo-<版本>.apk  # 热更新包
│   └── index.html          # 落地页
├── legacy/                 # 旧 Cloudflare Worker（已死，仅历史参考）
├── release.ps1             # 一键发版脚本
└── HOTUPDATE-PLAN.md       # 迁移方案与运维手册
```

部署后访问路径（域名由 EdgeOne 提供，或在控制台绑定自定义域名）：

- `https://<你的域名>/update.json`
- `https://<你的域名>/hongguo-1.0.18.apk`
- `POST https://<你的域名>/api/log`

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
3. KV 存储 → 开通 → 创建命名空间（如 `hongguo-logs`）→ 绑定到项目，**环境变量名填 `LOGS`**（函数按此名访问）；
4. 测试 `https://<默认域名>/update.json`、`/api/log` 与电视端国内可达性；
5. 需要救回已装客户端时：绑定自定义域名 `hongguo.kdns.fr`，KataBump 把 NS 改指 EdgeOne。
