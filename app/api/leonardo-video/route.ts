import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';

export async function POST(req: Request) {
  try {
    const { prompt, imageId, duration, model, apiKey: customApiKey } = await req.json();
    const apiKey = customApiKey || process.env.LEONARDO_API_KEY;

    if (!apiKey || apiKey === 'MY_LEONARDO_API_KEY') {
      return NextResponse.json({ error: 'Leonardo API key is missing. Open Settings (gear icon, top-right) → paste your key from https://app.leonardo.ai/api-access → Save.' }, { status: 400 });
    }

    // Classify the incoming model id into a payload family. The v2
    // generations endpoint serves kling / seedance / veo — each needs
    // a different payload shape. Legacy ray-v1 / ray-v2 still hit the
    // older motion-svd endpoint.
    type Family = 'kling' | 'seedance' | 'veo' | 'legacy';
    const m = String(model || '');
    const classify = (): { family: Family; apiModel: string } => {
      if (m === 'kling-3.0') return { family: 'kling', apiModel: 'kling-3.0' };
      if (m === 'kling-video-o-3' || m === 'kling-o3') return { family: 'kling', apiModel: 'kling-video-o-3' };
      if (m === 'seedance-2.0' || m === 'seedance-2.0-fast') return { family: 'seedance', apiModel: m };
      if (m === 'veo-3.1' || m === 'VEO3_1') return { family: 'veo', apiModel: 'VEO3_1' };
      if (m === 'VEO3_1FAST') return { family: 'veo', apiModel: 'VEO3_1FAST' };
      return { family: 'legacy', apiModel: m };
    };
    const { family, apiModel } = classify();

    const endpoint = family === 'legacy'
      ? 'https://cloud.leonardo.ai/api/rest/v1/generations-motion-svd'
      : 'https://cloud.leonardo.ai/api/rest/v2/generations';

    let body: Record<string, unknown>;
    if (family === 'kling') {
      const parameters: Record<string, unknown> = {
        prompt: String(prompt || 'Animate this image'),
        duration: Number(duration) || 3,
        mode: 'RESOLUTION_1080',
        motion_has_audio: true,
      };
      if (imageId) {
        parameters.guidances = {
          start_frame: [{ image: { id: imageId, type: 'GENERATED' } }],
        };
      } else {
        parameters.width = 1920;
        parameters.height = 1080;
      }
      body = { model: apiModel, public: false, parameters };
    } else if (family === 'seedance') {
      // Seedance tops out at 720p — no 1080p option exists. Aspect
      // ratios and motion_has_audio follow the start frame when one is
      // provided (the spec auto-matches source image dimensions).
      const parameters: Record<string, unknown> = {
        prompt: String(prompt || 'Animate this image'),
        duration: Number(duration) || 8,
        mode: 'RESOLUTION_720',
        motion_has_audio: true,
      };
      if (imageId) {
        parameters.guidances = {
          start_frame: [{ image: { id: imageId, type: 'GENERATED' } }],
        };
      } else {
        parameters.width = 1280;
        parameters.height = 720;
      }
      body = { model: apiModel, public: false, parameters };
    } else if (family === 'veo') {
      // Veo uses a flat payload: imageId / imageType / isPublic live
      // at the top level, not nested under `parameters.guidances`.
      // Duration must be 4, 6, or 8 per the spec.
      const rawDur = Number(duration) || 8;
      const safeDur = rawDur <= 4 ? 4 : rawDur <= 6 ? 6 : 8;
      const payload: Record<string, unknown> = {
        model: apiModel,
        prompt: String(prompt || 'Animate this image'),
        duration: safeDur,
        resolution: 'RESOLUTION_1080',
        isPublic: false,
      };
      if (imageId) {
        payload.imageId = imageId;
        payload.imageType = 'GENERATED';
      } else {
        payload.width = 1920;
        payload.height = 1080;
      }
      body = payload;
    } else {
      body = {
        imageId: imageId,
        motionStrength: 5,
        isPublic: false,
      };
    }

    const createRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      return NextResponse.json({ error: `Failed to start Leonardo video generation: ${err}` }, { status: 500 });
    }

    const createData = await createRes.json() as Record<string, unknown>;

    if (Array.isArray(createData)) {
      const errs = createData as Array<Record<string, unknown>>;
      if (errs.length > 0 && errs[0].extensions) {
        return NextResponse.json({ error: `Leonardo API Error: ${String(errs[0].message ?? 'Validation failed')}` }, { status: 400 });
      }
    }

    const gen = createData.generation as Record<string, unknown> | undefined;
    const generate = createData.generate as Record<string, unknown> | undefined;
    let generationId = createData.generationId || createData.id || gen?.id || generate?.generationId;

    if (!generationId) {
      for (const key in createData) {
        const val = createData[key];
        if (val && typeof val === 'object') {
          const obj = val as Record<string, unknown>;
          if (obj.generationId) {
            generationId = obj.generationId;
            break;
          } else if (obj.id) {
            generationId = obj.id;
            break;
          }
        }
      }
    }

    if (!generationId) {
      return NextResponse.json({ error: `No generation ID returned from Leonardo. Response: ${JSON.stringify(createData)}` }, { status: 500 });
    }

    return NextResponse.json({ generationId });

  } catch (e: unknown) {
    console.error('Leonardo Video API error:', e);
    return NextResponse.json({ error: getErrorMessage(e) || 'Internal Server Error' }, { status: 500 });
  }
}
