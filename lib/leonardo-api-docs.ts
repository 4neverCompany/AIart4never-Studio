/**
 * V030-008: Leonardo.AI v2 parameter specs for all six production
 * models (3 image, 3 video). Fed to pi.dev so the model-selection
 * reasoner can see the full parameter surface — which knobs each
 * model exposes and what values each knob accepts — rather than a
 * lossy compiled matrix.
 *
 * IMPORTANT: this intentionally OMITS the sample curl requests from
 * the upstream docs. Those samples contain specific prompt strings,
 * style_ids, and image IDs that are meaningless as guidance — pi
 * should not treat them as templates. Only the parameter catalogs
 * (accepted values, dimensions, style IDs, required vs optional) are
 * passed through so pi reasons from options, not from examples.
 *
 * V030-008 (per-model): exports both the full catalog (legacy
 * shortlist-pickers can still read it) and `LEONARDO_API_DOCS_BY_MODEL`,
 * a per-id slice. The per-model variant is what the per-model pi
 * caller hands to each parallel pi.dev request, keeping each request
 * focused on one model's surface only.
 */

const GPT_IMAGE_15 = `========================================================================
# GPT Image-1.5
========================================================================

## Endpoint
POST https://cloud.leonardo.ai/api/rest/v2/generations
Model identifier: "gpt-image-1.5"

## Parameters
- model (string, required): "gpt-image-1.5".
- prompt (string, required).
- quality (string, optional): LOW | MEDIUM | HIGH. App default: HIGH.
  NOTE: replaces the deprecated mode parameter (deprecated 2026-05-04).
- prompt_enhance (string, optional): ON | OFF. App default: ON.
- quantity (integer, optional).
- width (integer, optional).
- height (integer, optional).
- seed (integer, optional).
- public (boolean, optional).
- guidances.image_reference (array, optional, up to 6): each entry
  has image.id, image.type (GENERATED|UPLOADED), strength (LOW|MID|HIGH).

## Deprecation
The legacy mode parameter (FAST|QUALITY|ULTRA) is DEPRECATED as of
2026-05-04 and requests using it will FAIL after that date. Always use
the quality parameter instead.

## Aspect Ratio Settings (width × height)
| Aspect Ratio | Width | Height |
| 2:3          | 1024  | 1536   |
| 1:1          | 1024  | 1024   |
| 3:2          | 1536  | 1024   |
`;

const GPT_IMAGE_2 = `========================================================================
# GPT Image 2
========================================================================

## Endpoint
POST https://cloud.leonardo.ai/api/rest/v2/generations
Model identifier: "gpt-image-2"

## Parameters
- model (string, required): "gpt-image-2".
- prompt (string, required).
- quality (string, optional): LOW | MEDIUM | HIGH. Default: MEDIUM.
- prompt_enhance (string, optional): ON | OFF. Default: OFF.
- quantity (integer, optional, 1-8). Default: 1.
- width (integer, optional): must be multiple of 16. max(w,h) < 3840.
- height (integer, optional): must be multiple of 16. max(w,h) < 3840.
- public (boolean, optional). Default: false.
- guidances.image_reference (array, optional, up to 6): each reference
  includes image.id and image.type (GENERATED or UPLOADED).
  NOTE: GPT Image 2 does NOT use strength — must not be passed to the API.

## Aspect Ratio Settings (width × height)
| Aspect Ratio | Width | Height |
| 1:1         | 1024  | 1024   |
| 2:3         | 848   | 1264   |
| 3:2         | 1264  | 848    |
| 16:9        | 1376  | 768    |
| 9:16        | 768   | 1376   |

## Resolution Constraints
- Max edge length: max(width, height) < 3840.
- Both width and height must be multiples of 16.
- Aspect ratio limit: long/short ratio ≤ 3 (no 21:9 ultra-wide).
- Pixel count range: 655,360 ≤ width × height ≤ 8,294,400.
- size:auto is NOT supported and must not be passed to the API.

## Key Differences from GPT Image-1.5
- No seed parameter (GPT Image-1.5 supports it).
- No strength on image_reference (GPT Image-1.5 supports LOW|MID|HIGH).
- Default quality is MEDIUM (GPT Image-1.5 defaults to HIGH).
- Default prompt_enhance is OFF (GPT Image-1.5 defaults to ON).
- Max quantity 8 (GPT Image-1.5 caps at 4).
- Supports 16:9 and 9:16 (GPT Image-1.5 only 1:1, 2:3, 3:2).
`;

