# Dev preview / live verification

## TL;DR

```
bun run dev        # → http://localhost:3000  (Next dev, this repo)
```

The Claude Code **preview** integration reads `.claude/launch.json`. This repo
ships a local (gitignored) config named **`aiart4never-dev`** (`bun run dev`,
port 3000) — start it with the preview tool by that name.

## The cross-repo gotcha (why a preview once showed "MashupForge")

AIart4never Studio was forked from the sibling repo **MashupForge**, which lives
in a separate working tree (`…/c4n-MashupForge`, GitHub `4neverCompany/MashupForge`).
If a Claude Code session is rooted in the MashupForge tree instead of this one,
the preview server runs **that** repo — so you'd see the old "Mashup Studio"
header, "Generate Mashup" CTA, etc., even though this repo is fully rebranded.

Two consequences worth knowing:

1. **Start the session/preview from THIS repo** (`c4n-Master4neverAgent`). Then
   `aiart4never-dev` is the canonical preview config and everything is native.
2. The preview MCP **caches its launch-config list at startup** — adding a new
   config to `launch.json` mid-session is not picked up until the preview server
   restarts (next session). So if `preview_start <name>` reports "not found"
   right after you added it, that's expected; restart resolves it.

A bridge config named **`aiart4never`** is also registered in the MashupForge
tree's `.claude/launch.json` (`cmd /c "cd /d …c4n-Master4neverAgent && bun run dev
-- --port 3008"`, port 3008) so a preview rooted in MashupForge can still serve
THIS repo on 3008 after a restart.

## Verifying the design (Ashen Cyberforge)

The orange re-skin + the AIart4never copy are verified by source + a green
`bun run build`. For a live check once the preview targets this repo:

1. `preview_start aiart4never-dev` (or `aiart4never` from the MashupForge tree).
2. Open `/studio` → header reads **"AIart4never Studio"**, the CTA is
   **"Generate Beat"**, the empty state is **"No beats yet"**.
3. Settings → **Customize** tab → Connectors & Skills manager (orange primary,
   cyan secondary, ashen surfaces).

If the StartupReconciler ever logs `getAllPosts undefined` again, see
`hooks/useReconciler.ts` — storage MUST be built via the async
`IdbPostLifecycleStorage.open()` factory, never `new IdbPostLifecycleStorage()`.
