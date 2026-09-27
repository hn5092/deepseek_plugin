<#
.SYNOPSIS
  Install, verify, or roll back the codex-bridge plugin in a DSH profile, reversibly.

.DESCRIPTION
  Follows the same discipline as Install-DshPlugin.ps1: the plugin package is copied into
  <Home>\profiles\node_modules\<name> and one delimited managed block is written into the profile's
  cordis.patch.yml, which is the file the harness watches and hot-reloads. The difference is the
  configuration: the bridge needs bindings, an inbox root and a store root rather than credential
  references.

  Every run is reversible and non-destructive by construction:

    * the plugin is copied from an EXACT Git commit (`-Commit`), verified with `git rev-parse`, so the
      installed artifact corresponds to a reviewable revision rather than a moving working tree;
    * the package is staged from a clean export of that commit, so no logs, test scratch or local
      build output travel with it;
    * the previous patch file is backed up before any write, and the patched YAML is re-parsed before
      the write is kept — a file that does not parse is restored from the backup;
    * only the block delimited by this plugin's own markers is touched: other plugins' rows and every
      unrelated line are preserved byte for byte;
    * a previous artifact is MOVED aside rather than deleted, and a directory this script did not
      create is never removed;
    * `-Rollback` restores the newest backup and the previous artifact, or removes what this script
      installed when there was no previous artifact.

.PARAMETER DshHome
  DSH home. Defaults to $env:DSH_HOME, else $HOME\.dsh (the CLI harness home).

.PARAMETER Profile
  Profile to patch. Defaults to the profile that exists: web, else desktop, else the only one.

.PARAMETER Repo
  The plugin repository root. Defaults to the parent of this script's own directory.

.PARAMETER Commit
  Exact Git commit to install from. Required unless -Rollback.

.PARAMETER ControllerConfig
  Path to a YAML fragment holding the `bindings`, `inboxRoot` and `storeRoot` lines, inserted verbatim
  under the row's `config:`. Keeping it in a file means credential REFERENCES (never values) stay out of
  a command line and this script invents no configuration of its own.

.PARAMETER PackageRoot
  Where the package name is read from. Defaults to the plugin directory named in the config fragment's
  sibling `dsh-codex-bridge` folder.

.PARAMETER HealthUrl
  Optional. When given, the launch URL is read from this file and the bridge's health route is probed
  after the write; a failure rolls the write back.

.PARAMETER Rollback
  Restore the newest backup of the patch file and put the previous artifact back.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CodexBridge.ps1 -Commit 4fdacdc -ControllerConfig .\bridge-config.yml
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CodexBridge.ps1 -Rollback
#>
[CmdletBinding()]
param(
    [string] $DshHome,
    [string] $Profile,
    [string] $Repo,
    [string] $Commit,
    [string] $ControllerConfig,
    [string] $PackageRoot,
    [string] $HealthUrl,
    [switch] $Rollback
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
}
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = Split-Path -Parent $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($PackageRoot)) { $PackageRoot = Join-Path $Repo 'dsh-codex-bridge' }
if (-not (Test-Path -LiteralPath $PackageRoot)) { throw "plugin package not found: $PackageRoot" }
$manifestPath = Join-Path $PackageRoot 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "package.json not found in: $PackageRoot" }
$packageName = [string](Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).name
if ([string]::IsNullOrWhiteSpace($packageName)) { throw "package.json has no name: $manifestPath" }

# The patch layer the harness WATCHES and hot-reloads is the profile's own cordis.patch.yml.
if ([string]::IsNullOrWhiteSpace($Profile)) {
    $profilesRoot = Join-Path $DshHome 'profiles'
    foreach ($candidate in @('web', 'desktop')) {
        if (Test-Path -LiteralPath (Join-Path $profilesRoot $candidate)) { $Profile = $candidate; break }
    }
    if ([string]::IsNullOrWhiteSpace($Profile) -and (Test-Path -LiteralPath $profilesRoot)) {
        $found = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'node_modules' })
        if ($found.Count -eq 1) { $Profile = $found[0].Name }
    }
    if ([string]::IsNullOrWhiteSpace($Profile)) { throw "cannot pick a profile under $profilesRoot; pass -Profile" }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$target = Join-Path $modulesDir $packageName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$beginMarker = "# >>> dsh-plugin: $packageName"
