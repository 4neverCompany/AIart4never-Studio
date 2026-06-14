import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import {
  loadPostRecords,
  savePostRecords,
  applyTransition,
  PostId,
  type PostRecord,
} from '@/lib/post-lifecycle';

// POST-413-FIX phase 4 (2026-05-21): proxy uguu uploads through our own
// route so the browser never hits uguu directly. uguu.se sends no
// Access-Control-Allow-Origin header on /upload.php, so the browser's
// CORS check blocked phase 3's client-side upload outright (visible as
// "Failed to fetch" in DevTools). Server-side fetch has no CORS so we
// can re-host on the user's behalf and return just the hosted URL.
//
// v0.9.41 (2026-06-02): when a `postId` is present in the body (JSON or
// multipart), the route is now also the atomicity boundary for the
// post-lifecycle state machine. It:
//   1. Loads the post by postId.
//   2. Uploads the image to uguu.
//   3. On success: applies transition(post, 'captioning') AND sets
//      `hostedImageUrl` via `applyTransition()` (which persists both
//      the new state and the legacy mirror).
//   4. On failure: applies transition(post, 'failed', {
//      reason: 'image_upload_failed' }) and returns HTTP 502 with the
//      failed PostRecord so the caller can surface the failure to the
//      user.
//
// When no `postId` is present, the route falls through to the original
// multipart/uguu-only behavior (returns just the URL) so the rest of
// the codebase can migrate at its own pace. Backward compatibility
// with the existing /api/social/post caller is preserved.
//
// Body limit: this route still inherits Vercel's 4.5MB serverless
// function body limit. The frontend handles that by calling /api/upload
// once per image — a single watermarked JPEG@0.92 fits, and carousels
// upload their members serially-or-parallel as individual requests.

const UGUU_UPLOAD_ENDPOINT = 'https://uguu.se/upload.php';
const UPLOAD_TIMEOUT_MS = 30_000;

interface UguuResponse {
  success?: boolean;
  files?: Array<{ url?: string; hash?: string; filename?: string; size?: number; dupe?: boolean }>;
  description?: string;
  errorcode?: number;
  error?: string;
}

/**
 * Forward `bytes` to uguu.se and return the hosted URL. Shared by both
 * the legacy multipart path and the new postId-aware path. Throws on
 * any non-success outcome — callers decide how to react (legacy path
 * returns 502; state-machine path transitions the post to `failed`).
 */
async function uploadToUguu(bytes: ArrayBuffer, filename: string, contentType?: string): Promise<string> {
  const forwarded = new FormData();
  const blob = contentType
    ? new Blob([bytes], { type: contentType })
    : new Blob([bytes]);
  forwarded.append('files[]', blob, filename);

  const res = await fetch(UGUU_UPLOAD_ENDPOINT, {
    method: 'POST',
    body: forwarded,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const text = await res.text();
  let data: UguuResponse;
  try {
    data = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    console.error('[/api/upload] uguu non-JSON', { status: res.status, snippet });
    throw new UguuError(`uguu returned non-JSON (HTTP ${res.status}): ${snippet || '<empty>'}`, 502);
  }
  if (!res.ok || !data.success) {
    const msg = data.description ?? data.error ?? `HTTP ${res.status}`;
    console.error('[/api/upload] uguu rejected upload', { status: res.status, data });
    throw new UguuError(`uguu upload failed: ${msg}`, 502);
  }
  const url = data.files?.[0]?.url;
  if (!url) {
    console.error('[/api/upload] uguu success but no files[0].url', { data });
    throw new UguuError('uguu returned success but no files[0].url', 502);
  }
  return url;
}

/** Tagged error carrying the HTTP status to surface to the caller. */
class UguuError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UguuError';
    this.status = status;
  }
}

/**
 * Resolve the postId from a JSON body, a multipart form, or null. Looks
 * in the body fields in order: JSON `postId`, multipart `postId`. Any
 * falsy value (missing, empty string) returns null and the caller
 * takes the legacy path.
 */
