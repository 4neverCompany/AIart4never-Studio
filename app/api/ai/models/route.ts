// V082: /api/ai/models — full model catalog for the vercel-ai provider.
//
// Mirrors the nca equivalent (/api/nca/models): GET → JSON list of
// model entries with availability flags derived from server env
// vars. The Settings → AI Engine tab calls this to populate the
// model picker when the user has selected the vercel-ai agent.
//
// Response shape (each entry):
//   {
//     modelId, provider, family, generation, description,
//     recommendedFor[], contextWindow, defaultMaxTokens,
//     defaultTemperature, isDefault, isHighspeed, available
//   }
//
// `available` is true iff the entry's provider has its API key env
// var set on the server. Unavailable models are still returned so
// the picker can render them greyed out — users see what's possible
// with a single key toggle, and the `apiKeys` list in the Settings
// tab points at the env var name they need to set.

import { NextResponse } from 'next/server';
import { getAvailableTextModels, type TextModelAvailability } from '@/lib/text-model-catalog';

export const runtime = 'nodejs';

interface ModelEntryDto {
  modelId: string;
  provider: string;
  family: string;
  generation: string;
  description: string;
  recommendedFor: readonly string[];
  contextWindow: number;
  defaultMaxTokens: number;
  defaultTemperature: number;
  isDefault: boolean;
  isHighspeed: boolean;
  /** True iff the entry's provider has its env-var API key set. */
  available: boolean;
  /** Provider API-key env var name, surfaced for the Settings tab. */
  envKeyName: string | null;
}

const ENV_KEY_FOR_PROVIDER: Record<string, string> = {
  minimax: 'MINIMAX_API_KEY',
  openai: 'OPENAI_API_KEY',
};

function toDto(entry: TextModelAvailability): ModelEntryDto {
  const envKeyName = ENV_KEY_FOR_PROVIDER[entry.entry.provider] ?? null;
  return {
    modelId: entry.entry.modelId,
    provider: entry.entry.provider,
    family: entry.entry.family,
    generation: entry.entry.generation,
    description: entry.entry.description,
    recommendedFor: entry.entry.recommendedFor,
    contextWindow: entry.entry.contextWindow,
    defaultMaxTokens: entry.entry.defaultMaxTokens,
    defaultTemperature: entry.entry.defaultTemperature,
    isDefault: !!entry.entry.isDefault,
    isHighspeed: !!entry.entry.isHighspeed,
    available: entry.available,
    envKeyName,
  };
}

export async function GET(): Promise<Response> {
  // V082: read env vars server-side. Route lives on nodejs runtime
  // so process.env is safe. Routes pass the env snapshot into the
  // catalog's pure filter so the catalog itself stays testable
  // without env mocks.
  const envKeys = {
    minimax: Boolean(process.env.MINIMAX_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
  };
  const models = getAvailableTextModels(envKeys).map(toDto);
  return NextResponse.json({ models, envKeys });
}
