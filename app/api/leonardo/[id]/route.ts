import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const customApiKey = url.searchParams.get('apiKey');
    const apiKey = customApiKey || process.env.LEONARDO_API_KEY;

    if (!apiKey || apiKey === 'MY_LEONARDO_API_KEY') {
      return NextResponse.json({ error: 'Leonardo API key is missing. Open Settings → paste your key → Save.' }, { status: 400 });
    }

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    };

    // Generations created via /api/rest/v2/generations are not queryable via the
    // v1 GET (the Hasura auth hook for v1 returns "Invalid response from authorization
    // hook"). Try v2 first; fall back to v1 for legacy generations.
    let getRes = await fetch(`https://cloud.leonardo.ai/api/rest/v2/generations/${id}`, { headers, signal: AbortSignal.timeout(10000) });
    let usedV2 = true;
    if (!getRes.ok && (getRes.status === 404 || getRes.status === 405)) {
      getRes = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${id}`, { headers, signal: AbortSignal.timeout(10000) });
      usedV2 = false;
    }

    if (!getRes.ok) {
      const err = await getRes.text();
      // Leonardo's Hasura layer transiently returns 500s ("Invalid response
      // from authorization hook", "unexpected", etc.) while a generation is
      // still being committed to the datastore — a subsequent poll usually
      // succeeds. 404/425 also mean "not ready yet" for v2 generations. Treat
      // all of these as PENDING so the client keeps polling instead of
      // bailing out of the loop.
      if (
        getRes.status === 500 ||
        getRes.status === 502 ||
        getRes.status === 503 ||
        getRes.status === 504 ||
        getRes.status === 404 ||
        getRes.status === 425
      ) {
        return NextResponse.json({ status: 'PENDING' });
      }

      return NextResponse.json(
        { error: `Failed to check Leonardo generation status (${getRes.status}): ${err.slice(0, 200)}` },
        { status: getRes.status }
      );
    }

    const getData = await getRes.json() as Record<string, unknown>;
    // v1 wraps in `generations_by_pk`; v2 may return the generation flat or under
    // `generation` / `generations_by_pk`. Handle all known shapes.
    const generation =
      (getData.generations_by_pk as Record<string, unknown> | undefined) ||
      (getData.generation as Record<string, unknown> | undefined) ||
      (getData.id ? getData : null);

    if (!generation) {
      console.error('Leonardo unexpected status response shape:', JSON.stringify(getData).slice(0, 400));
      return NextResponse.json({ error: 'Generation not found' }, { status: 404 });
    }

    // Flatten Leonardo's prompt_moderations array into a single list
    // of classification strings. Leonardo returns it as
    // [{moderationClassification: ["NSFW", "TRADEMARK"]}] — the nesting
    // is historical, one entry per pipeline stage. Clients only care
    // about the union so we deduplicate here.
    const extractModeration = (gen: Record<string, unknown>): {
      classifications: string[];
      raw: unknown[];
    } => {
      const mods: unknown[] = Array.isArray(gen?.prompt_moderations) ? (gen.prompt_moderations as unknown[]) : [];
      const classifications: string[] = [];
      for (const m of mods) {
        const list = (m as Record<string, unknown>)?.moderationClassification;
        if (Array.isArray(list)) {
          for (const c of list) {
            if (typeof c === 'string' && c.trim()) classifications.push(c.trim());
          }
        }
      }
      return {
        classifications: [...new Set(classifications)],
        raw: mods,
      };
    };

    if (generation.status === 'COMPLETE') {
      const images = (generation.generated_images || generation.images || []) as Array<Record<string, unknown>>;
      if (images.length > 0) {
        const imageUrl = images[0].motionMP4URL || images[0].url;
        return NextResponse.json({ status: 'COMPLETE', url: imageUrl, imageId: images[0].id });
      }
      // COMPLETE with 0 images typically means content-filter rejection
      // (especially on gpt-image-1.5). Log the full payload + generation
      // object keys so we can spot shape mismatches where the images
      // field lives under an unexpected name.
      console.error(
        '[Leonardo] COMPLETE but 0 images. Full response:',
        JSON.stringify(getData).slice(0, 1000)
      );
      console.error(
        '[Leonardo] Generation object keys:',
        Object.keys(generation)
      );
      const mod = extractModeration(generation);
      const error = mod.classifications.length > 0
        ? `Blocked by content moderation: ${mod.classifications.join(', ')}`
        : 'Generation complete but no images found';
      return NextResponse.json({
        status: 'FAILED',
        error,
        moderation: { moderationClassification: mod.classifications },
        promptModerations: mod.raw,
        failedPrompt: typeof generation.prompt === 'string' ? generation.prompt : undefined,
        images: [],
      });
    } else if (generation.status === 'FAILED') {
      const failureReason = generation.failure_reason || 'Unknown reason';
      console.error('Leonardo generation failed:', failureReason, JSON.stringify(generation));
      const mod = extractModeration(generation);
      const error = mod.classifications.length > 0
        ? `Blocked by content moderation: ${mod.classifications.join(', ')}`
        : `Leonardo generation failed: ${failureReason}. This can happen due to prompt filters or technical issues on Leonardo's side.`;
      return NextResponse.json({
        status: 'FAILED',
        error,
        moderation: { moderationClassification: mod.classifications },
        promptModerations: mod.raw,
        failedPrompt: typeof generation.prompt === 'string' ? generation.prompt : undefined,
        images: [],
      });
    }

    return NextResponse.json({ status: generation.status }); // PENDING

  } catch (e: unknown) {
    console.error('Leonardo API error:', e);
    return NextResponse.json({ error: getErrorMessage(e) || 'Internal Server Error' }, { status: 500 });
  }
}
