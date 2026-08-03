# Install dsig (Windows). Linux and macOS users: run install.sh instead.
#
# Does the whole job from a bare machine: clones Vencord if you do not have it,
# installs its dependencies, copies the plugin in, builds, and points Vesktop at
# the build. Re-run it to update; it is safe to run repeatedly.
#
# Usage: .\install.ps1 [-Vencord path-to-Vencord] [-NoVesktop]
#   The path defaults to $env:VENCORD, then an existing
#   ~\Documents\GitHub\Vencord, then %LOCALAPPDATA%\dsig\Vencord, which the
#   script clones and maintains.
#
#   If scripts are blocked by policy, run:
#     powershell -ExecutionPolicy Bypass -File install.ps1

param(
    [string]$Vencord = "",
    [switch]$NoVesktop
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$RepoUrl = "https://github.com/Vendicated/Vencord.git"
# Written into checkouts this script created, so it can update them without
# ever running git in a tree the user maintains by hand.
$Marker = ".dsig-managed"

$LegacyDefault = Join-Path $HOME "Documents\GitHub\Vencord"
$ManagedDefault = Join-Path $env:LOCALAPPDATA "dsig\Vencord"

if (-not $Vencord) {
    if ($env:VENCORD) { $Vencord = $env:VENCORD }
    elseif (Test-Path (Join-Path $LegacyDefault "src")) { $Vencord = $LegacyDefault }
    else { $Vencord = $ManagedDefault }
}

function Fail([string]$Message) {
    Write-Error "install.ps1: $Message"
    exit 1
}

function Step([string]$Message) { Write-Host "==> $Message" }

function Have([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

if (-not (Have git)) { Fail "git is not on PATH; install Git first" }
if (-not (Have node)) { Fail "node is not on PATH; install Node.js first" }
if (-not (Have pnpm)) {
    # corepack ships with Node and can provide pnpm without a global install.
    if (Have corepack) { corepack enable pnpm }
    if (-not (Have pnpm)) { Fail "pnpm is not on PATH; install it (npm i -g pnpm) or enable corepack" }
}

# ── the Vencord checkout ──────────────────────────────────────────────────

if (-not (Test-Path (Join-Path $Vencord "src"))) {
    if ((Test-Path $Vencord) -and (Get-ChildItem -Force $Vencord | Select-Object -First 1)) {
        Fail "$Vencord exists but is not a Vencord checkout; move it aside or pass another path"
    }
    Step "cloning Vencord into $Vencord"
    New-Item -ItemType Directory -Force (Split-Path -Parent $Vencord) | Out-Null
    git clone --depth 1 $RepoUrl $Vencord
    if ($LASTEXITCODE -ne 0) { Fail "could not clone Vencord" }
    New-Item -ItemType File -Force (Join-Path $Vencord $Marker) | Out-Null
} elseif (Test-Path (Join-Path $Vencord $Marker)) {
    Step "updating $Vencord"
    # --ff-only: never invent a merge in a tree the user might look at.
    git -C $Vencord pull --ff-only --depth 1 origin HEAD
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "could not update Vencord; building the version already there"
    }
}

Step "installing Vencord's dependencies"
Push-Location $Vencord
pnpm install --silent
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "pnpm install failed" }
Pop-Location

# ── the plugin ────────────────────────────────────────────────────────────

# A symlink would break esbuild's alias resolution (it resolves real paths),
# so the plugin is copied in. The .desktop suffix keeps it out of web builds.
$Target = Join-Path $Vencord "src\userplugins\dsig.desktop"
Step "copying the plugin into $Target"
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
New-Item -ItemType Directory -Force (Join-Path $Vencord "src\userplugins") | Out-Null
Copy-Item -Recurse (Join-Path $Here "dsig.desktop") $Target

Step "building Vencord"
Push-Location $Vencord
$env:CI = "true"
pnpm build
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "pnpm build failed" }
Pop-Location

$Dist = Join-Path $Vencord "dist"
# Vesktop requires a package.json alongside the four vencordDesktop* files.
$DistPackage = Join-Path $Dist "package.json"
if (-not (Test-Path $DistPackage)) { Set-Content -Path $DistPackage -Value "{}" }

# ── point Vesktop at the build ────────────────────────────────────────────

$State = Join-Path $env:APPDATA "vesktop\state.json"
$Wired = $false

# Vesktop reads state.json once at startup and writes it back on exit, so a
# running instance would overwrite whatever is set here.
$Running = [bool](Get-Process -Name "Vesktop" -ErrorAction SilentlyContinue)

if ($NoVesktop) {
    # nothing to do
} elseif ($Running) {
    Write-Warning "Vesktop is running; close it and re-run to have it pointed at the build"
} elseif (Test-Path (Split-Path -Parent $State)) {
    if (Test-Path $State) { Copy-Item $State "$State.dsig-backup" -Force }
    node -e "const fs=require('fs');const [p,dir]=process.argv.slice(1);let s={};if(fs.existsSync(p)){try{s=JSON.parse(fs.readFileSync(p,'utf8')||'{}')}catch{console.error('state.json is not valid JSON; leaving it alone');process.exit(3)}}s.vencordDir=dir;fs.writeFileSync(p,JSON.stringify(s,null,4))" $State $Dist
    if ($LASTEXITCODE -eq 0) { $Wired = $true }
}

Write-Host ""
Write-Host "plugin  $Target"
Write-Host "build   $Dist"
Write-Host ""
if ($Wired) {
    Write-Host "Vesktop is now pointed at the build (previous state.json kept as state.json.dsig-backup):"
    Write-Host "  $State"
    Write-Host "Start Vesktop, then enable Dsig in Settings -> Plugins."
} else {
    Write-Host "Point your client at the build, then restart it:"
    Write-Host "  Vesktop:          Settings -> Vencord Location -> $Dist"
    Write-Host "  Discord Desktop:  cd `"$Vencord`"; pnpm inject"
    Write-Host "Then enable Dsig in Settings -> Plugins."
}
