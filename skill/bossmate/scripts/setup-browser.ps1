param(
  [ValidateSet("edge", "chrome")]
  [string]$Browser = "edge",
  [ValidateRange(1024, 65535)]
  [int]$Port = 9222,
  [string]$Home = ""
)

$ErrorActionPreference = "Stop"
if (-not $Home) {
  $Home = if ($env:BOSSMATE_HOME) { $env:BOSSMATE_HOME } elseif ($env:BOSS_JOB_HOME) { $env:BOSS_JOB_HOME } else { Join-Path $HOME ".bossmate" }
}
$candidates = if ($Browser -eq "edge") {
  @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
} else {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
}

$exe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $exe) { throw "没有找到 $Browser。请先安装 Edge 或 Chrome。" }

$resolvedHome = [IO.Path]::GetFullPath($Home)
$profile = Join-Path $resolvedHome "browser-profile"
New-Item -ItemType Directory -Force -Path $profile | Out-Null

$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--no-default-browser-check",
  "https://www.zhipin.com/"
)
Start-Process -FilePath $exe -ArgumentList $arguments

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 1 | Out-Null
    $ready = $true
    break
  } catch {}
}
if (-not $ready) { throw "浏览器已启动，但调试端口 $Port 没有就绪。" }

[pscustomobject]@{
  browser = $Browser
  port = $Port
  profile = $profile
  login = "请用户只在新打开的专用浏览器中登录 BOSS；不要向 Agent 提供密码、短信码或 Cookie。"
} | ConvertTo-Json
