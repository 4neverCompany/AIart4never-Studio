// V050-006: extracted from MainContent.handlePushIdeaToCompare so the
// "push to Studio" wiring is unit-testable. The original V041-HOTFIX-3BUGS
// Bug 1 was that this handler called a hand-rolled prompt-enhance instead
// of `suggestParametersAI`. Putting it in a helper that takes its
// dependencies as args means a regression of that shape now fails an
// arg-shape assertion in tests/integration/push-idea-to-studio.test.ts
// instead of slipping into a release.

import type { Dispatch, SetStateAction } from 'react';
import type { GenerateOptions, GeneratedImage, LeonardoModelConfig } from '@/types/mashup';
import type { ParamSuggestion, SuggestParametersInput } from './param-suggest';

export interface PushIdeaToStudioDeps {
  setIsPushing: (v: boolean) => void;
  setView: (v: 'compare') => void;
  setComparisonPrompt: (s: string) => void;
  setComparisonModels: (ids: string[]) => void;
  setComparisonOptions: Dispatch<SetStateAction<GenerateOptions>>;
  setParamSuggestion: (s: ParamSuggestion) => void;
  /** Arms the carousel watcher in MainContent (sets a ref) so that, if the
   *  user has carousel mode on, the resulting Compare run will auto-group. */
  armCarouselWatcher: () => void;
  /** Function-shaped suggest call so tests can substitute a vi.fn(). The
   *  production call site passes `suggestParametersAI` directly. */
  suggest: (input: SuggestParametersInput) => Promise<ParamSuggestion>;
  availableModels: LeonardoModelConfig[];
  modelGuides: Record<string, string>;
  availableStyles: { name: string; uuid: string }[];
  savedImages: GeneratedImage[];
}

export async function pushIdeaToStudio(
  prompt: string,
  deps: PushIdeaToStudioDeps,
): Promise<void> {
  deps.setIsPushing(true);
  deps.setView('compare');
  deps.armCarouselWatcher();
  deps.setComparisonPrompt(prompt);
  try {
    const suggestion = await deps.suggest({
      prompt,
      availableModels: deps.availableModels,
      modelGuides: deps.modelGuides,
      availableStyles: deps.availableStyles,
      savedImages: deps.savedImages,
    });
    deps.setComparisonModels(suggestion.modelIds);
    deps.setComparisonOptions((prev) => ({
      ...prev,
      aspectRatio: suggestion.aspectRatio,
      imageSize: suggestion.imageSize,
      negativePrompt: suggestion.negativePrompt ?? prev.negativePrompt ?? '',
      style: suggestion.style ?? prev.style,
      quality: suggestion.quality,
      promptEnhance: suggestion.promptEnhance,
    }));
    deps.setParamSuggestion(suggestion);
  } catch {
    // Suggestion failed entirely — prompt is still set; the user can pick
    // params manually or hit the Suggest button to retry. setIsPushing(false)
    // still runs in `finally`.
  } finally {
    deps.setIsPushing(false);
  }
}
