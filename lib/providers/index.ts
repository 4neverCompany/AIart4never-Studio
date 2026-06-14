/**
 * Barrel export for `lib/providers/`. The Director (lib/agent-tools)
 * imports from `@/lib/providers` only — never reaches into a
 * sub-file. This keeps the public surface narrow and gives us a
 * single chokepoint to gate the "which providers are exposed"
 * decision.
 */

export * from './interface';
export * from './cli-utils';
export * from './registry';

// The Higgsfield CLI/text adapters and the Leonardo HTTP adapter have been
// removed. minimax-video is the only adapter re-exported here.
export { MinimaxVideoAdapter, minimaxVideoAdapter, type MinimaxVideoAdapterOptions } from './minimax/video-adapter';
