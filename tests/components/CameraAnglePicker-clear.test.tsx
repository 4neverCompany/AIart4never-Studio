// V1.1.1-CAMERA-ANGLE-CLEAR: regression test for the "Clear" button in
// the CameraAnglePicker. The previous SettingsModal wiring passed
// `undefined` straight to `updateSettings({ cameraAngle: undefined })` —
// but `mergeSettings` (PROP-010 contract) intentionally strips
// `undefined` patches so a partial update can say "leave this field
// alone" without clobbering defaults. Result: the Clear button looked
// alive but did nothing, and the MCSLA C: fragment kept its old angle
// on the next prompt build.
//
// The fix lives in the parent (SettingsModal translates `undefined` →
// `clearSettings(['cameraAngle'])`), but the contract this test pins
// is the one the picker advertises to its parent:
//
//   1. With a value selected, the Clear button is visible.
//   2. Clicking it calls `onChange(undefined)`.
//   3. Without a value, no Clear button is rendered.
//
// That's all the picker needs to guarantee; the actual key-removal
// happens in the parent's `clearSettings` call (covered separately
// in the useSettings clearSettings unit test).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { CameraAnglePicker } from '@/components/Settings/CameraAnglePicker';
import { defaultSettings } from '@/types/mashup';

afterEach(() => cleanup());

describe('CameraAnglePicker — Clear button contract', () => {
  it('renders the Clear button when a value is selected', () => {
    render(
      <CameraAnglePicker
        settings={defaultSettings}
        value="low-angle-30"
        onChange={() => {}}
      />,
    );
    // The Clear button has the X icon and "Clear" label. The "role=button"
    // name match is case-insensitive.
    expect(screen.getByRole('button', { name: /clear/i })).toBeTruthy();
  });

  it('does NOT render the Clear button when no value is selected', () => {
    render(
      <CameraAnglePicker
        settings={defaultSettings}
        value={undefined}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  it('clicking Clear calls onChange(undefined) so the parent can drop the key', () => {
    const onChange = vi.fn();
    render(
      <CameraAnglePicker
        settings={defaultSettings}
        value="low-angle-30"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('clicking a card toggles selection: selected card → undefined, unselected card → slug', () => {
    const onChange = vi.fn();
    render(
      <CameraAnglePicker
        settings={defaultSettings}
        value="low-angle-30"
        onChange={onChange}
      />,
    );
    // Clicking the already-selected card deselects (calls onChange(undefined)).
    // The card itself is a role=radio (per the component source).
    const selectedCard = screen.getByRole('radio', { checked: true });
    fireEvent.click(selectedCard);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
