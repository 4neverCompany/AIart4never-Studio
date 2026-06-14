import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react';
import { Toast, showToast, type ToastType } from '@/components/Toast';

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function dispatchToast(message: string, type: ToastType) {
  act(() => {
    showToast(message, type);
  });
}

describe('Toast — variant rendering', () => {
  it('renders nothing when no toasts are active', () => {
    const { container } = render(<Toast />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders a success toast (Electric Blue accent)', () => {
    render(<Toast />);
    dispatchToast('Image saved!', 'success');
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.className).toContain('border-[#00e6ff]/30');
    expect(alert).toHaveTextContent('Image saved!');
  });

  it('renders an error toast (red accent)', () => {
    render(<Toast />);
    dispatchToast('Failed to save', 'error');
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-red-500/30');
    expect(alert).toHaveTextContent('Failed to save');
  });

  it('renders a warning toast (Metallic Gold accent)', () => {
    render(<Toast />);
    dispatchToast('Are you sure?', 'warning');
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-[#c5a062]/40');
  });

  it('renders an info toast (zinc accent)', () => {
    render(<Toast />);
    dispatchToast('Heads up', 'info');
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-zinc-700/60');
  });
});

describe('Toast — pipeline variants (QOL §4d)', () => {
  it("renders 'pipeline-progress' with Electric Blue accent", () => {
    render(<Toast />);
    dispatchToast('3 ideas queued for captions', 'pipeline-progress');
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.className).toContain('border-[#00e6ff]/40');
    expect(alert).toHaveTextContent('3 ideas queued for captions');
  });

  it("renders 'pipeline-ready' with Metallic Gold accent", () => {
    render(<Toast />);
    dispatchToast('Carousel ready to post', 'pipeline-ready');
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.className).toContain('border-[#c5a062]/40');
    expect(alert).toHaveTextContent('Carousel ready to post');
  });

  it('uses distinct border tints across pipeline-progress and pipeline-ready', () => {
    render(<Toast />);
    dispatchToast('progressing', 'pipeline-progress');
    dispatchToast('ready', 'pipeline-ready');
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    const progressEl = alerts.find((el) => el.textContent?.includes('progressing'))!;
    const readyEl = alerts.find((el) => el.textContent?.includes('ready'))!;
    expect(progressEl.className).toContain('border-[#00e6ff]/40');
    expect(readyEl.className).toContain('border-[#c5a062]/40');
  });
});

describe('Toast — behavior', () => {
  it('caps the visible stack at 4 toasts', () => {
    render(<Toast />);
    for (let i = 0; i < 6; i++) {
      dispatchToast(`message ${i}`, 'info');
    }
    expect(screen.getAllByRole('alert')).toHaveLength(4);
    // Oldest two were dropped — newest 4 remain
    expect(screen.queryByText('message 0')).toBeNull();
    expect(screen.queryByText('message 1')).toBeNull();
    expect(screen.getByText('message 5')).toBeInTheDocument();
  });

  it('dismisses on close button click and unmounts after exit animation', () => {
    render(<Toast />);
    dispatchToast('dismissable', 'success');
    const closeBtn = screen.getByRole('button', { name: 'Dismiss' });

    act(() => {
      fireEvent.click(closeBtn);
    });
    // Still in DOM during exit animation
    expect(screen.queryByRole('alert')).toBeInTheDocument();

    // After exit timer (280ms), toast unmounts
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('auto-dismisses after the configured timeout', () => {
    render(<Toast />);
    dispatchToast('auto-dismiss', 'pipeline-progress');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Advance past the dismiss + exit windows (3500ms + 280ms)
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
