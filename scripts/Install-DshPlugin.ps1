<#
.SYNOPSIS
  Install (or remove) a DSH plugin package from this repository into a DSH profile.

.DESCRIPTION
  Copies the plugin package into <Home>\profiles\node_modules\<package name> and writes one
  managed row into the profile patch layer <Home>\profiles\<Profile>\cordis.patch.yml,
  which is what makes the DSH Loader load the plugin and the Web client pick up its browser
  half. The package name is read from the plugin's own package.json, so this installer is
  not tied to one plugin.

  The copy under profiles\node_modules is the installed artifact; the repository folder
  stays the single source of truth, so re-run this script after editing the plugin. The
  patch file is backed up and the resulting YAML is parsed before the write is kept; a
  pre-existing unmanaged row for the same package is replaced by the managed block, and
  the managed block is what -Uninstall removes.

.PARAMETER DshHome
  DSH home. Defaults to the DSH Desktop harness home: %APPDATA%\dsh-desktop\harness on
  Windows, $HOME/.dsh on macOS and Linux, where Desktop and the CLI share it.

.PARAMETER Profile
  Profile to patch. Defaults to the profile that exists: `web` (the Windows Desktop
  build), else `desktop` (the macOS Desktop build), else the only profile present.

.PARAMETER PluginDir
  Plugin package directory. Defaults to `plugin` next to this script when it exists (the
  Skill layout), else `dsh-opencode-go-usage` at the repository root. The package name comes
  from that directory's package.json, so any plugin in this repository can be installed.

.PARAMETER Ref
  Credential references to sample, one per account row.

.PARAMETER Uninstall
  Remove the managed patch block and the installed copy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1 -PluginDir dsh-session-pins
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DshPlugin.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $DshHome,
    [string] $Profile,
    [string] $PluginDir,
    [string[]] $Ref = @(
        'OPENCODE_API_KEY_1',
        'OPENCODE_API_KEY_2',
        'OPENCODE_API_KEY_3',
        'OPENCODE_API_KEY_4'
    ),
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    # DSH Desktop on Windows keeps its harness home under %APPDATA%; on macOS and
    # Linux both Desktop and the CLI use $HOME/.dsh.
    $DshHome = if ($env:APPDATA) { Join-Path $env:APPDATA 'dsh-desktop\harness' } else { Join-Path $HOME '.dsh' }
}

# As a Skill this script sits next to <skill>/plugin; as a plain checkout the plugin is a
# folder at the repository root. Take whichever exists, or the explicit -PluginDir.
if ([string]::IsNullOrWhiteSpace($PluginDir)) {
    $PluginDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin'
    if (-not (Test-Path -LiteralPath $PluginDir)) {
        $PluginDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'dsh-opencode-go-usage'
    }
}
if (-not (Test-Path -LiteralPath $PluginDir)) { throw "plugin directory not found: $PluginDir" }
$manifestPath = Join-Path $PluginDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "package.json not found in: $PluginDir" }
$packageName = [string](Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).name
if ([string]::IsNullOrWhiteSpace($packageName)) { throw "package.json has no name: $manifestPath" }
# Keyed by package name, so the PowerShell and POSIX installers recognize each other's rows.
$rowId = $packageName
$beginMarker = "# >>> dsh-plugin: $packageName"
$endMarker = "# <<< dsh-plugin: $packageName"

# The profile name is not portable: the Windows Desktop build boots `web`, the macOS
# Desktop build boots `desktop`, and a CLI-only home may hold either. Pick the profile
# that exists instead of assuming one.
if ([string]::IsNullOrWhiteSpace($Profile)) {
    $profilesRoot = Join-Path $DshHome 'profiles'
    foreach ($candidate in @('web', 'desktop')) {
        if (Test-Path -LiteralPath (Join-Path $profilesRoot $candidate)) { $Profile = $candidate; break }
    }
    if ([string]::IsNullOrWhiteSpace($Profile) -and (Test-Path -LiteralPath $profilesRoot)) {
        $found = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne 'node_modules' })
        if ($found.Count -eq 1) { $Profile = $found[0].Name }
    }
    if ([string]::IsNullOrWhiteSpace($Profile)) {
        throw "cannot pick a profile under $profilesRoot; pass -Profile"
    }
    Write-Host "profile: $Profile"
}

$profileDir = Join-Path $DshHome "profiles\$Profile"
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$target = Join-Path $modulesDir $packageName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

