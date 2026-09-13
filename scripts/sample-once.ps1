<#
.SYNOPSIS
  Append one timestamped OpenCode Go usage sample to a rolling log.

.DESCRIPTION
  Wraps scripts/usage.ps1 so a scheduled task can sample every account every 30 minutes
  and keep a trend of the 5-hour, weekly and monthly windows. Each run appends a local
  timestamp header plus the usage table, so repeated samples read as a time series.

  Only reference names and masked key suffixes are written; the log carries no secret.

.PARAMETER LogPath
  Destination log file. Defaults to %LOCALAPPDATA%\opencode-go-usage\usage.log.

.PARAMETER RotationBytes
  Rotate to <LogPath>.1 once the log reaches this size. Default 1 MiB.

.PARAMETER CredentialFile
  Forwarded to scripts/usage.ps1: which .credentials.yaml files to read.

.PARAMETER TimeoutSec
  Forwarded to scripts/usage.ps1. Default 15.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Record-Usage.ps1
.EXAMPLE
  Get-Content "$env:LOCALAPPDATA\opencode-go-usage\usage.log" -Tail 20
#>
[CmdletBinding()]
param(
    [string] $LogPath = (Join-Path $env:LOCALAPPDATA 'opencode-go-usage\usage.log'),
    [int] $RotationBytes = 1MB,
    [string[]] $CredentialFile,
    [ValidateRange(3, 120)] [int] $TimeoutSec = 15
)

$ErrorActionPreference = 'Stop'

$reader = Join-Path $PSScriptRoot 'usage.ps1'
if (-not (Test-Path -LiteralPath $reader)) { throw "usage reader not found next to this script: $reader" }

$directory = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }

if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -ge $RotationBytes) {
    Move-Item -LiteralPath $LogPath -Destination ($LogPath + '.1') -Force
}

$readerArguments = @{ TimeoutSec = $TimeoutSec }
if ($CredentialFile) { $readerArguments.CredentialFile = $CredentialFile }

$table = (& $reader @readerArguments 2>&1 | Out-String).Trim()

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
$block = @('', "===== $stamp =====", $table)

Add-Content -LiteralPath $LogPath -Value $block -Encoding UTF8
$block | ForEach-Object { $_ }