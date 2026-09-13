<#
.SYNOPSIS
  Install (or remove) a DSH plugin package from this repository into a DSH profile.

.DESCRIPTION
  Copies <PluginDir> into <DshHome>\profiles\node_modules\<package name> and writes one
  managed row into <DshHome>\profiles\<ProfileName>\cordis.patch.yml, which is what makes
  the DSH Loader load the plugin and the Web client pick up its browser half.

  The patch file is backed up before every write, and the result is parsed with the
  harness's own YAML parser; a failed parse restores the backup. Re-running the script
  updates the managed row in place instead of appending a second one. A pre-existing row
  for the same package that this script did not write is refused, so a stale copy must be
  removed first (its installer's -Uninstall, or by hand).

.PARAMETER DshHome
  DSH home. Defaults to the DSH Desktop harness home; pass "$env:USERPROFILE\.dsh" for the CLI harness.

.PARAMETER ProfileName
  Profile to patch. Defaults to `web`, the profile the Desktop app boots.

.PARAMETER PluginDir
  Plugin package directory. Defaults to `dsh-opencode-go-usage` at this repository's root.

.PARAMETER Ref
  Optional credential references to sample, one per account row of the usage plugin.
  Omitted, the plugin's own defaults apply. Accepts `-Ref a,b` and `-Ref a b`.

.PARAMETER Uninstall
  Remove the managed row and the installed copy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1 -Ref OPENCODE_API_KEY_1,OPENCODE_API_KEY_2
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $DshHome = (Join-Path $env:APPDATA 'dsh-desktop\harness'),
    [string] $ProfileName = 'web',
    [string] $PluginDir,
    [string[]] $Ref,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not available while parameters bind, so the default is resolved here.
if ([string]::IsNullOrWhiteSpace($PluginDir)) {
    $PluginDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'dsh-opencode-go-usage'
}
# `-File script.ps1 -Ref a,b` binds one string, so split commas here.
$refs = @($Ref | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

if (-not (Test-Path -LiteralPath $PluginDir)) { throw "plugin directory not found: $PluginDir" }
$manifestPath = Join-Path $PluginDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "package.json not found in: $PluginDir" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$packageName = [string]$manifest.name
if ([string]::IsNullOrWhiteSpace($packageName)) { throw "package.json has no name: $manifestPath" }

$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$target = Join-Path $modulesDir $packageName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$beginMarker = "# >>> dsh-plugin: $packageName"
$endMarker = "# <<< dsh-plugin: $packageName"

function Remove-ReparsePointOrDirectory {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType) {
        # A junction must be removed without recursing, or its target is deleted too.
        cmd /c "rd `"$Path`"" | Out-Null
    } else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Write-PatchFile {
    param([string] $Text)

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (Test-Path -LiteralPath $patchPath) {
        Copy-Item -LiteralPath $patchPath -Destination "$patchPath.bak-$stamp" -Force
    }
    [IO.File]::WriteAllText($patchPath, ($Text.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))

    $yamlModule = Join-Path $modulesDir 'yaml'
    if (-not (Test-Path -LiteralPath $yamlModule)) {
        Write-Warning "yaml parser not found at $yamlModule; skipped the post-write validation"
        return
    }
    $probeLines = @(
        'const fs = require("node:fs");'
        'const yaml = require(process.argv[2]);'
        'const document = yaml.parse(fs.readFileSync(process.argv[3], "utf8"));'
        'if (document !== null && document !== undefined && !Array.isArray(document)) { console.error("patch file is not a YAML list"); process.exit(2); }'
        'console.log("patch rows:", document === null || document === undefined ? 0 : document.length);'
    )
    $probePath = Join-Path $env:TEMP 'dsh-plugin-patch-verify.cjs'
    [IO.File]::WriteAllText($probePath, ($probeLines -join "`n"), [Text.UTF8Encoding]::new($false))
    # Resolve node for the validation probe: PATH first, then the DSH Desktop bundled runtime.
    $nodeExe = $null
    $fromPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($fromPath) { $nodeExe = $fromPath.Source }
    if (-not $nodeExe) {
        $candidates = @(
            (Join-Path $env:ProgramFiles 'DSH Desktop\resources\app\node_modules\node\bin\node.exe')
        )
        if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DSH Desktop\resources\app\node_modules\node\bin\node.exe') }
        foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { $nodeExe = $candidate; break } }
    }
    if (-not $nodeExe) {
        Write-Warning 'node was not found (PATH or DSH Desktop bundle); skipped the post-write validation. The backup is kept next to the patch file.'
        return
    }
    & $nodeExe $probePath $yamlModule $patchPath
    $probeExit = $LASTEXITCODE
    Remove-Item $probePath -Force -ErrorAction SilentlyContinue
    if ($probeExit -ne 0) {
        Copy-Item -LiteralPath "$patchPath.bak-$stamp" -Destination $patchPath -Force
        throw 'the patched profile file did not parse; the backup was restored'
    }
    Write-Host "patched $patchPath (backup: cordis.patch.yml.bak-$stamp)"
}

if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile not found: $profileDir (pass -DshHome / -ProfileName)" }

$existing = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllText($patchPath) } else { '' }
$managedPattern = '(?ms)^\s*' + [regex]::Escape($beginMarker) + '.*?' + [regex]::Escape($endMarker) + '\r?\n?'

if ($Uninstall) {
    Remove-ReparsePointOrDirectory -Path $target
    if ([regex]::IsMatch($existing, $managedPattern)) {
        Write-PatchFile -Text ([regex]::Replace($existing, $managedPattern, ''))
    } else {
        Write-Warning "no managed row for $packageName in $patchPath; only the installed copy was removed"
    }
    Write-Host "uninstalled $packageName"
    return
}

# Refuse an unmanaged row for the same package: two rows would load the plugin twice.
if (-not [regex]::IsMatch($existing, $managedPattern)) {
    $unmanaged = '(?m)^\s*name:\s*' + [regex]::Escape("'$packageName'") + '\s*$'
    if ([regex]::IsMatch($existing, $unmanaged)) {
        throw "an unmanaged row for $packageName already exists in $patchPath; remove it (or run the installer that wrote it with -Uninstall) before installing from this repository"
    }
}

Remove-ReparsePointOrDirectory -Path $target
Copy-Item -LiteralPath $PluginDir -Destination $target -Recurse -Force
$fileCount = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object).Count
Write-Host "installed $packageName -> $target ($fileCount files)"

$block = @(
    ''
    "$beginMarker (managed by scripts/Install-DshPlugin.ps1)"
    '- insert:'
    "    - id: $packageName"
    "      name: '$packageName'"
)
if ($refs.Count -gt 0) {
    $block += @('      config:') + @('        refs:') + ($refs | ForEach-Object { "          - $_" })
}
$block += @($endMarker)
$blockText = ($block -join "`n").TrimStart("`n")

if ([regex]::IsMatch($existing, $managedPattern)) {
    Write-PatchFile -Text ([regex]::Replace($existing, $managedPattern, $blockText))
} else {
    $trimmed = $existing.TrimEnd()
    $prefix = if ($trimmed.Length -gt 0) { $trimmed + "`n`n" } else { '' }
    Write-PatchFile -Text ($prefix + $blockText)
}

Write-Host 'Reload the DSH window (or restart the app) if the plugin surface does not appear; profile patches usually reload live.'