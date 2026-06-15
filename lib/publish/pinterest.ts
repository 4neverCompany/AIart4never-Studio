/**
 * Pinterest publish flow — a single "create pin" Composio tool call.
 *
 * Unlike Instagram's multi-step container/publish dance, a Pinterest pin is
 * created and published in ONE call, so the plan is a single step whose result
 * carries the published pin id directly.
 *
 * The exact Composio Pinterest slug is a stable COMPOSIO tool name resolved
 * from the connector's tool list at runtime; it is kept here as a named const
 * so swapping it (if the connector exposes a different slug) is a one-line edit.
 */

import type { PublishPlan, PublishRequest, PublishStep } from './types';

/**
 * Composio tool slug for "create a pin". COMPOSIO tool names are stable slugs;
 * if the connected Pinterest connector advertises a different one (check its
 * `listMcpTools` output), change it HERE — it's the single source of truth.
 */
export const PINTEREST_CREATE_PIN = 'PINTEREST_CREATE_PIN';

/**
 * Build the (single-step) Pinterest publish plan for `req`.
 *
 * Pins the FIRST asset (`assets[0]`) to `boardId` with `caption` as the pin's
 * note/description. Pinterest pins are single-image, so any extra assets are
 * ignored by design — the caller decides which asset to pin.
 *
 * `req.options.link` (when present and a string) is threaded through as the
 * pin's outbound link.
 *
 * Throws when there are no assets, or when `boardId` is missing (a pin must
 * land on a board).
 */
export function buildPinterestPlan(req: PublishRequest): PublishPlan {
  const asset = req.assets[0];
  if (!asset) {
    throw new Error('buildPinterestPlan: no assets to publish');
  }
  if (!req.boardId) {
    throw new Error('buildPinterestPlan: boardId is required to create a pin');
  }

  const link = typeof req.options?.link === 'string' ? req.options.link : undefined;

  const step: PublishStep = {
    tool: PINTEREST_CREATE_PIN,
    args: {
      board_id: req.boardId,
      image_url: asset.url,
      // Pinterest's field is `description` (a.k.a. the pin "note").
      description: req.caption,
      ...(link ? { link } : {}),
    },
    description: `Create Pinterest pin on board ${req.boardId} for asset ${asset.id}`,
  };

  return { target: 'pinterest', steps: [step] };
}