const NANO_BANANA_2 = `========================================================================
# Nano Banana 2
========================================================================

## Endpoint
POST https://cloud.leonardo.ai/api/rest/v2/generations
Model identifier: "nano-banana-2"

## Parameters
- model (string, required): "nano-banana-2".
- prompt (string, required).
- prompt_enhance (string, optional): ON | OFF. App default: ON.
- quantity (integer, optional, default 1, max 8).
- width, height (integer, optional): see valid pairs table.
- seed (integer, optional).
- public (boolean, optional).
- style_ids (array of UUID, optional): preset style identifiers.
- guidances.image_reference (array, optional, up to 6): each image.id,
  image.type (GENERATED|UPLOADED), strength (LOW|MID|HIGH).

## Dimensions (width × height)
| AR    | 1K          | 2K           | 4K           |
| 1:1   | 1024 × 1024 | 2048 × 2048  | 4096 × 4096  |
| 2:3   | 848  × 1264 | 1696 × 2528  | 3392 × 5056  |
| 3:2   | 1264 × 848  | 2528 × 1696  | 5056 × 3392  |
| 3:4   | 896  × 1200 | 1792 × 2400  | 3584 × 4800  |
| 4:3   | 1200 × 896  | 2400 × 1792  | 4800 × 3584  |
| 4:5   | 928  × 1152 | 1856 × 2304  | 3712 × 4608  |
| 5:4   | 1152 × 928  | 2304 × 1856  | 4608 × 3712  |
| 9:16  | 768  × 1376 | 1536 × 2752  | 3072 × 5504  |
| 16:9  | 1376 × 768  | 2752 × 1536  | 5504 × 3072  |
| 21:9  | 1584 × 672  | 3168 × 1344  | 6336 × 2688  |

Width/height values 0,0 → match input reference aspect ratio.

## Style IDs (pick by name; UUIDs live in the app)
3D Render, Acrylic, Creative, Dynamic, Fashion, Game Concept,
Graphic Design 2D, Graphic Design 3D, Illustration, None, Portrait,
Portrait Cinematic, Portrait Fashion, Pro B&W Photography,
Pro Color Photography, Pro Film Photography, Ray Traced, Stock Photo,
Watercolor.
`;

const NANO_BANANA_PRO = `========================================================================
# Nano Banana Pro (API: gemini-image-2)
========================================================================

## Endpoint
POST https://cloud.leonardo.ai/api/rest/v2/generations
Model identifier: "gemini-image-2".

## Parameters
Same parameter surface as Nano Banana 2. prompt_enhance ON|OFF
(app default ON). quantity default 1, max 8. style_ids array accepted.
guidances.image_reference same shape (up to 6 refs).

## Dimensions
Width and height individually validated; 0,0 = match input reference.
Default 1024×1024 when unspecified. Same aspect ratio table as
Nano Banana 2 (1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 4:5 / 5:4 / 9:16 / 16:9 / 21:9).

## Style IDs
Same palette as Nano Banana 2 (3D Render, Acrylic, Creative, Dynamic,
Fashion, Game Concept, Graphic Design 2D, Graphic Design 3D,
Illustration, None, Portrait, Portrait Cinematic, Portrait Fashion,
Pro B&W Photography, Pro Color Photography, Pro Film Photography,
Ray Traced, Stock Photo, Watercolor).
`;

const KLING_30 = `========================================================================
# Kling 3.0 (video)
========================================================================

## Endpoint
POST https://cloud.leonardo.ai/api/rest/v2/generations
Model identifier: "kling-3.0".

## Parameters
- model (string, required): "kling-3.0".
- prompt (string, required, ≤1500 chars).
- duration (number, required): 3 – 15 seconds.
- width, height (number).
- mode (string): RESOLUTION_720 (Standard) | RESOLUTION_1080 (Pro, default).
- motion_has_audio (boolean).
- public (boolean).
- guidances.start_frame (array, max 1): requires NO image_reference.
- guidances.end_frame (array, max 1): requires start_frame AND no image_reference.
- guidances.image_reference (array, up to 7; 4 with video ref):
  requires NO start_frame or end_frame.

## Dimensions
720p: 16:9 1280×720; 1:1 960×960; 9:16 720×1280.
1080p: 16:9 1920×1080; 1:1 1440×1440; 9:16 1080×1920.
When width/height omitted and start_frame given, dims follow the start frame.
`;

