<#
  红果TV 发版脚本（EdgeOne Pages 版，替代已作废的 wrangler deploy）

  做的事：
    1. 从 HougTime/app/build.gradle.kts 读 versionCode / versionName
    2. 调 gradlew assembleDebug 构建 APK
    3. 拷到 public/hongguo-<versionName>.apk，删掉 public 下的旧包
    4. 计算 SHA-256，生成 public/update.json（v2 schema）
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

# ---------- 2. 构建 ----------
Write-Host "构建中..." -ForegroundColor Cyan
Push-Location $AppDir
try {
    & .\gradlew.bat :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}

$apkSrc = Join-Path $AppDir 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apkSrc)) { throw "找不到构建产物: $apkSrc" }

# ---------- 3. 拷包、删旧包 ----------
$apkName = "hongguo-$vn.apk"
$apkDst = Join-Path $publicDir $apkName
Copy-Item -LiteralPath $apkSrc -Destination $apkDst -Force
Get-ChildItem -LiteralPath $publicDir -Filter 'hongguo-*.apk' |
    Where-Object { $_.Name -ne $apkName } |
    ForEach-Object { Write-Host "删除旧包 $($_.Name)"; Remove-Item -LiteralPath $_.FullName -Force }
$sizeMb = [math]::Round((Get-Item -LiteralPath $apkDst).Length / 1MB, 2)
Write-Host "APK: public\$apkName ($sizeMb MB)" -ForegroundColor Green

# ---------- 4. update.json ----------
$sha = (Get-FileHash -LiteralPath $apkDst -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "SHA-256: $sha"

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
    apk         = $apkName
    notes       = $Notes
    sha256      = $sha
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
        git add "public/$apkName" "public/update.json"
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
