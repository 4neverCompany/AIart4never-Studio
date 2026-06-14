// @vitest-environment jsdom
//
// V030-008-per-model: verifies that ParamSuggestionCard maintains
// independent per-model state and emits the correct per-model map
// on Apply. Catches two bugs:
//
//   1. Tab selection doesn't switch which model's settings are shown
//   2. Style changes bleed to ALL models (shared state instead of keyed)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, fireEvent, screen, within } from '@testing-library/react';
import { ParamSuggestionCard } from '@/components/ParamSuggestionCard';
import type { ParamSuggestion, PerModelImageSuggestion } from '@/lib/param-suggest';

beforeEach(() => {
  cleanup();
});

function makeImageSuggestion(
  modelId: string,
  overrides?: Partial<PerModelImageSuggestion>,
): PerModelImageSuggestion {
  return {
    type: 'image',
    modelId,
    apiName: modelId,
    aspectRatio: '1:1',
    width: 1024,
    height: 1024,
    imageSize: '1K',
    promptEnhance: 'ON',
    reason: `${modelId} default settings`,
    source: 'rules',
    ...overrides,
  };
}

function makeSuggestion(
  perModel: Record<string, PerModelImageSuggestion>,
  modelIds?: string[],
): ParamSuggestion {
  const ids = modelIds ?? Object.keys(perModel);
  const first = perModel[ids[0]];
  return {
    modelIds: ids,
    perModel,
    aspectRatio: first?.aspectRatio ?? '1:1',
    imageSize: first?.imageSize ?? '1K',
    reasons: {
      models: 'test',
      aspectRatio: 'test',
      imageSize: 'test',
    },
    priorMatchCount: 0,
    source: 'rules',
  };
}

const styles = [
  { name: 'Dynamic', uuid: 'uuid-dynamic' },
  { name: 'Ray Traced', uuid: 'uuid-ray' },
  { name: 'Illustration', uuid: 'uuid-illust' },
];

