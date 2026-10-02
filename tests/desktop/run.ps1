$ErrorActionPreference = 'Stop'
$pilotRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
& (Join-Path $pilotRoot 'apps/windows/desktop/build.ps1') -Stage
$pilotTestDirectory = Join-Path $pilotRoot 'outputs/desktop-tests'
[IO.Directory]::CreateDirectory($pilotTestDirectory) | Out-Null
$pilotCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$pilotTestExe = Join-Path $pilotTestDirectory 'desktop-tests.exe'
& $pilotCompiler /nologo /target:exe "/out:$pilotTestExe" /reference:System.Drawing.dll (Join-Path $PSScriptRoot 'StartupRegistrationTests.cs') (Join-Path $pilotRoot 'apps/windows/desktop/StartupRegistration.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed to compile.' }
& $pilotTestExe (Join-Path $pilotRoot 'Even-Pilot.updated.exe')
if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed.' }
$pilotInstallerTests = Join-Path $pilotTestDirectory 'installer-tests.exe'
& $pilotCompiler /nologo /target:exe "/out:$pilotInstallerTests" /reference:System.Core.dll /reference:Microsoft.CSharp.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'InstallerSupportTests.cs') (Join-Path $pilotRoot 'apps/windows/desktop/InstallerSupport.cs') (Join-Path $pilotRoot 'apps/windows/desktop/DesktopPaths.cs') (Join-Path $pilotRoot 'apps/windows/desktop/StartupRegistration.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer support tests failed to compile.' }
& $pilotInstallerTests (Join-Path $pilotRoot 'Even-Pilot.updated.exe')
if ($LASTEXITCODE -ne 0) { throw 'Installer support tests failed.' }