$endMarker = "# <<< dsh-plugin: $packageName"
$managed = "(?ms)^\s*" + [regex]::Escape($beginMarker) + ".*?" + [regex]::Escape($endMarker) + "\r?\n?"
$archiveDir = Join-Path $modulesDir ".$packageName-artifacts"

<#
  Remove a path that may be a junction, without recursing into its target.
#>
function Remove-ReparsePointOrDirectory {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType) {
        if ($IsWindows -or $env:OS -eq 'Windows_NT') { cmd /c "rd `"$Path`"" | Out-Null }
        else { [IO.Directory]::Delete($Path, $false) }
    } else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

<#
  Par-parse the patched YAML before keeping the write, using the harness's own yaml module.
  Returns nothing; throws when the file does not parse so the caller can restore the backup.
#>
function Assert-YamlParses {
    param([string] $Path)
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { Write-Warning 'node not found; skipped the post-write parse check'; return }
    # Resolve js-yaml from the harness installation, since the profile copy may not carry it.
    $candidates = @(
        (Join-Path $DshHome 'profiles\node_modules\js-yaml'),
        (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\js-yaml')
    )
    $yamlModule = $null
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath (Join-Path $candidate 'index.js')) { $yamlModule = Join-Path $candidate 'index.js'; break } }
    if (-not $yamlModule) { Write-Warning 'yaml parser not found; skipped the post-write parse check'; return }
    $probePath = Join-Path $env:TEMP "dsh-patch-probe-$([guid]::NewGuid().ToString('N')).mjs"
    # The module specifier must be a file:// URL: a bare Windows path is read as a URL with scheme "c:".
    $moduleUrl = ([Uri]$yamlModule).AbsoluteUri
    $targetUrl = ([Uri](Resolve-Path -LiteralPath $Path).Path).AbsoluteUri
    $probe = @"
import fs from 'node:fs';
import yaml from '$moduleUrl';
const text = fs.readFileSync(new URL('$targetUrl'), 'utf8');
yaml.load(text);
console.log('ok');
"@
    Set-Content -LiteralPath $probePath -Value $probe -Encoding UTF8
    try {
        & $nodeExe $probePath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "the patched profile file did not parse: $Path" }
    } finally { Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue }
}

if ($Rollback) {
    $restored = $false
    $backups = @(Get-ChildItem -LiteralPath $profileDir -Filter 'cordis.patch.yml.bak-*' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    if ($backups.Count -gt 0) {
        Copy-Item -LiteralPath $backups[0].FullName -Destination $patchPath -Force
        Write-Host "restored the patch file from $($backups[0].Name)"
        $restored = $true
    } else {
        # No backup: remove only this plugin's managed block, leaving every other line untouched.
        if (Test-Path -LiteralPath $patchPath) {
            $text = [IO.File]::ReadAllText($patchPath)
            if ([regex]::IsMatch($text, $managed)) {
                [IO.File]::WriteAllText($patchPath, ([regex]::Replace($text, $managed, '').TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
                Write-Host "removed this plugin's managed patch block (no backup existed)"
                $restored = $true
            }
        }
    }
    $previous = @(Get-ChildItem -LiteralPath $archiveDir -Filter "$packageName.*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1)
    if ($previous.Count -gt 0) {
        Remove-ReparsePointOrDirectory -Path $target
        Move-Item -LiteralPath $previous[0].FullName -Destination $target -Force
        Write-Host "restored the previous artifact from $($previous[0].Name)"
    } else {
        Remove-ReparsePointOrDirectory -Path $target
        Write-Host 'no previous artifact existed; removed the installed copy'
    }
    if (-not $restored) { Write-Warning 'nothing to roll back' }
    Write-Host 'rollback complete'
    return
}

if ([string]::IsNullOrWhiteSpace($Commit)) { throw '-Commit is required (the exact Git commit to install)' }
if ([string]::IsNullOrWhiteSpace($ControllerConfig)) { throw '-ControllerConfig is required (a YAML fragment with the row''s config)' }
if (-not (Test-Path -LiteralPath $ControllerConfig)) { throw "controller config not found: $ControllerConfig" }

# 1) Resolve the exact commit, so the artifact is a reviewable revision and not a working tree.
Push-Location -LiteralPath $Repo
try {
    $resolved = (& git rev-parse --verify "$Commit^{commit}" 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolved)) { throw "not a valid commit in $Repo : $Commit" }
    $resolved = $resolved.Trim()
    $dirty = (& git status --porcelain -- $packageName)
    if (-not [string]::IsNullOrWhiteSpace(($dirty -join ''))) {
        Write-Warning "the working tree has uncommitted changes under $packageName; the COMMIT is what gets installed"
    }
} finally { Pop-Location }

# 2) Stage a clean export of that commit: no logs, no test scratch, no local build output.
#
# `git archive <commit>:<dir>` extracts that directory's CONTENTS at the archive root, so they are
# extracted into a directory named after the package rather than a nested one.
$stage = Join-Path $env:TEMP "dsh-bridge-stage-$stamp"
$exportDir = Join-Path $stage $packageName
New-Item -ItemType Directory -Path $exportDir -Force | Out-Null
Push-Location -LiteralPath $Repo
try {
    $archive = Join-Path $stage 'pkg.tar'
    & git archive --format=tar --output=$archive "$resolved`:$packageName"
    if ($LASTEXITCODE -ne 0) { throw "git archive failed for $resolved`:$packageName" }
    & tar -xf $archive -C $exportDir
    if ($LASTEXITCODE -ne 0) { throw 'could not extract the staged archive' }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath (Join-Path $exportDir 'package.json'))) {
    # Nothing can be installed from this commit; the staging directory is this script's own output and is
    # removed before failing so a failed attempt leaves no residue.
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    throw "the commit did not contain $packageName as a package"
}
# Tests are part of the source of truth but are not operational payload; a deployment carries the plugin only.
Get-ChildItem -LiteralPath $exportDir -Recurse -File -Filter '*.test.mjs' -ErrorAction SilentlyContinue | Remove-Item -Force