describe('ParamSuggestionCard — per-model state isolation', () => {
  it('renders an independent panel for each selected model', () => {
    const suggestion = makeSuggestion({
      'nano-banana-2': makeImageSuggestion('nano-banana-2', { style: 'Dynamic' }),
      'nano-banana-pro': makeImageSuggestion('nano-banana-pro', { style: 'Illustration' }),
      'gpt-image-1.5': makeImageSuggestion('gpt-image-1.5'),
    });

    const { container } = render(
      <ParamSuggestionCard
        suggestion={suggestion}
        availableStyles={styles}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    // Each model has its own panel div — verify all three panels render
    const panels = container.querySelectorAll('.border.border-zinc-800\\/80');
    expect(panels.length).toBe(3);

    // Model names appear in both toggle buttons and panel headers
    expect(screen.getAllByText(/Nano Banana 2/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Nano Banana Pro/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/GPT Image-1.5/).length).toBeGreaterThanOrEqual(1);
  });

  it('changing style in Edit mode for one model does NOT change another model', () => {
    // V082-PARAM-SCRIPT: gpt-image-1.5's editor no longer renders a
    // Style row (the model has no style parameter), so this test now
    // pairs two style-capable models and verifies the per-model
    // isolation that the original test asserted.
    const onApply = vi.fn();
    const suggestion = makeSuggestion({
      'nano-banana-2': makeImageSuggestion('nano-banana-2', { style: 'Dynamic' }),
      'nano-banana-pro': makeImageSuggestion('nano-banana-pro'),
    });

    const { container } = render(
      <ParamSuggestionCard
        suggestion={suggestion}
        availableStyles={styles}
        onApply={onApply}
        onDismiss={vi.fn()}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getByTitle('Override per-model settings'));

    const panels = container.querySelectorAll('.border.border-zinc-800\\/80');
    expect(panels.length).toBe(2);

    const allLabels = Array.from(container.querySelectorAll('label'));
    const styleLabels = allLabels.filter(l => l.textContent?.trim() === 'Style');
    expect(styleLabels.length).toBe(2);

    const nanoStyleSelect = styleLabels[0].parentElement?.querySelector('select');
    const proStyleSelect = styleLabels[1].parentElement?.querySelector('select');
    expect(nanoStyleSelect).toBeTruthy();
    expect(proStyleSelect).toBeTruthy();

    fireEvent.change(nanoStyleSelect!, { target: { value: 'Ray Traced' } });

    // The second model's style select should still be untouched.
    expect((proStyleSelect as HTMLSelectElement).value).toBe('');

    fireEvent.click(screen.getByText('Apply'));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [, , perModel] = onApply.mock.calls[0];

    expect(perModel['nano-banana-2'].style).toBe('Ray Traced');
    expect(perModel['nano-banana-pro'].style).toBeUndefined();
  });

  it('hides Style and Negative Prompt rows for models that do not support them', () => {
    // V082-PARAM-SCRIPT: gpt-image-1.5 has capabilities.styles === false
    // and capabilities.negativePrompt === false. The editor must not
    // expose those knobs for it.
    const suggestion = makeSuggestion({
      'gpt-image-1.5': makeImageSuggestion('gpt-image-1.5'),
    });

    const { container } = render(
      <ParamSuggestionCard
        suggestion={suggestion}
        availableStyles={styles}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('Override per-model settings'));

    const allLabels = Array.from(container.querySelectorAll('label'));
    const styleLabels = allLabels.filter(l => l.textContent?.trim() === 'Style');
    const negLabels = allLabels.filter(l => l.textContent?.trim() === 'Negative Prompt');
    expect(styleLabels.length).toBe(0);
    expect(negLabels.length).toBe(0);
  });

  it('Apply emits the full per-model map with independent values', () => {
    const onApply = vi.fn();
    const suggestion = makeSuggestion({
      'nano-banana-2': makeImageSuggestion('nano-banana-2', {
        style: 'Dynamic',
        aspectRatio: '16:9',
      }),
      'nano-banana-pro': makeImageSuggestion('nano-banana-pro', {
        style: 'Illustration',
        aspectRatio: '9:16',
      }),
      'gpt-image-1.5': makeImageSuggestion('gpt-image-1.5', {
        aspectRatio: '1:1',
        quality: 'HIGH',
      }),
    });

    render(
      <ParamSuggestionCard
        suggestion={suggestion}
        availableStyles={styles}
        onApply={onApply}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Apply'));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [modelIds, , perModel] = onApply.mock.calls[0];

    expect(modelIds).toEqual(['nano-banana-2', 'nano-banana-pro', 'gpt-image-1.5']);

    // Each model has its own independent values
    expect(perModel['nano-banana-2'].style).toBe('Dynamic');
    expect(perModel['nano-banana-2'].aspectRatio).toBe('16:9');

    expect(perModel['nano-banana-pro'].style).toBe('Illustration');
    expect(perModel['nano-banana-pro'].aspectRatio).toBe('9:16');

    expect(perModel['gpt-image-1.5'].style).toBeUndefined();
    expect(perModel['gpt-image-1.5'].aspectRatio).toBe('1:1');
    expect(perModel['gpt-image-1.5'].quality).toBe('HIGH');
  });

  it('toggling a model off removes it from the Apply payload', () => {
    const onApply = vi.fn();
    const suggestion = makeSuggestion({
      'nano-banana-2': makeImageSuggestion('nano-banana-2'),
      'gpt-image-1.5': makeImageSuggestion('gpt-image-1.5'),
    });

    render(
      <ParamSuggestionCard
        suggestion={suggestion}
        availableStyles={styles}
        onApply={onApply}
        onDismiss={vi.fn()}
      />,
    );

    // Click "GPT Image-1.5" model toggle button to deselect it
    const gptButton = screen.getByRole('button', { name: /GPT Image-1.5/ });
    fireEvent.click(gptButton);

    fireEvent.click(screen.getByText('Apply'));

    const [modelIds, , perModel] = onApply.mock.calls[0];
    expect(modelIds).toEqual(['nano-banana-2']);
    expect(perModel['gpt-image-1.5']).toBeUndefined();
    expect(perModel['nano-banana-2']).toBeDefined();
  });

  it('independent aspect ratio changes per model', () => {
    const onApply = vi.fn();
    const suggestion = makeSuggestion({
      'nano-banana-2': makeImageSuggestion('nano-banana-2', { aspectRatio: '1:1' }),
      'nano-banana-pro': makeImageSuggestion('nano-banana-pro', { aspectRatio: '1:1' }),
    });

    const { container } = render(
      <ParamSuggestionCard
        suggestion={suggestion}
        availableStyles={styles}
        onApply={onApply}
        onDismiss={vi.fn()}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getByTitle('Override per-model settings'));

    // Find Aspect Ratio selects via their labels
    const allLabels = Array.from(container.querySelectorAll('label'));
    const aspectLabels = allLabels.filter(l => l.textContent?.trim() === 'Aspect Ratio');
    expect(aspectLabels.length).toBe(2);

    const nanoAspectSelect = aspectLabels[0].parentElement?.querySelector('select');
    const proAspectSelect = aspectLabels[1].parentElement?.querySelector('select');
    expect(nanoAspectSelect).toBeTruthy();
    expect(proAspectSelect).toBeTruthy();

    // Change first model to 16:9, second to 9:16
    fireEvent.change(nanoAspectSelect!, { target: { value: '16:9' } });
    fireEvent.change(proAspectSelect!, { target: { value: '9:16' } });

    fireEvent.click(screen.getByText('Apply'));

    const [, , perModel] = onApply.mock.calls[0];
    expect(perModel['nano-banana-2'].aspectRatio).toBe('16:9');
    expect(perModel['nano-banana-pro'].aspectRatio).toBe('9:16');
  });
});