function Remove-ReparsePointOrDirectory {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType) {
        # A junction must be removed without recursing, or its target is deleted too.
        if ($IsWindows -or $env:OS -eq 'Windows_NT') {
            cmd /c "rd `"$Path`"" | Out-Null
        } else {
            # cmd.exe does not exist off Windows; deleting the link itself leaves the
            # target alone.
            [IO.Directory]::Delete($Path, $false)
        }
    } else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile not found: $profileDir" }

if ($Uninstall) {
    Remove-ReparsePointOrDirectory -Path $target
    if (Test-Path -LiteralPath $patchPath) {
        $text = [IO.File]::ReadAllText($patchPath)
        $pattern = "(?ms)^\s*" + [regex]::Escape($beginMarker) + ".*?" + [regex]::Escape($endMarker) + "\r?\n?"
        if ([regex]::IsMatch($text, $pattern)) {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            Copy-Item -LiteralPath $patchPath -Destination "$patchPath.bak-$stamp" -Force
            [IO.File]::WriteAllText($patchPath, ([regex]::Replace($text, $pattern, '').TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
            Write-Host "removed the profile patch row (backup: cordis.patch.yml.bak-$stamp)"
        } else {
            Write-Warning "no managed patch block found in $patchPath"
        }
    }
    Write-Host "uninstalled $packageName"
    return
}

# `-File script.ps1 -Ref a,b` binds one string, so split commas here.
$refs = @($Ref | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

if (-not (Test-Path -LiteralPath $PluginDir)) { throw "plugin source not found: $PluginDir" }

# 1) Installed copy: the artifact DSH resolves from the profile.
Remove-ReparsePointOrDirectory -Path $target
Copy-Item -LiteralPath $PluginDir -Destination $target -Recurse -Force
$fileCount = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object).Count
Write-Host "installed $packageName -> $target ($fileCount files)"

# 2) Managed profile patch block, delimited so uninstall finds exactly what was written.
$block = @(
    ''
    "$beginMarker (managed by scripts/Install-DshPlugin.ps1)"
    '- insert:'
    "    - id: $rowId"
    "      name: '$packageName'"
    '      config:'
    '        refs:'
) + ($refs | ForEach-Object { "          - $_" }) + @(
    $endMarker
)

$existing = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllText($patchPath) } else { '' }
$managed = "(?ms)^\s*" + [regex]::Escape($beginMarker) + ".*?" + [regex]::Escape($endMarker) + "\r?$"
$blockText = ($block -join "`n").TrimStart("`n")

# A profile that still ships the default `[]` placeholder must have that line replaced,
# not appended after: `[]` followed by a sequence item is not valid YAML, so the parse
# below would reject the file and the write would be rolled back. Comments are kept.
$effective = (($existing -split "`r?`n") |
    ForEach-Object { ($_ -replace '#.*$', '').Trim() } |
    Where-Object { $_ }) -join ''
if ($effective -eq '[]' -or $effective -eq '') {
    $existing = [regex]::Replace($existing, '(?m)^\s*\[\s*\]\s*\r?\n?', '')
}

if ([regex]::IsMatch($existing, $managed)) {
    $updated = [regex]::Replace($existing, $managed, $blockText)
} else {
    # A row written by an older marker scheme still names this package: replace that block
    # instead of appending a second one, which would load the plugin twice.
    $legacy = $null
    foreach ($candidate in [regex]::Matches($existing, '(?ms)^[ \t]*# >>>.*?^[ \t]*# <<<[^\n]*\r?\n?')) {
        if ($candidate.Value -match ("(?m)name:\s*'?" + [regex]::Escape($packageName) + "'?\s*$")) { $legacy = $candidate; break }
    }
    if ($null -ne $legacy) {
        $updated = $existing.Substring(0, $legacy.Index) + $blockText + "`n" + $existing.Substring($legacy.Index + $legacy.Length)
        Write-Host "replaced the row for $packageName written by an older installer"
    } else {
        $unmanaged = '(?m)^\s*name:\s*' + [regex]::Escape("'$packageName'") + '\s*$'
        if ([regex]::IsMatch($existing, $unmanaged)) {
            throw "an unmanaged row for $packageName already exists in $patchPath; remove it by hand before installing from this repository"
        }
        $trimmed = $existing.TrimEnd()
        $updated = $(if ($trimmed.Length -gt 0) { $trimmed + "`n`n" } else { '' }) + $blockText
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path -LiteralPath $patchPath) { Copy-Item -LiteralPath $patchPath -Destination "$patchPath.bak-$stamp" -Force }
[IO.File]::WriteAllText($patchPath, ($updated.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))

# 3) Parse the written YAML with the harness parser before trusting the write.
$yamlModule = Join-Path $modulesDir 'yaml'
if (Test-Path -LiteralPath $yamlModule) {
    $probeLines = @(
        'const fs = require("node:fs");'
        'const yaml = require(process.argv[2]);'
        'const document = yaml.parse(fs.readFileSync(process.argv[3], "utf8"));'
        'const rows = [];'
        'for (const entry of document) for (const row of (entry.insert || [])) rows.push(row.id);'
        'console.log("parsed rows:", rows.join(", "));'
        "if (!rows.includes('$rowId')) { console.error('row missing after write'); process.exit(2); }"
    )
    $probe = $probeLines -join "`n"
    $probePath = Join-Path ([IO.Path]::GetTempPath()) 'ocg-verify-patch.cjs'
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    # Resolve node for the validation probe: PATH first, then the DSH Desktop bundled runtime.
    $nodeExe = $null
    $fromPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($fromPath) { $nodeExe = $fromPath.Source }
    if (-not $nodeExe) {
        $candidates = @()
        # Join-Path throws on a null base, and ProgramFiles is unset off Windows.
        if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'DSH Desktop\resources\app\node_modules\node\bin\node.exe') }
        if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DSH Desktop\resources\app\node_modules\node\bin\node.exe') }
        if ($HOME) {
            # macOS: the Desktop app ships its own node runtime under Application Support.
            $candidates += (Join-Path $HOME 'Library/Application Support/io.github.hairyf.deepseek-harness-desktop/runtime/bin/node')
        }
        $candidates += '/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/node/bin/node'
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
} else {
    Write-Warning "yaml parser not found at $yamlModule; skipped the post-write validation"
}

Write-Host "patched $patchPath (backup: cordis.patch.yml.bak-$stamp)"
Write-Host 'The GO chip sits in the composer row next to the model picker; press Ctrl+R in the DSH window if it does not appear (Ctrl+Shift+R restarts the harness instead).'
