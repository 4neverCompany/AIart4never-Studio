'use client';

import { useState } from 'react';
import { Plus, X, Drama } from 'lucide-react';

// V080-DES-001 (re-pass): pool expanded to 32 universes + 32 genres so
// every row sits comfortably above the "30+" target with headroom for
// niches the curator hadn't covered yet.
const CURATED_UNIVERSES = [
  'Marvel', 'DC', 'Star Wars', 'Star Trek', 'Warhammer 40k', 'Dune',
  'LOTR', 'Game of Thrones', 'Anime', 'Studio Ghibli', 'Disney', 'Cyberpunk 2077',
  'Harry Potter', 'Witcher', 'Mass Effect', 'Halo', 'Fallout', 'Bloodborne',
  'Attack on Titan', 'One Piece', 'Naruto', 'Dragon Ball', 'Evangelion', 'Avatar',
  'Stranger Things', 'The Matrix', 'Blade Runner', 'Akira',
  'Pokémon', 'Zelda', 'Final Fantasy', 'Elder Scrolls',
];

const CURATED_GENRES = [
  'Sci-Fi', 'Fantasy', 'Horror', 'Cyberpunk', 'Steampunk', 'Western',
  'Noir', 'Post-apocalyptic', 'Slice-of-life', 'Mythology',
  'Dark Fantasy', 'High Fantasy', 'Space Opera', 'Dystopian', 'Gothic',
  'Urban Fantasy', 'Mecha', 'Isekai', 'Cosmic Horror', 'Solarpunk',
  'Grimdark', 'Magical Realism', 'Sword & Sorcery', 'Biopunk',
  'Weird West', 'Lovecraftian', 'Superhero', 'Crime',
  'Surrealism', 'Retro-futurism', 'Vaporwave', 'Afrofuturism',
];

const MAX_SELECTIONS = 10;

interface Step2Props {
  universes: string[];
  genres: string[];
  onChangeUniverses: (next: string[]) => void;
  onChangeGenres: (next: string[]) => void;
}

export function Step2Niche({ universes, genres, onChangeUniverses, onChangeGenres }: Step2Props) {
  return (
    <div className="space-y-6">
      <div>
        <h3 id="onboarding-title" className="text-xl font-bold text-white">What do you create?</h3>
        <p className="text-sm text-zinc-400 mt-1">
          Pick the realities and styles you create in — up to {MAX_SELECTIONS} each. The agent uses these to brainstorm Master4never beats.
        </p>
      </div>

      <ChipRow
        title="Realities"
        curated={CURATED_UNIVERSES}
        selected={universes}
        onChange={onChangeUniverses}
        max={MAX_SELECTIONS}
      />

      <ChipRow
        title="Genres"
        curated={CURATED_GENRES}
        selected={genres}
        onChange={onChangeGenres}
        max={MAX_SELECTIONS}
      />

      <IdentityPreview universes={universes} genres={genres} />
    </div>
  );
}

function ChipRow({
  title, curated, selected, onChange, max,
}: { title: string; curated: readonly string[]; selected: string[]; onChange: (v: string[]) => void; max: number }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  function toggle(name: string) {
    if (selected.includes(name)) {
      onChange(selected.filter((s) => s !== name));
    } else if (selected.length < max) {
      onChange([...selected, name]);
    }
  }

  function commitCustom() {
    const v = draft.trim();
    if (v && !selected.includes(v) && selected.length < max) {
      onChange([...selected, v]);
    }
    setDraft('');
    setAdding(false);
  }

  // Custom chips = selected items not in the curated list — render
  // alongside curated so removals work the same way.
  const customChips = selected.filter((s) => !curated.includes(s));
  const allChips = [...curated, ...customChips];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wide">{title}</h4>
        <span className="text-[10px] text-zinc-500">{selected.length} / {max}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {allChips.map((name) => {
          const isSel = selected.includes(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              className={`px-3 py-1.5 rounded-full border text-sm transition-all ${
                isSel
                  ? 'border-[#ff7a18] bg-[#ff7a18]/15 text-[#ff7a18]'
                  : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
              } ${!isSel && selected.length >= max ? 'opacity-40 cursor-not-allowed' : ''}`}
              disabled={!isSel && selected.length >= max}
            >
              {name}
            </button>
          );
        })}
        {adding ? (
          <span className="inline-flex items-center gap-1 border border-[#ff7a18]/40 rounded-full pl-3 pr-1 py-0.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitCustom(); }
                if (e.key === 'Escape') { setDraft(''); setAdding(false); }
              }}
              placeholder="Enter custom..."
              className="bg-transparent text-sm text-[#ff7a18] focus:outline-none w-32"
            />
            <button type="button" onClick={() => { setDraft(''); setAdding(false); }}
              className="p-1 text-zinc-500 hover:text-zinc-300">
              <X className="w-3 h-3" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={selected.length >= max}
            className="text-xs text-zinc-500 hover:text-[#ff7a18] inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-3 h-3" /> Add custom
          </button>
        )}
      </div>
    </div>
  );
}

function IdentityPreview({ universes, genres }: { universes: string[]; genres: string[] }) {
  const hasBoth = universes.length > 0 && genres.length > 0;

  return (
    <div className="bg-zinc-900/60 rounded-xl p-3 border border-[#ff7a18]/15 flex items-start gap-3">
      <Drama className="w-5 h-5 text-[#ff7a18] mt-0.5 shrink-0" />
      <div className="text-xs">
        <div className="text-zinc-300 font-medium mb-0.5">Your agent identity</div>
        {hasBoth ? (
          <p className="text-zinc-400 italic">
            &ldquo;You&rsquo;ll generate Master4never beats across {universes.join(' × ')} in {genres.join(' and ')} styles.&rdquo;
          </p>
        ) : (
          <p className="text-zinc-500">Pick at least one reality and one style to see your identity</p>
        )}
      </div>
    </div>
  );
}