# 3) Keep the previous artifact instead of deleting it, so a rollback has something to restore.
if (Test-Path -LiteralPath $target) {
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
    Move-Item -LiteralPath $target -Destination (Join-Path $archiveDir "$packageName.$stamp") -Force
    Write-Host "kept the previous artifact as $packageName.$stamp"
}
New-Item -ItemType Directory -Path $modulesDir -Force | Out-Null
Copy-Item -LiteralPath $exportDir -Destination $target -Recurse -Force
$fileCount = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object).Count
Write-Host "installed $packageName @ $resolved -> $target ($fileCount files)"
# The staging directory is this script's OWN temporary output, so it is removed once the artifact has been
# copied. Only this exact path is touched; nothing else under the temp root is inspected or deleted.
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

# 4) Write one managed block, preserving every unrelated line and every other plugin's row.
$configLines = @(Get-Content -LiteralPath $ControllerConfig -Encoding UTF8 | Where-Object { $_.Trim().Length -gt 0 })
$block = @(
    ''
    "$beginMarker (managed by scripts/Install-CodexBridge.ps1 @ $resolved)"
    '- insert:'
    "    - id: $packageName"
    "      name: '$packageName'"
    '      config:'
) + ($configLines | ForEach-Object { "        $($_.TrimEnd())" }) + @(
    $endMarker
)
$blockText = ($block -join "`n").TrimStart("`n")

