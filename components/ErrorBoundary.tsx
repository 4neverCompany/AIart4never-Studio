'use client';

import React, { Component, type ErrorInfo, type ReactNode, type ComponentType } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

// ── Props / State ─────────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  section?: string;
  /**
   * fullScreen: true → covers the entire viewport (use for the root app boundary).
   * false (default) → compact inline card (use for section boundaries).
   */
  fullScreen?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// ── Full-screen fallback ──────────────────────────────────────────────────────

function FullScreenError({
  section,
  error,
  onRetry,
}: {
  section?: string;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[9995] flex flex-col items-center justify-center bg-[#050505]"
      role="alert"
      aria-live="assertive"
    >
      {/* Radial depth glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 40% at 50% 42%, rgba(197,160,98,0.04) 0%, transparent 70%)',
        }}
        aria-hidden="true"
      />

      {/* ── Logo mark (distressed — red-tinted centre dot) ── */}
      <div className="relative w-14 h-14 mb-7 shrink-0" aria-hidden="true">
        <div
          className="absolute inset-0 rounded-full border border-[#c5a062]/40"
          style={{ animation: 'eb-ring 4s ease-in-out infinite' }}
        />
        <div
          className="absolute rounded-full border border-red-500/30"
          style={{ inset: '10px', animation: 'eb-ring 4s ease-in-out infinite 0.6s' }}
        />
        <div
          className="absolute rounded-full bg-red-500"
          style={{
            width: 8,
            height: 8,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            boxShadow: '0 0 10px rgba(239,68,68,0.8), 0 0 20px rgba(239,68,68,0.3)',
          }}
        />
      </div>

      {/* ── Heading ── */}
      <h1 className="text-xl font-bold text-white mb-1 tracking-tight">
        Something went wrong
      </h1>

      {/* ── Section badge ── */}
      {section && (
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600 mb-4">
          {section}
        </p>
      )}

      {/* ── Gold rule ── */}
      <div
        className="w-24 h-px mb-6"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(197,160,98,0.35), transparent)',
        }}
        aria-hidden="true"
      />

      {/* ── Error message ── */}
      {error?.message && (
        <p className="text-sm text-zinc-500 mb-6 text-center max-w-sm px-6 leading-relaxed font-mono">
          {error.message}
        </p>
      )}

      {/* ── Actions ── */}
      <div className="flex gap-3">
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#c5a062] hover:bg-[#d4b278] text-[#050505] transition-colors shadow-[0_0_12px_rgba(197,160,98,0.25)]"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold border border-[#00e6ff]/30 text-[#00e6ff] hover:bg-[#00e6ff]/10 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reload app
        </button>
      </div>

      <style>{`
        @keyframes eb-ring {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50%       { opacity: 0.7; transform: scale(1.04); }
        }
      `}</style>
    </div>
  );
}

// ── Inline fallback ───────────────────────────────────────────────────────────

function InlineError({
  section,
  error,
  onRetry,
}: {
  section?: string;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center p-4 sm:p-8 min-h-[150px] sm:min-h-[200px] rounded-xl bg-[#050505] border border-[#c5a062]/20 shadow-[0_4px_24px_rgba(0,0,0,0.5)]"
      role="alert"
    >
      {/* Icon */}
      <div className="w-10 h-10 rounded-xl bg-[#c5a062]/10 border border-[#c5a062]/30 flex items-center justify-center mb-4">
        <AlertTriangle className="w-5 h-5 text-[#c5a062]" />
      </div>

      {/* Heading */}
      <h3 className="text-base font-semibold text-white mb-1 tracking-tight">
        Something went wrong
      </h3>

      {/* Section label */}
      {section && (
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-600 mb-3">
          {section}
        </p>
      )}

      {/* Error message */}
      <p className="text-xs text-zinc-500 mb-5 text-center max-w-xs leading-relaxed font-mono">
        {error?.message || 'An unexpected error occurred.'}
      </p>

      {/* Retry */}
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#c5a062]/15 hover:bg-[#c5a062]/25 border border-[#c5a062]/30 text-[#c5a062] transition-colors"
      >
        <RefreshCw className="w-3 h-3" />
        Retry
      </button>
    </div>
  );
}

// ── ErrorBoundary class ───────────────────────────────────────────────────────

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const section = this.props.section || 'Unknown';
    console.error(`[ErrorBoundary:${section}] Caught error:`, error);
    console.error(`[ErrorBoundary:${section}] Component stack:`, errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      if (this.props.fullScreen) {
        return (
          <FullScreenError
            section={this.props.section}
            error={this.state.error}
            onRetry={this.handleReset}
          />
        );
      }

      return (
        <InlineError
          section={this.props.section}
          error={this.state.error}
          onRetry={this.handleReset}
        />
      );
    }

    return this.props.children;
  }
}

// ── HOC ───────────────────────────────────────────────────────────────────────

export function withErrorBoundary<P extends object>(
  WrappedComponent: ComponentType<P>,
  section?: string,
) {
  const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';

  const WithErrorBoundary = (props: P) => (
    <ErrorBoundary section={section || displayName}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );

  WithErrorBoundary.displayName = `withErrorBoundary(${displayName})`;
  return WithErrorBoundary;
}
