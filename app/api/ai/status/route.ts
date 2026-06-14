// LLM-INTEGRATION-0513: status probe for the vercel-ai provider.
//
// GET → JSON { available, authenticated, provider, model, modelInfo }
//
// Mirrors the shape of /api/nca/status so the SettingsModal can render
// a "vercel-ai" card with the same dot/label/model conventions. There
// is no install state — direct HTTPS API calls work as long as the env
// var is set, so `available` and `authenticated` collapse to the same
// signal: MINIMAX_API_KEY (preferred) or OPENAI_API_KEY is present on
// the server.
//
// 0513-CONSOLIDATION: v1.0 chain was MiniMax → OpenAI → Anthropic →
// OpenRouter. The v1.0.1 trim keeps only MiniMax and OpenAI.
//
// The picked provider's default model is reported so the UI can show
// e.g. "MiniMax-M3" without hitting the underlying API. The model is
// resolved through the catalog so legacy alias forms
// (e.g. `M2.7-highspeed` written by pre-v082 settings) are normalised
// before being reported.

import { NextResponse } from 'next/server';
import {
  resolveTextModel,
  getDefaultTextModelForProvider,
  getTextModelCatalogEntry,
} from '@/lib/text-model-catalog';

export const runtime = 'nodejs';

interface AiStatus {
  available: boolean;
  authenticated: boolean;
  // 0513-CONSOLIDATION: chain trimmed to {minimax, openai}. See module
  // header for rationale.
  provider: 'minimax' | 'openai' | null;
  model: string | null;
  /**
   * V082: full catalog entry for the resolved model. The Settings
   * card uses this to render the family/generation/description
   * without a second round-trip. Null when the model isn't in the
   * catalog (legacy / typo / unknown upstream id).
   */
  modelInfo: {
    modelId: string;
    family: string;
    generation: string;
    description: string;
    contextWindow: number;
    defaultMaxTokens: number;
    isDefault: boolean;
  } | null;
}

// Detection priority MUST mirror resolveProvider() in
// app/api/ai/prompt/route.ts — the status badge must agree with the
// provider that will actually serve the next request.
function detect(): AiStatus {
  const envModel = process.env.VERCEL_AI_MODEL?.trim() || undefined;
  // V082-CATALOG: resolve through the catalog so legacy alias
  // forms get normalised. Falls back to the provider default when
  // no env var is set.
  const pickModel = (provider: 'minimax' | 'openai'): string => {
    if (envModel) {
      const resolved = resolveTextModel(envModel);
      if (resolved && resolved.provider === provider) return resolved.modelId;
    }
    return (
      getDefaultTextModelForProvider(provider) ||
      (provider === 'minimax' ? 'MiniMax-M3' : 'gpt-4o-mini')
    );
  };
  const buildInfo = (modelId: string) => {
    const entry = getTextModelCatalogEntry(modelId);
    if (!entry) return null;
    return {
      modelId: entry.modelId,
      family: entry.family,
      generation: entry.generation,
      description: entry.description,
      contextWindow: entry.contextWindow,
      defaultMaxTokens: entry.defaultMaxTokens,
      isDefault: !!entry.isDefault,
    };
  };
  if (process.env.MINIMAX_API_KEY) {
    const modelId = pickModel('minimax');
    return {
      available: true,
      authenticated: true,
      provider: 'minimax',
      model: modelId,
      modelInfo: buildInfo(modelId),
    };
  }
  if (process.env.OPENAI_API_KEY) {
    const modelId = pickModel('openai');
    return {
      available: true,
      authenticated: true,
      provider: 'openai',
      model: modelId,
      modelInfo: buildInfo(modelId),
    };
  }
  return { available: false, authenticated: false, provider: null, model: null, modelInfo: null };
}

export async function GET(): Promise<Response> {
  return NextResponse.json(detect());
}
