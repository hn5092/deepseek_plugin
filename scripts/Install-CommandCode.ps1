<#
.SYNOPSIS
  Install (or remove) the CommandCode route in a DSH settings.yaml.

.DESCRIPTION
  Windows port of scripts/Install-CommandCode.sh, compatible with it: both write the same
  `# >>> dsh-commandcode route` / `# <<< dsh-commandcode route` block, and the block is placed
  inside the existing llm-pi-ai `providers:` mapping so it coexists with the OpenCode Go routes
  instead of replacing them. A missing llm-pi-ai section is created.

  ZDR (x-cmd-zdr: "1") is OFF unless -Zdr is given: per CommandCode's own documentation it
  meters an account at the plan's default allowance (3x fewer credits on GOAT) and can route to
  a pricier upstream, so it is not a free privacy toggle.

.PARAMETER DshHome
  DSH home. Defaults to the DSH Desktop harness home; pass "$env:USERPROFILE\.dsh" for the CLI harness.

.PARAMETER Ref
  Credential reference the route reads, default COMMANDCODE_API_KEY. The key itself stays in the
  DSH credential store or the matching environment variable.

.PARAMETER SetDefault
  Also point agent-default-model at this route (model deepseek/deepseek-v4.1-flash).

.PARAMETER Effort
  reasoningEffort written by -SetDefault. Default max.

.PARAMETER Zdr
  Enable x-cmd-zdr: "1" on the route. Read the warning above first.

.PARAMETER DryRun
  Report what would change without writing.

.PARAMETER Uninstall
  Remove the managed block.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CommandCode.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CommandCode.ps1 -SetDefault -Effort max
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-CommandCode.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $DshHome = (Join-Path $env:APPDATA 'dsh-desktop\harness'),
    [string] $Ref = 'COMMANDCODE_API_KEY',
    [switch] $SetDefault,
    [ValidateSet('low', 'high', 'max')] [string] $Effort = 'max',
    [switch] $Zdr,
    [switch] $DryRun,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

$template = Join-Path (Split-Path -Parent $PSScriptRoot) 'provider\commandcode\settings.llm-pi-ai.yml'
$settingsPath = Join-Path $DshHome 'settings.yaml'
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$beginMarker = '# >>> dsh-commandcode route'
$endMarker = '# <<< dsh-commandcode route'
$routeId = 'commandcode'
$defaultModel = 'deepseek/deepseek-v4.1-flash'

if (-not (Test-Path -LiteralPath $settingsPath)) { throw "settings.yaml not found: $settingsPath" }
$existing = [IO.File]::ReadAllText($settingsPath)
$managedPattern = '(?ms)^\s*' + [regex]::Escape($beginMarker) + '.*?' + [regex]::Escape($endMarker) + '\r?\n?'
$managed = [regex]::IsMatch($existing, $managedPattern)

