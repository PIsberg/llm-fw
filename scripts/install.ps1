# llm-fw one-step installer for Windows (PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/PIsberg/llm-fw/main/scripts/install.ps1 | iex
#
# Or invoke with flags:
#   .\scripts\install.ps1 [-ProxyOnly] [-NoStart] [-Judge] [-NoJudge] [-Version <ver>]
#
# Environment overrides:
#   $env:LLM_FW_PKG         Package spec passed to `npm install -g` (default: llm-fw)
#   $env:LLM_FW_PROXY_ONLY  Set to 1 to skip the sinkhole (--proxy-only)
#   $env:LLM_FW_NO_START    Set to 1 to skip starting the proxy after setup

param(
  [switch]$ProxyOnly,
  [switch]$Sinkhole,
  [switch]$Judge,
  [switch]$NoJudge,
  [switch]$NoStart,
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$Pkg = if ($Version) { "llm-fw@$Version" } elseif ($env:LLM_FW_PKG) { $env:LLM_FW_PKG } else { "llm-fw" }
$SkipStart = $NoStart.IsPresent -or ($env:LLM_FW_NO_START -eq "1")
$UseProxyOnly = $ProxyOnly.IsPresent -or ($env:LLM_FW_PROXY_ONLY -eq "1")

# 1. Verify Node.js >= 22 and npm.
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  Write-Error "llm-fw requires Node.js 22 or newer (node was not found on PATH). Install with: winget install OpenJS.NodeJS.LTS"
  exit 1
}

$NodeVer = (& node -v 2>$null | Out-String).Trim()
$NodeMajor = if ($NodeVer -match '^v?(\d+)') { [int]$Matches[1] } else { 0 }
if ($NodeMajor -lt 22) {
  Write-Error "llm-fw requires Node.js 22+ (found $NodeVer). Upgrade with: winget upgrade OpenJS.NodeJS.LTS"
  exit 1
}

$NpmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $NpmCmd) {
  Write-Error "llm-fw requires npm, which was not found alongside node."
  exit 1
}

# 2. Install llm-fw globally (--ignore-scripts: llm-fw needs no install scripts).
Write-Host "==> Installing $Pkg..."
& npm install -g --ignore-scripts $Pkg
if ($LASTEXITCODE -ne 0) {
  Write-Error "npm install -g failed with exit code $LASTEXITCODE."
  exit $LASTEXITCODE
}

# 3. Locate the installed llm-fw binary even if npm's global prefix is not on PATH.
$NpmPrefix = (& npm prefix -g).Trim()
$LlmFwCmd = Get-Command llm-fw -ErrorAction SilentlyContinue
$LlmFwBin = if ($LlmFwCmd) {
  $LlmFwCmd.Source
} elseif (Test-Path (Join-Path $NpmPrefix "llm-fw.cmd")) {
  Join-Path $NpmPrefix "llm-fw.cmd"
} elseif (Test-Path (Join-Path $NpmPrefix "bin\llm-fw")) {
  Join-Path $NpmPrefix "bin\llm-fw"
} else {
  Write-Error "llm-fw binary not found after install (checked PATH and $NpmPrefix)."
  exit 1
}

# 4. Run `llm-fw setup`.
$SetupArgs = @("setup")
if ($UseProxyOnly) { $SetupArgs += "--proxy-only" }
if ($Sinkhole.IsPresent) { $SetupArgs += "--sinkhole" }
if ($Judge.IsPresent) {
  $SetupArgs += "--judge"
} else {
  $SetupArgs += "--no-judge"
}

Write-Host "==> Running llm-fw setup..."
& $LlmFwBin @SetupArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

# Refresh proxy/CA variables into the current PowerShell session so open terminals work immediately.
foreach ($VarName in @("HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS")) {
  $UserVal = [Environment]::GetEnvironmentVariable($VarName, "User")
  if ($UserVal) {
    Set-Item -Path "Env:$VarName" -Value $UserVal
  }
}

# 5. Start the proxy.
if (-not $SkipStart) {
  Write-Host "==> Starting llm-fw..."
  & $LlmFwBin start
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
