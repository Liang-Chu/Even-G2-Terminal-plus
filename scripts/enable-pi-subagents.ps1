#requires -Version 5.1
<#
.SYNOPSIS
Install the official Pi subagent example for the current Windows user.
.DESCRIPTION
Online (default): detect installed Pi, resolve its official release tag to a
commit, and download the matching official example. Requires Pi 0.87.1+ and
HTTPS access to api.github.com / raw.githubusercontent.com.
Local: copy the example bundled with an npm installation, without downloads.
Extension code and workflow prompts are unchanged. Only the agent frontmatter
model field is removed so children inherit the current model/thinking level.
No custom delegation rules, credentials, package installs, or live Pi reloads.
.EXAMPLE
.\enable-pi-subagents.ps1
.EXAMPLE
.\enable-pi-subagents.ps1 -Source Local
#>
[CmdletBinding()]
param(
    [ValidateSet('Online', 'Local')][string]$Source = 'Online',
    [string]$PiPackageRoot,
    [string]$AgentDirectory = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi/agent' })
)
$ErrorActionPreference = 'Stop'

function Resolve-UserPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'A nonempty directory is required.' }
    if ($Value -eq '~') { $Value = $env:USERPROFILE }
    elseif ($Value -match '^~[\\/]') { $Value = Join-Path $env:USERPROFILE $Value.Substring(2) }
    return [IO.Path]::GetFullPath($Value)
}
$AgentDirectory = Resolve-UserPath $AgentDirectory
$piCommand = Get-Command pi -ErrorAction SilentlyContinue
if ($PiPackageRoot) {
    $PiPackageRoot = (Resolve-Path -LiteralPath (Resolve-UserPath $PiPackageRoot)).Path
} elseif ($piCommand -and $piCommand.Source) {
    $candidate = Join-Path (Split-Path -Parent $piCommand.Source) 'node_modules/@earendil-works/pi-coding-agent'
    if (Test-Path -LiteralPath (Join-Path $candidate 'package.json')) { $PiPackageRoot = $candidate }
}
if ($PiPackageRoot) {
    $package = Get-Content -LiteralPath (Join-Path $PiPackageRoot 'package.json') -Raw | ConvertFrom-Json
    if ($package.name -ne '@earendil-works/pi-coding-agent') { throw 'Expected the official @earendil-works/pi-coding-agent package.' }
    $piVersion = [string]$package.version
} elseif ($piCommand -and $Source -eq 'Online') {
    # Standalone Pi installations have no npm package directory. --version
    # exits without opening a session, running a task, or contacting a model.
    $versionOutput = (& $piCommand --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the installed Pi version. Run pi --version to check the installation.' }
    $versionMatch = [regex]::Match($versionOutput, '(?m)^(?:pi(?: version)?\s+)?(?<version>\d+\.\d+\.\d+)\s*$')
    if (-not $versionMatch.Success) { throw 'Unrecognized Pi version output. Use -PiPackageRoot for a custom npm installation.' }
    $piVersion = $versionMatch.Groups['version'].Value
} else {
    throw 'Pi was not found. Install official Pi first, or specify -PiPackageRoot for a custom npm installation.'
}
if ($piVersion -notmatch '^\d+\.\d+\.\d+$' -or [version]$piVersion -lt [version]'0.87.1') {
    throw 'This installer requires a stable Pi release 0.87.1 or later. Update Pi first; no configuration was changed.'
}
if ($Source -eq 'Local' -and -not $PiPackageRoot) { throw 'Local mode requires -PiPackageRoot or an npm-installed Pi.' }

# No usernames, repository checkout, or model credentials are embedded here.
$files = @()
foreach ($name in @('index.ts', 'agents.ts')) {
    $files += [pscustomobject]@{ Relative = $name; Destination = Join-Path $AgentDirectory "extensions/subagent/$name"; Role = $false }
}
foreach ($name in @('scout', 'planner', 'reviewer', 'worker')) {
    $files += [pscustomobject]@{ Relative = "agents/$name.md"; Destination = Join-Path $AgentDirectory "agents/$name.md"; Role = $true }
}
foreach ($name in @('implement', 'scout-and-plan', 'implement-and-review')) {
    $files += [pscustomobject]@{ Relative = "prompts/$name.md"; Destination = Join-Path $AgentDirectory "prompts/$name.md"; Role = $false }
}

$http = $null
try {
    if ($Source -eq 'Online') {
        Add-Type -AssemblyName System.Net.Http
        # TLS 1.2 for Windows PowerShell 5.1; existing protocol settings remain.
        $previousProtocols = [Net.ServicePointManager]::SecurityProtocol
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocols -bor [Net.SecurityProtocolType]::Tls12
        $http = [Net.Http.HttpClient]::new()
        $http.Timeout = [TimeSpan]::FromSeconds(30)
        $http.DefaultRequestHeaders.UserAgent.ParseAdd('Terminal-plus-subagent-installer/2')
        $http.DefaultRequestHeaders.Accept.ParseAdd('application/vnd.github+json')
        $tag = "v$piVersion"
        Write-Host "Resolving official Pi $tag..."
        $release = ($http.GetStringAsync("https://api.github.com/repos/earendil-works/pi/commits/$tag").GetAwaiter().GetResult()) | ConvertFrom-Json
        $revision = [string]$release.sha
        if ($revision -notmatch '^[0-9a-f]{40}$') { throw 'The official release did not resolve to a commit.' }
        $baseUrl = "https://raw.githubusercontent.com/earendil-works/pi/$revision/packages/coding-agent"
        $remotePackage = ($http.GetStringAsync("$baseUrl/package.json").GetAwaiter().GetResult()) | ConvertFrom-Json
        if ($remotePackage.name -ne '@earendil-works/pi-coding-agent' -or $remotePackage.version -ne $piVersion) {
            throw 'Official source package/version did not match the installed Pi.'
        }
        $sourceLocation = "https://github.com/earendil-works/pi/tree/$revision/packages/coding-agent/examples/extensions/subagent"
    } else {
        $sourceLocation = Join-Path $PiPackageRoot 'examples/extensions/subagent'
        $revision = "local:$piVersion"
    }

    # Download and preflight every file before changing the destination.
    # A network error, missing file or customization conflict writes nothing.
    $prepared = foreach ($file in $files) {
        if ($Source -eq 'Online') {
            Write-Host "Downloading $($file.Relative)..."
            $bytes = $http.GetByteArrayAsync("$baseUrl/examples/extensions/subagent/$($file.Relative)").GetAwaiter().GetResult()
            $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        } else {
            $text = [IO.File]::ReadAllText((Join-Path $sourceLocation $file.Relative))
        }
        if ([string]::IsNullOrWhiteSpace($text)) { throw "Empty official file: $($file.Relative)" }
        if ($file.Role) {
            $parts = [regex]::Match($text, '\A---\r?\n(?<front>.*?)\r?\n---(?<body>.*)\z', 'Singleline')
            if (-not $parts.Success) { throw "Missing agent frontmatter: $($file.Relative)" }
            $front = [regex]::Replace($parts.Groups['front'].Value, '(?m)^model:[^\r\n]*(?:\r?\n|$)', '').TrimEnd()
            $text = "---`n$front`n---" + $parts.Groups['body'].Value
        }
        $exists = Test-Path -LiteralPath $file.Destination
        # npm on Windows may normalize line endings. Preserve equivalent files.
        if ($exists -and [IO.File]::ReadAllText($file.Destination).Replace("`r`n", "`n") -cne $text.Replace("`r`n", "`n")) {
            throw "Existing file differs; nothing was changed. Review it first: $($file.Destination)"
        }
        [pscustomobject]@{ Destination = $file.Destination; Text = $text; Exists = $exists }
    }
} catch {
    throw "Subagent setup stopped before installation: $($_.Exception.Message)"
} finally {
    if ($http) { $http.Dispose() }
    if (Test-Path variable:previousProtocols) { [Net.ServicePointManager]::SecurityProtocol = $previousProtocols }
}

$written = 0
foreach ($file in $prepared) {
    if ($file.Exists) { continue }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $file.Destination)) | Out-Null
    # CreateNew also refuses a file created by another process after preflight.
    $stream = [IO.File]::Open($file.Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($file.Text); $stream.Write($bytes, 0, $bytes.Length) }
    finally { $stream.Dispose() }
    $written++
}
[pscustomobject]@{
    PiVersion = $piVersion
    Source = $Source
    Revision = $revision
    SourceLocation = $sourceLocation
    AgentDirectory = $AgentDirectory
    FilesAdded = $written
    FilesAlreadyPresent = @($prepared | Where-Object Exists).Count
    Model = 'Inherit the current Pi model and thinking level'
    Next = 'In an idle Pi terminal, enter /reload; new Pi terminals load it automatically.'
}