const KLING_O3 = `========================================================================
# Kling O3 (API: kling-video-o-3)
========================================================================

## Endpoint
POST https://cloud.leonardo.ai/api/rest/v2/generations
Model identifier: "kling-video-o-3".

## Parameters
- model (string, required): "kling-video-o-3".
- prompt (string, required, ≤1500 chars).
- duration (number, required): 3 – 15; max 10 if a video reference is used.
- mode: RESOLUTION_720 | RESOLUTION_1080 (default).
- motion_has_audio (boolean). Audio is stripped when a video reference is used.
- guidances.start_frame (array, max 1).
- guidances.end_frame (array, max 1).
- guidances.image_reference (array, up to 7; 4 with video ref).
- guidances.video_reference_base (array, max 1): id + type (GENERATED only);
  may be combined with image_reference.

## Dimensions
720p: 16:9 1280×720; 1:1 960×960; 9:16 720×1280.
1080p: 16:9 1920×1080; 1:1 1440×1440; 9:16 1080×1920.
`;

const SEEDANCE_20 = `========================================================================
# Seedance 2.0 (API: seedance-2.0 | seedance-2.0-fast)
========================================================================

## Endpoint
POST https://cloud.leonardo.ai/api/rest/v2/generations
Model identifier: "seedance-2.0" or "seedance-2.0-fast".

## Parameters
- model (string, required): seedance-2.0 | seedance-2.0-fast.
- prompt (string, required, ≤1500 chars).
- duration (integer, optional): 4..15 (any integer). Default 8.
- mode (string, optional): RESOLUTION_480 | RESOLUTION_720 (default). NO 1080p.
- width, height (integer, optional). 0,0 = match source image (img2video).
- prompt_enhance (string, optional): ON | OFF. Auto-OFF when start_frame is set.
- motion_has_audio (boolean, optional): generates dialogue, SFX, ambient.
- public (boolean, optional).
- seed (integer, optional): 0–4294967295, -1 = random.
- guidances.start_frame (array, max 1): mutually exclusive with image_reference / video_reference_base.
- guidances.end_frame (array, max 1): requires start_frame.
- guidances.image_reference (array, max 4): mutually exclusive with start/end_frame.
- guidances.video_reference_base (array, max 3): mutually exclusive with start/end_frame,
  may coexist with image_reference.

## Dimensions
480p: 21:9 992×432; 16:9 864×496; 4:3 752×560; 1:1 640×640;
      3:4 560×752; 9:16 496×864; 9:21 432×992.
720p: 21:9 1470×630; 16:9 1280×720; 4:3 1112×834; 1:1 960×960;
      3:4 834×1112; 9:16 720×1280; 9:21 630×1470.
Seven aspect ratios × two resolutions = fourteen valid combos.
Supports ultra-wide 21:9 and 9:21 framings.
`;

const VEO_31 = `========================================================================
# Veo 3.1 (API: VEO3_1 | VEO3_1FAST)
========================================================================

## Endpoint
POST https://cloud.leonardo.ai/api/rest/v1/generations-image-to-video
Model identifier: "VEO3_1" or "VEO3_1FAST".

## Parameters
- model (string): VEO3_1 | VEO3_1FAST.
- prompt (string).
- duration (number): 4 | 6 | 8.
- resolution: RESOLUTION_720 | RESOLUTION_1080.
- width, height (number).
- imageId (string): starting frame image id.
- imageType (string): UPLOADED | GENERATED.
- endFrameImage (object, optional): id + type; requires imageId/imageType.
- isPublic (boolean).

## Dimensions
720p 16:9 → 1280×720; 720p 9:16 → 720×1280.
1080p 16:9 → 1920×1080; 1080p 9:16 → 1080×1920.
Dimensions outside these are rejected. Uploaded images are cropped to fit.
`;

/**
 * Per-model API doc slice keyed on the in-app model id (NOT api_name).
 * Per-model pi calls hand the relevant slice to pi so it reasons over
 * one model's surface at a time — sharper reasoning, smaller token
 * budget per request, and per-model parallelism becomes free.
 */
export const LEONARDO_API_DOCS_BY_MODEL: Record<string, string> = {
  'gpt-image-1.5': GPT_IMAGE_15,
  'gpt-image-2': GPT_IMAGE_2,
  'nano-banana-2': NANO_BANANA_2,
  'nano-banana-pro': NANO_BANANA_PRO,
  'kling-3.0': KLING_30,
  'kling-o3': KLING_O3,
  'veo-3.1': VEO_31,
  'seedance-2.0': SEEDANCE_20,
};

/**
 * Full catalog (concatenated per-model slices). Kept for the legacy
 * "single pi call picks model + params" path and for any caller that
 * wants the holistic catalog. New per-model callers should reach for
 * LEONARDO_API_DOCS_BY_MODEL[modelId] instead.
 */
export const LEONARDO_API_DOCS = `
${GPT_IMAGE_15}
${GPT_IMAGE_2}
${NANO_BANANA_2}
${NANO_BANANA_PRO}
${KLING_30}
${KLING_O3}
${VEO_31}
${SEEDANCE_20}`;
