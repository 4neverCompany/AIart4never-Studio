'use client';

// V050-002 Phase 1: trivial extraction of the Pipeline tab from
// MainContent. PipelinePanel is dynamic-imported by the parent so this
// component receives it as a child to keep ssr:false / lazy-load
// semantics intact.

import type { ReactNode } from 'react';

export interface PipelineViewProps {
  panel: ReactNode;
}

export function PipelineView({ panel }: PipelineViewProps) {
  return <>{panel}</>;
}
