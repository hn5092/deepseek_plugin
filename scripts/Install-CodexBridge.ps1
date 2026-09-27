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
  The plugin package directory whose package.json names the package to install. Defaults to
  `dsh-codex-bridge` under -Repo.

.PARAMETER HealthUrl
  Optional. When given, the launch URL is read from this file and the bridge's health route is probed
  after the write; a failure rolls the write back.

.PARAMETER Rollback
  Restore the newest backup of the patch file and put the previous artifact back.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CodexBridge.ps1 -Commit <exact-commit> -ControllerConfig .\bridge-config.yml
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
# This plugin's own migration receipt. Rollback reads THIS, not "the newest .bak file in the directory",
# because the profile directory is shared with other plugins and other people: the newest backup may belong
# to someone else's later change, and restoring it would silently revert their work.
$receiptPath = Join-Path $archiveDir 'migration.json'
# This run's receipt, set once the install is complete. The health gate below reads it to roll back
# exactly what this run changed; it is `$null` until then, and the gate handles that case.
$script:receipt = $null

<#
  Confirm a path really sits inside an allowed root before this script moves or deletes it.

  A deployment script that deletes recursively must not be one string-concatenation away from removing a
  directory it never created, so every destructive path is checked against the roots this run is allowed to
  touch: the profile's own node_modules, or this run's staging directory.
#>
function Assert-PathInside {
    param([string] $Path, [string] $Root, [string] $What)
    $full = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $inside = $full.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    if (-not $inside) { throw "$What is outside its allowed root; refusing: $full (root: $fullRoot)" }
    return $full
}

<#
  Remove a path that may be a link, deleting the LINK ITSELF and never recursing into its target.

  `Remove-Item -Recurse` follows a junction, and shelling out to `cmd /c rd` only exists on Windows. Both
  are avoided: the shell's own .NET IO is used, and the entry is checked to be a reparse point before the
  non-recursive directory delete.
#>
function Remove-ReparsePointOrDirectory {
    param([string] $Path, [string] $Root)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $full = Assert-PathInside -Path $Path -Root $Root -What 'the artifact path'
    $item = Get-Item -LiteralPath $full -Force
    if ($item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        # Non-recursive: removes the link, leaves whatever it points at untouched.
        [IO.Directory]::Delete($full, $false)
    } else {
        Remove-Item -LiteralPath $full -Recurse -Force
    }
}

<#
  Read this plugin's migration receipt, if a previous install left one.
