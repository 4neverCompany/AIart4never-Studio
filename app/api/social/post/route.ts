import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import { resolveInstagramCredentials } from '@/lib/instagram-credentials';

const IG_GRAPH_API_VERSION = 'v21.0';

// POST-NONJSON-DIAG (2026-05-21): typed error class so the outer catch
// can surface upstream URL + Vercel-edge headers + body snippet in the
// JSON error response. Maurice hit a "Request Enqueued" plain-text body
// that the IG branch's parseJsonOrThrow already names, but the route
// also had an unwrapped res.json() (Pinterest uguu upload) and the
// frontend had no visibility into which upstream produced the failure
// or whether a Vercel edge/WAF layer intercepted before our code ran.
const VERCEL_DIAG_HEADERS = [
  'x-vercel-id',
  'x-vercel-error',
  'x-vercel-mitigated',
  'server',
] as const;

function pickVercelHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of VERCEL_DIAG_HEADERS) {
    const v = res.headers.get(h);
    if (v) out[h] = v;
  }
  return out;
}

class UpstreamNonJsonError extends Error {
  readonly upstreamUrl: string;
  readonly upstreamStatus: number;
  readonly upstreamBodySnippet: string;
  readonly upstreamHeaders: Record<string, string>;
  constructor(
    context: string,
    url: string,
    status: number,
    snippet: string,
    headers: Record<string, string>,
  ) {
    super(
      `${context} [${url}]: server returned non-JSON (HTTP ${status}). First 200 chars: ${snippet || '<empty>'}`,
    );
    this.name = 'UpstreamNonJsonError';
    this.upstreamUrl = url;
    this.upstreamStatus = status;
    this.upstreamBodySnippet = snippet;
    this.upstreamHeaders = headers;
  }
}

/** Platform branch tracker — updated as the handler enters each block. */
type ActiveBranch =
  | 'init'
  | 'parse-input'
  | 'fetch-media'
  | 'instagram'
  | 'twitter'
  | 'pinterest'
  | 'discord'
  | 'finalize';

/**
 * Parse a response body as JSON, or throw a readable error that includes
 * HTTP status + a snippet of the raw body. Graph API and uguu both return
 * HTML error pages on some failure modes (rate limits, 502s, maintenance
 * windows); calling plain `res.json()` on those bodies throws the generic
 * "Unexpected token < in JSON at position 0" that users can't action.
 *
 * STORY-133: Instagram posting surfaced that raw parse error with no hint
 * of which endpoint failed or what the server actually said.
 */
async function parseJsonOrThrow(res: Response, context: string): Promise<Record<string, unknown>> {
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const snippet = raw.slice(0, 200).replace(/\s+/g, ' ').trim();
    // POST-NONJSON-DIAG (2026-05-21): throw a typed error carrying url +
    // status + body snippet + Vercel-edge headers so the outer catch can
    // include them in the JSON error response. Maurice can then read the
    // toast to identify whether a Vercel WAF/queue intercept, a Meta
    // anti-abuse response, or an uguu degradation produced the body.
    throw new UpstreamNonJsonError(
      context,
      res.url,
      res.status,
      snippet,
      pickVercelHeaders(res),
    );
  }
}

/** Extract .error.message from a parsed Graph API / uguu response. */
function apiErrMsg(data: Record<string, unknown>): string {
  const e = data.error;
  if (typeof e === 'object' && e !== null) {
    return ((e as Record<string, unknown>).message as string | undefined) ?? JSON.stringify(e);
  }
  return String(e ?? '');
}

/**
 * Poll IG container status until FINISHED (or ERROR/EXPIRED). Replaces a
 * blind 5-second sleep that flaked on slow uploads and wasted 5s on fast ones.
 *
 * FIX-101: Graph API exposes `GET /{container-id}?fields=status_code` which
 * returns IN_PROGRESS, FINISHED, ERROR, EXPIRED, or PUBLISHED. Poll every
 * 1.5s up to 60s. Throws on terminal failure states.
 */
