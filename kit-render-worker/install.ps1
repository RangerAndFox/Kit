# Kit Render Worker — install script
#
# Usage: .\install.ps1
#
# Prompts for worker role, priority, Dropbox sync path, FFmpeg location,
# then writes .env and registers the worker in Supabase (via first heartbeat
# when the worker is started). Does NOT install as a Windows service by
# default — operator can do that via NSSM, sc.exe, or Task Scheduler.

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════"
Write-Host " Kit Render Worker — Installer"
Write-Host "═══════════════════════════════════════════════════════"
Write-Host ""

# Pre-flight: FFmpeg
$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegCmd) {
    Write-Host "WARNING: ffmpeg not found on PATH." -ForegroundColor Yellow
    Write-Host "Install via Chocolatey: choco install ffmpeg"
    Write-Host "Or download from https://ffmpeg.org/download.html and add bin\ to PATH."
    Write-Host ""
}

# Prompts
$supabaseUrl = Read-Host "SUPABASE_URL (e.g. https://xxx.supabase.co)"
$supabaseKey = Read-Host "SUPABASE_SERVICE_ROLE_KEY" -AsSecureString
$supabaseKeyPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($supabaseKey))

$hostname = Read-Host "Worker hostname (default: $env:COMPUTERNAME)"
if ([string]::IsNullOrWhiteSpace($hostname)) { $hostname = $env:COMPUTERNAME }

$role = Read-Host "Role [primary/fallback] (default: fallback)"
if ([string]::IsNullOrWhiteSpace($role)) { $role = "fallback" }

$priorityDefault = if ($role -eq "primary") { "1" } else { "10" }
$priority = Read-Host "Priority [1-99] (default: $priorityDefault)"
if ([string]::IsNullOrWhiteSpace($priority)) { $priority = $priorityDefault }

$dropboxPath = Read-Host "Dropbox sync folder (default: D:\Dropbox)"
if ([string]::IsNullOrWhiteSpace($dropboxPath)) { $dropboxPath = "D:\Dropbox" }

$ffmpegPath = Read-Host "FFmpeg path (default: ffmpeg)"
if ([string]::IsNullOrWhiteSpace($ffmpegPath)) { $ffmpegPath = "ffmpeg" }

# After Effects render farm (optional). Auto-detect a common install path.
$aerenderGuess = (Get-ChildItem "C:\Program Files\Adobe\Adobe After Effects *\Support Files\aerender.exe" -ErrorAction SilentlyContinue | Select-Object -Last 1).FullName
$aerenderPrompt = if ($aerenderGuess) { "aerender path (Enter to use detected: $aerenderGuess, or 'none')" } else { "aerender path (Enter to skip if no After Effects on this machine)" }
$aerenderPath = Read-Host $aerenderPrompt
if ([string]::IsNullOrWhiteSpace($aerenderPath)) { $aerenderPath = $aerenderGuess }
if ($aerenderPath -eq "none") { $aerenderPath = "" }
if ($aerenderPath) {
    Write-Host "This machine will be AE-capable (renders aerender chunks)." -ForegroundColor Green
} else {
    Write-Host "No aerender — this machine runs transcode + stitch jobs only." -ForegroundColor Yellow
}

# Write .env
$envFile = Join-Path $PSScriptRoot ".env"
@"
SUPABASE_URL=$supabaseUrl
SUPABASE_SERVICE_ROLE_KEY=$supabaseKeyPlain
WORKER_HOSTNAME=$hostname
WORKER_ROLE=$role
WORKER_PRIORITY=$priority
DROPBOX_SYNC_PATH=$dropboxPath
FFMPEG_PATH=$ffmpegPath
AERENDER_PATH=$aerenderPath
CPU_THRESHOLD=50
MIN_DISK_FREE_GB=10
HEARTBEAT_INTERVAL_MS=10000
POLL_INTERVAL_MS=5000
FALLBACK_DELAY_SECONDS=30
"@ | Out-File -FilePath $envFile -Encoding utf8 -NoNewline

Write-Host ""
Write-Host "Wrote .env to $envFile" -ForegroundColor Green

# Install npm deps
Write-Host ""
Write-Host "Installing dependencies (npm install)..."
Push-Location $PSScriptRoot
npm install
Pop-Location

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════"
Write-Host " Setup complete."
Write-Host ""
Write-Host " To start the worker:"
Write-Host "   cd $PSScriptRoot"
Write-Host "   npm start"
Write-Host ""
Write-Host " To run as a Windows service, recommended options:"
Write-Host "   - NSSM:           https://nssm.cc/  (free, easiest)"
Write-Host "   - Task Scheduler: at logon, run 'npm start' from this folder"
Write-Host "═══════════════════════════════════════════════════════"