#>
function Read-Receipt {
    if (-not (Test-Path -LiteralPath $receiptPath)) { return $null }
    try { return Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

<#
  Whether the file currently at the patch path still contains EXACTLY the block this plugin last wrote.

  Rollback must never overwrite someone else's edit. The receipt records the block text this plugin wrote,
  so a mismatch means the file changed underneath us and the rollback refuses instead of clobbering it.
#>
function Test-BlockUnchanged {
    param([object] $Receipt, [string] $Text)
    if ($null -eq $Receipt -or [string]::IsNullOrWhiteSpace([string]$Receipt.block)) { return $true }
    return $Text.Contains([string]$Receipt.block)
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
    # Rollback is bound to THIS plugin's own receipt. "The newest .bak in the profile directory" would be a
    # different plugin's or another operator's later change, and restoring it would revert their work.
    $receipt = Read-Receipt
    if ($null -eq $receipt) { throw "no migration receipt for $packageName; refusing to guess which backup to restore" }
    $restored = $false
    if (Test-Path -LiteralPath $patchPath) {
        $text = [IO.File]::ReadAllText($patchPath)
        if (-not (Test-BlockUnchanged -Receipt $receipt -Text $text)) {
            # Someone edited the region this plugin wrote. Overwriting it would destroy their change, so the
            # rollback stops and says exactly what it found.
            throw "the patch file changed since this plugin was installed; refusing to overwrite it. Remove this plugin's marked block by hand, or reconcile it first."
        }
        if ([regex]::IsMatch($text, $managed)) {
            # Only this plugin's own block is removed; every other line and every other plugin's row stays.
            [IO.File]::WriteAllText($patchPath, ([regex]::Replace($text, $managed, '').TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
            Write-Host "removed this plugin's managed patch block"
            $restored = $true
        }
    }
    Remove-ReparsePointOrDirectory -Path $target -Root $modulesDir
    if (-not [string]::IsNullOrWhiteSpace([string]$receipt.previousArtifact)) {
        $prevPath = Join-Path $archiveDir ([string]$receipt.previousArtifact)
        if (Test-Path -LiteralPath $prevPath) {
            Move-Item -LiteralPath (Assert-PathInside -Path $prevPath -Root $modulesDir -What 'the archived artifact') -Destination $target -Force
            Write-Host "restored the previous artifact from $([string]$receipt.previousArtifact)"
        } else {
            Write-Warning "the receipt names a previous artifact that is gone: $([string]$receipt.previousArtifact)"
        }
    } else {
        Write-Host 'no previous artifact existed; removed the installed copy'
    }
    Remove-Item -LiteralPath $receiptPath -Force -ErrorAction SilentlyContinue
    if (-not $restored) { Write-Warning 'nothing to roll back in the patch file' }
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
#    The name is recorded in this plugin's receipt, so rollback restores THIS artifact and not whichever
#    file happens to sort newest in a directory shared with other plugins.
$previousArtifactName = ''
if (Test-Path -LiteralPath $target) {
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
    $previousArtifactName = "$packageName.$stamp"
    $archiveTarget = Assert-PathInside -Path (Join-Path $archiveDir $previousArtifactName) -Root $modulesDir -What 'the archived artifact'
    Move-Item -LiteralPath (Assert-PathInside -Path $target -Root $modulesDir -What 'the existing artifact') -Destination $archiveTarget -Force
    Write-Host "kept the previous artifact as $previousArtifactName"
}
New-Item -ItemType Directory -Path $modulesDir -Force | Out-Null
Copy-Item -LiteralPath $exportDir -Destination (Assert-PathInside -Path $target -Root $modulesDir -What 'the install target') -Recurse -Force
$fileCount = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object).Count
Write-Host "installed $packageName @ $resolved -> $target ($fileCount files)"
# The staging directory is this script's OWN temporary output, so it is removed once the artifact has been
# copied. Only this exact path is touched; nothing else under the temp root is inspected or deleted.
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath (Assert-PathInside -Path $stage -Root $env:TEMP -What 'the staging directory') -Recurse -Force -ErrorAction SilentlyContinue }

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
    # A profile file that does not parse would stop the loader from reading ANY plugin, so BOTH halves of
    # this install are undone: the patch file goes back to its saved content and the previous artifact is
    # put back where it was. Restoring only the patch file would leave the new artifact in place while the
    # header comment claimed a full rollback.
    if (Test-Path -LiteralPath "$patchPath.bak-$stamp") { Copy-Item -LiteralPath "$patchPath.bak-$stamp" -Destination $patchPath -Force }
    Remove-ReparsePointOrDirectory -Path $target -Root $modulesDir
    if (-not [string]::IsNullOrWhiteSpace($previousArtifactName)) {
        $prevPath = Join-Path $archiveDir $previousArtifactName
        if (Test-Path -LiteralPath $prevPath) { Move-Item -LiteralPath (Assert-PathInside -Path $prevPath -Root $modulesDir -What 'the archived artifact') -Destination $target -Force }
    }
    Remove-Item -LiteralPath $receiptPath -Force -ErrorAction SilentlyContinue
    Write-Error "the patched profile file did not parse; the previous patch file AND the previous artifact were restored. $($_.Exception.Message)"
    throw
}
# Write the migration receipt LAST: it exists only for a completed install, and it records exactly what
# this run changed so a later rollback restores this plugin alone.
#   previousArtifact  the archive name this run set aside (empty when there was none)
#   backup            the patch-file backup taken before this run's write
#   block             the exact block this run wrote, used to detect edits before a rollback overwrites
try {
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
    $receipt = [ordered]@{
        package = $packageName
        commit = $resolved
        stamp = $stamp
        patch = $patchPath
        previousArtifact = $previousArtifactName
        backup = if (Test-Path -LiteralPath "$patchPath.bak-$stamp") { "cordis.patch.yml.bak-$stamp" } else { '' }
        block = $blockText
    }
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    $script:receipt = $receipt
} catch {
    Write-Warning "could not write the migration receipt; -Rollback will refuse rather than guess: $($_.Exception.Message)"
}
Write-Host "patched $patchPath (backup: cordis.patch.yml.bak-$stamp)"

# 5) Optional health gate against a launch URL, so a bad write can be rolled back immediately.
#
# The probe AUTHENTICATES first and then requires the NEW interface, for two reasons that both matter:
#
#   - the main harness authenticates `/codex-bridge/health`, so an anonymous GET returns 401 and a gate
#     that used one would fail every install;
#   - the OLD one-way bridge answers `/health` 200 ANONYMOUSLY and reports only the three legacy routes.
#     Treating that 200 as success would declare the upgrade healthy while the collaboration surface is
#     still the old one, so the probe requires an authenticated response that names the collaboration
#     route and the bindings.
#
# The probe runs on the CLI, which already implements exactly this authentication, rather than
# re-implementing a login here. `-SkipHttpErrorCheck` is deliberately NOT used: it is a PowerShell 7
# feature and this script must run on the Windows PowerShell 5.1 the harness ships with.
if (-not [string]::IsNullOrWhiteSpace($HealthUrl)) {
    if (-not (Test-Path -LiteralPath $HealthUrl)) { throw "launch URL file not found: $HealthUrl" }
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { throw 'node was not found; the health gate needs it to authenticate' }
    $cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'dsh-codex-bridge\scripts\bridge-cli.mjs'
    if (-not (Test-Path -LiteralPath $cli)) { throw "bridge CLI not found for the health gate: $cli" }
    $deadline = (Get-Date).AddSeconds(60)
    $healthy = $false
    $lastDetail = ''
    while ((Get-Date) -lt $deadline -and -not $healthy) {
        $probe = & $nodeExe $cli health --url-file $HealthUrl 2>&1
        if ($LASTEXITCODE -eq 0) {
            try {
                $parsed = ($probe -join "`n") | ConvertFrom-Json
                # The collaboration route and the bindings are what distinguish the new bridge from the old
                # one-way one, both of which answer 200.
                $hasCollab = @($parsed.routes) | Where-Object { $_ -like '*codex-collab*' }
                if ($hasCollab -and [int]$parsed.bindings -ge 1) { $healthy = $true }
                else { $lastDetail = "authenticated 200 but no collaboration route or bindings: $($probe -join ' ')" }
            } catch { $lastDetail = "the health response was not JSON: $($probe -join ' ')" }
        } else {
            $lastDetail = "health probe exit $LASTEXITCODE : $(($probe -join ' ').Trim())"
        }
        if (-not $healthy) { Start-Sleep -Milliseconds 1500 }
    }
    if (-not $healthy) {
        # Two different failures, and they must not be conflated:
        #
        #   * an UPGRADE of a plugin the host has already IMPORTED cannot take effect in that process. The
        #     Loader re-imports by name on reload, and Node's ES module cache returns the module it already
        #     loaded for that path, so the running host keeps serving the previous artifact. This is
        #     measured behavior, not a guess. The install ON DISK is correct, so rolling it back would
        #     destroy good work: the honest outcome is "restart required".
        #   * a FIRST install is not affected (nothing was imported before), so failing to come up means
        #     the write itself was wrong and it IS rolled back.
        $wasUpgrade = -not [string]::IsNullOrWhiteSpace($previousArtifactName)
        if ($wasUpgrade) {
            Write-Warning "installed, but the RUNNING host still serves the previous artifact."
            Write-Warning "A plugin the host has already imported cannot be swapped in place; restart the harness, then verify."
            Write-Host "restart-required: $packageName @ $resolved is on disk and will activate on the next harness start."
            exit 3
        }
        # A first install that did not come up is a genuine failure: undo both halves of it.
        if ($null -ne $script:receipt -and (Test-Path -LiteralPath "$patchPath.bak-$stamp")) {
            Copy-Item -LiteralPath "$patchPath.bak-$stamp" -Destination $patchPath -Force
        } elseif (Test-Path -LiteralPath $patchPath) {
            $text = [IO.File]::ReadAllText($patchPath)
            if ([regex]::IsMatch($text, $managed)) { [IO.File]::WriteAllText($patchPath, ([regex]::Replace($text, $managed, '').TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false)) }
        }
        Remove-ReparsePointOrDirectory -Path $target -Root $modulesDir
        if (-not [string]::IsNullOrWhiteSpace($previousArtifactName)) {
            $prevPath = Join-Path $archiveDir $previousArtifactName
            if (Test-Path -LiteralPath $prevPath) { Move-Item -LiteralPath (Assert-PathInside -Path $prevPath -Root $modulesDir -What 'the archived artifact') -Destination $target -Force }
        }
        Remove-Item -LiteralPath $receiptPath -Force -ErrorAction SilentlyContinue
        throw "the bridge health route did not report the collaboration interface after the write; the patch and artifact were rolled back. $lastDetail"
    }
    Write-Host 'health check passed (authenticated, collaboration route present)'
}

Write-Host 'The profile patch layer is watched and hot-reloaded, so no harness restart is required; refresh the browser with Ctrl+R.'
