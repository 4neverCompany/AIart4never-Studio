'use client';

/**
 * AGENTIC-CORE / PHASE 2 — Cyberforge Console right rail.
 *
 * ADDITIVE companion to {@link AgentConsole}: a ~240px rail that renders the
 * operator's two standing concerns next to the live chat, both from REAL data:
 *
 *   1. APPROVAL DECK — the pending beats awaiting a human decision. Reads
 *      `settings.scheduledPosts` (filtered to `status === 'pending_approval'`)
 *      out of {@link useMashup}, resolves each post's thumbnail/caption from
 *      `savedImages` (falling back to `images`), and wires Approve/Reject to the
 *      REAL `approveScheduledPost` / `rejectScheduledPost` context actions. The
 *      publish gate is human-owned, so the deck states that plainly. No mock
 *      beats — an empty queue shows a quiet empty state.
 *
 *   2. CANON PANEL — the ACTIVE character's locked identity, read-only, from
 *      `lib/canon`: the avatar initial in an orange ring + name, the locked
 *      Higgsfield Element token (`<<<id>>>`, JetBrains Mono / cyan / lock), the
 *      4 content pillars as tags, and the realities (PRIME cyan / W40K orange).
 *
 * The rail never drives the agent loop and never mutates canon — it READS the
 * approval + canon sources and calls the existing approve/reject actions.
 */

import { useMemo } from 'react';
import {
  ShieldCheck,
  Check,
  X,
  Lock,
  Inbox,
  Sparkles,
  Image as ImageIcon,
} from 'lucide-react';
import { useMashup } from '@/components/MashupContext';
import {
  getCharacter,
  getReality,
  CONTENT_PILLARS,
  REALITIES,
  type CharacterId,
  type RealityId,
} from '@/lib/canon';
import type { GeneratedImage, ScheduledPost } from '@/types/mashup';

// ── Approval Deck ───────────────────────────────────────────────────────────

interface PendingBeat {
  post: ScheduledPost;
  image?: GeneratedImage;
}

