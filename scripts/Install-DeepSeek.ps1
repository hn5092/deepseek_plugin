<#
.SYNOPSIS
  Install (or remove) the DeepSeek provider configuration in a DSH home.

.DESCRIPTION
  Two independent scopes, so one command covers both ways DSH is used here:

  settings (default) - merge the DeepSeek model catalog into <DshHome>\settings.yaml, which is
                       what the DSH Desktop profile reads. The block is written between managed
                       markers so it can be updated or removed exactly. An existing unmanaged
                       `llm-deepseek:` section is refused rather than overwritten.

  profile           - create <DshHome>\profiles\<ProfileName> so `dsh --profile <ProfileName>`
                       boots the DeepSeek provider directly (CLI). The package.json bundle
                       follows -Surface: headless (default) or web.

  Both scopes back the file up before writing and parse the result with the harness YAML parser.
  The API key itself is never written by this script: it belongs in the DSH credential store
  (DEEPSEEK_API_KEY) or in an environment variable of the same name.

.PARAMETER DshHome
  DSH home. Defaults to the DSH Desktop harness home; pass "$env:USERPROFILE\.dsh" for the CLI harness.

.PARAMETER Scope
  settings | profile | both. Defaults to settings.

.PARAMETER ProfileName
  Profile directory to create in profile scope. Defaults to deepseek.

.PARAMETER Surface
  Bundle set for the created profile: headless (default) or web.

.PARAMETER Uninstall
  Remove the managed settings block and/or the created profile directory.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DeepSeek.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DeepSeek.ps1 -Scope both -Surface web
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-DeepSeek.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $DshHome,
    [ValidateSet('settings', 'profile', 'both')] [string] $Scope = 'settings',
    [string] $ProfileName = 'deepseek',
    [ValidateSet('headless', 'web')] [string] $Surface = 'headless',
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    # DSH Desktop on Windows keeps its harness home under %APPDATA%; on macOS and
    # Linux both Desktop and the CLI use $HOME/.dsh.
    $DshHome = if ($env:APPDATA) { Join-Path $env:APPDATA 'dsh-desktop\harness' } else { Join-Path $HOME '.dsh' }
}

$providerDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'provider\deepseek'
$settingsTemplate = Join-Path $providerDir 'settings.llm-deepseek.yml'
$profileTemplate = Join-Path $providerDir 'profile.cordis.patch.yml'
$settingsPath = Join-Path $DshHome 'settings.yaml'
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$beginMarker = '# >>> dsh-deepseek provider'
$endMarker = '# <<< dsh-deepseek provider'

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
    } else { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Resolve-Node {
    $fromPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($fromPath) { return $fromPath.Source }
    $candidates = @()
    # Join-Path throws on a null base, and ProgramFiles is unset off Windows.
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'DSH Desktop\resources\app\node_modules\node\bin\node.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DSH Desktop\resources\app\node_modules\node\bin\node.exe') }
    if ($HOME) {
        # macOS: the Desktop app ships its own node runtime under Application Support.
        $candidates += (Join-Path $HOME 'Library/Application Support/io.github.hairyf.deepseek-harness-desktop/runtime/bin/node')
    }
    $candidates += '/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/node/bin/node'
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
    return $null
}

function Assert-Yaml {
    param(
        [string] $Path,
        [string] $Check
    )

    $yamlModule = Join-Path $modulesDir 'yaml'
    if (-not (Test-Path -LiteralPath $yamlModule)) {
        Write-Warning "yaml parser not found at $yamlModule; skipped the post-write validation"
        return
    }
    $nodeExe = Resolve-Node
    if (-not $nodeExe) {
        Write-Warning 'node was not found (PATH or DSH Desktop bundle); skipped the post-write validation'
        return
    }
    $probePath = Join-Path ([IO.Path]::GetTempPath()) 'dsh-deepseek-verify.cjs'
    $probe = @(
        'const fs = require("node:fs");'
        'const yaml = require(process.argv[2]);'
        'const doc = yaml.parse(fs.readFileSync(process.argv[3], "utf8"));'
        'if (process.argv[4] === "settings") {'
        '  const section = doc && doc["llm-deepseek"];'
        '  if (section === undefined || section === null) { console.log("no llm-deepseek section yet (valid for uninstall)"); }'
        '  else { const models = section.models; if (!Array.isArray(models) || models.length === 0) { console.error("settings has no llm-deepseek.models"); process.exit(2); } console.log("settings models:", models.length); }'
        '} else {'
        '  if (!Array.isArray(doc)) { console.error("patch file is not a YAML list"); process.exit(2); }'
        '  const ids = doc.map((row) => row && row.id);'
        '  if (!ids.includes("llm-deepseek")) { console.error("patch has no llm-deepseek row"); process.exit(2); }'
        '  console.log("patch rows:", doc.length);'
        '}'
        'const bad = [];'
        'const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };'
        'walk(doc);'
        'if (bad.length) process.exit(3);'
    )
    [IO.File]::WriteAllText($probePath, ($probe -join "`n"), [Text.UTF8Encoding]::new($false))
    & $nodeExe $probePath $yamlModule $Path $Check
    $code = $LASTEXITCODE
    Remove-Item $probePath -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) { throw "validation failed for $Path" }
}

