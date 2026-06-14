<#
.SYNOPSIS
  Install the Higgsfield CLI into a MashupForge-local directory so the AI
  agent can generate through Higgsfield WITHOUT a global npm install and
  WITHOUT the WebView OAuth flow.

.DESCRIPTION
  MashupForge's Higgsfield provider (lib/providers/higgsfield/cli-adapter.ts)
  resolves the CLI binary in this order:
    1. $env:HIGGSFIELD_BIN  (absolute path to the binary — what this script sets)
    2. `higgsfield` / `higgs` on PATH

  This script:
    1. installs `@higgsfield/cli` (pinned to the version the adapter targets)
       into  src-tauri\resources\higgsfield-cli\  — self-contained, not global,
       and ready to be bundled into a future installer build.
    2. sets the USER env var HIGGSFIELD_BIN to the installed shim, so both
       `bun run tauri dev` AND the installed MashupForge app (whose Next.js
       server process inherits your user env) find it automatically.

  AUTH: you do NOT need the OAuth window. Paste a CLI token from the
  Higgsfield dashboard into MashupForge → Settings → Higgsfield. The adapter
  writes it to a temp credentials.json the CLI reads (no browser round-trip).
  Alternatively run `higgsfield auth login` once (device flow in your normal
  system browser — not the in-app WebView).

  Requires: Node.js on PATH (the CLI is a Node script). You already have it
  if you run bun/npm.

.NOTES
  Pinned to @higgsfield/cli 0.1.40 — the version the adapter's flag set /
  subcommands were written against. Bumping the pin may change flags; verify
  cli-adapter.ts against the new CLI before raising it.
#>
[CmdletBinding()]
param(
  [string]$Version = '0.1.40',
  # Override the install dir if you want it somewhere else (e.g. a stable
  # per-user location like "$env:LOCALAPPDATA\MashupForge\higgsfield-cli").
  # Defaults (computed below) to src-tauri\resources\higgsfield-cli.
  [string]$Dest,
  # Skip setting the user env var (just install).
  [switch]$NoEnv
)

$ErrorActionPreference = 'Stop'

# Default install dir: a stable, repo-independent MashupForge user location
# (%LOCALAPPDATA%\MashupForge\higgsfield-cli). This survives moving/deleting
# the repo and is found by the installed app's server process via
# HIGGSFIELD_BIN. Pass -Dest src-tauri\resources\higgsfield-cli to instead
# stage it for installer bundling.
if (-not $Dest) {
  $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  $Dest = Join-Path $base 'MashupForge\higgsfield-cli'
}

# --- preflight ----------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js is not on PATH. Install Node 22+ first (the Higgsfield CLI is a Node script)."
}
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  throw "npm is not on PATH. Install Node.js (which ships npm)."
}

$Dest = [System.IO.Path]::GetFullPath($Dest)
Write-Host "Installing @higgsfield/cli@$Version into:`n  $Dest`n" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# A minimal package.json so `npm install <pkg>` lands in $Dest\node_modules
# and creates the .bin shims, instead of walking up to a parent package.json.
$pkgJson = Join-Path $Dest 'package.json'
if (-not (Test-Path $pkgJson)) {
  '{ "name": "mashupforge-higgsfield-cli-host", "version": "1.0.0", "private": true }' |
    Set-Content -Path $pkgJson -Encoding utf8
}

Push-Location $Dest
try {
  & npm install "@higgsfield/cli@$Version" --no-audit --no-fund --loglevel error
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
} finally {
  Pop-Location
}

# --- resolve the installed binary --------------------------------------------
# On Windows npm writes a .cmd shim into node_modules\.bin\.
$binDir = Join-Path $Dest 'node_modules\.bin'
$shim = Join-Path $binDir 'higgsfield.cmd'
if (-not (Test-Path $shim)) {
  # Fall back to the extensionless shim (some npm versions / shells).
  $alt = Join-Path $binDir 'higgsfield'
  if (Test-Path $alt) { $shim = $alt }
  else { throw "Higgsfield CLI shim not found under $binDir after install." }
}
$shim = [System.IO.Path]::GetFullPath($shim)
Write-Host "`nInstalled. CLI binary:`n  $shim" -ForegroundColor Green

# --- smoke test ---------------------------------------------------------------
try {
  $ver = & $shim --version 2>&1 | Select-Object -First 1
  Write-Host "Smoke test: higgsfield --version -> $ver"
} catch {
  Write-Warning "Could not run the CLI ($($_.Exception.Message)). It is installed; check Node is on PATH."
}

# --- wire HIGGSFIELD_BIN ------------------------------------------------------
if (-not $NoEnv) {
  [Environment]::SetEnvironmentVariable('HIGGSFIELD_BIN', $shim, 'User')
  $env:HIGGSFIELD_BIN = $shim  # also set for the current shell
  Write-Host "`nSet user env var HIGGSFIELD_BIN = $shim" -ForegroundColor Green
  Write-Host "RESTART MashupForge (and any dev server) so it picks up the new env var." -ForegroundColor Yellow
} else {
  Write-Host "`n[-NoEnv] HIGGSFIELD_BIN not set. Point MashupForge at the CLI with:" -ForegroundColor Yellow
  Write-Host "  setx HIGGSFIELD_BIN `"$shim`""
}

Write-Host "`nNext:" -ForegroundColor Cyan
Write-Host "  1. Restart MashupForge."
Write-Host "  2. Settings -> Higgsfield -> paste a CLI token from the Higgsfield dashboard"
Write-Host "     (no OAuth window needed), OR run '$shim auth login' once."
Write-Host "  3. The AI agent (Director pipeline) and the manual Studio panel can now"
Write-Host "     generate through the local Higgsfield CLI."