function ApprovalDeck() {
  const {
    settings,
    savedImages,
    images,
    approveScheduledPost,
    rejectScheduledPost,
  } = useMashup();

  // Resolve the real pending queue + each beat's renderable image. We look in
  // savedImages first (the persistent gallery), then images (the ephemeral
  // generation buffer) so a freshly-generated, not-yet-saved beat still shows.
  const pending = useMemo<PendingBeat[]>(() => {
    const posts = (settings.scheduledPosts ?? []).filter(
      (p) => p.status === 'pending_approval',
    );
    const byId = new Map<string, GeneratedImage>();
    for (const img of [...savedImages, ...images]) {
      if (!byId.has(img.id)) byId.set(img.id, img);
    }
    return posts.map((post) => ({ post, image: byId.get(post.imageId) }));
  }, [settings.scheduledPosts, savedImages, images]);

  return (
    <section
      data-testid="approval-deck"
      aria-label="Approval deck"
      className="rail-panel"
    >
      <header className="flex items-center gap-2 mb-3">
        <ShieldCheck className="w-3.5 h-3.5 text-[#ff7a18] shrink-0" />
        <h2 className="rail-heading flex-1" style={{ fontFamily: 'var(--font-sans)' }}>
          Approval deck
        </h2>
        <span
          data-testid="approval-count"
          className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-[#ff7a18]/12 text-[#ff9d4d] border border-[#ff7a18]/30"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {pending.length}
        </span>
      </header>

      <p className="text-[10px] text-[#8a97a6] leading-snug mb-3 flex items-center gap-1.5">
        <Lock className="w-3 h-3 shrink-0 text-[#8a97a6]" />
        publish gated — human decides
      </p>

      {pending.length === 0 ? (
        <div
          data-testid="approval-empty"
          className="flex flex-col items-center gap-2 py-6 text-center"
        >
          <Inbox className="w-6 h-6 text-[#8a97a6]/50" />
          <p className="text-[11px] text-[#8a97a6] leading-snug">
            No beats awaiting approval.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {pending.map(({ post, image }) => {
            const thumb = image?.url ?? image?.originalUrl;
            const caption = (post.caption || image?.prompt || 'Untitled beat').trim();
            return (
              <li
                key={post.id}
                data-testid="approval-item"
                className="rounded-xl border border-[#8a97a6]/16 bg-[#0e0f12] p-2.5"
              >
                <div className="flex items-start gap-2.5">
                  <div className="w-12 h-12 shrink-0 rounded-lg overflow-hidden border border-[#8a97a6]/18 bg-[#050505] flex items-center justify-center">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumb}
                        alt="Pending beat"
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <ImageIcon className="w-4 h-4 text-[#8a97a6]/50" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-[#e8edf2] leading-snug line-clamp-2">
                      {caption}
                    </p>
                    {typeof post.viralityScore === 'number' && (
                      <span
                        className="mt-1 inline-block text-[9px] font-mono text-[#00e6ff]"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        virality {post.viralityScore}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 mt-2.5">
                  <button
                    type="button"
                    data-testid="approve-btn"
                    onClick={() => approveScheduledPost(post.id)}
                    aria-label="Approve beat"
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-[#00e6ff]/12 text-[#00e6ff] border border-[#00e6ff]/35 hover:bg-[#00e6ff]/22 transition-colors"
                  >
                    <Check className="w-3 h-3" />
                    Approve
                  </button>
                  <button
                    type="button"
                    data-testid="reject-btn"
                    onClick={() => rejectScheduledPost(post.id)}
                    aria-label="Reject beat"
                    className="flex items-center justify-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-[#8a97a6] border border-[#8a97a6]/22 hover:text-red-300 hover:border-red-500/40 hover:bg-red-500/8 transition-colors"
                  >
                    <X className="w-3 h-3" />
                    Reject
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Canon Panel ─────────────────────────────────────────────────────────────

function RealityDots() {
  // PRIME = cyan, the W40K family = orange. Read straight from REALITIES.
  const dotColor = (id: RealityId) =>
    id === 'prime' ? '#00e6ff' : '#ff7a18';
  return (
    <ul data-testid="canon-realities" className="space-y-1">
      {Object.values(REALITIES).map((reality) => (
        <li key={reality.id} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: dotColor(reality.id) }}
            aria-hidden
          />
          <span className="text-[11px] text-[#cdd6e0] truncate">
            {reality.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CanonPanel({ characterId }: { characterId: CharacterId }) {
  // READ-ONLY canon. getCharacter throws on an unknown id; guard so a stale
  // setting never crashes the rail — fall back to the visible empty surface.
  const character = useMemo(() => {
    try {
      return getCharacter(characterId);
    } catch {
      return undefined;
    }
  }, [characterId]);

  if (!character) {
    return (
      <section data-testid="canon-panel" aria-label="Canon panel" className="rail-panel border-b-0">
        <h2 className="rail-heading mb-2" style={{ fontFamily: 'var(--font-sans)' }}>
          Canon
        </h2>
        <p className="text-[11px] text-[#8a97a6]">No active character.</p>
      </section>
    );
  }

  const reality = getReality(character.reality);
  const initial = character.name.trim().charAt(0).toUpperCase() || 'K';

  return (
    <section
      data-testid="canon-panel"
      aria-label="Canon panel"
      className="rail-panel border-b-0"
    >
      <h2 className="rail-heading mb-3" style={{ fontFamily: 'var(--font-sans)' }}>
        Canon
      </h2>

      {/* Active character */}
      <div className="flex items-center gap-2.5 mb-3.5">
        <div className="w-10 h-10 shrink-0 rounded-full bg-[#0e0f12] border-2 border-[#ff7a18] flex items-center justify-center">
          <span
            className="text-sm font-bold text-[#ff9d4d]"
            style={{ fontFamily: 'var(--font-sans)' }}
          >
            {initial}
          </span>
        </div>
        <div className="min-w-0">
          <p
            data-testid="canon-character-name"
            className="text-xs font-bold text-[#e8edf2] truncate"
            style={{ fontFamily: 'var(--font-sans)' }}
          >
            {character.name}
          </p>
          <p className="text-[10px] text-[#8a97a6] truncate">{reality.label}</p>
        </div>
      </div>

      {/* Element — Story 2.8: canon is resolved LIVE from Higgsfield per
          generation (the agent looks up the character's current Element in chat).
          The browser has no run context and the id is not hardcoded, so we show
          the honest live state instead of a stale token. */}
      <div className="mb-3.5">
        <p className="rail-heading mb-1.5" style={{ fontFamily: 'var(--font-sans)' }}>
          Element
        </p>
        <span
          data-testid="canon-element-live"
          className="flex items-center gap-1.5 text-[10px] font-mono text-[#8a97a6] bg-[#8a97a6]/8 border border-[#8a97a6]/22 rounded-lg px-2 py-1"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          <Lock className="w-3 h-3 shrink-0" />
          resolved live in chat
        </span>
      </div>

      {/* Content pillars */}
      <div className="mb-3.5">
        <p className="rail-heading mb-1.5 flex items-center gap-1.5" style={{ fontFamily: 'var(--font-sans)' }}>
          <Sparkles className="w-3 h-3 text-[#ff7a18]" />
          Pillars
        </p>
        <div data-testid="canon-pillars" className="flex flex-wrap gap-1.5">
          {CONTENT_PILLARS.map((pillar) => (
            <span
              key={pillar.id}
              title={pillar.description}
              className="text-[10px] px-2 py-0.5 rounded-md bg-[#ff7a18]/8 text-[#ffb877] border border-[#ff7a18]/22"
            >
              {pillar.name}
            </span>
          ))}
        </div>
      </div>

      {/* Realities */}
      <div>
        <p className="rail-heading mb-1.5" style={{ fontFamily: 'var(--font-sans)' }}>
          Realities
        </p>
        <RealityDots />
      </div>
    </section>
  );
}

// ── Rail ─────────────────────────────────────────────────────────────────────

export function AgentConsoleRail({ characterId }: { characterId: CharacterId }) {
  return (
    <aside
      data-testid="agent-console-rail"
      aria-label="Console rail"
      className="rail-surface"
    >
      <ApprovalDeck />
      <CanonPanel characterId={characterId} />
    </aside>
  );
}