async function waitForIgContainerReady(
  hostUrl: string,
  containerId: string,
  accessToken: string,
  context: string,
): Promise<void> {
  const intervalMs = 1500;
  const timeoutMs = 60_000;
  const started = Date.now();

  while (true) {
    const statusRes = await fetch(
      `https://${hostUrl}/${IG_GRAPH_API_VERSION}/${containerId}?fields=status_code`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) },
    );
    const statusData = await parseJsonOrThrow(statusRes, `${context} status poll`);
    if (statusData.error) {
      throw new Error(`${context} status poll error: ${apiErrMsg(statusData)}`);
    }
    const code = statusData.status_code as string | undefined;
    if (code === 'FINISHED' || code === 'PUBLISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`${context} container ${code.toLowerCase()} before publish`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${context} container not ready after ${timeoutMs / 1000}s (last status=${code ?? 'unknown'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Pad an image to fit Instagram's accepted aspect ratio range (4:5 → 1.91:1).
 *
 * Instagram center-crops any image outside this range on upload, which was
 * cutting off watermarks placed near the edges. We instead letterbox the
 * source image on a black canvas sized to the nearest safe ratio, so the
 * entire original frame survives.
 *
 * - Too tall (ratio < 4/5): add horizontal black bars (pillarbox) until
 *   the canvas reaches 4:5 portrait.
 * - Too wide (ratio > 1.91): add vertical black bars (letterbox) until
 *   the canvas reaches 1.91:1 landscape.
 * - Already in range: returned unchanged.
 */
async function prepareForInstagram(buffer: Buffer): Promise<Buffer> {
  type SharpFn = (input?: Buffer | string) => { metadata(): Promise<{ width?: number; height?: number }>; resize(opts: Record<string, unknown>): { jpeg(opts: Record<string, unknown>): { toBuffer(): Promise<Buffer> } } };
  let sharpFn: SharpFn;
  try {
    const mod = await import('sharp');
    sharpFn = (mod.default ?? mod) as unknown as SharpFn;
  } catch {
    return buffer;
  }

  const meta = await sharpFn(buffer).metadata();
  const { width = 1080, height = 1080 } = meta;
  const ratio = width / height;

  const MIN_RATIO = 4 / 5; // 0.8 — tallest portrait IG accepts
  const MAX_RATIO = 1.91;  // widest landscape IG accepts

  if (ratio >= MIN_RATIO && ratio <= MAX_RATIO) {
    return buffer;
  }

  let newWidth: number;
  let newHeight: number;

  if (ratio < MIN_RATIO) {
    newHeight = height;
    newWidth = Math.ceil(height * MIN_RATIO);
  } else {
    newWidth = width;
    newHeight = Math.ceil(width / MAX_RATIO);
  }

  return sharpFn(buffer)
    .resize({
      width: newWidth,
      height: newHeight,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 1 },
      position: 'center',
    })
    .jpeg({ quality: 95 })
    .toBuffer();
}

