# Copy dsig into a Vencord checkout and rebuild it (Windows).
# Linux and macOS users: run install.sh instead.
#
# Vesktop is pointed at VENCORD\dist via its "Vencord Location" setting
# (state.json -> vencordDir), so a rebuild is all that is needed to pick up
# plugin changes; restart Vesktop afterwards.
#
# Usage: .\install.ps1 [-Vencord path-to-Vencord]
#   If scripts are blocked by policy, run:
#     powershell -ExecutionPolicy Bypass -File install.ps1

param(
    [string]$Vencord = "$(Join-Path $HOME 'Documents\GitHub\Vencord')"
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$Message) {
    Write-Error "install.ps1: $Message"
    exit 1
}

if (-not (Test-Path (Join-Path $Vencord "src"))) {
    Fail "not a Vencord checkout: $Vencord`nclone it first:  git clone https://github.com/Vendicated/Vencord.git `"$Vencord`""
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "node is not on PATH; install Node.js first"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    # corepack ships with Node and can provide pnpm without a global install.
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        corepack enable pnpm
    }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Fail "pnpm is not on PATH; install it (npm i -g pnpm) or enable corepack"
    }
}

if (-not (Test-Path (Join-Path $Vencord "node_modules"))) {
    Push-Location $Vencord
    pnpm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "pnpm install failed" }
    Pop-Location
}

# A symlink would break esbuild's alias resolution (it resolves real paths),
# so the plugin is copied in.
$Target = Join-Path $Vencord "src\userplugins\dsig"
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
New-Item -ItemType Directory -Force (Join-Path $Vencord "src\userplugins") | Out-Null
Copy-Item -Recurse (Join-Path $Here "plugin") $Target

Push-Location $Vencord
$env:CI = "true"
pnpm build
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "pnpm build failed" }
Pop-Location

# Vesktop requires a package.json alongside the four vencordDesktop* files.
$DistPackage = Join-Path $Vencord "dist\package.json"
if (-not (Test-Path $DistPackage)) { Set-Content -Path $DistPackage -Value "{}" }

Write-Host ""
Write-Host "installed into $Target"
Write-Host "built to       $(Join-Path $Vencord 'dist')"
Write-Host ""
Write-Host "Point your client at the build (once), then restart it:"
Write-Host "  Vesktop:          Settings -> Vencord Location -> $(Join-Path $Vencord 'dist')"
Write-Host "    (state.json at  $env:APPDATA\vesktop\state.json)"
Write-Host "  Discord Desktop:  cd `"$Vencord`"; pnpm inject"
