<#
.SYNOPSIS
  Install (or remove) the OpenCode Go route set in a DSH settings.yaml.

.DESCRIPTION
  Writes the llm-pi-ai section from provider/opencode-go/settings.llm-pi-ai.yml: five parallel
  routes (opencode-go-1..5) over one subscription, each with its own credential reference and
  its own x-opencode-session, so each route can carry a different API key.

  The DSH Desktop client rewrites settings.yaml from its own snapshot when the user changes a
  UI preference, which reverts this section; running this script again replays it. Behaviour:

  - a managed block (written by this script) is replaced in place;
  - an existing unmanaged llm-pi-ai section is REPLACED as well, after a backup, because that is
    the replay path - run with -DryRun to see the provider ids that would be dropped;
  - no section: the block is appended.

  The API key itself is never written: each route references a credential name, and the keys
  stay in the DSH credential store (or the matching environment variables).

.PARAMETER DshHome
  DSH home. Defaults to the DSH Desktop harness home; pass "$env:USERPROFILE\.dsh" for the CLI harness.

.PARAMETER Client
  Client tag used for x-opencode-session and the user agent, in place of __CLIENT__ in the
  template. Keep the same value across replays so prompt caching stays stable.

.PARAMETER Ref
  Credential references, one per route, in route order. Defaults to OPENCODE_API_KEY_1..5.

.PARAMETER DryRun
  Report what would change without writing anything.

.PARAMETER Uninstall
  Remove the route set. A managed block is removed; an unmanaged section is removed only when
  every provider in it is an opencode-go route.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-OpenCodeGo.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-OpenCodeGo.ps1 -Client dsh-desktop-mybox -Ref KEY_A,KEY_B,KEY_C,KEY_D,KEY_E
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-OpenCodeGo.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $DshHome = (Join-Path $env:APPDATA 'dsh-desktop\harness'),
    [string] $Client = 'dsh-opencode-go',
    [string[]] $Ref = @('OPENCODE_API_KEY_1', 'OPENCODE_API_KEY_2', 'OPENCODE_API_KEY_3', 'OPENCODE_API_KEY_4', 'OPENCODE_API_KEY_5'),
    [switch] $DryRun,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