export async function POST(req: Request) {
  // POST-NONJSON-DIAG (2026-05-21): tracker shared between the try and the
  // outer catch so the failure response can name which platform branch was
  // executing when the throw happened. Updated as the handler crosses
  // branch boundaries.
  let activeBranch: ActiveBranch = 'init';
  // Original request body, captured before any platform branch runs, so
  // the outer catch can emit a redacted replay-cURL for Maurice. Captured
  // separately because `await req.json()` consumes the body.
  let rawBodyForReplay: Record<string, unknown> | null = null;
  try {
    activeBranch = 'parse-input';
    const parsed = await req.json();
    rawBodyForReplay = parsed;
    const { caption, platforms, mediaUrl, mediaUrls, mediaBase64, credentials } = parsed;

    // Fix 5 (mmx brief): old scheduled content arrived here with empty
    // mediaUrl AND no base64, then silently produced a 0-image post that
    // exploded later inside the platform branches with a cryptic Graph
    // API error. Validate the contract up front.
    if (!Array.isArray(platforms) || platforms.length === 0) {
      return NextResponse.json({ error: 'platforms is required and must be a non-empty array' }, { status: 400 });
    }

    const results: Record<string, unknown> = {};

    // Helper to get image buffers
    const imageItems: { buffer: Buffer, mimeType: string, url?: string }[] = [];

    activeBranch = 'fetch-media';
    const urlsToProcess = mediaUrls && mediaUrls.length > 0 ? mediaUrls : (mediaUrl ? [mediaUrl] : []);

    for (const url of urlsToProcess) {
      let buffer: Buffer | null = null;
      let mimeType = 'image/jpeg';

      if (url.startsWith('data:')) {
        const base64Data = url.split(',')[1];
        if (base64Data) {
          buffer = Buffer.from(base64Data, 'base64');
          mimeType = url.split(';')[0].split(':')[1] || 'image/jpeg';
        }
      } else {
        // Fix 5: Leonardo signed URLs expire after ~24h. Without an
        // ok-check, the route was reading the JSON error body as if it
        // were the image and forwarding the bytes downstream, where IG
        // / uguu would reject them with confusing errors. Refuse early
        // with a host- and status-aware message instead.
        let imgRes: Response;
        try {
          imgRes = await fetch(url, { signal: AbortSignal.timeout(15000) });
        } catch (e) {
          throw new Error(`Failed to fetch media URL (${getErrorMessage(e)}): ${url}`);
        }
        if (!imgRes.ok) {
          const isLeonardo = url.includes('leonardo.ai') || url.includes('storage.googleapis.com');
          const hint = isLeonardo
            ? ' (Leonardo signed URLs expire ~24h after generation; the image needs to be re-hosted or the post was generated too long ago)'
            : '';
          throw new Error(`Media URL returned HTTP ${imgRes.status} ${imgRes.statusText}${hint}: ${url}`);
        }
        const arrayBuffer = await imgRes.arrayBuffer();
        if (arrayBuffer.byteLength === 0) {
          throw new Error(`Media URL returned an empty response body: ${url}`);
        }
        buffer = Buffer.from(arrayBuffer);
        mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
      }

      if (buffer) {
        imageItems.push({ buffer, mimeType, url: url.startsWith('http') ? url : undefined });
      }
    }

    // Fallback for mediaBase64 (single image)
    if (imageItems.length === 0 && mediaBase64) {
      imageItems.push({ buffer: Buffer.from(mediaBase64, 'base64'), mimeType: 'image/jpeg' });
    }

    // Fix 5: every platform branch below assumes at least one image.
    // Bail with a clear error if neither mediaUrl(s) nor mediaBase64
    // produced a usable buffer (covers the "old content with expired
    // Leonardo URL and no base64 backup" case the brief flagged).
    if (imageItems.length === 0) {
      return NextResponse.json(
        { error: 'No image to post — mediaUrl(s) failed to fetch and no mediaBase64 fallback was provided' },
        { status: 400 }
      );
    }

    if (platforms.includes('instagram')) {
      activeBranch = 'instagram';
      const { igAccountId: igAccountIdRaw, igAccessToken: igAccessTokenRaw } =
        resolveInstagramCredentials(process.env, credentials?.instagram);
      if (!igAccessTokenRaw || !igAccountIdRaw) {
        throw new Error('Instagram credentials incomplete');
      }
      const igAccountId = igAccountIdRaw.trim().replace(/[^0-9]/g, '');
      const igAccessToken = igAccessTokenRaw.trim();

      if (igAccessToken.startsWith('IGAA')) {
        throw new Error('You are using an Instagram Basic Display token (starts with IGAA). To publish posts, you need a Facebook Page Access Token (starts with EAA). Get one from Meta Developer Portal -> Graph API Explorer.');
      }
      if (igAccessToken.startsWith('IGQ')) {
        throw new Error('You are using an Instagram Basic Display token (starts with IGQ). To publish posts, you need a Facebook Page Access Token (starts with EAA). The Basic Display API does not support posting.');
      }

      const hostUrl = 'graph.facebook.com';

      // Preprocess every image through prepareForInstagram so IG doesn't
      // center-crop anything. We build a SEPARATE igItems array instead
      // of mutating imageItems — Twitter / Pinterest / Discord run after
      // this block and each has its own sizing rules that shouldn't get
      // the IG letterboxing applied.
      //
      // Note: we intentionally DO NOT reuse pre-existing Leonardo URLs
      // (item.url) for IG even when they're available. Passing the raw
      // Leonardo URL directly would bypass our padding entirely and IG
      // would crop the original. Every image is re-hosted via uguu with
      // the padded buffer.
      const igItems: { buffer: Buffer; mimeType: string }[] = [];
      for (const item of imageItems) {
        const padded = await prepareForInstagram(item.buffer);
        igItems.push({ buffer: padded, mimeType: 'image/jpeg' });
      }

      const igMediaUrls: string[] = [];
      for (const item of igItems) {
        try {
          const formData = new FormData();
          const blob = new Blob([new Uint8Array(item.buffer)], { type: item.mimeType });
          formData.append('files[]', blob, 'image.jpg');

          const uploadRes = await fetch('https://uguu.se/upload.php', {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(30000),
          });

          const uploadData = await parseJsonOrThrow(uploadRes, 'uguu image upload');
          if (!uploadRes.ok) {
            throw new Error(`uguu upload failed (HTTP ${uploadRes.status}): ${uploadData?.description || uploadData?.error || 'no message'}`);
          }
          const uploadFiles = uploadData.files as Array<Record<string, unknown>> | undefined;
          if (!uploadData.success || !uploadFiles || !uploadFiles[0]) {
            throw new Error('uguu returned invalid response (missing files[0].url)');
          }
          igMediaUrls.push(uploadFiles[0].url as string);
        } catch (e: unknown) {
          if (e instanceof UpstreamNonJsonError) throw e;
          throw new Error(`Failed to host image for Instagram: ${getErrorMessage(e)}`);
        }
      }

      if (igMediaUrls.length === 1) {
        // Single image post
        const containerRes = await fetch(`https://${hostUrl}/${IG_GRAPH_API_VERSION}/${igAccountId}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${igAccessToken}` },
          body: JSON.stringify({ image_url: igMediaUrls[0], caption: caption }),
          signal: AbortSignal.timeout(15000),
        });
        const containerData = await parseJsonOrThrow(containerRes, 'IG Container');
        if (containerData.error) throw new Error(`IG Container Error: ${apiErrMsg(containerData)}`);

        await waitForIgContainerReady(hostUrl, containerData.id as string, igAccessToken, 'IG Container');

        const publishRes = await fetch(`https://${hostUrl}/${IG_GRAPH_API_VERSION}/${igAccountId}/media_publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${igAccessToken}` },
          body: JSON.stringify({ creation_id: containerData.id }),
          signal: AbortSignal.timeout(15000),
        });
        const publishData = await parseJsonOrThrow(publishRes, 'IG Publish');
        if (publishData.error) throw new Error(`IG Publish Error: ${apiErrMsg(publishData)}`);
        results.instagram = publishData;
      } else if (igMediaUrls.length > 1) {
        // Carousel post
        const childrenIds: string[] = [];
        for (const url of igMediaUrls) {
          // FIX-IG-CAROUSEL-CHILD: Graph API rejects carousel children
          // without an explicit `media_type` ("Only photo or video can
          // be accepted as media type"). is_carousel_item alone does
          // not let the API infer the type. We only handle image
          // carousels in this branch (igMediaUrls filters above) so
          // IMAGE is correct; reels/video carousels would need VIDEO +
          // a separate upload flow we don't support yet.
          const childRes = await fetch(`https://${hostUrl}/${IG_GRAPH_API_VERSION}/${igAccountId}/media`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${igAccessToken}` },
            body: JSON.stringify({ media_type: 'IMAGE', image_url: url, is_carousel_item: true }),
            signal: AbortSignal.timeout(15000),
          });
          const childData = await parseJsonOrThrow(childRes, 'IG Carousel Item');
          if (childData.error) throw new Error(`IG Carousel Item Error: ${apiErrMsg(childData)}`);
          childrenIds.push(childData.id as string);
        }

        // Create Carousel Container
        const carouselRes = await fetch(`https://${hostUrl}/${IG_GRAPH_API_VERSION}/${igAccountId}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${igAccessToken}` },
          body: JSON.stringify({ media_type: 'CAROUSEL', children: childrenIds, caption: caption }),
          signal: AbortSignal.timeout(15000),
        });
        const carouselData = await parseJsonOrThrow(carouselRes, 'IG Carousel Container');
        if (carouselData.error) throw new Error(`IG Carousel Container Error: ${apiErrMsg(carouselData)}`);

        await waitForIgContainerReady(hostUrl, carouselData.id as string, igAccessToken, 'IG Carousel Container');

        const publishRes = await fetch(`https://${hostUrl}/${IG_GRAPH_API_VERSION}/${igAccountId}/media_publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${igAccessToken}` },
          body: JSON.stringify({ creation_id: carouselData.id }),
          signal: AbortSignal.timeout(15000),
        });
        const publishData = await parseJsonOrThrow(publishRes, 'IG Carousel Publish');
        if (publishData.error) throw new Error(`IG Carousel Publish Error: ${apiErrMsg(publishData)}`);
        results.instagram = publishData;
      }
    }

    if (platforms.includes('twitter')) {
      activeBranch = 'twitter';
      const twAppKey = process.env.TWITTER_APP_KEY ?? credentials?.twitter?.appKey ?? '';
      const twAppSecret = process.env.TWITTER_APP_SECRET ?? credentials?.twitter?.appSecret ?? '';
      const twAccessToken = process.env.TWITTER_ACCESS_TOKEN ?? credentials?.twitter?.accessToken ?? '';
      const twAccessSecret = process.env.TWITTER_ACCESS_SECRET ?? credentials?.twitter?.accessSecret ?? '';
      if (!twAppKey || !twAppSecret || !twAccessToken || !twAccessSecret) {
        throw new Error('Twitter credentials incomplete');
      }
      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: twAppKey,
        appSecret: twAppSecret,
        accessToken: twAccessToken,
        accessSecret: twAccessSecret,
      });

      const mediaIds: string[] = [];
      for (const item of imageItems.slice(0, 4)) { // Twitter allows up to 4 images
        const mediaId = await client.v1.uploadMedia(item.buffer, { mimeType: item.mimeType });
        mediaIds.push(mediaId);
      }

      const tweet = await client.v2.tweet({
        text: caption,
        // twitter-api-v2 requires an exact-length tuple ([string] | [string,string] | …)
        // but our array length is dynamic (0-4). Double-cast via unknown avoids `as any`.
        ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds as unknown as [string, string, string, string] } } : {})
      });
      results.twitter = tweet;
    }

    if (platforms.includes('pinterest')) {
      activeBranch = 'pinterest';
      const pinAccessToken = process.env.PINTEREST_ACCESS_TOKEN ?? credentials?.pinterest?.accessToken ?? '';
      if (!pinAccessToken) {
        throw new Error('Pinterest access token missing');
      }

      // Pinterest needs a public image URL. Reuse the first image item
      // (Pinterest v5 pins are single-image); upload to uguu if we only
      // have a buffer.
      if (imageItems.length === 0) {
        throw new Error('Pinterest: no image to pin');
      }

      const first = imageItems[0];
      let publicUrl = first.url || null;
      if (!publicUrl) {
        try {
          const formData = new FormData();
          const blob = new Blob([new Uint8Array(first.buffer)], { type: first.mimeType });
          formData.append('files[]', blob, 'pin.jpg');
          const uploadRes = await fetch('https://uguu.se/upload.php', {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(30000),
          });
          // POST-NONJSON-DIAG (2026-05-21): was `await uploadRes.json()`,
          // which bubbled the raw V8 SyntaxError when uguu returned plain
          // text (rate-limit page, "Request Enqueued" overload response,
          // etc.) and the outer catch surfaced that uninformative message
          // verbatim. The IG branch already uses parseJsonOrThrow for the
          // same upload, so mirror it here for parity + named upstream in
          // the error message.
          const uploadData = await parseJsonOrThrow(uploadRes, 'uguu image upload (pinterest)');
          if (!uploadRes.ok) {
            throw new Error(`uguu upload failed (HTTP ${uploadRes.status}): ${(uploadData?.description as string | undefined) ?? (uploadData?.error as string | undefined) ?? 'no message'}`);
          }
          const uploadFiles2 = uploadData.files as Array<Record<string, unknown>> | undefined;
          if (!uploadData?.success || !uploadFiles2?.[0]?.url) {
            throw new Error('uguu returned invalid response');
          }
          publicUrl = uploadFiles2[0].url as string;
        } catch (e: unknown) {
          // Re-throw UpstreamNonJsonError directly so the outer catch keeps
          // its typed fields (url, status, snippet, vercel headers) instead
          // of stringifying through getErrorMessage and dropping them.
          if (e instanceof UpstreamNonJsonError) throw e;
          throw new Error(`Failed to host image for Pinterest: ${getErrorMessage(e)}`);
        }
      }

      const firstLine = (caption || '').split('\n')[0] || 'Mashup';
      const title = firstLine.length > 100 ? firstLine.slice(0, 97) + '…' : firstLine;

      const pinBody: Record<string, unknown> = {
        title,
        description: caption || '',
        media_source: { source_type: 'image_url', url: publicUrl },
      };
      const pinBoardId = process.env.PINTEREST_BOARD_ID ?? credentials?.pinterest?.boardId ?? '';
      if (pinBoardId) {
        pinBody.board_id = pinBoardId;
      }

      const pinRes = await fetch('https://api.pinterest.com/v5/pins', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pinAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pinBody),
        signal: AbortSignal.timeout(15000),
      });
      const pinData = await (pinRes.json() as Promise<Record<string, unknown>>).catch((): Record<string, unknown> => ({}));
      if (!pinRes.ok) {
        const msg = (pinData?.message as string | undefined) || (pinData?.error as string | undefined) || `Pinterest API returned ${pinRes.status}`;
        throw new Error(`Pinterest: ${msg}`);
      }
      results.pinterest = pinData;
    }

    if (platforms.includes('discord')) {
      activeBranch = 'discord';
      const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL ?? credentials?.discord?.webhookUrl ?? '';
      if (!discordWebhookUrl) {
        throw new Error('Discord webhook URL missing');
      }
      const DISCORD_WEBHOOK_PREFIXES = [
        'https://discord.com/api/webhooks/',
        'https://discordapp.com/api/webhooks/',
      ];
      if (!DISCORD_WEBHOOK_PREFIXES.some((p) => discordWebhookUrl.startsWith(p))) {
        throw new Error('Discord webhook URL must start with https://discord.com/api/webhooks/ or https://discordapp.com/api/webhooks/');
      }

      const formData = new FormData();
      formData.append('payload_json', JSON.stringify({ content: caption }));

      imageItems.forEach((item, idx) => {
        const blob = new Blob([new Uint8Array(item.buffer)], { type: item.mimeType });
        formData.append(`files[${idx}]`, blob, `image-${idx}.jpg`);
      });

      const discordRes = await fetch(discordWebhookUrl, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(10000),
      });

      if (!discordRes.ok) {
        const errBody = await discordRes.text().catch(() => '');
        const snippet = errBody.slice(0, 200).replace(/\s+/g, ' ').trim();
        throw new Error(
          `Discord post failed (HTTP ${discordRes.status})${snippet ? `: ${snippet}` : ''}`,
        );
      }
      results.discord = { success: true };
    }

    activeBranch = 'finalize';
    return NextResponse.json({ success: true, results });
  } catch (e: unknown) {
    // POST-NONJSON-DIAG (2026-05-21): enrich the error response with the
    // branch that was active when the throw happened, any upstream URL +
    // status + body snippet + Vercel-edge headers captured by
    // parseJsonOrThrow, plus a redacted replay-cURL Maurice can paste
    // straight into a terminal. Server-side console.error keeps the same
    // information in Vercel function logs / Tauri sidecar stderr for
    // post-mortem reads when the surfaced toast is too short.
    const errorPayload: Record<string, unknown> = {
      error: getErrorMessage(e),
      branch: activeBranch,
    };
    if (e instanceof UpstreamNonJsonError) {
      errorPayload.upstream = {
        url: e.upstreamUrl,
        status: e.upstreamStatus,
        bodySnippet: e.upstreamBodySnippet,
        headers: e.upstreamHeaders,
      };
    }
    // Redacted replay cURL — strip mediaBase64 (multi-MB) and any token
    // strings from credentials so Maurice can paste this verbatim into a
    // terminal or share it without leaking secrets.
    if (rawBodyForReplay) {
      const redacted = redactReplayBody(rawBodyForReplay);
      const requestUrl = (() => { try { return new URL(req.url).pathname; } catch { return '/api/social/post'; } })();
      errorPayload.replayCurl =
        `curl -X POST '${requestUrl}' -H 'Content-Type: application/json' --data-raw '${JSON.stringify(redacted)}'`;
    }
    console.error('[/api/social/post] failure', {
      branch: activeBranch,
      message: getErrorMessage(e),
      upstream: e instanceof UpstreamNonJsonError ? {
        url: e.upstreamUrl,
        status: e.upstreamStatus,
        bodySnippet: e.upstreamBodySnippet,
        headers: e.upstreamHeaders,
      } : undefined,
    });
    return NextResponse.json(errorPayload, { status: 500 });
  }
}

/**
 * Strip secrets and oversized fields from the request body so a replay
 * cURL can be safely shared. Keeps shape so a paste-and-run reproduces
 * the same code path.
 */
function redactReplayBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (typeof out.mediaBase64 === 'string') {
    out.mediaBase64 = `<redacted: ${(out.mediaBase64 as string).length} chars>`;
  }
  if (out.credentials && typeof out.credentials === 'object') {
    const c = out.credentials as Record<string, unknown>;
    const redactedCreds: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      redactedCreds[k] = v && typeof v === 'object' ? '<redacted>' : v ? '<redacted>' : v;
    }
    out.credentials = redactedCreds;
  }
  return out;
}
