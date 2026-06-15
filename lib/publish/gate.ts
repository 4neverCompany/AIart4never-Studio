/**
 * THE HUMAN GATE — the product's core safety property.
 *
 * Nothing reaches Instagram / Pinterest unless a human approved it. Every
 * publish flows through {@link assertPublishable} BEFORE any network call (the
 * dispatcher runs it as its first statement — see `lib/publish/dispatch.ts`).
 * There is deliberately NO bypass flag: the only way past the gate is for the
 * operator to flip `approved = true` on each asset via the approval UI.
 *
 * `GeneratedImage.approved` is the gate flag: persisted `false` at generation,
 * flipped `true` only by the operator. The gate refuses any set where the list
 * is empty, ANY asset is not explicitly `approved === true`, or any asset lacks
 * a `url` (we can't publish what we can't fetch).
 *
 * Watermarking is applied UPSTREAM at generation (`lib/canon` WATERMARK recipe);
 * the gate does NOT re-watermark. {@link softWatermarkWarnings} is a non-throwing
 * advisory only — it never blocks a publish.
 */

import type { GeneratedImage } from '@/types/mashup';

/**
 * Typed error thrown by {@link assertPublishable} when a set fails the human
 * gate. `code` lets callers branch (UI copy, telemetry) without string-matching
 * the message; `assetIds` lists the offending assets where applicable.
 *
 * Mirrors the project's `McpError` convention (stable `code`, prototype fix-up
 * for `instanceof` after transpilation).
 */
export type PublishGateErrorCode =
  | 'empty-set'
  | 'not-approved'
  | 'missing-url';

export class PublishGateError extends Error {
  readonly code: PublishGateErrorCode;
  /** Ids of the assets that tripped the gate (empty for `empty-set`). */
  readonly assetIds: string[];

  constructor(code: PublishGateErrorCode, message: string, assetIds: string[] = []) {
    super(message);
    this.name = 'PublishGateError';
    this.code = code;
    this.assetIds = assetIds;
    // Preserve `instanceof` after ES2017 transpilation.
    Object.setPrototypeOf(this, PublishGateError.prototype);
  }
}

/**
 * The hard stop. Throws a {@link PublishGateError} when the set is unpublishable.
 *
 * Throw conditions, checked in order:
 *   1. `empty-set`    — the list is empty (nothing to publish).
 *   2. `not-approved` — ANY asset has `approved !== true` (the human gate).
 *   3. `missing-url`  — any asset lacks a non-empty `url`.
 *
 * Returns `void` on success. There is no return value and no bypass — a thrown
 * error is the only signal, and the caller must not catch-and-continue past it.
 */
export function assertPublishable(assets: GeneratedImage[]): void {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new PublishGateError('empty-set', 'Nothing to publish: the asset set is empty.');
  }

  // The human gate: every asset must be EXPLICITLY approved. `approved` is
  // optional on the type and undefined by default, so `!== true` correctly
  // rejects both the unset and the explicit-false cases.
  const unapproved = assets.filter((a) => a.approved !== true);
  if (unapproved.length > 0) {
    throw new PublishGateError(
      'not-approved',
      `Publish blocked: ${unapproved.length} asset(s) are not approved by a human. ` +
        'Approve them in the review UI first — there is no bypass.',
      unapproved.map((a) => a.id),
    );
  }

  // Composio fetches the media server-side from `url`; an asset without one
  // cannot be published even though it is approved.
  const missingUrl = assets.filter((a) => !a.url || a.url.trim() === '');
  if (missingUrl.length > 0) {
    throw new PublishGateError(
      'missing-url',
      `Publish blocked: ${missingUrl.length} approved asset(s) have no url to publish.`,
      missingUrl.map((a) => a.id),
    );
  }
}

/**
 * Marker substring the watermark recipe stamps onto an asset's tags. Assets are
 * watermarked at generation time (see `lib/canon` WATERMARK); a tag carrying
 * this marker is the soft signal that the watermark was applied. Kept a named
 * const so a future tag-convention change is a one-line edit.
 */
export const WATERMARK_TAG_MARKER = 'watermark';

/**
 * Non-throwing advisory: flags assets that look unwatermarked (no tag contains
 * {@link WATERMARK_TAG_MARKER}). This is a SOFT check only — the watermark is
 * applied upstream at generation, so a missing marker usually means the asset
 * pre-dates tag tracking, not that it is unwatermarked. The dispatcher surfaces
 * these as warnings; they NEVER block a publish (that's the gate's job).
 *
 * Returns one human-readable warning string per suspect asset (empty array when
 * all assets carry the marker).
 */
export function softWatermarkWarnings(assets: GeneratedImage[]): string[] {
  if (!Array.isArray(assets)) return [];
  const warnings: string[] = [];
  for (const a of assets) {
    const tags = Array.isArray(a.tags) ? a.tags : [];
    const looksWatermarked = tags.some((t) =>
      t.toLowerCase().includes(WATERMARK_TAG_MARKER),
    );
    if (!looksWatermarked) {
      warnings.push(
        `Asset ${a.id} has no "${WATERMARK_TAG_MARKER}" tag — verify it was watermarked at generation (advisory only).`,
      );
    }
  }
  return warnings;
}