function Install-Settings {
    if (-not (Test-Path -LiteralPath $settingsPath)) { throw "settings.yaml not found: $settingsPath" }
    if (-not (Test-Path -LiteralPath $settingsTemplate)) { throw "template not found: $settingsTemplate" }

    $existing = [IO.File]::ReadAllText($settingsPath)
    $managed = '(?ms)^\s*' + [regex]::Escape($beginMarker) + '.*?' + [regex]::Escape($endMarker) + '\r?\n?'
    $managedFound = [regex]::IsMatch($existing, $managed)

    if (-not $Uninstall -and -not $managedFound -and [regex]::IsMatch($existing, '(?m)^llm-deepseek:\s*$')) {
        throw "settings.yaml already carries an unmanaged llm-deepseek section; merge it by hand (or delete it) before installing this configuration"
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force

    if ($Uninstall) {
        if (-not $managedFound) { Write-Warning "no managed DeepSeek block in $settingsPath"; return }
        $text = [regex]::Replace($existing, $managed, '')
        [IO.File]::WriteAllText($settingsPath, ($text.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
        Assert-Yaml -Path $settingsPath -Check settings 2>$null
        Write-Host "removed the DeepSeek settings block (backup: settings.yaml.bak-$stamp)"
        return
    }

    $block = ($beginMarker + ' (managed by scripts/Install-DeepSeek.ps1)') + "`n" +
             ([IO.File]::ReadAllText($settingsTemplate).TrimEnd()) + "`n" + $endMarker
    if ($managedFound) {
        $text = [regex]::Replace($existing, $managed, $block)
    } else {
        $trimmed = $existing.TrimEnd()
        $prefix = if ($trimmed.Length -gt 0) { $trimmed + "`n`n" } else { '' }
        $text = $prefix + $block
    }
    [IO.File]::WriteAllText($settingsPath, ($text.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
    Assert-Yaml -Path $settingsPath -Check settings
    Write-Host "wrote the DeepSeek model catalog into $settingsPath (backup: settings.yaml.bak-$stamp)"
}

function Install-Profile {
    if (-not (Test-Path -LiteralPath $profileTemplate)) { throw "template not found: $profileTemplate" }
    if ($Uninstall) {
        Remove-ReparsePointOrDirectory -Path $profileDir
        Write-Host "removed profile $profileDir"
        return
    }

    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    $cordisRoot = Join-Path $profileDir 'cordis.yml'
    if (-not (Test-Path -LiteralPath $cordisRoot)) {
        $rootText = "# dsh profile root - the tree is composed as patches; edit cordis.patch.yml.`n[]`n"
        [IO.File]::WriteAllText($cordisRoot, $rootText, [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText((Join-Path $profileDir 'cordis.patch.yml'), ([IO.File]::ReadAllText($profileTemplate).TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $profileDir 'pnpm-workspace.yaml'), "packages: []`n", [Text.UTF8Encoding]::new($false))

    $surfaceBundle = if ($Surface -eq 'web') { '@deepseek-ai/dsh-web-app' } else { '@deepseek-ai/dsh-headless' }
    $manifest = [ordered]@{
        name = "dsh-profile-$ProfileName"
        private = $true
        dependencies = [ordered]@{}
        dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', $surfaceBundle) } }
    }
    [IO.File]::WriteAllText((Join-Path $profileDir 'package.json'), (($manifest | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))

    Assert-Yaml -Path (Join-Path $profileDir 'cordis.patch.yml') -Check profile
    Write-Host "created profile $ProfileName ($Surface) at $profileDir"
}

if (-not (Test-Path -LiteralPath $DshHome)) { throw "DSH home not found: $DshHome" }

if ($Scope -in @('settings', 'both')) { Install-Settings }
if ($Scope -in @('profile', 'both')) { Install-Profile }

if (-not $Uninstall) {
    $credentialFile = Join-Path $DshHome '.credentials.yaml'
    Write-Host ''
    Write-Host 'Next step: provide the DeepSeek API key under the reference DEEPSEEK_API_KEY.'
    Write-Host "  credential file: $credentialFile"
    Write-Host "  add under 'refs:':  DEEPSEEK_API_KEY: <your key>"
    Write-Host '  (or set the DEEPSEEK_API_KEY environment variable for the process that launches DSH)'
    if ($Scope -in @('profile', 'both')) { Write-Host "  run it with: dsh --profile $ProfileName" }
    if ($Scope -in @('settings', 'both')) { Write-Host '  DSH Desktop picks this up on the next window refresh (Ctrl+R).' }
}
