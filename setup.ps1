# Prepares this machine to run the music queue. Called by start.bat; safe to run every time.
param([switch]$NoSystem) # -NoSystem: skip firewall + desktop shortcut (for testing)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin = Join-Path $root 'bin'
$port = if ($env:PORT) { $env:PORT } else { '3100' }
New-Item -ItemType Directory -Force $bin | Out-Null

Write-Host ''
Write-Host '  🎵 คิวเพลง — กำลังเตรียมโปรแกรม...'

# 0) An older version still running (a new listSong.exe was just double-clicked): close it so the new one starts.
#    The same version is left alone; the server then just opens the page, since the port is taken.
$build = if (Test-Path "$root\build.txt") { (Get-Content -Raw "$root\build.txt").Trim() } else { 'dev' }
$running = $null
try {
  $wc = New-Object Net.WebClient
  $wc.Proxy = $null
  $wc.Encoding = [Text.Encoding]::UTF8
  $running = $wc.DownloadString("http://127.0.0.1:$port/api/info") | ConvertFrom-Json
} catch { }
if ($running -and $running.urls -and $running.build -ne $build) {
  Write-Host '  พบโปรแกรมเวอร์ชันเก่าเปิดอยู่ — กำลังปิดแล้วเปิดเวอร์ชันใหม่แทน...'
  try {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      $old = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ParentProcessId)"
      Stop-Process -Id $old.ProcessId -Force -ErrorAction SilentlyContinue
      # also close the old window: listSong.exe, or the cmd running start.bat (it would sit at "pause")
      if ($parent -and ($parent.Name -eq 'listSong.exe' -or ($parent.Name -eq 'cmd.exe' -and $parent.CommandLine -match 'start\.bat'))) {
        Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue
      }
      for ($i = 0; $i -lt 40 -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Milliseconds 250
      }
    }
  } catch {
    Write-Host '  ปิดเวอร์ชันเก่าไม่สำเร็จ — ปิดหน้าต่างคิวเพลงเดิมเองแล้วเปิดใหม่อีกครั้ง' -ForegroundColor Yellow
  }
}

function Save-Download($url, $dest, $label) {
  Write-Host "  กำลังดาวน์โหลด $label (ครั้งแรกเท่านั้น) ..."
  $tmp = "$dest.download"
  try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    Move-Item -Force $tmp $dest
  } catch {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host "  ดาวน์โหลด $label ไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ตแล้วเปิด start.bat ใหม่อีกครั้ง" -ForegroundColor Red
    Write-Host "  ($($_.Exception.Message))" -ForegroundColor DarkGray
    exit 1
  }
}

# 1) Node.js — use the installed one, otherwise a portable node.exe in bin\
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Test-Path "$bin\node.exe")) {
  Save-Download 'https://nodejs.org/dist/latest-v22.x/win-x64/node.exe' "$bin\node.exe" 'Node.js'
}

# 2) yt-dlp — keep our own copy in bin\ and update it weekly, because YouTube changes often
$yt = Join-Path $bin 'yt-dlp.exe'
if (-not (Test-Path $yt)) {
  Save-Download 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' $yt 'yt-dlp'
} elseif ((Get-Item $yt).LastWriteTime -lt (Get-Date).AddDays(-7)) {
  Write-Host '  กำลังอัปเดต yt-dlp ...'
  try { & $yt -U 2>&1 | Out-Null; (Get-Item $yt).LastWriteTime = Get-Date } catch { Write-Host '  อัปเดตไม่สำเร็จ ใช้เวอร์ชันเดิมไปก่อน' }
}

if ($NoSystem) { exit 0 }

# 3) Windows Firewall — let other machines on the LAN connect (asks for admin once)
$rule = "listSong (TCP $port)"
if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
  Write-Host '  ขออนุญาตเปิดไฟร์วอลล์ให้เครื่องอื่นในวง LAN เข้ามาได้ — กด Yes ในหน้าต่างที่เด้งขึ้น'
  try {
    $cmd = "New-NetFirewallRule -DisplayName '$rule' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any | Out-Null"
    Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $cmd
  } catch {
    Write-Host '  ข้ามการตั้งค่าไฟร์วอลล์ (เครื่องอื่นอาจเข้าไม่ได้ ดู README)'
  }
}

# 4) Desktop shortcut, so next time it's one double-click
# (rewritten every start so it always points at the latest launcher: listSong.exe, or start.bat when run from source)
try {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'คิวเพลง.lnk'
  $target = if ($env:LISTSONG_LAUNCHER) { $env:LISTSONG_LAUNCHER } else { Join-Path $root 'start.bat' }
  $isNew = -not (Test-Path $lnk)
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $target
  $s.WorkingDirectory = $root
  $s.IconLocation = (Join-Path $root 'public\favicon.ico') + ',0'
  $s.Description = 'คิวเพลง YouTube สำหรับวง LAN'
  $s.Save()
  if ($isNew) { Write-Host '  สร้างทางลัด "คิวเพลง" บนหน้าจอแล้ว' }
} catch { }

exit 0
