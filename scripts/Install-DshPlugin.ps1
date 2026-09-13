<#
.SYNOPSIS
  Install (or remove) the OpenCode Go usage UI plugin in a DSH profile.

.DESCRIPTION
  The plugin source lives in this Skill at ../plugin and is installed as the package
  `dsh-opencode-go-usage` under <Home>\profiles\node_modules plus one managed row in the
  profile patch layer <Home>\profiles\<Profile>\cordis.patch.yml. The DSH Web client then
  shows a `GO <月度最大占用>%` chip in the conversation header; clicking it opens the
  per-account 5-hour / weekly / monthly table.

  The copy under profiles\node_modules is the installed artifact; ../plugin stays the
  single source of truth, so re-run this script after editing the plugin. The patch file
  is backed up and the resulting YAML is parsed before the write is kept.

.PARAMETER DshHome
  DSH home. Defaults to the DSH Desktop harness home.

.PARAMETER Profile
  Profile to patch. Defaults to `web`, the profile the Desktop app boots.

.PARAMETER Ref
  Credential references to sample, one per account row.

.PARAMETER Uninstall
  Remove the managed patch block and the installed copy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Install-UiPlugin.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Install-UiPlugin.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $DshHome = (Join-Path $env:APPDATA 'dsh-desktop\harness'),
    [string] $Profile = 'web',
    [string[]] $Ref = @(
        'OPENCODE_API_KEY_1',
        'OPENCODE_API_KEY_2',
        'OPENCODE_API_KEY_3',
        'OPENCODE_API_KEY_4'
    ),
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

$packageName = 'dsh-opencode-go-usage'
$rowId = 'opencode-go-usage'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$target = Join-Path $modulesDir $packageName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$beginMarker = '# >>> opencode-go-usage UI plugin'
$endMarker = '# <<< opencode-go-usage UI plugin'

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

if (-not (Test-Path -LiteralPath $source)) { throw "plugin source not found: $source" }

# 1) Installed copy: the artifact DSH resolves from the profile.
Remove-ReparsePointOrDirectory -Path $target
Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
$fileCount = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object).Count
Write-Host "installed $packageName -> $target ($fileCount files)"

# 2) Managed profile patch block, delimited so uninstall finds exactly what was written.
$block = @(
    ''
    '# >>> opencode-go-usage UI plugin (managed by .agents/skills/opencode-go-usage/scripts/Install-UiPlugin.ps1)'
    '- insert:'
    "    - id: $rowId"
    "      name: '$packageName'"
    '      config:'
    '        refs:'
) + ($refs | ForEach-Object { "          - $_" }) + @(
    '# <<< opencode-go-usage UI plugin'
)

$existing = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllText($patchPath) } else { '' }
$managed = "(?ms)^\s*" + [regex]::Escape($beginMarker) + ".*?" + [regex]::Escape($endMarker) + "\r?$"
$blockText = ($block -join "`n").TrimStart("`n")
if ([regex]::IsMatch($existing, $managed)) {
    $updated = [regex]::Replace($existing, $managed, $blockText)
} else {
    $trimmed = $existing.TrimEnd()
    $updated = $(if ($trimmed.Length -gt 0) { $trimmed + "`n`n" } else { '' }) + $blockText
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
        'if (!rows.includes("opencode-go-usage")) { console.error("row missing after write"); process.exit(2); }'
    )
    $probe = $probeLines -join "`n"
    $probePath = Join-Path $env:TEMP 'ocg-verify-patch.cjs'
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    # Resolve node for the validation probe: PATH first, then the DSH Desktop bundled runtime.
    $nodeExe = $null
    $fromPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($fromPath) { $nodeExe = $fromPath.Source }
    if (-not $nodeExe) {
        $candidates = @((Join-Path $env:ProgramFiles 'DSH Desktop\resources\app\node_modules\node\bin\node.exe'))
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
} else {
    Write-Warning "yaml parser not found at $yamlModule; skipped the post-write validation"
}

Write-Host "patched $patchPath (backup: cordis.patch.yml.bak-$stamp)"
Write-Host 'The GO chip sits in the composer row next to the model picker; press Ctrl+R in the DSH window if it does not appear (Ctrl+Shift+R restarts the harness instead).'
