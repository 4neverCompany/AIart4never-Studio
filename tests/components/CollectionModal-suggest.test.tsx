// @vitest-environment jsdom
//
// V080-DES-004: pin the Collection auto-name UX contract.
// - The Suggest button only appears when the modal opened with
//   pre-selected images AND the parent supplied an onSuggest callback.
// - Clicking Suggest shows a loading affordance on the inputs while
//   the call is in flight.
// - When onSuggest resolves with a name+description, both fields fill.
// - When onSuggest resolves with null (pi.dev unavailable), the fields
//   stay empty and no error is rendered.
// - The user can still type into / override the suggested values.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollectionModal } from '@/components/CollectionModal';

beforeEach(() => {
  cleanup();
});

describe('CollectionModal — V080-DES-004 auto-suggest', () => {
  it('hides the Suggest button when no images are pre-selected', () => {
    render(
      <CollectionModal
        onClose={() => {}}
        onCreate={() => {}}
        selectionCount={0}
        onSuggest={async () => ({ name: 'X', description: 'Y' })}
      />,
    );
    expect(screen.queryByRole('button', { name: /suggest/i })).toBeNull();
  });

  it('hides the Suggest button when no onSuggest handler is provided', () => {
    render(
      <CollectionModal
        onClose={() => {}}
        onCreate={() => {}}
        selectionCount={5}
      />,
    );
    expect(screen.queryByRole('button', { name: /suggest/i })).toBeNull();
  });

  it('shows the Suggest button when both selection and handler are present', () => {
    render(
      <CollectionModal
        onClose={() => {}}
        onCreate={() => {}}
        selectionCount={3}
        onSuggest={async () => ({ name: 'Marvel Heroes', description: 'A collection' })}
      />,
    );
    expect(screen.getByRole('button', { name: /suggest/i })).toBeTruthy();
  });

  it('populates name AND description from a successful suggest call', async () => {
    const user = userEvent.setup();
    const onSuggest = vi.fn().mockResolvedValue({
      name: 'Cyberpunk Saturday Mornings',
      description: 'Retro cartoons reimagined in neon-soaked future LA.',
    });
    render(
      <CollectionModal
        onClose={() => {}}
        onCreate={() => {}}
        selectionCount={4}
        onSuggest={onSuggest}
      />,
    );

    await user.click(screen.getByRole('button', { name: /suggest/i }));

    await waitFor(() => {
      expect(onSuggest).toHaveBeenCalledTimes(1);
    });

    const nameInput = screen.getByPlaceholderText(/leave blank to auto-name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Cyberpunk Saturday Mornings');

    // Description was populated AND the disclosure was auto-opened.
    const descTextarea = screen.getByPlaceholderText(/what is this collection about/i) as HTMLTextAreaElement;
    expect(descTextarea.value).toBe('Retro cartoons reimagined in neon-soaked future LA.');
  });

  it('leaves fields empty and renders no error when onSuggest returns null (pi.dev unavailable)', async () => {
    const user = userEvent.setup();
    const onSuggest = vi.fn().mockResolvedValue(null);
    render(
      <CollectionModal
        onClose={() => {}}
        onCreate={() => {}}
        selectionCount={2}
        onSuggest={onSuggest}
      />,
    );

    await user.click(screen.getByRole('button', { name: /suggest/i }));

    await waitFor(() => {
      expect(onSuggest).toHaveBeenCalledTimes(1);
    });

    const nameInput = screen.getByPlaceholderText(/leave blank to auto-name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('');
    // No alert, no error text, no toast surfaced — quiet failure per AC.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/error|failed|unavailable/i)).toBeNull();
  });

  it('lets the user override the suggested name after generation', async () => {
    const user = userEvent.setup();
    const onSuggest = vi.fn().mockResolvedValue({
      name: 'Auto Name',
      description: 'Auto desc',
    });
    render(
      <CollectionModal
        onClose={() => {}}
        onCreate={() => {}}
        selectionCount={1}
        onSuggest={onSuggest}
      />,
    );

    await user.click(screen.getByRole('button', { name: /suggest/i }));
    await waitFor(() => expect(onSuggest).toHaveBeenCalled());

    const nameInput = screen.getByPlaceholderText(/leave blank to auto-name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Auto Name');

    // User edits — input stays editable after the suggest cycle.
    await user.clear(nameInput);
    await user.type(nameInput, 'My Custom Name');
    expect(nameInput.value).toBe('My Custom Name');
  });

  it('disables the Suggest button while a request is in flight', async () => {
    let resolveSuggest: (v: { name: string; description: string }) => void = () => {};
    const onSuggest = vi.fn(
      () =>
        new Promise<{ name: string; description: string }>((res) => {
          resolveSuggest = res;
        }),
    );
    render(
      <CollectionModal
        onClose={() => {}}
        onCreate={() => {}}
        selectionCount={3}
        onSuggest={onSuggest}
      />,
    );

    const suggestBtn = screen.getByRole('button', { name: /suggest/i });
    fireEvent.click(suggestBtn);

    // While pending, the button is disabled (cursor-wait styling).
    await waitFor(() => expect(suggestBtn).toBeDisabled());

    resolveSuggest({ name: 'X', description: 'Y' });
    await waitFor(() => expect(suggestBtn).not.toBeDisabled());
  });
});
