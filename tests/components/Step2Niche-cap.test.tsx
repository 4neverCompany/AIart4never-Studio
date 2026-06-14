// @vitest-environment jsdom
//
// V081-TEST-GAPS: pin the onboarding 10-item selection cap (V080-DES-001).
//
// QA flagged this in V080-QA-REVIEW.md (gap #3). The cap was raised
// 2 → 10 in V080-DES-001 and the QA reviewer wanted verification that
// the guard in `ChipRow.toggle()` still blocks selections past the
// new max — *and* that the disabled state is reflected in the DOM
// (the button gets disabled + the ".opacity-40 cursor-not-allowed"
// classes), so a future code-tidy can't quietly drop the guard.
//
// ChipRow is private; we drive it through the public Step2Niche
// surface so the test pins the exposed contract, not the internals.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Step2Niche } from '@/components/onboarding/steps/Step2Niche';

beforeEach(() => {
  cleanup();
});

describe('Step2Niche — 10-item selection cap (V080-DES-001 / V081-TEST-GAPS)', () => {
  it('shows the live "N / 10" counter that tracks selections', () => {
    const onChangeUniverses = vi.fn();
    render(
      <Step2Niche
        universes={['Marvel', 'DC']}
        genres={[]}
        onChangeUniverses={onChangeUniverses}
        onChangeGenres={() => {}}
      />,
    );
    // Universes counter at "2 / 10"; genres at "0 / 10"
    expect(screen.getByText('2 / 10')).toBeTruthy();
    expect(screen.getByText('0 / 10')).toBeTruthy();
  });

  it('lets a user toggle a curated chip on when below the cap', () => {
    const onChangeUniverses = vi.fn();
    render(
      <Step2Niche
        universes={[]}
        genres={[]}
        onChangeUniverses={onChangeUniverses}
        onChangeGenres={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Marvel' }));
    expect(onChangeUniverses).toHaveBeenCalledWith(['Marvel']);
  });

  it('blocks toggling a NEW chip on once the cap is reached (button disabled)', () => {
    const cap10 = ['Marvel', 'DC', 'Star Wars', 'Star Trek', 'Warhammer 40k',
                   'Dune', 'LOTR', 'Game of Thrones', 'Anime', 'Studio Ghibli'];
    const onChangeUniverses = vi.fn();
    render(
      <Step2Niche
        universes={cap10}
        genres={[]}
        onChangeUniverses={onChangeUniverses}
        onChangeGenres={() => {}}
      />,
    );
    // 11th chip — currently unselected, must be disabled
    const eleventh = screen.getByRole('button', { name: 'Disney' });
    expect(eleventh).toBeDisabled();
    fireEvent.click(eleventh);
    expect(onChangeUniverses).not.toHaveBeenCalled();
  });

  it('keeps the 10 already-selected chips clickable for deselection at the cap', () => {
    const cap10 = ['Marvel', 'DC', 'Star Wars', 'Star Trek', 'Warhammer 40k',
                   'Dune', 'LOTR', 'Game of Thrones', 'Anime', 'Studio Ghibli'];
    const onChangeUniverses = vi.fn();
    render(
      <Step2Niche
        universes={cap10}
        genres={[]}
        onChangeUniverses={onChangeUniverses}
        onChangeGenres={() => {}}
      />,
    );
    // A selected chip at the cap stays clickable — user must be able
    // to drop one to make room for another.
    const selected = screen.getByRole('button', { name: 'Marvel' });
    expect(selected).not.toBeDisabled();
    fireEvent.click(selected);
    expect(onChangeUniverses).toHaveBeenCalledWith(
      cap10.filter((u) => u !== 'Marvel'),
    );
  });

  it('disables the "Add custom" affordance once the cap is reached', () => {
    const cap10 = ['Marvel', 'DC', 'Star Wars', 'Star Trek', 'Warhammer 40k',
                   'Dune', 'LOTR', 'Game of Thrones', 'Anime', 'Studio Ghibli'];
    render(
      <Step2Niche
        universes={cap10}
        genres={[]}
        onChangeUniverses={() => {}}
        onChangeGenres={() => {}}
      />,
    );
    const addCustom = screen.getAllByRole('button', { name: /Add custom/i });
    // One per ChipRow (universes + genres). Universes side is at cap →
    // its button is disabled; genres side is empty → its button is
    // enabled. Verify both halves so the cap rule isn't accidentally
    // global instead of per-row.
    const universesBtn = addCustom[0]!;
    const genresBtn = addCustom[1]!;
    expect(universesBtn).toBeDisabled();
    expect(genresBtn).not.toBeDisabled();
  });

  it('enforces the cap independently per row (universes at cap does not lock genres)', () => {
    const cap10 = ['Marvel', 'DC', 'Star Wars', 'Star Trek', 'Warhammer 40k',
                   'Dune', 'LOTR', 'Game of Thrones', 'Anime', 'Studio Ghibli'];
    const onChangeGenres = vi.fn();
    render(
      <Step2Niche
        universes={cap10}
        genres={[]}
        onChangeUniverses={() => {}}
        onChangeGenres={onChangeGenres}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sci-Fi' }));
    expect(onChangeGenres).toHaveBeenCalledWith(['Sci-Fi']);
  });
});
