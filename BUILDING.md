# Building MashupForge

## Prerequisites
- Node.js 20 LTS
- npm OR bun (bun is primary; npm is fallback — see below)
- Rust 1.77.2+ (for Tauri desktop build)
- Windows: NSIS (for the installer)

## Web build (Vercel)
```bash
npm install        # or: bun install
npm run dev        # local dev
npm run build      # production build → .next/standalone
```

## Desktop build (Tauri 2, Windows NSIS)
```bash
# 1. Install JS deps
bun install || npm install

# 2. Build the Next.js standalone output
npm run build

# 3. Copy the standalone output into src-tauri/frontend-stub
# (release.yml does this in CI; locally you can do it manually:)
mkdir -p src-tauri/frontend-stub
cp -r .next/standalone/. src-tauri/frontend-stub/
cp -r .next/static src-tauri/frontend-stub/.next/static
cp -r public src-tauri/frontend-stub/public 2>/dev/null || true

# 4. Build the Tauri installer
npm run tauri:build
# → installer goes to src-tauri/target/release/bundle/nsis/
```

## Package manager policy
Bun is the primary package manager (faster, more correct). The
`package-lock.json` is the fallback when bun misbehaves (it's
pre-1.0 and occasionally has install bugs).

- On a clean checkout, try `bun install --frozen-lockfile` first.
- If bun fails, run `npm install` (this regenerates the npm lockfile).
- The `bun.lock freshness` CI check will fail if `package-lock.json`
  is newer than `bun.lock` — fix by running `bun install` and committing
  the refreshed `bun.lock`.

## Tauri signing
Auto-update requires a signing key. Generate one:
```bash
npx tauri signer generate -w ~/.tauri/mashupforge.key
```
Add the private key + password to GitHub Secrets:
- TAURI_SIGNING_PRIVATE_KEY (file contents)
- TAURI_SIGNING_PRIVATE_KEY_PASSWORD
- TAURI_UPDATER_PUBLIC_KEY (the pubkey, set in tauri.conf.json
  `plugins.updater.pubkey`)

## Auto-update
The Tauri auto-updater checks
https://github.com/4neverCompany/MashupForge/releases/latest/download/latest.json
on every app start. When a new release is published, the desktop
app prompts the user to update. The signature on the update
payload is verified against the public key in tauri.conf.json.

## Verifying a release
1. Download the .msi or .exe from the GitHub Release
2. Verify the SHA-256 checksum (provided in the release notes)
3. Run the installer; it should drop the binary in
   `%LOCALAPPDATA%\Programs\MashupForge\`
4. Launch the app; it should auto-update from the previous version
