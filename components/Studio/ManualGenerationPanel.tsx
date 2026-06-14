'use client';

/**
 * ManualGenerationPanel — unified content generation UI.
 *
 * Was fehlt vor v1.3.5
 * --------------------
 * Das Repo hatte starke Provider-Abstraktionen (ProviderAdapter, Registry,
 * Adapters für Higgsfield/Leonardo/MiniMax) und ein reiches Modell-Catalog
 * (HIGGSFIELD_IMAGE_MODELS, HIGGSFIELD_VIDEO_MODELS, LEONARDO_MODELS).
 * Was fehlte war die UI, um diese Auswahl manuell zu treffen. Der einzige
 * Weg, mit Higgsfield zu generieren, war über die AI-Agent-Loop im
 * Pipeline, was weder sichtbar noch kontrollierbar war.
 *
 * Was diese Komponente macht
 * --------------------------
 * Ein Drop-in-Panel für die Studio-Seite. Der User wählt:
 *   - Modus: Bild oder Video
 *   - Provider: Higgsfield, Leonardo, MiniMax
 *   - Modell: gefiltert nach Provider
 *   - Prompt, Negative Prompt, Aspect Ratio
 *   - Optionale Watermark + Save-to-Library Toggle
 * Klick auf "Generate" ruft die richtige API-Route auf, zeigt das
 * Result, persistiert es lokal (über lib/images/storage), und legt
 * es in der Bilder-Bibliothek ab.
 *
 * Warum nicht durch useImageGeneration
 * ------------------------------------
 * useImageGeneration ist ~1600 LOC eng mit dem Pipeline-Code verzahnt
 * (Ideen-Generierung, Anti-AI-Look, Moderation-Retry, …). Eine
 * 4-6h-Refaktor-Aktion, die alle drei Provider-Code-Pfade auf
 * getProvider() umstellt, ist ein eigenes Stück Arbeit (v1.3.6).
 * Hier geht es um die UI — die existierenden drei Routen
 * (/api/higgsfield/image, /api/leonardo, /api/minimax-image) sind
 * bereits unified auf Server-Seite, wir müssen sie nur dispatchen.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Sparkles, Image as ImageIcon, Film, Loader2, X, Check } from 'lucide-react'
import { loadSkillContentForModel } from '@/lib/actions/higgsfield-skills'
import { useSettings } from '@/hooks/useSettings'
import { type GeneratedImage } from '@/types/mashup'
import {
  HIGGSFIELD_IMAGE_MODELS,
  HIGGSFIELD_VIDEO_MODELS,
  HIGGSFIELD_DEFAULT_IMAGE_MODEL,
  HIGGSFIELD_DEFAULT_VIDEO_MODEL,
  type HiggsfieldImageModelSlug,
  type HiggsfieldVideoModelSlug,
} from '@/lib/higgsfield/models'
import { persistImageToDisk } from '@/lib/images/storage'
import { displayUrl, displayUrlAsync } from '@/lib/images/storage'
import { useImageSrc } from '@/hooks/useImageSrc'

type Mode = 'image' | 'video'
type Provider = 'higgsfield' | 'leonardo' | 'minimax'

interface ModelOption {
  id: string
  displayName: string
  badge?: string
  blurb: string
  aspectRatios: readonly string[]
  resolutions?: readonly string[]
  creditHint: number
  family: string
}

const PROVIDER_LABEL: Record<Provider, string> = {
  higgsfield: 'Higgsfield',
  leonardo: 'Leonardo',
  minimax: 'MiniMax',
}

const ASPECT_RATIOS = [
  '1:1',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const

const RESOLUTIONS = ['1k', '2k', '4k'] as const

// ------------------------------------------------------------------
// Provider-specific model lists
// ------------------------------------------------------------------

const HIGGSFIELD_MODELS_IMAGE: ModelOption[] = HIGGSFIELD_IMAGE_MODELS.map((m) => ({
  id: m.slug,
  displayName: m.displayName,
  badge: m.badge,
  blurb: m.blurb,
  aspectRatios: m.aspectRatios,
  resolutions: m.resolutions,
  creditHint: m.creditHint,
  family: m.family,
}))

const HIGGSFIELD_MODELS_VIDEO: ModelOption[] = HIGGSFIELD_VIDEO_MODELS.map((m) => ({
  id: m.slug,
  displayName: m.displayName,
  badge: m.badge,
  blurb: m.blurb,
  aspectRatios: m.aspectRatios,
  resolutions: ['720p', '1080p'],
  creditHint: m.creditHint,
  family: m.family,
}))

// Leonardo models — sourced from /api/ai/models but kept inline here
// so the picker doesn't have to fetch on every render. Keep in sync
// with lib/leonardo/models.
const LEONARDO_MODELS_IMAGE: ModelOption[] = [
  {
    id: 'phoenix',
    displayName: 'Phoenix',
    badge: 'flagship',
    blurb: 'Leonardo flagship. Best photorealism, slow, expensive.',
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9'],
    creditHint: 25,
    family: 'phoenix',
  },
  {
    id: 'nano-banana-pro',
    displayName: 'Nano Banana Pro',
    badge: 'fast',
    blurb: 'Higgsfield-style Nano Banana via Leonardo. Cheap, good for quick drafts.',
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9'],
    creditHint: 5,
    family: 'nano-banana',
  },
  {
    id: 'gpt-image-1.5',
    displayName: 'GPT Image 1.5',
    badge: 'pro',
    blurb: 'OpenAI GPT Image 1.5. Good for photorealistic people, slower.',
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9'],
    creditHint: 15,
    family: 'gpt-image',
  },
]

const LEONARDO_MODELS_VIDEO: ModelOption[] = [
  {
    id: 'leonardo-motion',
    displayName: 'Leonardo Motion',
    badge: 'fast',
    blurb: 'Quick image-to-video animation. Cheap, ~3s clips.',
    aspectRatios: ['1:1', '16:9', '9:16'],
    creditHint: 30,
    family: 'motion',
  },
]

// MiniMax models — text-to-image + text-to-video. Keep in sync with
// lib/minimax/models when those land.
const MINIMAX_MODELS_IMAGE: ModelOption[] = [
  {
    id: 'minimax-image-01',
    displayName: 'MiniMax Image 01',
    badge: 'fast',
    blurb: 'Cheap general-purpose image model. Good for batch generation.',
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9'],
    creditHint: 2,
    family: 'minimax-image',
  },
]

const MINIMAX_MODELS_VIDEO: ModelOption[] = [
  {
    id: 'minimax-hailuo-02',
    displayName: 'MiniMax Hailuo 02',
    badge: 'flagship',
    blurb: 'High-quality text-to-video. 6-10s clips at 1080p.',
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p'],
    creditHint: 40,
    family: 'minimax-video',
  },
]

function getModelList(provider: Provider, mode: Mode): ModelOption[] {
  if (provider === 'higgsfield') {
    return mode === 'image' ? HIGGSFIELD_MODELS_IMAGE : HIGGSFIELD_MODELS_VIDEO
  }
  if (provider === 'leonardo') {
    return mode === 'image' ? LEONARDO_MODELS_IMAGE : LEONARDO_MODELS_VIDEO
  }
  // minimax
  return mode === 'image' ? MINIMAX_MODELS_IMAGE : MINIMAX_MODELS_VIDEO
}

function getDefaultModel(provider: Provider, mode: Mode): string {
  if (provider === 'higgsfield') {
    return mode === 'image'
      ? HIGGSFIELD_DEFAULT_IMAGE_MODEL
      : HIGGSFIELD_DEFAULT_VIDEO_MODEL
  }
  if (provider === 'leonardo') {
    return mode === 'image' ? 'phoenix' : 'leonardo-motion'
  }
  // minimax
  return mode === 'image' ? 'minimax-image-01' : 'minimax-hailuo-02'
}

function getDefaultAspectRatio(models: ModelOption[]): string {
  // Use the first aspect ratio from the model's supported set
  return models[0]?.aspectRatios[0] || '1:1'
}

function getDefaultResolution(models: ModelOption[]): string {
  return models[0]?.resolutions?.[0] || ''
}

// ------------------------------------------------------------------
// Result preview chip
// ------------------------------------------------------------------

function ResultPreview({
  image,
  onClose,
}: {
  image: GeneratedImage
  onClose: () => void
}) {
  const src = useImageSrc(image)
  return (
    <div className="relative rounded-lg overflow-hidden border border-white/10 bg-black/40">
      <button
        type="button"
        onClick={onClose}
        className="absolute top-2 right-2 z-10 rounded-full bg-black/60 p-1.5 text-white/80 hover:bg-black/80 hover:text-white"
        aria-label="Close preview"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {image.isVideo ? (
        <video
          src={src}
          controls
          autoPlay
          loop
          className="w-full max-h-[420px] object-contain"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={image.prompt}
          className="w-full max-h-[420px] object-contain"
        />
      )}
      <div className="p-3 text-xs text-white/70 border-t border-white/10 space-y-1">
        <div className="line-clamp-2">{image.prompt}</div>
        <div className="flex items-center gap-2 text-white/50">
          <span>{PROVIDER_LABEL[(image.modelInfo?.provider as Provider) || 'higgsfield'] || (image.modelInfo?.provider ?? '')}</span>
          <span>·</span>
          <span>{image.modelInfo?.modelName ?? image.modelInfo?.modelId ?? ''}</span>
          {image.localPath && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1 text-emerald-400">
                <Check className="h-3 w-3" /> saved locally
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// Main component
// ------------------------------------------------------------------

export function ManualGenerationPanel({ onImageGenerated }: { onImageGenerated?: (img: GeneratedImage) => void }) {
  const { settings } = useSettings()
  const cliToken = settings.higgsfieldCliToken

  const [mode, setMode] = useState<Mode>('image')
  const [provider, setProvider] = useState<Provider>('higgsfield')
  const [modelId, setModelId] = useState<string>(() => getDefaultModel('higgsfield', 'image'))
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState<string>('1:1')
  const [resolution, setResolution] = useState<string>('')
  const [referenceImageUrl, setReferenceImageUrl] = useState('')

  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<GeneratedImage | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // V1.6 (M1.2): Higgsfield counts as "connected" when EITHER the
  // OAuth flow completed, OR a CLI token is set, OR the local CLI
  // binary is installed AND authenticated (bundled CLI / cached
  // `higgsfield auth login` creds). We probe the CLI-auth endpoint
  // when the provider is higgsfield so the guard + label reflect the
  // CLI reality instead of the OAuth-only flag — which is what made
  // the panel show "not connected" and refuse to generate even when
  // a working CLI was right there.
  const [cliReady, setCliReady] = useState(false)
  const higgsfieldReady = settings.higgsfieldConnected || Boolean(cliToken) || cliReady

  // Provider-aware model list
  const availableModels = useMemo(() => getModelList(provider, mode), [provider, mode])
  const selectedModel = useMemo(
    () => availableModels.find((m) => m.id === modelId),
    [availableModels, modelId],
  )

  // Reset model + aspect ratio + resolution when provider/mode changes.
  // react-hooks/set-state-in-effect: deferred via queueMicrotask
  // (project convention), stale-guarded against a provider/mode flip
  // before the microtask fires.
  useEffect(() => {
    let stale = false
    queueMicrotask(() => {
      if (stale) return
      const newModelId = getDefaultModel(provider, mode)
      setModelId(newModelId)
      const models = getModelList(provider, mode)
      setAspectRatio(getDefaultAspectRatio(models))
      setResolution(getDefaultResolution(models))
    })
    return () => { stale = true }
  }, [provider, mode])

  // Reset aspect/resolution to the model's supported set when the
  // model changes (the default is fine for the default, but if the
  // user picks a different model the previous AR may not be in the
  // supported set).
  useEffect(() => {
    if (!selectedModel) return
    let stale = false
    queueMicrotask(() => {
      if (stale) return
      if (!selectedModel.aspectRatios.includes(aspectRatio)) {
        setAspectRatio(selectedModel.aspectRatios[0] || '1:1')
      }
      if (
        selectedModel.resolutions &&
        resolution &&
        !selectedModel.resolutions.includes(resolution)
      ) {
        setResolution(selectedModel.resolutions[0] || '')
      }
    })
    return () => { stale = true }
  }, [selectedModel, aspectRatio, resolution])

  // Elapsed-time ticker for the "Generating…" label
  useEffect(() => {
    if (!generating) return
    const startedAt = Date.now()
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)
    return () => clearInterval(interval)
  }, [generating])

  // V1.6 (M1.2): probe the local Higgsfield CLI auth state when the
  // provider is higgsfield. `binaryAvailable && authenticated` means
  // the user can generate via the CLI even without OAuth.
  useEffect(() => {
    if (provider !== 'higgsfield') return
    let cancelled = false
    fetch('/api/higgsfield/cli-auth')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { binaryAvailable?: boolean; authenticated?: boolean } | null) => {
        if (cancelled || !d) return
        setCliReady(Boolean(d.binaryAvailable && d.authenticated))
      })
      .catch(() => {
        if (!cancelled) setCliReady(false)
      })
    return () => { cancelled = true }
  }, [provider])

  // ------------------------------------------------------------------
  // Generate
  // ------------------------------------------------------------------

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      setError('Prompt is required')
      return
    }
    if (provider === 'higgsfield' && !higgsfieldReady) {
      setError(
        'Higgsfield isn’t ready. Run `higgsfield auth login` once, paste a CLI token, or connect your account in Settings → AI Engine.',
      )
      return
    }

    setGenerating(true)
    setError(null)
    setResult(null)
    setElapsed(0)

    try {
      let res: Response
      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        aspectRatio,
        negativePrompt: negativePrompt.trim() || undefined,
        referenceImageUrl: referenceImageUrl.trim() || undefined,
      }

      if (mode === 'image') {
        if (resolution) body.resolution = resolution

        if (provider === 'higgsfield') {
          body.model = modelId
          // V1.3.6-CLI-TOKEN: forward the user's CLI token (if any)
          // so the server uses the CLI path instead of OAuth.
          if (cliToken) body.higgsfieldCliToken = cliToken
          // V1.4.3-MANUAL-SKILLS: in manual mode (Studio panel),
          // the pipeline's `activeSkills`-based skill injection
          // doesn't run. The skill files live on the server's disk,
          // so a Server Action resolves the binding + content
          // (loading them here would pull node:fs into the client
          // bundle — the v1.4.4 Turbopack build break).
          try {
            const skillContent = await loadSkillContentForModel(`higgsfield:${modelId}`)
            if (skillContent) {
              body.prompt = `${skillContent}\n\n---\n\n# Idea to render\n\n${body.prompt}`
            }
          } catch {
            // Non-fatal — proceed with the raw prompt if the
            // skill loader fails.
          }
          res = await fetch('/api/higgsfield/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        } else if (provider === 'leonardo') {
          body.modelId = modelId
          res = await fetch('/api/ai/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        } else {
          // minimax
          body.model = modelId
          res = await fetch('/api/minimax-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        }
      } else {
        // mode === 'video'
        body.model = modelId
        if (provider === 'higgsfield') {
          // V1.6 (M1.2): forward the CLI token so the video route can
          // use the CLI path (parity with the image branch).
          if (cliToken) body.higgsfieldCliToken = cliToken
          res = await fetch('/api/higgsfield/video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        } else if (provider === 'leonardo') {
          res = await fetch('/api/leonardo/video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        } else {
          res = await fetch('/api/minimax-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        }
      }

      if (!res.ok) {
        let msg = `Generation failed (${res.status})`
        try {
          const data = (await res.json()) as { error?: string }
          msg = data.error || msg
        } catch {
          // ignore
        }
        throw new Error(msg)
      }

      const data = (await res.json()) as {
        url?: string
        imageUrl?: string
        videoUrl?: string
        requestId?: string
      }
      const assetUrl = data.url || data.imageUrl || data.videoUrl
      if (!assetUrl) {
        throw new Error('Provider returned no asset URL')
      }

      const newImage: GeneratedImage = {
        id: `manual-${Date.now()}`,
        url: assetUrl,
        prompt: prompt.trim(),
        status: 'ready',
        isVideo: mode === 'video',
        aspectRatio,
        modelInfo: {
          provider,
          modelId,
          modelName: selectedModel?.displayName || modelId,
        },
        savedAt: Date.now(),
      }

      // V1.3.4: persist to local disk so the asset survives the CDN
      // URL expiring. Fire-and-forget — if it fails we still have
      // the CDN URL.
      try {
        const localPath = await persistImageToDisk(assetUrl, newImage.id, newImage.savedAt!)
        if (localPath) newImage.localPath = localPath
      } catch {
        /* non-fatal */
      }

      setResult(newImage)
      onImageGenerated?.(newImage)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }, [
    prompt,
    provider,
    mode,
    modelId,
    aspectRatio,
    resolution,
    negativePrompt,
    referenceImageUrl,
    higgsfieldReady,
    selectedModel,
    cliToken,
    onImageGenerated,
  ])

  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-300" />
          Generate
        </h3>
        {/* Mode toggle */}
        <div className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode('image')}
            className={`flex items-center gap-1 rounded px-2 py-1 ${
              mode === 'image' ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white/80'
            }`}
            aria-pressed={mode === 'image'}
          >
            <ImageIcon className="h-3 w-3" />
            Image
          </button>
          <button
            type="button"
            onClick={() => setMode('video')}
            className={`flex items-center gap-1 rounded px-2 py-1 ${
              mode === 'video' ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white/80'
            }`}
            aria-pressed={mode === 'video'}
          >
            <Film className="h-3 w-3" />
            Video
          </button>
        </div>
      </div>

      {/* Provider + Model row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor="manual-provider" className="text-xs text-white/70 block">
            Provider
          </label>
          <select
            id="manual-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
            className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            disabled={generating}
          >
            <option value="higgsfield">
              Higgsfield
              {higgsfieldReady
                ? ' (connected)'
                : ' (not connected)'}
            </option>
            <option value="leonardo">Leonardo</option>
            <option value="minimax">MiniMax</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="manual-model" className="text-xs text-white/70 block">
            Model
            {selectedModel?.badge && (
              <span className="ml-1.5 inline-block rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">
                {selectedModel.badge}
              </span>
            )}
          </label>
          <select
            id="manual-model"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            disabled={generating}
          >
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
                {m.creditHint ? ` · ~${m.creditHint}cr` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Prompt */}
      <div className="space-y-1.5">
        <label htmlFor="manual-prompt" className="text-xs text-white/70 block">
          Prompt
        </label>
        <textarea
          id="manual-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`Describe the ${mode} you want…`}
          className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white min-h-[80px] resize-y"
          disabled={generating}
        />
      </div>

      {/* Negative prompt (collapsed-by-default for compactness) */}
      <details className="text-xs">
        <summary className="cursor-pointer text-white/50 hover:text-white/70 select-none">
          Advanced
        </summary>
        <div className="mt-2 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="manual-negative" className="text-xs text-white/70 block">
              Negative prompt
            </label>
            <textarea
              id="manual-negative"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              placeholder="Things to avoid in the output…"
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white min-h-[50px] resize-y"
              disabled={generating}
            />
          </div>
          {mode === 'image' && referenceImageUrl.trim() === '' && (
            <div className="space-y-1.5">
              <label htmlFor="manual-ref" className="text-xs text-white/70 block">
                Reference image URL (image-to-image)
              </label>
              <input
                id="manual-ref"
                value={referenceImageUrl}
                onChange={(e) => setReferenceImageUrl(e.target.value)}
                placeholder="https://… (optional)"
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white"
                disabled={generating}
              />
            </div>
          )}
        </div>
      </details>

      {/* Aspect ratio + resolution row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor="manual-aspect" className="text-xs text-white/70 block">
            Aspect ratio
          </label>
          <select
            id="manual-aspect"
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            disabled={generating}
          >
            {ASPECT_RATIOS.filter((ar) =>
              selectedModel ? selectedModel.aspectRatios.includes(ar) : true,
            ).map((ar) => (
              <option key={ar} value={ar}>
                {ar}
              </option>
            ))}
          </select>
        </div>
        {mode === 'image' && selectedModel?.resolutions && (
          <div className="space-y-1.5">
            <label htmlFor="manual-res" className="text-xs text-white/70 block">
              Resolution
            </label>
            <select
              id="manual-res"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
              disabled={generating}
            >
              {selectedModel.resolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Generate button */}
      <button
        type="button"
        onClick={handleGenerate}
        disabled={generating || !prompt.trim()}
        className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-white text-black px-3 py-2 text-sm font-medium hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {generating ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating… {elapsed > 0 ? `(${elapsed}s)` : ''}
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4" />
            Generate {selectedModel ? `(${selectedModel.creditHint ?? '?'}cr est.)` : ''}
          </>
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      {/* Result */}
      {result && <ResultPreview image={result} onClose={() => setResult(null)} />}
    </div>
  )
}
