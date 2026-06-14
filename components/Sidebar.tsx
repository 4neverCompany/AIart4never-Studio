'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, Search, MessageSquare, Loader2, ExternalLink, Image as ImageIcon, Sparkles, Columns, RefreshCw, History } from 'lucide-react';
import { useMashup, LEONARDO_MODELS } from './MashupContext';
import { streamAI, extractJsonArrayFromLLM, stripThinkBlocks } from '@/lib/aiClient';
import { MASHUPFORGE_AI_PERSONA } from '@/lib/agent-prompt';
import { HealthStrip } from './platform/HealthStrip';
import { ReadAloudButton } from './mmx/ReadAloudButton';

type Tab = 'chat' | 'content' | 'history';

interface TrendSource {
  topic: string;
  headline: string;
  source: string;
  url: string;
}

/**
 * Merge two source arrays into one, preferring the earlier entry when
 * URLs collide. /api/trending and /api/ai/prompt's webSearch enrichment
 * frequently surface the same news article from different aggregators
 * — the de-dupe is what keeps the rendered list tight.
 */
function mergeSourcesByUrl(
  existing: TrendSource[] | undefined,
  incoming: TrendSource[],
): TrendSource[] {
  const seen = new Set<string>();
  const out: TrendSource[] = [];
  for (const src of [...(existing ?? []), ...incoming]) {
    if (!src.url || seen.has(src.url)) continue;
    seen.add(src.url);
    out.push(src);
  }
  return out;
}

interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  streaming?: boolean; // true while AI is still typing
  groundingChunks?: unknown[];
  recommendations?: string[];
  trendingSources?: TrendSource[];
  ideas?: Array<{ context: string; concept: string }>;
}

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<Tab>('content');
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [contentMessages, setContentMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { generateImages, settings, setView, generateComparison, generateNegativePrompt, setComparisonPrompt, setComparisonOptions, addIdea, isSidebarOpen, setIsSidebarOpen, images, clearComparison } = useMashup();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages, contentMessages]);

  const handleSend = async (overrideInput?: string) => {
    const textToSend = overrideInput || input;
    if (!textToSend.trim() || isLoading) return;

    const userMsg = textToSend.trim();
    if (!overrideInput) setInput('');
    setIsLoading(true);

    if (activeTab === 'chat') {
      const userMsgObj = { id: Date.now().toString(), role: 'user' as const, text: userMsg };
      const modelMsgId = (Date.now() + 1).toString();
      setChatMessages((prev) => [
        ...prev,
        userMsgObj,
        { id: modelMsgId, role: 'model', text: '', streaming: true },
      ]);
      try {
        // AI-ROLE-REDESIGN (2026-05-22): chat-mode system prompt now
        // uses the MashupForge AI persona + Content Pillars / Style
        // Tags vocabulary. Settings keys (agentNiches, agentGenres)
        // unchanged for storage back-compat.
        const systemInstruction = `${settings.agentPrompt || MASHUPFORGE_AI_PERSONA}
              Content Pillars: ${settings.agentNiches?.join(', ') || 'None — answer freely'}.
              Style Tags: ${settings.agentGenres?.join(', ') || 'None — answer freely'}.`;

        let acc = '';
        for await (const delta of streamAI(userMsg, {
          mode: 'chat',
          systemPrompt: systemInstruction,
          provider: settings.activeAiAgent,
          model: settings.activeTextModel,
          onSources: (sources) => {
            // Emitted by /api/ai/prompt before text deltas when web-
            // search enrichment found hits. Append to the model's
            // message so the "Trending sources" affordance renders
            // alongside the streaming answer.
            setChatMessages((prev) =>
              prev.map((m) => (m.id === modelMsgId ? { ...m, trendingSources: mergeSourcesByUrl(m.trendingSources, sources) } : m))
            );
          },
        })) {
          acc += delta;
          // Strip MiniMax-M2.5/M2.7 reasoning prefix before display.
          // `stripThinkBlocks` handles in-flight unterminated `<think>`
          // blocks too — while the model is mid-reasoning the bubble
          // stays empty, then snaps to the real answer once `</think>`
          // arrives. Same helper that `parseJsonFromLLM` uses, so the
          // chat path matches the JSON-extract paths.
          setChatMessages((prev) =>
            prev.map((m) => (m.id === modelMsgId ? { ...m, text: stripThinkBlocks(acc) } : m))
          );
        }
        if (!acc) {
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === modelMsgId ? { ...m, text: '(no response)', streaming: false } : m
            )
          );
        } else {
          setChatMessages((prev) =>
            prev.map((m) => (m.id === modelMsgId ? { ...m, streaming: false } : m))
          );
        }
      } catch {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === modelMsgId
              ? { ...m, text: 'Error: Could not get response.', streaming: false }
              : m
          )
        );
      } finally {
        setIsLoading(false);
      }
    } else {
      // Content Generator — fetch trending first, then stream ideas.
      const userMsgObj = { id: Date.now().toString(), role: 'user' as const, text: userMsg };
      const modelMsgId = (Date.now() + 1).toString();
      setContentMessages((prev) => [
        ...prev,
        userMsgObj,
        { id: modelMsgId, role: 'model', text: '⏳ Researching trending topics…', streaming: true },
      ]);

      try {
        // Step 1: Fetch trending data for all active niches/genres
        let trendingSummary = '';
        let trendingResults: TrendSource[] = [];
        try {
          const trendRes = await fetch('/api/trending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              niches: settings.agentNiches,
              genres: settings.agentGenres,
              ideaConcept: userMsg,
            }),
          });
          const trendData = await trendRes.json() as { success?: boolean; summary?: string; results?: TrendSource[] };
          if (trendData.success && trendData.summary) {
            trendingSummary = trendData.summary;
          }
          if (trendData.success && Array.isArray(trendData.results)) {
            trendingResults = trendData.results;
          }
        } catch { /* non-blocking */ }

        // Step 2: Build trend-aware prompt
        const trendingBlock = trendingSummary
          ? `\n\nCURRENT TRENDING CONTEXT — base your ideas on these real trends to make them timely and shareable:\n${trendingSummary}\n`
          : '';
        // AI-ROLE-REDESIGN (2026-05-22): MashupForge AI persona +
        // Content Pillars / Style Tags vocabulary. Settings fallback
        // values stay as concrete examples so empty-configuration
        // users still see useful idea-gen output.
        const pillars = settings.agentNiches?.join(', ') || 'Marvel, DC, Star Wars, Warhammer 40k';
        const styles = settings.agentGenres?.join(', ') || 'Cinematic Crossovers, Epic Action, Visual Storytelling';

        const message = `${settings.agentPrompt || MASHUPFORGE_AI_PERSONA}

Content Pillars: ${pillars}
Style Tags: ${styles}
${trendingBlock}

Topic: ${userMsg}

Generate 3-5 crossover content ideas that are SPECTACULAR, timely, and would go viral on Instagram. Each idea should be a visually stunning image concept.
Return them as a JSON array. Each object has "context" (short catchy title) and "concept" (detailed image generation prompt, vivid and cinematic).
Return ONLY the JSON array, no prose.`;

        setContentMessages((prev) =>
          prev.map((m) =>
            m.id === modelMsgId
              ? { ...m, text: trendingSummary ? `📈 Found trending topics!\n\n⏳ Generating trend-aware ideas…` : '⏳ Generating ideas…' }
              : m
          )
        );

        let acc = '';
        for await (const delta of streamAI(message, {
          mode: 'idea',
          provider: settings.activeAiAgent,
          model: settings.activeTextModel,
          onSources: (sources) => {
            // /api/ai/prompt's DDG/Brave webSearch enrichment lands
            // here; /api/trending's SearXNG+Reddit hits are already
            // in `trendingResults` (collected pre-stream). Merge both
            // by URL so the user sees a single source list with no
            // duplicates.
            setContentMessages((prev) =>
              prev.map((m) => (m.id === modelMsgId ? { ...m, trendingSources: mergeSourcesByUrl(m.trendingSources, sources) } : m))
            );
          },
        })) {
          acc += delta;
          // Same think-block strip as the chat handler above — keeps
          // MiniMax reasoning out of the visible idea-stream while it's
          // still thinking. extractJsonArrayFromLLM already strips for
          // the final parse pass, this just keeps the streaming bubble
          // clean too.
          setContentMessages((prev) =>
            prev.map((m) => (m.id === modelMsgId ? { ...m, text: stripThinkBlocks(acc), streaming: true } : m))
          );
        }
        // Clear streaming flag when done
        const finalAcc = acc;
        setContentMessages((prev) =>
          prev.map((m) => (m.id === modelMsgId ? { ...m, streaming: false } : m))
        );

        let ideaCount = 0;
        const parsedIdeas: Array<{ context: string; concept: string }> = [];
        // Use extractJsonArrayFromLLM so reasoning-model output
        // (MiniMax-M2.5/M2.7 `<think>…</think>` blocks, markdown
        // fences, prose around the JSON) is normalised before
        // parse. The previous `JSON.parse(cleaned)` threw silently
        // on the leading `<` of `<think>`, leaving ideaCount=0 →
        // ideas never saved to the Ideas Board, and the user just
        // saw the raw stream text instead of the success message.
        // Same root cause as MXIMG-001's captioning silent-fail.
        const rawItems = extractJsonArrayFromLLM(acc);
        for (const item of rawItems) {
          if (typeof item !== 'object' || item === null) continue;
          const rec = item as Record<string, unknown>;
          const concept = typeof rec.concept === 'string' ? rec.concept : '';
          const context = typeof rec.context === 'string' ? rec.context : '';
          if (concept) {
            addIdea(concept, context);
            parsedIdeas.push({ context, concept });
            ideaCount++;
          }
        }

        setContentMessages((prev) =>
          prev.map((m) =>
            m.id === modelMsgId
              ? {
                  ...m,
                  text: parsedIdeas.length > 0
                    ? `✨ Generated ${ideaCount} ideas and saved them to your Ideas Board!`
                    : acc,
                  trendingSources: trendingResults,
                  ideas: parsedIdeas.length > 0 ? parsedIdeas : undefined,
                }
              : m
          )
        );
      } catch {
        setContentMessages((prev) =>
          prev.map((m) =>
            m.id === modelMsgId
              ? { ...m, text: 'Error: Could not perform search.' }
              : m
          )
        );
      } finally {
        setIsLoading(false);
      }
    }
  };

  const messages = activeTab === 'chat' ? chatMessages : contentMessages;

  return (
    <>
      {/* Mobile Backdrop */}
      {isSidebarOpen && (
        <div
          role="presentation"
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}
      
      <aside aria-label="Sidebar" className={`fixed md:static inset-y-0 left-0 z-50 w-[85vw] sm:w-80 glass-panel flex flex-col h-full shrink-0 transition-transform duration-300 ease-in-out ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div role="tablist" aria-label="Sidebar panels" className="flex p-2 gap-1.5 border-b border-[#c5a062]/15">
          {(
            [
              { id: 'content', label: 'Content', Icon: Search, controls: 'sidebar-content-panel' },
              { id: 'chat',    label: 'Chat',    Icon: MessageSquare, controls: 'sidebar-chat-panel' },
              { id: 'history', label: 'History', Icon: History, controls: 'sidebar-history-panel' },
            ] as const
          ).map(({ id, label, Icon, controls }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={isActive}
                aria-controls={controls}
                onClick={() => setActiveTab(id)}
                className={`flex-1 py-1.5 px-3 rounded-xl flex flex-col items-center justify-center gap-0 text-xs transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e6ff]/50 ${
                  isActive
                    ? 'bg-[#00e6ff]/10 text-[#00e6ff] border border-[#00e6ff]/20 font-bold'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] border border-transparent font-semibold'
                }`}
              >
                <span className="flex items-center gap-1.5 py-0.5">
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </span>
                <span
                  aria-hidden="true"
                  className={`h-0.5 rounded-full transition-all duration-200 ${isActive ? 'w-5 bg-[#00e6ff]' : 'w-0 bg-transparent'}`}
                />
              </button>
            );
          })}
        </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeTab === 'history' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Recent Generations</h3>
              {images.length > 0 && (
                <button
                  type="button"
                  onClick={clearComparison}
                  className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>
            {images.length === 0 ? (
              <div className="text-center py-10">
                <History className="w-8 h-8 text-zinc-800 mx-auto mb-2" />
                <p className="text-xs text-zinc-400">No generation history yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {images.filter(img => img.status === 'ready').map((img) => (
                  <button
                    key={img.id}
                    className="group relative aspect-square bg-zinc-900/60 rounded-xl overflow-hidden border border-[#c5a062]/15 hover:border-[#c5a062]/50 transition-all duration-200 cursor-pointer text-left"
                    onClick={() => {
                      setComparisonPrompt(img.prompt);
                      setView('compare');
                    }}
                    aria-label={`Open in Studio: ${img.prompt.slice(0, 60)}`}
                  >
                    {img.url ? (
                      <img src={img.url} alt={`Generated: ${img.prompt.slice(0, 80)}`} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-zinc-700" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2">
                      <p className="text-[10px] text-white line-clamp-2 leading-tight">{img.prompt}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
        <>
        {messages.length === 0 && (
          <div className="text-center text-zinc-500 text-sm mt-10 flex flex-col items-center gap-4">
            {activeTab === 'chat' ? (
              <p>Ask me anything about fantasy universes or brainstorm crossover ideas!</p>
            ) : (
              <>
                <p>Generate peak content, what-if scenarios, and crossovers for Star Wars, Marvel, DC, and Warhammer 40k.</p>
                <button
                  onClick={() => {
                    handleSend(`Autonomous Content Generation: Research current trends and generate a viral concept with 3 image prompts based on my personality settings.`);
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-[#00e6ff]/10 hover:bg-[#00e6ff]/20 border border-[#00e6ff]/25 hover:border-[#00e6ff]/50 text-[#00e6ff] rounded-xl transition-all duration-200 font-semibold text-sm"
                >
                  <Sparkles className="w-4 h-4" />
                  Automate Content Gen
                </button>
              </>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div
              className={`max-w-[90%] rounded-2xl px-4 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-[#00e6ff] text-[#050505] rounded-br-sm'
                  : 'bg-zinc-800 text-zinc-200 rounded-bl-sm'
              }`}
            >
              {msg.role === 'user' ? (
                msg.text
              ) : msg.role === 'model' ? (
                <div className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                  {msg.streaming && (
                    <span className="inline-block w-2 h-4 bg-[#00e6ff] ml-0.5 animate-pulse align-middle" />
                  )}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-zinc-600 select-none">
                {new Date(parseInt(msg.id)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              {/* FEAT-MMX-MUSIC-UI: read-aloud only on model messages with
                  finished text — skip empty placeholders and user echoes. */}
              {msg.role === 'model' && msg.text.trim().length > 0 && (
                <ReadAloudButton text={msg.text} />
              )}
            </div>
            {msg.groundingChunks && msg.groundingChunks.length > 0 && (
              <div className="mt-2 space-y-1 w-full pl-2 border-l-2 border-zinc-700">
                <p className="text-xs text-zinc-500 font-medium">Sources:</p>
                {msg.groundingChunks.map((raw, j) => {
                  const chunk = raw as { web?: { uri?: string; title?: string } };
                  if (chunk.web?.uri) {
                    return (
                      <a
                        key={j}
                        href={chunk.web.uri}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 truncate"
                      >
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        <span className="truncate">{chunk.web.title || chunk.web.uri}</span>
                      </a>
                    );
                  }
                  return null;
                })}
              </div>
            )}
            {msg.trendingSources && msg.trendingSources.length > 0 && (
              <div className="mt-2 space-y-1 w-full pl-2 border-l-2 border-[#00e6ff]/30">
                <p className="text-xs text-zinc-500 font-medium">Sources:</p>
                {msg.trendingSources.map((src, j) =>
                  src.url ? (
                    <a
                      key={j}
                      href={src.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 truncate"
                    >
                      <ExternalLink className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        <span className="text-zinc-500">[{src.source}]</span> {src.headline}
                      </span>
                    </a>
                  ) : (
                    <div key={j} className="flex items-center gap-1 text-xs text-zinc-400 truncate">
                      <span className="truncate">
                        <span className="text-zinc-500">[{src.source}]</span> {src.headline}
                      </span>
                    </div>
                  )
                )}
              </div>
            )}
            {msg.ideas && msg.ideas.length > 0 && (
              <div className="mt-2 space-y-2 w-full pl-3 border-l-2 border-emerald-500/30">
                {msg.ideas.map((idea, j) => (
                  <div
                    key={j}
                    className="group cursor-pointer rounded-xl bg-zinc-800/50 border border-zinc-700/50 hover:border-emerald-500/40 p-2.5 transition-colors"
                    onClick={() => {
                      setComparisonPrompt(idea.concept);
                      setView('compare');
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium text-white leading-tight">{idea.context || `Idea ${j + 1}`}</p>
                      <span className="shrink-0 text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">On Board</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1 whitespace-pre-wrap leading-relaxed">{idea.concept}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-start">
            <div className="bg-zinc-800 text-zinc-300 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-2 text-xs">
              {activeTab === 'chat' ? (
                <>
                  <span className="inline-flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00e6ff] animate-pulse [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00e6ff] animate-pulse [animation-delay:200ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00e6ff] animate-pulse [animation-delay:400ms]" />
                  </span>
                </>
              ) : (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#00e6ff]" />
                  <span>Generating…</span>
                </>
              )}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
        </>
        )}
      </div>

      {activeTab !== 'history' && (
      <div className="p-4 border-t border-[#c5a062]/15 bg-[#050505]/90">
        <form
          suppressHydrationWarning
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="relative"
        >
          <input
            suppressHydrationWarning
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={activeTab === 'chat' ? 'Message AI...' : 'Generate content...'}
            className="w-full bg-zinc-900/80 border border-zinc-700/60 rounded-xl pl-4 pr-10 py-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-[#00e6ff]/25 focus:border-[#00e6ff]/40 transition-all duration-200"
            disabled={isLoading}
          />
          <button
            suppressHydrationWarning
            type="submit"
            disabled={!input.trim() || isLoading}
            aria-label="Send message"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-zinc-400 hover:text-white disabled:opacity-50 disabled:hover:text-zinc-400 transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
      )}

      {/* V040-007: persistent platform health strip at the aside's bottom.
          Auto-hides when zero platforms are configured. */}
      <HealthStrip />
    </aside>
    </>
  );
}
