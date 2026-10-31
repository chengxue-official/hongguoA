<#
  红果TV 发版脚本（EdgeOne Pages 版，替代已作废的 wrangler deploy）

  做的事：
    1. 从 HougTime/app/build.gradle.kts 读 versionCode / versionName
    2. 调 gradlew assembleDebug 构建 APK 两次（-PabiTarget=32 / =64）
    3. 分别拷到 public/hongguo-<versionName>.apk（32 位）与
       public/hongguo-<versionName>-arm64.apk（64 位），删掉 public 下的其它旧包
    4. 计算两个包的 SHA-256，生成 public/update.json（v2 schema）
    5. 可选 -Push：git add/commit/push（EdgeOne Pages 的 Git 集成会自动部署）

  用法：
    .\release.ps1                                  # 构建并生成 update.json
    .\release.ps1 -Notes "修复xxx"                 # 指定更新说明
    .\release.ps1 -Push                            # 顺便提交推送
    .\release.ps1 -Mirrors "https://a/update.json,https://b/update.json" -LogApi "https://a/api/log"

  说明：
    - 不传 -Notes 时沿用现有 update.json 的 notes（避免重跑一次把更新说明清空）
    - 不传 -Mirrors / -LogApi 时沿用现有 update.json 的值
    - 首次接入 EdgeOne：先 edgeone pages deploy（或连 Git 仓库），把项目默认域名填进
      UpdateChecker.NEW_HOST 与本脚本的 -LogApi，再发版
#>
param(
    [string]$Notes = "",
    [string]$Mirrors = "",
    [string]$LogApi = "",
    [string]$AppDir = "",
    [switch]$Push
)

$ErrorActionPreference = 'Stop'
$releaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AppDir) { $AppDir = Join-Path (Split-Path -Parent $releaseDir) 'HougTime' }
$AppDir = (Resolve-Path $AppDir).Path
$publicDir = Join-Path $releaseDir 'public'
$manifest = Join-Path $publicDir 'update.json'

# ---------- 1. 读版本 ----------
$gradle = Join-Path $AppDir 'app\build.gradle.kts'
$text = Get-Content -LiteralPath $gradle -Raw -Encoding UTF8
$vc = [int]([regex]::Match($text, 'versionCode\s*=\s*(\d+)').Groups[1].Value)
$vn = [regex]::Match($text, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value
if ($vc -le 0 -or -not $vn) { throw "无法从 $gradle 读取版本号" }
Write-Host "版本: v$vn ($vc)" -ForegroundColor Cyan

# ---------- 2. 构建（双 ABI：32 位 + 64 位，各打一次） ----------
$apkName32 = "hongguo-$vn.apk"
$apkName64 = "hongguo-$vn-arm64.apk"
$apkSrc = Join-Path $AppDir 'app\build\outputs\apk\debug\app-debug.apk'
$sha32 = ""; $sha64 = ""
foreach ($target in @('32', '64')) {
    $name = if ($target -eq '64') { $apkName64 } else { $apkName32 }
    Write-Host "构建中（abiTarget=$target）..." -ForegroundColor Cyan
    Push-Location $AppDir
    try {
        & .\gradlew.bat :app:assembleDebug "-PabiTarget=$target"
        if ($LASTEXITCODE -ne 0) { throw "构建失败（abiTarget=$target, exit $LASTEXITCODE）" }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $apkSrc)) { throw "找不到构建产物: $apkSrc" }

    # ---------- 3. 拷包 ----------
    $apkDst = Join-Path $publicDir $name
    Copy-Item -LiteralPath $apkSrc -Destination $apkDst -Force
    $sizeMb = [math]::Round((Get-Item -LiteralPath $apkDst).Length / 1MB, 2)
    Write-Host "APK: public\$name ($sizeMb MB)" -ForegroundColor Green
    $sha = (Get-FileHash -LiteralPath $apkDst -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "SHA-256: $sha"
    if ($target -eq '64') { $sha64 = $sha } else { $sha32 = $sha }
}
# 删掉除本次两个新包之外的旧包（含上个版本的两个包）。
# BUG-116：光删工作区文件不够——旧包是 git 跟踪的发布物，不提交删除，
# 远端仓库与 CDN 上会永久累积历史 APK（按老 URL 仍可下到旧版本）。
# 记下文件名，-Push 时一并 git add（add 已跟踪但已删除的路径 = 暂存删除）。
$deletedOld = @()
$oldFiles = @(Get-ChildItem -LiteralPath $publicDir -Filter 'hongguo-*.apk' |
    Where-Object { $_.Name -ne $apkName32 -and $_.Name -ne $apkName64 })
foreach ($f in $oldFiles) {
    Write-Host "删除旧包 $($f.Name)"
    $deletedOld += $f.Name
    Remove-Item -LiteralPath $f.FullName -Force
}

# ---------- 4. update.json ----------
# apk/sha256 指向 32 位包：旧客户端只认这两个字段，保证它们继续可更新；
# apk64/sha256_64 供 64 位进程的新客户端使用（清单缺失时客户端回落 apk）。

# 沿用旧清单里的 notes / mirrors / logApi（未显式传入时）
$oldNotes = ""; $oldMirrors = @(); $oldLogApi = ""
if (Test-Path -LiteralPath $manifest) {
    try {
        $old = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($old.notes) { $oldNotes = [string]$old.notes }
        if ($old.mirrors) { $oldMirrors = @($old.mirrors) }
        if ($old.logApi) { $oldLogApi = [string]$old.logApi }
    } catch {
        Write-Warning "旧 update.json 解析失败，忽略: $($_.Exception.Message)"
    }
}
if (-not $Notes) { $Notes = $oldNotes }
$mirrorList = if ($Mirrors) { @($Mirrors -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @($oldMirrors) }
$apiValue = if ($LogApi) { $LogApi } else { $oldLogApi }

$obj = [ordered]@{
    versionCode = $vc
    versionName = $vn
    apk         = $apkName32
    notes       = $Notes
    sha256      = $sha32
    apk64       = $apkName64
    sha256_64   = $sha64
    mirrors     = @($mirrorList)
    logApi      = $apiValue
}
$json = $obj | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifest, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已生成 public\update.json" -ForegroundColor Green

# ---------- 5. 可选：提交推送 ----------
if ($Push) {
    Push-Location $releaseDir
    try {
        $addPaths = @("public/$apkName32", "public/$apkName64", "public/update.json")
        foreach ($d in $deletedOld) { $addPaths += "public/$d" }
        git add -- $addPaths
        git commit -m "release: v$vn ($vc)"
        git push
        if ($LASTEXITCODE -ne 0) { throw "git push 失败" }
    } finally {
        Pop-Location
    }
    Write-Host "已推送，等 EdgeOne Pages 自动部署完成即可" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "下一步："
    Write-Host "  git add public/ ; git commit -m 'release: v$vn' ; git push    # 或带 -Push 重跑"
    Write-Host "  或直接： edgeone pages deploy （项目目录选 $releaseDir）"
}
