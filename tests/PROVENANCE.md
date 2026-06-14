# Test Suite Provenance — 110/110 tests

Maps each test file to the story/audit that created it and what it guards.

| File | Tests | Origin | Guards |
|------|------:|--------|--------|
| `lib/aiClient.test.ts` | 17 | `43b67d8` — JSON.parse safety for LLM output | `extractJsonArrayFromLLM`, `extractJsonObjectFromLLM` — fence stripping, malformed JSON fallback |
| `lib/smartScheduler.test.ts` | 16 | `801447f` — PROP-011 phase 4 coverage | `findBestSlots`, `findBestSlot`, `loadEngagementData`, `saveEngagementData` — slot scoring, platform caps, TTL expiry |
| `api/proxy-image-allowlist.test.ts` | 14 | `a2411c2` — SEC-001/002/003 SSRF allowlist | `isAllowedUrl` — protocol downgrade, SSRF via localhost/127.0.0.1, host suffix lookalike, case sensitivity |
| `lib/errors.test.ts` | 10 | `2448254` — getErrorMessage(undefined) fix | `getErrorMessage`, `isError` — edge cases: circular objects, null, undefined, non-Error shapes |
| `lib/modelOptimizer.test.ts` | 8 | `801447f` — PROP-011 phase 4 coverage | `enhancePromptForModel` — negative prompt stripping for gpt-image, aspect ratio defaults, style passthrough |
| `hooks/mergeSettings.test.ts` | 8 | `e124ce8` — AUDIT-051 POLISH-018 gate | `mergeSettings` — undefined stripping, watermark deep-merge, apiKeys deep-merge, partial patch preservation |
| `lib/fetchWithRetry.test.ts` | 7 | `3ff243f` — OPT-002 transient failure retry | `fetchWithRetry` — 200 passthrough, 4xx no-retry, 500 retry-then-succeed, network error exhaustion |
| `lib/pi-setup.test.ts` | 7 | `cbe178a` — STORY-091 trending error fix | `resolvePiJsEntry` — scalar/object bin field, missing package.json, malformed JSON, missing entry file |
| `lib/desktop-config-keys.test.ts` | 10 | `914c1fd` — VERIFY-001 + CRED-001 gate | `DESKTOP_CONFIG_KEYS` — locks all 11 keys: LEONARDO, ZAI, IG, Twitter×4, Pinterest×2, Discord |
| `lib/instagram-credentials.test.ts` | 7 | `614e8ec` — VERIFY-003 env-first resolver gate | `resolveInstagramCredentials` — env-over-body priority, partial env, undefined body, web fallback |
| `lib/runtime-env.test.ts` | 7 | `ff31bd5` — AUDIT-047 serverless guard gate | `isServerless` — VERCEL/AWS_LAMBDA/NETLIFY/CF_PAGES flags, empty-string non-match, multi-flag |

## Coverage by category

- **Security:** 14 tests (proxy-image SSRF allowlist)
- **Data integrity:** 32 tests (instagram-credentials, desktop-config-keys, runtime-env, mergeSettings)
- **LLM output safety:** 17 tests (aiClient JSON extraction)
- **Scheduler correctness:** 16 tests (smartScheduler slot scoring + engagement cache)
- **Error handling:** 17 tests (errors + fetchWithRetry)
- **Model pipeline:** 8 tests (modelOptimizer prompt enhancement)
- **Desktop setup:** 7 tests (pi-setup binary resolution)
