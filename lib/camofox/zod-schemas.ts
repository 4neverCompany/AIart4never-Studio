/**
 * CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): Zod response-validation schemas.
 *
 * Every camofox response body the client consumes gets a schema
 * here. We use Zod (not manual `typeof` checks) because:
 * 1. Parse errors throw a typed `CamofoxParseError` instead of
 *    silently coercing to `[]` (silent-empty is the original
 *    `lib/web-search.ts` antipattern this whole migration was
 *    meant to fix).
 * 2. Zod's TS inference gives us runtime + compile-time safety
 *    from a single declaration.
 *
 * Schema list maps 1:1 to the public surface of `client.ts`:
 *   - /health        → zCamofoxHealth
 *   - /tabs          → zCamofoxTabOpen
 *   - /links         → zCamofoxLink (array element)
 *   - /snapshot      → text-only, no schema
 */
import { z } from 'zod';

/**
 * /health response (200 OK). Example:
 *   { ok: true, engine: "camoufox", browserConnected: true, ... }
 *
 * We mark every field optional except `ok` because camofox
 * historically adds fields without bumping versions, and we don't
 * want a 1.11.3 release with one new field to break 1.11.2 clients.
 * The `engine` field is what we use to detect "is this a camofox
 * service or something else on the same port" (see Day 1's
 * `is_camofox_responding_on` in `src-tauri/src/lib.rs`).
 */
export const zCamofoxHealth = z.object({
  ok: z.boolean().optional(),
  engine: z.string().optional(),
  browserConnected: z.boolean().optional(),
  browserRunning: z.boolean().optional(),
  activeTabs: z.number().optional(),
  activeSessions: z.number().optional(),
  consecutiveFailures: z.number().optional(),
  recovering: z.boolean().optional(),
});

/**
 * /tabs POST response. The server returns either `{ tabId }` or
 * `{ id }` (server versions pre-1.10 used `id`; 1.10+ standardized
 * on `tabId`). We accept both via a union.
 */
export const zCamofoxTabOpen = z.union([
  z.object({ tabId: z.string() }),
  z.object({ id: z.string() }),
]);

/**
 * /tabs/{id}/links response element. Each link has a `ref` (e.g.
 * `e4`), a `url`, and `text` (the link's visible text). The
 * mapper in `client.ts` uses `text` as the result title.
 *
 * `text` is optional because some camofox versions return icon
 * links with empty text. `url` is required — a link without a
 * destination is unusable.
 */
export const zCamofoxLink = z.object({
  ref: z.string().optional(),
  url: z.string(),
  text: z.string().optional().default(''),
});
