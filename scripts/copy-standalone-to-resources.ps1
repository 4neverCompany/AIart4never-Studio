# scripts/copy-standalone-to-resources.ps1
#
# Copies the Next.js standalone build output into
# src-tauri/resources/app so the Tauri desktop bundle can ship a
# self-contained Next server.
#
# Must be run AFTER `npm run build` (which produces .next/standalone).
# Must be run BEFORE `npx tauri build` (which bundles resources).
#
# Next standalone mode only includes server.js + a trace-minimized
# node_modules subset — it does NOT include .next/static or public/.
# Those have to be copied manually per Next.js docs.
# See: https://nextjs.org/docs/app/api-reference/next-config-js/output#automatically-copying-traced-files

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$Standalone = Join-Path $RepoRoot '.next\standalone'
$StaticDir = Join-Path $RepoRoot '.next\static'
$PublicDir = Join-Path $RepoRoot 'public'
$AppDir = Join-Path $RepoRoot 'src-tauri\resources\app'
$Wrapper = Join-Path $RepoRoot 'scripts\tauri-server-wrapper.js'

Write-Host "[copy-standalone] Source: $Standalone"
Write-Host "[copy-standalone] Target: $AppDir"

if (-not (Test-Path $Standalone)) {
    throw "[copy-standalone] .next/standalone not found — run ``npm run build`` first."
}
if (-not (Test-Path $Wrapper)) {
    throw "[copy-standalone] Missing wrapper at $Wrapper"
}

if (Test-Path $AppDir) {
    Write-Host "[copy-standalone] Removing stale $AppDir ..."
    Remove-Item -Recurse -Force $AppDir
}
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

Write-Host "[copy-standalone] Copying standalone tree ..."
Copy-Item -Path (Join-Path $Standalone '*') -Destination $AppDir -Recurse -Force

# .next/static -> resources/app/.next/static
if (Test-Path $StaticDir) {
    $TargetNext = Join-Path $AppDir '.next'
    New-Item -ItemType Directory -Force -Path $TargetNext | Out-Null
    Write-Host "[copy-standalone] Copying .next/static ..."
    Copy-Item -Path $StaticDir -Destination $TargetNext -Recurse -Force
} else {
    Write-Warning "[copy-standalone] .next/static not found — static assets will 404 at runtime"
}

# public/ -> resources/app/public/
if (Test-Path $PublicDir) {
    Write-Host "[copy-standalone] Copying public/ ..."
    Copy-Item -Path $PublicDir -Destination $AppDir -Recurse -Force
}

# Install the Tauri server wrapper as start.js alongside server.js
$StartJs = Join-Path $AppDir 'start.js'
Copy-Item -Path $Wrapper -Destination $StartJs -Force
Write-Host "[copy-standalone] Wrote $StartJs"

$ServerJs = Join-Path $AppDir 'server.js'
if (-not (Test-Path $ServerJs)) {
    throw "[copy-standalone] Expected server.js at $ServerJs after copy — standalone build may be broken."
}

Write-Host "[copy-standalone] Done."

# V108-CLEANUP: strip the user's project source tree that Next.js
# standalone copied verbatim. Standalone is supposed to include
# only server.js + trace-minimized node_modules, but with the
# current `outputFileTracingRoot` config it pulls in `app/`,
# `components/`, `hooks/`, `lib/`, `types/`, `public/` etc. — that
# bloats the NSIS installer by ~20 MB and leaks source into the
# shipped binary. Strip everything except the runtime essentials.
Write-Host "[copy-standalone] Stripping source tree from standalone copy ..."
$StripDirs = @('app', 'components', 'hooks', 'lib', 'types', 'docs', 'tests', 'scripts', 'design', 'assets')
foreach ($d in $StripDirs) {
    $path = Join-Path $AppDir $d
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path
        Write-Host "  removed $d/"
    }
}
# The Tauri webview launches via start.js (the wrapper), which only
# needs server.js + node_modules subset. Keep .next/ (where .next/static
# landed) and start.js. Drop the project-root cruft that standalone
# also dragged in (bun.lock, package-lock.json, tsconfig.tsbuildinfo,
# HANDOFF.md, BRAND.md, etc.) — they aren't needed at runtime.
$StripFiles = @('bun.lock', 'package-lock.json', 'tsconfig.tsbuildinfo', 'HANDOFF.md', 'BRAND.md', 'NOTICE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'QA.md', 'DESIGNER.md', 'metadata.json', 'package.json', 'tsconfig.json', 'eslint.config.mjs', 'postcss.config.mjs', 'next.config.ts', 'next-env.d.ts', 'vercel.json', '.eslintrc.json', 'LICENSE', 'build-local.bat', 'build-windows.ps1')
foreach ($f in $StripFiles) {
    $path = Join-Path $AppDir $f
    if (Test-Path $path) {
        Remove-Item -Force $path
    }
}
# Drop src/ subtree if present (standalone shouldn't include it but
# be defensive — see HANDOFF.md §9.1 "Tauri `frontendDist` rejects
# paths containing `node_modules`" gotcha).
$SrcPath = Join-Path $AppDir 'src'
if (Test-Path $SrcPath) {
    Remove-Item -Recurse -Force $SrcPath
}
Write-Host "[copy-standalone] Done (post-strip)."