if ($Uninstall) {
    if (-not $managed) { throw "nothing to remove: no '$beginMarker' block in $settingsPath" }
    $text = [regex]::Replace($existing, $managedPattern, '')
    if ($DryRun) { Write-Host '[dry run] would remove the CommandCode block'; return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force
    [IO.File]::WriteAllText($settingsPath, ($text.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
    Write-Host "removed the CommandCode block (backup: settings.yaml.bak-$stamp)"
    return
}

if (-not (Test-Path -LiteralPath $template)) { throw "template not found: $template" }

# Block body: the template minus its leading comment block, with ZDR lines kept or dropped.
$body = @()
foreach ($line in [IO.File]::ReadAllLines($template)) {
    if ($line -match '^\s*#\s*\[zdr\]') {
        if ($Zdr) { $body += ($line -replace '#\s*\[zdr\]', '').TrimEnd() }
        continue
    }
    if ($line -match '^#') { continue }
    if ($line.Trim().Length -eq 0) { continue }
    $body += ($line -replace '__REF__', $Ref).TrimEnd()
}
$block = @($beginMarker) + $body + @($endMarker)
$blockText = ($block -join "`n")

if ($managed) {
    $text = [regex]::Replace($existing, $managedPattern, ($blockText + "`n"))
} elseif ([regex]::IsMatch($existing, '(?m)^llm-pi-ai:')) {
    # Insert as the first child of the llm-pi-ai providers mapping (position-based, so a
    # `providers:` elsewhere in the file cannot be mistaken for this one).
    $section = [regex]::Match($existing, '(?ms)^llm-pi-ai:.*?(?=^[a-z][a-z0-9-]*:|\z)')
    $providers = [regex]::Match($section.Value, '(?m)^\s+providers:\s*$')
    if (-not $section.Success -or -not $providers.Success) {
        throw "settings.yaml has an llm-pi-ai section without a providers mapping; add one by hand before installing this route"
    }
    $insertAt = $section.Index + $providers.Index + $providers.Length
    $text = $existing.Substring(0, $insertAt) + "`n" + $blockText + $existing.Substring($insertAt)
} else {
    $trimmed = $existing.TrimEnd()
    $prefix = if ($trimmed.Length -gt 0) { $trimmed + "`n`n" } else { '' }
    $text = $prefix + "llm-pi-ai:`n  providers:`n" + $blockText
}

if ($SetDefault) {
    $defaultBlock = "agent-default-model:`n  provider: $routeId`n  model: $defaultModel`n  reasoningEffort: $Effort"
    if ([regex]::IsMatch($text, '(?ms)^agent-default-model:.*?(?=^[a-z][a-z0-9-]*:|\z)')) {
        $text = [regex]::Replace($text, '(?ms)^agent-default-model:.*?(?=^[a-z][a-z0-9-]*:|\z)', ($defaultBlock + "`n"))
    } else {
        $text = $text.TrimEnd() + "`n`n" + $defaultBlock
    }
}

if ($DryRun) {
    Write-Host "[dry run] would write the $routeId route (ref $Ref, zdr $([bool]$Zdr), set-default $([bool]$SetDefault))"
    return
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$stamp" -Force
[IO.File]::WriteAllText($settingsPath, ($text.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))

# Validate with the harness YAML parser: the block exists, its ref is ours, and the section kept
# every provider it had before.
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
    $probePath = Join-Path $env:TEMP 'dsh-commandcode-verify.cjs'
    $probe = @(
        'const fs = require("node:fs");'
        'const yaml = require(process.argv[2]);'
        'const doc = yaml.parse(fs.readFileSync(process.argv[3], "utf8"));'
        'const providers = doc && doc["llm-pi-ai"] && doc["llm-pi-ai"].providers;'
        'if (!providers) { console.error("no llm-pi-ai.providers"); process.exit(2); }'
        'const route = providers["commandcode"];'
        'if (!route) { console.error("no commandcode route"); process.exit(2); }'
        'if (route.apiKeyEnv !== process.argv[4]) { console.error("apiKeyEnv is " + route.apiKeyEnv + ", expected " + process.argv[4]); process.exit(3); }'
        'if (process.argv[5] === "1") { const d = doc["agent-default-model"]; if (!d || d.provider !== "commandcode") { console.error("agent-default-model.provider is " + (d && d.provider)); process.exit(4); } }'
        'console.log("commandcode route ok; coexisting providers: " + Object.keys(providers).filter((id) => id !== "commandcode").join(", "));'
        'console.log("models: " + route.models.map((model) => model.id).join(", "));'
    )
    [IO.File]::WriteAllText($probePath, ($probe -join "`n"), [Text.UTF8Encoding]::new($false))
    & $nodeExe $probePath $yamlModule $settingsPath $Ref ([string][int][bool]$SetDefault)
    $code = $LASTEXITCODE
    Remove-Item $probePath -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) {
        Copy-Item -LiteralPath "$settingsPath.bak-$stamp" -Destination $settingsPath -Force
        throw 'the written settings.yaml did not validate; the backup was restored'
    }
} else {
    Write-Warning 'yaml parser or node not found; skipped the post-write validation'
}
Write-Host "wrote the $routeId route into $settingsPath (backup: settings.yaml.bak-$stamp)"
Write-Host "Next: put the CommandCode API key in the credential store under the reference $Ref."