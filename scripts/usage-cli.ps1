<#
.SYNOPSIS
  Show OpenCode Go usage (5-hour / weekly / monthly windows) for every API key you own.

.DESCRIPTION
  Calls the per-key endpoint GET https://opencode.ai/zen/go/v1/usage and prints each
  window's percentage plus its reset time. One row per API key = one row per account.

  Keys are read from DSH credential files: both the newer format with a `refs:` block
  and the older flat `NAME: sk-...` format. Only the reference name and a masked suffix
  are ever printed; the key itself never reaches the console.

.PARAMETER CredentialFile
  One or more .credentials.yaml paths. Defaults to the DSH desktop harness home and the
  DSH CLI home: %APPDATA%\dsh-desktop\harness plus %USERPROFILE%\.dsh on Windows, and
  $HOME/.dsh on macOS and Linux, where Desktop and the CLI share one home.

.PARAMETER TimeoutSec
  Per-request timeout, default 15.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File usage.ps1
.EXAMPLE
  pwsh -File scripts/usage-cli.ps1
#>
[CmdletBinding()]
param(
    [string[]] $CredentialFile,
    [ValidateRange(3, 120)] [int] $TimeoutSec = 15
)

$ErrorActionPreference = 'Stop'
$endpoint = 'https://opencode.ai/zen/go/v1/usage'

# Resolved after binding: Join-Path throws on a null base, and APPDATA/USERPROFILE are
# unset off Windows.
if (-not $CredentialFile -or $CredentialFile.Count -eq 0) {
    $cliHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($HOME) { $HOME } else { $null }
    $candidates = @()
    if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'dsh-desktop\harness\.credentials.yaml') }
    if ($cliHome) { $candidates += (Join-Path $cliHome '.dsh\.credentials.yaml') }
    $CredentialFile = @($candidates)
}

function Get-Refs {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return @() }

    $rows = @()
    $inRefs = $false
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        if ($line -match '^refs:\s*$') { $inRefs = $true; continue }
        if ($inRefs -and $line -match '^\S') { $inRefs = $false }   # left the refs block

        $name = $null
        $value = $null

        if ($inRefs -and $line -match '^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$') {
            $name = $matches[1]
            $value = $matches[2]
        }
        elseif ($line -match '^([A-Za-z_][A-Za-z0-9_]*):\s*[''"]?(sk-[^\s''"]+)[''"]?\s*$') {
            # older flat credentials file: top-level NAME: sk-...
            $name = $matches[1]
            $value = $matches[2]
        }

        if (-not $name) { continue }
        $value = $value.Trim().Trim("'").Trim('"')
        if ($name -notmatch 'OPENCODE') { continue }
        if ([string]::IsNullOrWhiteSpace($value)) { continue }

        $rows += [pscustomobject]@{ Ref = $name; Secret = $value; Source = $Path }
    }
    return $rows
}

function Get-Masked {
    param([string] $Key)
    if ($Key.Length -lt 8) { return '****' }
    return '****' + $Key.Substring($Key.Length - 4)
}

$refs = @()
foreach ($path in $CredentialFile) { $refs += Get-Refs -Path $path }
$refs = @($refs | Sort-Object -Property Ref, Source -Unique)

if ($refs.Count -eq 0) {
    Write-Warning 'No OpenCode API keys found in the given credential files.'
    return
}

$rows = @()
foreach ($ref in $refs) {
    $row = [ordered]@{
        Account   = $ref.Ref
        Key       = Get-Masked -Key $ref.Secret
        Home      = Split-Path (Split-Path $ref.Source -Parent) -Leaf
        Rolling5h = '-'
        Weekly    = '-'
        Monthly   = '-'
        Reset5h   = '-'
        ResetWeek = '-'
    }
    try {
        $response = Invoke-RestMethod -Uri $endpoint -Method Get -TimeoutSec $TimeoutSec -Headers @{
            Authorization = "Bearer $($ref.Secret)"
            'User-Agent'  = 'dsh-desktop-opencode-usage/1.0'
        }
        $u = $response.usage
        foreach ($window in @('rolling', 'weekly', 'monthly')) {
            $slot = $u.$window
            if ($null -eq $slot) { continue }
            $text = '{0}% ({1})' -f $slot.percent, $slot.status
            switch ($window) {
                'rolling' {
                    $row.Rolling5h = $text
                    if ($slot.resetsAt) { $row.Reset5h = ([datetime]$slot.resetsAt).ToLocalTime().ToString('MM-dd HH:mm') }
                }
                'weekly' {
                    $row.Weekly = $text
                    if ($slot.resetsAt) { $row.ResetWeek = ([datetime]$slot.resetsAt).ToLocalTime().ToString('MM-dd HH:mm') }
                }
                'monthly' { $row.Monthly = $text }
            }
        }
    }
    catch {
        $detail = $_.Exception.Message
        if ($_.ErrorDetails.Message) {
            try { $detail = ($_.ErrorDetails.Message | ConvertFrom-Json).error.message } catch { $detail = $_.ErrorDetails.Message }
        }
        $row.Rolling5h = 'ERROR'
        $row.Weekly = $detail
    }
    $rows += [pscustomobject] $row
}

$rows | Format-Table -AutoSize -Property Account, Key, Home, Rolling5h, Reset5h, Weekly, ResetWeek, Monthly | Out-String -Width 200
