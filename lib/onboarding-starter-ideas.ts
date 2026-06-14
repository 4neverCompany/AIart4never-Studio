// V050-DES-002: tiny seed set used by Step 3 of the onboarding wizard.
// Filtered by the user's selected universes/genres so the first
// suggestion already feels personal. Intentionally small (~20 entries)
// — the brainstorm-with-AI path covers everything else.

export interface StarterIdea {
  /** Display title shown in the picker. */
  title: string;
  /** Universes this idea draws from (matched against agentNiches). */
  universes: string[];
  /** Genres this idea fits (matched against agentGenres). */
  genres: string[];
  /** One-line concept fed into the pipeline as the idea text. */
  concept: string;
}

export const STARTER_IDEAS: readonly StarterIdea[] = [
  { title: 'Marvel meets Cyberpunk', universes: ['Marvel'], genres: ['Cyberpunk'],
    concept: 'Iron Man patrolling Night City rooftops at 3am, neon rain on chrome armor.' },
  { title: 'Star Wars Noir', universes: ['Star Wars'], genres: ['Noir'],
    concept: 'A Mandalorian bounty hunter in a smoke-filled Coruscant cantina, single light source, cinematic.' },
  { title: 'LOTR x Studio Ghibli', universes: ['LOTR', 'Studio Ghibli'], genres: ['Fantasy'],
    concept: 'Hobbits picnicking in a Ghibli-style meadow with floating spirits in the background.' },
  { title: 'Warhammer 40k vs Dune', universes: ['Warhammer 40k', 'Dune'], genres: ['Sci-Fi'],
    concept: 'A Space Marine standing on Arrakis dunes, sandworm rising on the horizon, twin suns.' },
  { title: 'Game of Thrones Cyberpunk', universes: ['Game of Thrones'], genres: ['Cyberpunk'],
    concept: 'The Iron Throne reimagined as a server rack, Daenerys in chrome armor, holographic dragons.' },
  { title: 'DC Heroes in Mythology', universes: ['DC'], genres: ['Mythology'],
    concept: 'Wonder Woman as a Greek goddess on Mount Olympus, painterly classical style.' },
  { title: 'Anime Western', universes: ['Anime'], genres: ['Western'],
    concept: 'A lone samurai-cowboy at sunset, anime cel-shaded style, dust devils in the background.' },
  { title: 'Star Trek Horror', universes: ['Star Trek'], genres: ['Horror'],
    concept: 'The Enterprise bridge in derelict darkness, single emergency light, something is wrong.' },
  { title: 'Disney Post-apocalyptic', universes: ['Disney'], genres: ['Post-apocalyptic'],
    concept: 'A weathered Mickey Mouse statue half-buried in a wasteland, twilight, hopeful.' },
  { title: 'Cyberpunk 2077 Slice-of-life', universes: ['Cyberpunk 2077'], genres: ['Slice-of-life'],
    concept: 'A Night City street vendor at dawn, steaming noodles, friendly chrome arm, warm light.' },
];

const FALLBACK: StarterIdea = {
  title: 'Generic crossover',
  universes: [],
  genres: [],
  concept: 'A surprising mashup of two iconic worlds — pick the one that excites you.',
};

/**
 * Pick up to N starter ideas matching the user's selected niches.
 * Falls back to the generic concept if nothing matches (so the picker
 * never renders empty).
 */
export function pickStarterIdeas(
  niches: readonly string[],
  genres: readonly string[],
  limit = 5,
): StarterIdea[] {
  const nicheSet = new Set(niches);
  const genreSet = new Set(genres);

  const scored = STARTER_IDEAS.map((idea) => {
    let score = 0;
    for (const u of idea.universes) if (nicheSet.has(u)) score += 2;
    for (const g of idea.genres) if (genreSet.has(g)) score += 1;
    return { idea, score };
  });

  const matched = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.idea);

  if (matched.length === 0) return [FALLBACK];
  return matched;
}
