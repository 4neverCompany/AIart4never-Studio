# Third-Party Licences

> CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): new file. Acknowledges the
> third-party packages bundled with MashupForge that aren't tracked
> in the standard lockfile-and-Dependabot flow.

## v1.1.0 additions

### @askjo/camofox-browser v1.11.2

- **Upstream:** <https://github.com/jo-inc/camofox-browser>
- **License:** MIT (see `node_modules/@askjo/camofox-browser/LICENSE` after install, or the upstream repo)
- **Path in our bundle:** `src-tauri/resources/camofox/package/`
  (fetched at build time by `scripts/fetch-camofox-browser.ps1`,
  not committed to git)
- **License compatibility:** MIT is compatible with our
  AGPL-3.0-or-later. No action required.
- **Modifications:** None — we ship the upstream tarball verbatim.

### Camoufox engine (downloaded by camofox-browser at first run)

- **Upstream:** <https://github.com/daijro/camoufox>
- **License:** MPL-2.0 (Mozilla Public License 2.0)
- **Path:** Downloaded by camofox-browser's `postinstall` to
  `~/.camofox/` (~300 MB, not in our installer).
- **License compatibility:** MPL-2.0 is compatible with our
  AGPL-3.0-or-later. The MPL-2.0 file-level copyleft applies to
  Camoufox's own source files; we don't distribute any Camoufox
  modifications. No action required.
- **Modifications:** None.

## How to update this file

When a new third-party package is bundled (added to the NSIS
installer, fetched by a build script, or downloaded by a sidecar
at runtime), add a section here with:

1. Package name + version
2. Upstream URL
3. License type (link to the LICENSE file or the SPDX identifier)
4. Path in the bundle (or where the binary lands at runtime)
5. License compatibility with AGPL-3.0-or-later (most permissive
   licenses are compatible; some weak-copyleft like LGPL-2.1 are
   compatible with care; GPL-3.0 is compatible; AGPL is what we
   already are; SSPL is NOT)
6. Modifications (or "None" if we ship the upstream verbatim)

If a license is incompatible, flag it in the PR description and
do not merge without Maurice's sign-off.