$existing = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllText($patchPath) } else { '' }
$effective = (($existing -split "`r?`n") | ForEach-Object { ($_ -replace '#.*$', '').Trim() } | Where-Object { $_ }) -join ''
if ($effective -eq '[]' -or $effective -eq '') {
    $existing = [regex]::Replace($existing, '(?m)^\s*\[\s*\]\s*\r?\n?', '')
}
$updated = if ([regex]::IsMatch($existing, $managed)) { [regex]::Replace($existing, $managed, $blockText) } else { $existing.TrimEnd() + "`n" + $blockText + "`n" }

if (Test-Path -LiteralPath $patchPath) { Copy-Item -LiteralPath $patchPath -Destination "$patchPath.bak-$stamp" -Force }
[IO.File]::WriteAllText($patchPath, $updated, [Text.UTF8Encoding]::new($false))
try {
    Assert-YamlParses -Path $patchPath
} catch {
    # A profile file that does not parse would stop the loader from reading ANY plugin, so the backup is
    # restored immediately and this plugin's artifact is put back as it was.
    if (Test-Path -LiteralPath "$patchPath.bak-$stamp") { Copy-Item -LiteralPath "$patchPath.bak-$stamp" -Destination $patchPath -Force }
    Write-Error "the patched profile file did not parse; the previous patch file was restored unchanged. $($_.Exception.Message)"
    throw
}
Write-Host "patched $patchPath (backup: cordis.patch.yml.bak-$stamp)"

# 5) Optional health gate against a launch URL, so a bad write can be rolled back immediately.
if (-not [string]::IsNullOrWhiteSpace($HealthUrl)) {
    if (-not (Test-Path -LiteralPath $HealthUrl)) { throw "launch URL file not found: $HealthUrl" }
    $bytes = [IO.File]::ReadAllBytes($HealthUrl)
    $text = if ($bytes.Length -gt 1 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) { [Text.Encoding]::Unicode.GetString($bytes) } else { [Text.Encoding]::UTF8.GetString($bytes) }
    $match = [regex]::Matches($text, 'http://(?:127\.0\.0\.1|localhost|\[::1\]):\d+/\?[^\s)]+')
    if ($match.Count -eq 0) { throw "no loopback launch URL in $HealthUrl" }
    $launch = $match[$match.Count - 1].Value
    $origin = ([Uri]$launch).GetLeftPart([UriPartial]::Authority)
    $deadline = (Get-Date).AddSeconds(60)
    $healthy = $false
    while ((Get-Date) -lt $deadline -and -not $healthy) {
        try {
            $response = Invoke-WebRequest -Uri "$origin/codex-bridge/health" -MaximumRedirection 0 -SkipHttpErrorCheck -TimeoutSec 10
            if ($response.StatusCode -eq 200) { $healthy = $true }
        } catch { }
        if (-not $healthy) { Start-Sleep -Milliseconds 1000 }
    }
    if (-not $healthy) {
        # Exact rollback of THIS plugin only: restore the backup and the previous artifact.
        if (Test-Path -LiteralPath "$patchPath.bak-$stamp") { Copy-Item -LiteralPath "$patchPath.bak-$stamp" -Destination $patchPath -Force }
        Remove-ReparsePointOrDirectory -Path $target
        $previous = @(Get-ChildItem -LiteralPath $archiveDir -Filter "$packageName.*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1)
        if ($previous.Count -gt 0) { Move-Item -LiteralPath $previous[0].FullName -Destination $target -Force }
        throw 'the bridge health route did not answer after the write; the patch and artifact were rolled back'
    }
    Write-Host 'health check passed'
}

Write-Host 'The profile patch layer is watched and hot-reloaded, so no harness restart is required; refresh the browser with Ctrl+R.'
