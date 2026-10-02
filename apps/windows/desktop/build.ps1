param([switch]$Stage)
$ErrorActionPreference = 'Stop'
$pilotRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$pilotCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $pilotCompiler)) { throw 'The Windows .NET Framework compiler is required.' }
$pilotNode = (Get-Command node -ErrorAction Stop).Source
& $pilotNode (Join-Path $pilotRoot 'scripts/build-icons.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Icon build failed.' }
$pilotOutput = Join-Path $pilotRoot $(if ($Stage) { 'Even-Pilot.updated.exe' } else { 'Even-Pilot.exe' })
$pilotIcon = Join-Path $PSScriptRoot 'assets/Even-Pilot.ico'
& $pilotCompiler /nologo /target:winexe /optimize+ "/out:$pilotOutput" "/win32icon:$pilotIcon" "/resource:$pilotIcon,Even-Pilot.ico" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'Tray.cs') (Join-Path $PSScriptRoot 'StartupRegistration.cs') (Join-Path $PSScriptRoot 'DesktopPaths.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
$pilotInterrupt = Join-Path $PSScriptRoot 'Even-Pilot.TerminalInterrupt.exe'
& $pilotCompiler /nologo /target:exe /optimize+ "/out:$pilotInterrupt" /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'TerminalInterrupt.cs')
if ($LASTEXITCODE -ne 0) { throw 'Terminal interrupt helper build failed.' }
Write-Output "Built $pilotOutput"