$template = Join-Path (Split-Path -Parent $PSScriptRoot) 'provider\opencode-go\settings.llm-pi-ai.yml'
$settingsPath = Join-Path $DshHome 'settings.yaml'
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$beginMarker = '# >>> dsh-opencode-go routes'
$endMarker = '# <<< dsh-opencode-go routes'
$refs = @($Ref | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

if (-not (Test-Path -LiteralPath $settingsPath)) { throw "settings.yaml not found: $settingsPath" }
if (-not $Uninstall -and -not (Test-Path -LiteralPath $template)) { throw "template not found: $template" }
if (-not $Uninstall -and $refs.Count -ne 5) { throw "exactly 5 credential references are required (one per route); got $($refs.Count)" }

$existing = [IO.File]::ReadAllText($settingsPath)
$managedPattern = '(?ms)^\s*' + [regex]::Escape($beginMarker) + '.*?' + [regex]::Escape($endMarker) + '\r?\n?'
$sectionPattern = '(?ms)^llm-pi-ai:.*?(?=^[a-z][a-z0-9-]*:|\z)'
$managed = [regex]::IsMatch($existing, $managedPattern)
$section = [regex]::Match($existing, $sectionPattern)
$providerIds = @()
if ($section.Success) {
    $providerIds = [regex]::Matches($section.Value, '(?m)^    ([A-Za-z0-9_.-]+):') | ForEach-Object { $_.Groups[1].Value }
}

if ($Uninstall) {
    if ($managed) {
        $text = [regex]::Replace($existing, $managedPattern, '')
    } elseif ($section.Success -and @($providerIds | Where-Object { $_ -notmatch '^opencode-go-' }).Count -eq 0) {
        $text = [regex]::Replace($existing, $sectionPattern, '')
    } else {
        throw 'nothing to remove: settings.yaml has no managed route set, and its llm-pi-ai section holds providers this script did not create'
    }
    if ($DryRun) { Write-Host "[dry run] would remove the route set"; return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force
    [IO.File]::WriteAllText($settingsPath, ($text.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
    Write-Host "removed the OpenCode Go route set (backup: settings.yaml.bak-$stamp)"
    return
}

if ($section.Success) {
    Write-Host "llm-pi-ai providers found before the write: $($providerIds -join ', ')"
}

# Build the block: client tag, then the credential reference per route in template order.
$block = ([IO.File]::ReadAllText($template).TrimEnd()) -replace '__CLIENT__', $Client
$index = 0
$block = [regex]::Replace($block, '(?m)^(      apiKeyEnv: )\S+$', {
        param($match)
        $value = $refs[$script:index]
        $script:index++
        $match.Groups[1].Value + $value
    })
if ($index -ne 5) { throw "template declared $index credential slots; expected 5" }
$block = $beginMarker + ' (managed by scripts/Install-OpenCodeGo.ps1)' + "`n" + $block + "`n" + $endMarker

if ($managed) {
    $text = [regex]::Replace($existing, $managedPattern, $block)
} elseif ($section.Success) {
    $text = [regex]::Replace($existing, $sectionPattern, $block + "`n")
} else {
    $trimmed = $existing.TrimEnd()
    $prefix = if ($trimmed.Length -gt 0) { $trimmed + "`n`n" } else { '' }
    $text = $prefix + $block
}

if ($DryRun) { Write-Host "[dry run] would write the route set ($($refs -join ', '))"; return }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force
[IO.File]::WriteAllText($settingsPath, ($text.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))

# Validate with the harness YAML parser: five routes, each on its own reference.
$yamlModule = Join-Path $modulesDir 'yaml'
$nodeExe = $null
$fromPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($fromPath) { $nodeExe = $fromPath.Source }
if (-not $nodeExe) {
    $candidates = @((Join-Path $env:ProgramFiles 'DSH Desktop\resources\app\node_modules\node\bin\node.exe'))
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DSH Desktop\resources\app\node_modules\node\bin\node.exe') }
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { $nodeExe = $candidate; break } }
}
if ((Test-Path -LiteralPath $yamlModule) -and $nodeExe) {
    $probePath = Join-Path $env:TEMP 'dsh-opencode-go-verify.cjs'
    $probe = @(
        'const fs = require("node:fs");'
        'const yaml = require(process.argv[2]);'
        'const doc = yaml.parse(fs.readFileSync(process.argv[3], "utf8"));'
        'const providers = doc && doc["llm-pi-ai"] && doc["llm-pi-ai"].providers;'
        'if (!providers) { console.error("settings has no llm-pi-ai.providers"); process.exit(2); }'
        'const routes = ["opencode-go-1", "opencode-go-2", "opencode-go-3", "opencode-go-4", "opencode-go-5"];'
        'const refs = require("node:fs").readFileSync(process.argv[4], "utf8").split(/\r?\n/).filter(Boolean);'
        'if (refs.length !== routes.length) { console.error("expected " + routes.length + " credential references, got " + refs.length); process.exit(2); }'
        'for (let i = 0; i < routes.length; i++) {'
        '  const route = providers[routes[i]];'
        '  if (!route) { console.error("missing route " + routes[i]); process.exit(2); }'
        '  if (route.apiKeyEnv !== refs[i]) { console.error("route " + routes[i] + " references " + route.apiKeyEnv + " instead of " + refs[i]); process.exit(3); }'
        '}'
        'console.log("validated routes:", routes.join(", "));'
    )
    [IO.File]::WriteAllText($probePath, ($probe -join "`n"), [Text.UTF8Encoding]::new($false))
    $refFile = Join-Path $env:TEMP 'dsh-opencode-go-refs.txt'
    [IO.File]::WriteAllText($refFile, (($refs -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    & $nodeExe $probePath $yamlModule $settingsPath $refFile
    $code = $LASTEXITCODE
    Remove-Item $probePath, $refFile -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) {
        Copy-Item -LiteralPath "$settingsPath.bak-$stamp" -Destination $settingsPath -Force
        throw 'the written settings.yaml did not validate; the backup was restored'
    }
} else {
    Write-Warning 'yaml parser or node not found; skipped the post-write validation'
}
Write-Host "wrote the OpenCode Go route set into $settingsPath (backup: settings.yaml.bak-$stamp)"
Write-Host 'Each route needs its own key in the DSH credential store under the references above; a route without one fails with MISSING_CREDENTIAL.'