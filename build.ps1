# Builds dist\listSong.exe (single-file installer/launcher) and dist\listSong.zip.
# Needs only Windows: uses the C# compiler that ships with .NET Framework 4.x.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$stage = Join-Path ([IO.Path]::GetTempPath()) 'listSong-build'
$appFiles = 'server.js', 'package.json', 'README.md', 'start.bat', 'setup.ps1', 'public'

Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force "$stage\app" | Out-Null
foreach ($f in $appFiles) { Copy-Item -Recurse (Join-Path $root $f) "$stage\app\" }
# build stamp: lets a new listSong.exe spot an older copy that is still running and replace it
$build = Get-Date -Format 'yyyyMMdd-HHmmss'
[IO.File]::WriteAllText("$stage\app\build.txt", $build)

# ZipFile writes forward-slash entry names, which every unzip tool understands
$appZip = "$stage\app.zip"
[IO.Compression.ZipFile]::CreateFromDirectory("$stage\app", $appZip)
Copy-Item -Force $appZip "$dist\listSong.zip"

$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
& $csc /nologo /codepage:65001 /target:exe /optimize+ `
  "/win32icon:$root\public\favicon.ico" `
  "/resource:$appZip,app.zip" `
  /r:System.IO.Compression.dll `
  "/out:$dist\listSong.exe" `
  "$root\launcher\Launcher.cs"
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }

Remove-Item -Recurse -Force $stage
Get-ChildItem $dist | ForEach-Object { '  {0,-14} {1,8:N0} KB' -f $_.Name, ($_.Length / 1KB) }
