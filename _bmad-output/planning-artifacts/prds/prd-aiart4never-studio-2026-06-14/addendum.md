# PRD Addendum — AIart4never Studio (technical depth)

Technical-how that belongs downstream (architecture / solution design), kept out of the
capability-level PRD. Full detail lives in `docs/PRODUCT-BRIEF.md`; this is the extract.

## Reuse base (MashupForge → adapt + harden, Repo Strategy B)
Adopt-as-is (adapt, not copy): provider registry `lib/providers/registry.ts`, agent-loop
`lib/agent-loop/` (Vercel AI SDK `ToolLoopAgent` + budget + `stopWhen`), post-lifecycle state-machine
`lib/post-lifecycle/`, watermark `lib/watermark.ts`, settings-schema `lib/desktop-config-keys.ts`
(→ extend into the Connectors/Skills registry, FR-17–19), asset hosting `app/api/upload`, error
hierarchy `lib/agent-tools/errors.ts`, pipeline daemon `lib/pipeline-processor.ts`, credit budget
`lib/credit-budget.ts`, Tauri NSIS + minisign auto-update + CI. **Drop:** the mashup content brain;
the homegrown `web-search`/`trending-client` (unreliable → replace per FR-15).

## LLM wiring — MiniMax-M3 only, on subscription (FR-20)
- **Auth:** MiniMax **Token Plan** subscription → per-team Subscription Key (prefix `sk-cp-`, not
  interchangeable with PAYG keys), same OpenAI-compatible endpoint `https://api.minimax.io/v1`
  (`api.minimaxi.com/v1` for China — key must match region), `Authorization: Bearer`.
- **Model id:** `MiniMax-M3`. Tool-calling via `tools` + `tool_choice` (no legacy `function_call`).
- **Load-bearing gotcha:** AI SDK v6 `@ai-sdk/openai` default targets the **Responses API**, which
  MiniMax does NOT implement → 404 on first call. **Force Chat Completions** —
  `@ai-sdk/openai-compatible` `createOpenAICompatible({name,apiKey,baseURL})`, or `openai.chat('MiniMax-M3')`
  (the proven MashupForge path; that repo hardcodes the LEGACY `api.minimaxi.chat/v1` — use `api.minimax.io/v1`).
- **Behaviour:** prefer tool-calls (Zod) over JSON mode (silently ignored on M3); strip `<think>…</think>`.
- **Quotas:** Plus $20 / Max $50 / Ultra $120 mo (3-4 / 4-5 / 6-7 agents); Ultra ≈ 12.5B M3 tok/mo;
  5h-rolling + weekly window; throttle (~1 min) when exceeded — single-user desktop never hits it.
  Don't hard-depend on `/v1/token_plan/remains` (in-flux, may be cookie-gated).
- **Risk posture:** M3 tool discipline unverified independently → bounded by Approval Gate (FR-10) +
  flat subscription.

## Web-research Connector (FR-15)
- **Primary: Exa** — remote MCP `https://mcp.exa.ai/mcp?exaApiKey=KEY` (or stdio `npx -y exa-mcp-server`,
  `EXA_API_KEY`). Semantic search + page-content fetch + domain/date filters. Free 20,000 req/mo.
- **Fallback: Tavily** — `https://mcp.tavily.com/mcp/?tavilyApiKey=KEY` (Nebius-acquired Feb 2026).
- **Pattern:** public-web discovery + clean extraction (blogs/ArtStation/Reddit/roundups). **No**
  direct IG/TikTok/Pinterest scraping (Firecrawl blocks them; ToS). Apify = opt-in specialist only.

## Media generation (FR-2/4/6)
- **Primary:** Higgsfield (official hosted MCP `mcp.higgsfield.ai/mcp`), anchored to locked Elements
  (Kael `9349dc19`, Kaelus `812c9a78`, watermark `6c36180d`).
- **Alternates (pluggable):** MiniMax **Hailuo** (video) / `image-01` (text-to-image), Leonardo.
- **Pipeline (locked, ffmpeg):** watermark 75% (variants) → crop 4:5 / 2:3 / 9:16 → host on public URL.

## Publishing (FR-8/9)
- **Instagram:** Composio MCP (`INSTAGRAM_POST_IG_USER_MEDIA` + `_PUBLISH`; carousel/story/reel),
  account `aiart4never`. **Pinterest:** fresh adapter from the current Pinterest API (MashupForge's
  is a stub) — or Zapier `pinterest_create_pin` interim. All behind the Approval Gate (FR-10).

## Distribution (Platform NFR)
- Tauri → Windows **NSIS `.exe`**, `createUpdaterArtifacts: true`, signed **minisign** auto-update;
  GitHub Actions (`tauri-windows.yml` et al.). **Public** repo/releases (private = rate-limited +
  storage-capped). Signing key = CI secret; only the public key ships.

## PM linkage
Linear project "AIart4never Studio" (team 4nevercompany): M0 Fork→ (Repo-B) / M1 Canon / M2 Loop /
M3 Growth / M4 Scale; 16 issues incl. 4NE-12 (Connectors manager), 4NE-13 (CLI), 4NE-16 (web-research
MCP), 4NE-20 (MiniMax wiring).
