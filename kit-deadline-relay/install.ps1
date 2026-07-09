# Kit Deadline Relay — install script
#
# Run on ONE studio machine that has: the Deadline client (deadlinecommand),
# After Effects (to read render queues), and access to the project share.
#
# Usage: .\install.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════"
Write-Host " Kit Deadline Relay — Installer"
Write-Host "═══════════════════════════════════════════════════════"
Write-Host ""

# Pre-flight: locate deadlinecommand
$dc = if ($env:DEADLINE_PATH) { Join-Path $env:DEADLINE_PATH 'deadlinecommand.exe' } else { 'C:\Program Files\Thinkbox\Deadline10\bin\deadlinecommand.exe' }
if (Test-Path $dc) {
    Write-Host "Found deadlinecommand: $dc" -ForegroundColor Green
    Write-Host "Pools:"; & $dc -Pools
    Write-Host "Groups:"; & $dc -Groups
} else {
    Write-Host "WARNING: deadlinecommand not found. Set DEADLINECOMMAND_PATH in .env after install." -ForegroundColor Yellow
    $dc = ""
}

# Pre-flight: auto-detect AfterFX.exe
$afterfxGuess = (Get-ChildItem "C:\Program Files\Adobe\Adobe After Effects *\Support Files\AfterFX.exe" -ErrorAction SilentlyContinue | Select-Object -Last 1).FullName

$supabaseUrl = Read-Host "SUPABASE_URL"
$supabaseKey = Read-Host "SUPABASE_SERVICE_ROLE_KEY" -AsSecureString
$supabaseKeyPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($supabaseKey))

$pool = Read-Host "Deadline pool (default: none)"; if ([string]::IsNullOrWhiteSpace($pool)) { $pool = "none" }
$group = Read-Host "Deadline group for AE nodes (default: none)"; if ([string]::IsNullOrWhiteSpace($group)) { $group = "none" }
$priority = Read-Host "Priority 0-100 (default: 50)"; if ([string]::IsNullOrWhiteSpace($priority)) { $priority = "50" }
$aeVer = Read-Host "AE version for Deadline (e.g. 2022, 2024)"; if ([string]::IsNullOrWhiteSpace($aeVer)) { $aeVer = "2022" }
$chunk = Read-Host "Frames per Deadline task for sequences (default: 10)"; if ([string]::IsNullOrWhiteSpace($chunk)) { $chunk = "10" }

$afterfxPrompt = if ($afterfxGuess) { "AfterFX.exe path (Enter for detected: $afterfxGuess)" } else { "AfterFX.exe path" }
$afterfx = Read-Host $afterfxPrompt; if ([string]::IsNullOrWhiteSpace($afterfx)) { $afterfx = $afterfxGuess }

Write-Host ""
Write-Host "Path map: how a Dropbox path maps to the farm share."
Write-Host "  Format: /Projects=>\\server\projects;/Delivery-Queue=>\\server\delivery"
$pathMap = Read-Host "DEADLINE_PATH_MAP"

$envFile = Join-Path $PSScriptRoot ".env"
@"
SUPABASE_URL=$supabaseUrl
SUPABASE_SERVICE_ROLE_KEY=$supabaseKeyPlain
DEADLINECOMMAND_PATH=$dc
DEADLINE_POOL=$pool
DEADLINE_GROUP=$group
DEADLINE_PRIORITY=$priority
AE_VERSION=$aeVer
DEADLINE_CHUNK_SIZE=$chunk
AFTERFX_PATH=$afterfx
DEADLINE_PATH_MAP=$pathMap
POLL_INTERVAL_MS=10000
"@ | Out-File -FilePath $envFile -Encoding utf8 -NoNewline

Write-Host ""
Write-Host "Wrote .env to $envFile" -ForegroundColor Green
Write-Host "Installing dependencies (npm install)..."
Push-Location $PSScriptRoot
npm install
Pop-Location

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════"
Write-Host " Setup complete."
Write-Host ""
Write-Host " Start the relay:   npm start"
Write-Host " Then set RENDER_BACKEND=deadline in Kit's Railway env."
Write-Host "═══════════════════════════════════════════════════════"
