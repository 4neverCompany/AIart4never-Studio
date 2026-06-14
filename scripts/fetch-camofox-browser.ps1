# scripts/fetch-camofox-browser.ps1
#
# Downloads the pinned @askjo/camofox-browser npm package and extracts it
# into src-tauri/resources/camofox so the Tauri desktop bundle ships a
# self-contained stealth browser sidecar.
#
# Cached in .cache/camofox so repeat runs skip the download.
# Safe to re-run — exits early if the launcher script is already in place.
#
# CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): analog zu fetch-windows-node.ps1.
# Pattern-Konsistenz: idempotent, cache-friendly, no-CI-noise.

$ErrorActionPreference = 'Stop'

$CamofoxVersion = '1.11.2'
$PackageSpec = "@askjo/camofox-browser@$CamofoxVersion"
$TarballBaseName = "askjo-camofox-browser-$CamofoxVersion.tgz"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$CamofoxDir = Join-Path $RepoRoot 'src-tauri\resources\camofox'
$CacheDir = Join-Path $RepoRoot '.cache\camofox'
$TarballPath = Join-Path $CacheDir $TarballBaseName

Write-Host "[fetch-camofox] Version: $CamofoxVersion"
Write-Host "[fetch-camofox] Target:  $CamofoxDir"

# Marker file: presence of launcher means the install is complete.
# CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): tarball contents are
# `<root>/bin/camofox-browser.js` (NOT `<root>/package/bin/...`).
# `npm pack` extracts the tarball contents into a `package/` subdir
# under our `$ExtractDir`, then we copy that subdir's CONTENTS
# (not the `package/` dir itself) into `$CamofoxDir`. So the final
# layout has the launcher directly at `$CamofoxDir/bin/...`.
$LauncherJsx = Join-Path $CamofoxDir 'bin' 'camofox-browser.js'
if (Test-Path $LauncherJsx) {
    Write-Host "[fetch-camofox] launcher already present at $LauncherJsx — skipping download."
    exit 0
}

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $CamofoxDir | Out-Null

if (-not (Test-Path $TarballPath)) {
    Write-Host "[fetch-camofox] Packing $PackageSpec from npm registry ..."
    $prev = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        # `npm pack <spec>` downloads the tarball to cwd. We cd into the
        # cache dir first so the artifact lands in a known location.
        Push-Location $CacheDir
        try {
            npm pack $PackageSpec 2>&1 | ForEach-Object { Write-Host "[npm] $_" }
        } finally {
            Pop-Location
        }
    } finally {
        $ProgressPreference = $prev
    }
} else {
    Write-Host "[fetch-camofox] Using cached tarball at $TarballPath"
}

if (-not (Test-Path $TarballPath)) {
    throw "[fetch-camofox] expected tarball $TarballPath not found after `npm pack`. Check that @askjo/camofox-browser@$CamofoxVersion is published to the npm registry."
}

Write-Host "[fetch-camofox] Extracting $TarballPath ..."
$ExtractDir = Join-Path $CacheDir 'extract'
if (Test-Path $ExtractDir) { Remove-Item -Recurse -Force $ExtractDir }
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null

# tar -xzf is available on Windows 10+ and Windows Server 2019+. tar is
# the standard way to extract .tgz files; Expand-Archive does not handle
# gzip directly. Use tar.exe from System32 to avoid the npm-pack
# dependency on a particular tar implementation.
tar -xzf $TarballPath -C $ExtractDir

$Inner = Join-Path $ExtractDir 'package'
if (-not (Test-Path $Inner)) {
    throw "[fetch-camofox] expected inner dir $Inner not found after extract"
}

# Clear target dir so we get a clean copy, not a merge of stale leftovers
# from a previous version. The installer would replace these anyway, but
# dev-time `cargo run` reuses the same on-disk dir.
if (Test-Path $CamofoxDir) { Remove-Item -Recurse -Force $CamofoxDir }
New-Item -ItemType Directory -Force -Path $CamofoxDir | Out-Null

Write-Host "[fetch-camofox] Copying to $CamofoxDir ..."
Get-ChildItem -Path $Inner -Force | Copy-Item -Destination $CamofoxDir -Recurse -Force

if (-not (Test-Path $LauncherJsx)) {
    throw "[fetch-camofox] launcher missing at $LauncherJsx after copy. The package layout may have changed in $CamofoxVersion."
}

# Audit-trail file: the `package.json` from the tarball records the
# exact resolved version + integrity hash. We keep a top-level copy so
# `npm ls` in the bundle dir shows what shipped.
$AuditPath = Join-Path $CamofoxDir 'CAMOFOX_VERSION.txt'
"@askjo/camofox-browser@$CamofoxVersion" | Out-File -FilePath $AuditPath -Encoding utf8 -NoNewline

Write-Host "[fetch-camofox] Done. Launcher at $LauncherJsx"
