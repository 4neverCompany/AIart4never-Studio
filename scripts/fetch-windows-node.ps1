# scripts/fetch-windows-node.ps1
#
# Downloads the pinned Node.js Windows LTS binary and extracts it into
# src-tauri/resources/node so the Tauri desktop bundle ships a
# self-contained Node runtime.
#
# Cached in .cache/node so repeat runs skip the download.
# Safe to re-run — exits early if node.exe is already in place.

$ErrorActionPreference = 'Stop'

$NodeVersion = 'v22.11.0'
$Arch = 'win-x64'
$ZipName = "node-$NodeVersion-$Arch.zip"
$ZipUrl = "https://nodejs.org/dist/$NodeVersion/$ZipName"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$NodeDir = Join-Path $RepoRoot 'src-tauri\resources\node'
$CacheDir = Join-Path $RepoRoot '.cache\node'
$ZipPath = Join-Path $CacheDir $ZipName

Write-Host "[fetch-node] Version: $NodeVersion"
Write-Host "[fetch-node] Target:  $NodeDir"

if (Test-Path (Join-Path $NodeDir 'node.exe')) {
    Write-Host "[fetch-node] node.exe already present — skipping download."
    exit 0
}

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null

if (-not (Test-Path $ZipPath)) {
    Write-Host "[fetch-node] Downloading $ZipUrl"
    # Invoke-WebRequest with -UseBasicParsing avoids the IE engine dep on
    # Windows Server / Core editions. Progress bar is noisy in CI, so
    # suppress via ProgressPreference.
    $prev = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing
    } finally {
        $ProgressPreference = $prev
    }
} else {
    Write-Host "[fetch-node] Using cached zip at $ZipPath"
}

Write-Host "[fetch-node] Extracting ..."
$ExtractDir = Join-Path $CacheDir 'extract'
if (Test-Path $ExtractDir) { Remove-Item -Recurse -Force $ExtractDir }
Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

$Inner = Join-Path $ExtractDir "node-$NodeVersion-$Arch"
if (-not (Test-Path $Inner)) {
    throw "[fetch-node] Expected inner dir $Inner not found after extract"
}

Write-Host "[fetch-node] Copying to $NodeDir ..."
Get-ChildItem -Path $Inner -Force | Copy-Item -Destination $NodeDir -Recurse -Force

$FinalExe = Join-Path $NodeDir 'node.exe'
if (-not (Test-Path $FinalExe)) {
    throw "[fetch-node] node.exe missing at $FinalExe after copy"
}

Write-Host "[fetch-node] Done. node.exe at $FinalExe"
