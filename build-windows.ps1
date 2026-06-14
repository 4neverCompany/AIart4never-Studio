# build-windows.ps1
#
# MashupForge Windows desktop build orchestrator. Runs the full Phase 1
# build pipeline and emits a .msi installer at
# src-tauri\target\<release|debug>\bundle\msi\.
#
# Usage:
#   .\build-windows.ps1                 # release build (unsigned .msi)
#   .\build-windows.ps1 -Dev             # debug build (faster, keeps assertions)
#   .\build-windows.ps1 -SkipToolchainCheck  # bypass the upfront tool check
#
# Prerequisites (one-time setup, see docs/WINDOWS-BUILD.md):
#   - Node.js 22 LTS on PATH
#   - Rust via rustup, with x86_64-pc-windows-msvc target
#   - Visual Studio 2022 Build Tools with "Desktop development with C++"
#   - WebView2 Runtime (pre-installed on Win11, stub installer on Win10)
#   - Git for Windows

param(
    [switch]$Dev = $false,
    [switch]$SkipToolchainCheck = $false
)

$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$ScriptsDir = Join-Path $RepoRoot 'scripts'
Set-Location $RepoRoot

Write-Host ""
Write-Host "=== MashupForge Windows Desktop Build ==="
Write-Host "Repo:  $RepoRoot"
Write-Host "Mode:  $(if ($Dev) { 'debug' } else { 'release' })"
Write-Host ""

# -----------------------------------------------------------------------------
# [1/8] Toolchain sanity check
# -----------------------------------------------------------------------------
if (-not $SkipToolchainCheck) {
    Write-Host "[1/8] Toolchain check ..."
    $required = @('node', 'npm', 'cargo', 'rustc', 'git')
    foreach ($cmd in $required) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            throw "Missing required tool: $cmd. See docs/WINDOWS-BUILD.md for install instructions."
        }
    }
    $rustupOutput = & rustup target list --installed 2>$null
    if ($LASTEXITCODE -ne 0 -or -not ($rustupOutput -match 'x86_64-pc-windows-msvc')) {
        throw "Rust target x86_64-pc-windows-msvc not installed. Run: rustup target add x86_64-pc-windows-msvc"
    }
    Write-Host "      OK — node $(& node --version), rustc $(& rustc --version | ForEach-Object { $_.Split(' ')[1] })"
} else {
    Write-Host "[1/8] Skipping toolchain check (--SkipToolchainCheck)"
}

# -----------------------------------------------------------------------------
# [2/8] npm ci
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[2/8] Installing JS dependencies (npm ci) ..."
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

# -----------------------------------------------------------------------------
# [3/8] Test suite — fail fast before the heavy Tauri build
# -----------------------------------------------------------------------------
# Pure-function vitest smoke layer (PROP-011 phase 1). Runs in <1s and
# gates the rest of the pipeline so a broken helper never reaches the
# .msi bundle. If the suite grows past ~30s, move it to a separate CI
# job and keep this step as `npm run test -- --bail`.
Write-Host ""
Write-Host "[3/8] Running test suite (npm test) ..."
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test failed" }

# -----------------------------------------------------------------------------
# [4/8] Fetch bundled Node.js
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[4/8] Fetching bundled Node.js for sidecar ..."
& (Join-Path $ScriptsDir 'fetch-windows-node.ps1')
if ($LASTEXITCODE -ne 0) { throw "fetch-windows-node.ps1 failed" }

# -----------------------------------------------------------------------------
# [5/8] (Runtime install) — pi.dev is installed on first launch, not baked
# -----------------------------------------------------------------------------
# Previous Phase 1 builds baked @mariozechner/pi-coding-agent into
# src-tauri/resources/pi/ via scripts/bake-pi.ps1. That was superseded by
# the runtime-install architecture: the Rust launcher sets
# MASHUPFORGE_PI_DIR to %APPDATA%\MashupForge\pi, and the Next sidecar's
# /api/pi/install route installs pi into that prefix on first app launch.
# Smaller installer, no pinned pi version in the .msi.
Write-Host ""
Write-Host "[5/8] Skipping pi bake — runtime-install architecture"

# -----------------------------------------------------------------------------
# [6/8] Next.js standalone build
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[6/8] Next.js standalone build ..."
npm run build
if ($LASTEXITCODE -ne 0) { throw "next build failed" }

# -----------------------------------------------------------------------------
# [7/8] Copy standalone tree into Tauri resources
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[7/8] Copying standalone tree -> src-tauri/resources/app ..."
& (Join-Path $ScriptsDir 'copy-standalone-to-resources.ps1')
if ($LASTEXITCODE -ne 0) { throw "copy-standalone-to-resources.ps1 failed" }

# -----------------------------------------------------------------------------
# [8/8] Tauri build
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[8/8] Tauri build ..."
if ($Dev) {
    npx tauri build --debug
} else {
    npx tauri build
}
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

# -----------------------------------------------------------------------------
# Report artifacts
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Build complete ==="

$BundleRoot = if ($Dev) {
    Join-Path $RepoRoot 'src-tauri\target\debug\bundle'
} else {
    Join-Path $RepoRoot 'src-tauri\target\release\bundle'
}

$Exe = Get-ChildItem -Path $BundleRoot -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue
$Msi = Get-ChildItem -Path $BundleRoot -Filter '*.msi' -Recurse -ErrorAction SilentlyContinue

if ($Exe) {
    Write-Host "NSIS EXE: $($Exe.FullName)"
} elseif ($Msi) {
    Write-Host "MSI:      $($Msi.FullName)"
} else {
    Write-Warning "No installer found under $BundleRoot"
    Get-ChildItem -Path $BundleRoot -Recurse -File | ForEach-Object { Write-Host "  $($_.FullName)" }
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Double-click the .msi to install."
Write-Host "  2. Click past the SmartScreen warning (unsigned — Phase 3 will add a cert)."
Write-Host "  3. On first launch, create %APPDATA%\MashupForge\config.json with your API keys."
Write-Host "     See docs/WINDOWS-BUILD.md section 'Runtime configuration' for the schema."
Write-Host ""