async function extractPostId(req: Request, ct: string | null): Promise<string | null> {
  if (ct && ct.toLowerCase().includes('application/json')) {
    // Parse defensively — bad JSON is "no postId" and falls through to
    // the legacy path. We can't both parse once here and again in the
    // legacy handler, so the JSON branch is gated on this returning a
    // truthy postId; the legacy multipart branch handles its own body.
    let parsed: unknown;
    try {
      parsed = await req.clone().json();
    } catch {
      return null;
    }
    if (parsed && typeof parsed === 'object') {
      const v = (parsed as Record<string, unknown>).postId;
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    return null;
  }
  if (ct && ct.toLowerCase().includes('multipart/form-data')) {
    // Use a clone — req.formData() consumes the body.
    try {
      const fd = await req.clone().formData();
      const v = fd.get('postId');
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * State-machine branch. Uploads the image, then applies a transition
 * to 'captioning' (success) or 'failed' (uguu rejection). Returns the
 * updated PostRecord in either case.
 */
async function handlePostIdFlow(
  postIdStr: string,
  bytes: ArrayBuffer,
  filename: string,
  contentType: string | undefined,
): Promise<NextResponse> {
  let postId: ReturnType<typeof PostId>;
  try {
    postId = PostId(postIdStr);
  } catch (e) {
    return NextResponse.json(
      { error: `invalid postId: ${getErrorMessage(e)}` },
      { status: 400 },
    );
  }

  const records = await loadPostRecords();
  const post = records.find((p) => p.id === postId);
  if (!post) {
    return NextResponse.json(
      { error: `post ${postIdStr} not found` },
      { status: 404 },
    );
  }

  // Defensive: only allow the transition from a state that can reach
  // 'captioning'. The state machine itself will throw on illegal
  // transitions, but checking up front gives a clearer 409 message.
  if (post.state !== 'image_ready' && post.state !== 'generating_image' && post.state !== 'captioning') {
    return NextResponse.json(
      { error: `cannot upload image for post in state '${post.state}'` },
      { status: 409 },
    );
  }

  let hostedUrl: string;
  try {
    hostedUrl = await uploadToUguu(bytes, filename, contentType);
  } catch (e) {
    const reason = 'image_upload_failed';
    const note = `uguu upload failed: ${getErrorMessage(e)}`;
    let failed: PostRecord;
    try {
      failed = await applyTransition(postId, 'failed', { reason, note });
    } catch (innerE) {
      // The state machine rejected the transition (e.g. illegal from
      // current state). Surface the underlying uguu error so the
      // caller can still see why the upload died, and fall through to
      // 502.
      console.error('[/api/upload] applyTransition(failed) threw', innerE);
      return NextResponse.json(
        { error: note, transitionError: getErrorMessage(innerE) },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error: note,
        post: failed,
      },
      { status: 502 },
    );
  }

  // Success path. Persist the hostedImageUrl on the post FIRST, then
  // apply the state transition. The migration bridge re-reads the
  // post, calls the pure `transition()` function (which preserves all
  // non-state fields via spread), and writes back. The URL carries
  // through. This is the atomicity boundary the v0.9.41 fix requires:
  // if either write fails, the caller can recover from the partial
  // state via the reconciler.
  const recordsWithUrl = await loadPostRecords();
  const idx = recordsWithUrl.findIndex((p) => p.id === postId);
  if (idx < 0) {
    return NextResponse.json(
      { error: `post ${postIdStr} vanished between lookup and write` },
      { status: 500 },
    );
  }
  recordsWithUrl[idx] = { ...recordsWithUrl[idx], hostedImageUrl: hostedUrl };
  await savePostRecords(recordsWithUrl);

  const updated = await applyTransition(postId, 'captioning', {
    note: 'Image hosted on uguu; ready for captioning',
  });
  // `applyTransition` re-reads the post, so the URL we just wrote
  // propagates into the returned record via the spread inside
  // `transition()`. Belt-and-suspenders: re-stamp the URL in case a
  // future refactor of the bridge decides to drop it.
  const merged: PostRecord = { ...updated, hostedImageUrl: hostedUrl };

  return NextResponse.json({ post: merged, url: hostedUrl });
}

/**
 * Legacy multipart path: upload to uguu, return just the hosted URL.
 * No state machine interaction. Preserved verbatim from the v0.9.41
 * phase-4 implementation so existing callers (e.g. /api/social/post)
 * keep working.
 */
async function handleLegacyMultipart(req: Request): Promise<NextResponse> {
  const incoming = await req.formData();
  const file = incoming.get('file');
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    return NextResponse.json({ error: 'multipart `file` field is required' }, { status: 400 });
  }
  const blob = file as Blob;
  const filename = (file as { name?: string }).name || 'image.jpg';
  const contentType = (file as { type?: string }).type || undefined;
  const bytes = await blob.arrayBuffer();
  const url = await uploadToUguu(bytes, filename, contentType);
  return NextResponse.json({ url });
}

export async function POST(req: Request) {
  try {
    const ct = req.headers.get('content-type');
    const postId = await extractPostId(req, ct);

    if (postId) {
      // PostId-aware path. We accept the image bytes from EITHER a JSON
      // body (preferred for programmatic callers) OR a multipart
      // form-data (preferred for browser FormData uploads that
      // already include a postId field).
      if (ct && ct.toLowerCase().includes('application/json')) {
        const body = (await req.json()) as Record<string, unknown>;
        const imageBytesRaw = body.imageBytes ?? body.file;
        if (imageBytesRaw === undefined || imageBytesRaw === null) {
          return NextResponse.json(
            { error: 'imageBytes is required when postId is provided' },
            { status: 400 },
          );
        }
        const { bytes, filename } = decodeImageBytes(imageBytesRaw);
        return handlePostIdFlow(postId, bytes, filename, undefined);
      }
      // Multipart: re-parse the form to pull out the file alongside
      // the postId we already found.
      const fd = await req.formData();
      const file = fd.get('file');
      if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
        return NextResponse.json(
          { error: 'multipart `file` field is required alongside postId' },
          { status: 400 },
        );
      }
      const blob = file as Blob;
      const filename = (file as { name?: string }).name || 'image.jpg';
      const contentType = (file as { type?: string }).type || undefined;
      const bytes = await blob.arrayBuffer();
      return handlePostIdFlow(postId, bytes, filename, contentType);
    }

    // No postId — legacy multipart path. We do NOT support a bare JSON
    // { file: ... } upload here because the original contract is
    // multipart only; if a caller sends JSON with no postId, treat it
    // as a 400 so the API shape stays predictable.
    if (ct && ct.toLowerCase().includes('application/json')) {
      return NextResponse.json(
        { error: 'JSON body requires `postId` (legacy multipart path is multipart only)' },
        { status: 400 },
      );
    }
    return await handleLegacyMultipart(req);
  } catch (e: unknown) {
    if (e instanceof UguuError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error('[/api/upload] handler error', e);
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

/**
 * Accept `imageBytes` as either:
 *   - a base64 string (with or without a `data:<mime>;base64,` prefix), or
 *   - a number[]/Uint8Array (raw byte values)
 *
 * The shape mirrors what the social/post route used to send as
 * `mediaBase64` and what the frontend's FormData+postId wrapper will
 * forward. Returns the decoded ArrayBuffer plus a best-guess filename.
 */
function decodeImageBytes(raw: unknown): { bytes: ArrayBuffer; filename: string } {
  if (typeof raw === 'string') {
    const stripped = raw.replace(/^data:[^;]+;base64,/, '');
    const bytes = Buffer.from(stripped, 'base64');
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { bytes: ab instanceof ArrayBuffer ? ab : new ArrayBuffer(0), filename: 'image.jpg' };
  }
  if (raw instanceof Uint8Array) {
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    return { bytes: ab instanceof ArrayBuffer ? ab : new ArrayBuffer(0), filename: 'image.jpg' };
  }
  if (Array.isArray(raw)) {
    const u8 = Uint8Array.from(raw.filter((n) => typeof n === 'number') as number[]);
    return { bytes: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), filename: 'image.jpg' };
  }
  throw new Error('imageBytes must be a base64 string, Uint8Array, or number[]');
}
