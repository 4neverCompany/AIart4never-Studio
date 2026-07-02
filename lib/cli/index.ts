/**
 * 4NE-13 — headless CLI core (D8: a library that wraps the agent-loop for
 * scripting / CI / unattended runs).
 *
 * `runCli(argv, deps)` is a PURE function: it parses arguments, calls injected
 * side-effect functions, and returns `{ code, lines }`. It NEVER reads
 * `process.*`, never prints, and never exits — the thin `bin/aiart4never.ts`
 * does that. This is what makes the whole CLI testable with no real LLM,
 * network, or storage.
 *
 * Commands (match the Linear 4NE-13 story):
 *   - `run-beat`        — run ONE autonomy tick now (generate is gated by the
 *                         director's own HIL; the asset lands in the approval
 *                         queue as approved:false). NEVER publishes.
 *   - `run-week`        — print the reuse-first weekly content plan (4NE-22)
 *                         plus the growth tuner's posting-time/hook PROPOSALS
 *                         (Story 8-11): each change is explicit and only an
 *                         operator `--accept`/`--edit` flows into the plan
 *                         (ignored/`--reject` ⇒ the base value is kept — no
 *                         silent tuning). Does NOT generate by default;
 *                         `--execute` is the safe no-spend stub (see below).
 *   - `status`          — MiniMax quota, active budget ceiling, connector-health
 *                         summary, last few journal ticks. Read-only.
 *   - `connectors …`    — list / test / add / remove (add+remove are gated by
 *                         `--yes`).
 *
 * SAFETY (publish): there is no publish dependency in {@link CliDeps} at all —
 * the CLI cannot publish. `run-beat` only queues to the human approval gate.
 *
 * Exit codes: 0 ok, 1 runtime error, 2 usage error.
 */

import type { CharacterId, WeeklySlot } from '@/lib/canon';
import { listCharacters, WEEKLY_TEMPLATE } from '@/lib/canon';
import { buildConnectorActivateRequest } from '@/lib/connectors';
import type { AutonomyConfig } from '@/lib/autonomy';
import { shouldTick, nextTickAt } from '@/lib/autonomy';
import type { AutonomyTickDeps } from '@/lib/autonomy/loop';
import type { ConnectorHealth } from '@/lib/connectors/health';
import {
  adaptWeeklyTemplate,
  applyProposalDecisions,
  attributeEngagement,
  buildTuningProposals,
  recommendHooks,
  recommendPostingTimes,
} from '@/lib/growth';
import type { ProposalDecision, TuningProposal } from '@/lib/growth';
import { getErrorMessage } from '@/lib/errors';

import { parseArgs, strOption, flag, multiOption, type ParsedArgs } from './args';
import type { CliDeps, CliResult, OperatorConfirm } from './types';

export type { CliDeps, CliResult, OperatorConfirm } from './types';
export type {
  CliBudgetSnapshot,
  CliQuotaSnapshot,
} from './types';

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'aiart4never — headless CLI for the Master4never agent',
  '',
  'Usage:',
  '  aiart4never run-beat [--character <id>]    Run one autonomy tick now (queues to the approval gate; never publishes)',
  '  aiart4never tick [--character <id>]        Run one autonomy tick IF DUE (for a cron/daemon — no-ops until enabled + past the tick hour + not already today)',
  '  aiart4never run-week [--character <id>]    Print the reuse-first weekly content plan + growth tuning proposals',
  '                       [--accept <id>]        Accept a posting-time/hook proposal as recommended (repeatable)',
  '                       [--edit <id>=<value>]  Accept a proposal with YOUR value (hour 0..23 / hook id; repeatable)',
  '                       [--reject <id>]        Reject a proposal — same as ignoring it: the base value is kept',
  '                       [--execute]            (safe: prints a notice, does NOT generate — use the app to spend)',
  '  aiart4never status                          Quota, budget ceiling, connector health, recent ticks (read-only)',
  '  aiart4never connectors list                 List registered connectors (redacted) + health',
  '  aiart4never connectors test <id>            Health-check one connector',
  '  aiart4never connectors add --name <n> --url <u> [--header k=v ...] [--yes]   Propose + (with --yes) install a connector',
  '  aiart4never connectors remove <id> [--yes]  Remove a connector (gated)',
  '  aiart4never --help                          Show this help',
  '',
  'Exit codes: 0 ok · 1 runtime error · 2 usage error',
].join('\n');

const VALID_CHARACTER_IDS = new Set<string>(listCharacters().map((c) => c.id));

/** Resolve the active character: a valid `--character`, else the config default. */
function resolveCharacter(
  args: ParsedArgs,
  cfg: AutonomyConfig,
): { characterId: CharacterId } | { error: string } {
  const requested = strOption(args, 'character');
  if (requested === undefined) return { characterId: cfg.activeCharacterId };
  if (!VALID_CHARACTER_IDS.has(requested)) {
    return {
      error: `unknown character '${requested}' (valid: ${[...VALID_CHARACTER_IDS].join(', ')})`,
    };
  }
  return { characterId: requested as CharacterId };
}

/** One-line health summary: "ok srv-1 (3 tools, 42ms)" / "auth-error srv-2: …". */
function formatHealthLine(h: ConnectorHealth): string {
  const head = `  [${h.status}] ${h.name} (${h.id})`;
  if (h.status === 'ok') {
    const tools = h.toolCount ?? 0;
    const latency = h.latencyMs !== undefined ? `, ${h.latencyMs}ms` : '';
    return `${head} — ${tools} tool${tools === 1 ? '' : 's'}${latency}`;
  }
  if (h.status === 'disabled') return `${head} — disabled (not probed)`;
  return `${head} — ${h.error ?? 'unknown error'}`;
}

// ---------------------------------------------------------------------------
// run-beat
// ---------------------------------------------------------------------------

async function cmdRunBeat(args: ParsedArgs, deps: CliDeps): Promise<CliResult> {
  const baseCfg = await deps.loadAutonomyConfig();
  const resolved = resolveCharacter(args, baseCfg);
  if ('error' in resolved) return { code: EXIT_USAGE, lines: [resolved.error] };

  const cfg: AutonomyConfig = { ...baseCfg, activeCharacterId: resolved.characterId };
  const tickDeps: AutonomyTickDeps = {
    now: deps.now(),
    loadLibrary: deps.loadLibrary,
    runDirector: deps.runDirector,
    persistAsset: deps.persistAsset,
  };

  const result = await deps.runTick(cfg, tickDeps);

  const lines: string[] = [];
  lines.push(`Autonomy beat — ${cfg.activeCharacterId} · ${result.day}`);
  lines.push(`  decision: ${result.decision}${result.pillarId ? ` (${result.pillarId})` : ''}`);
  lines.push(`  ${result.note}`);
  if (result.error) lines.push(`  error: ${result.error}`);

  if (result.queued && result.assetId) {
    lines.push(`  queued asset: ${result.assetId}`);
    // The keystone safety message: a beat lands in the human approval queue,
    // it does NOT publish. (approved:false is enforced inside persistAsset.)
    lines.push('  landed in the approval queue (approved:false — never published by the CLI)');
  } else {
    lines.push('  nothing queued this beat');
  }

  // A beat that errored is a runtime failure (exit 1) but still well-formed.
  return { code: result.error ? EXIT_RUNTIME : EXIT_OK, lines };
}

// ---------------------------------------------------------------------------
// tick — the DUE-GATED autonomy tick (Story 8-13: the live-daemon entry)
// ---------------------------------------------------------------------------

/**
 * Story 8-13 — the live autonomy trigger. Unlike `run-beat` (which ticks
 * UNCONDITIONALLY), `tick` runs a tick ONLY when one is due per the pure
 * `shouldTick` (enabled + daily cadence + at/after the local tick hour + not
 * already ticked today). This is what a scheduler calls: safe to invoke on any
 * cadence (e.g. hourly OS cron / a Tauri background timer) because it no-ops
 * until a tick is genuinely due, so it fires at most once per local day.
 *
 * DECISION (Story 8-13 / OAQ-2): the live trigger runs LOCALLY via this CLI, NOT
 * a remote server cron. A generate-day tick runs the director → Higgsfield,
 * which needs the operator's connector; that connector is client-side (local
 * store), so only a local process (this CLI on the operator's machine) can
 * generate. A remote Vercel cron (like sunday-recap) can only do connector-less
 * work. Schedule this command locally, e.g. `aiart4never tick` hourly.
 *
 * `lastTickAt` is derived from the journal's newest entry (no separate state
 * store), consistent with `runAutonomyOnceIfDue` advancing lastTickAt even on an
 * errored tick — so a failed tick does not retry the same local day. NEVER
 * publishes (queues to the approval gate as approved:false, same as run-beat).
 */
async function cmdTick(args: ParsedArgs, deps: CliDeps): Promise<CliResult> {
  const baseCfg = await deps.loadAutonomyConfig();
  const resolved = resolveCharacter(args, baseCfg);
  if ('error' in resolved) return { code: EXIT_USAGE, lines: [resolved.error] };
  const cfg: AutonomyConfig = { ...baseCfg, activeCharacterId: resolved.characterId };

  const now = deps.now();
  // Derive lastTickAt from the journal (most-recent-first → [0].at).
  const journal = await deps.readJournal();
  const lastTickAt = journal[0]?.at ?? null;

  if (!shouldTick(now, lastTickAt, cfg)) {
    const reason = !cfg.enabled
      ? 'autonomy is disabled (enable it first)'
      : cfg.cadence !== 'daily'
        ? `cadence is '${cfg.cadence}' (only 'daily' auto-ticks)`
        : now.getHours() < cfg.tickHourLocal
          ? `before the daily tick hour (${cfg.tickHourLocal}:00 local)`
          : 'already ticked today';
    return {
      code: EXIT_OK,
      lines: [
        `Autonomy tick not due — ${reason}.`,
        `  next daily window: ${new Date(nextTickAt(now, cfg)).toISOString()}`,
      ],
    };
  }

  const tickDeps: AutonomyTickDeps = {
    now,
    loadLibrary: deps.loadLibrary,
    runDirector: deps.runDirector,
    persistAsset: deps.persistAsset,
  };
  const result = await deps.runTick(cfg, tickDeps);
  // Journal the fired tick — audit trail AND the dedup source for the next call.
  await deps.appendTick(result);

  const lines: string[] = [];
  lines.push(`Autonomy tick FIRED — ${cfg.activeCharacterId} · ${result.day}`);
  lines.push(`  decision: ${result.decision}${result.pillarId ? ` (${result.pillarId})` : ''}`);
  lines.push(`  ${result.note}`);
  if (result.error) lines.push(`  error: ${result.error}`);
  if (result.queued && result.assetId) {
    lines.push(`  queued asset: ${result.assetId} (approval queue, approved:false — never published)`);
  } else {
    lines.push('  nothing queued this tick');
  }
  return { code: result.error ? EXIT_RUNTIME : EXIT_OK, lines };
}

// ---------------------------------------------------------------------------
// run-week (+ Story 8-11 growth tuning proposals)
// ---------------------------------------------------------------------------

/** Render an hour value as `HH:00 UTC` for the report lines. */
function fmtHour(v: number | string): string {
  return `${String(v).padStart(2, '0')}:00 UTC`;
}

/** Render a proposal/decision value per its kind (`19 → 19:00 UTC`, hooks quoted). */
function fmtValue(kind: TuningProposal['kind'], v: number | string): string {
  return kind === 'posting-hour' ? fmtHour(v) : `"${v}"`;
}

/** The two report lines for one proposal: the change + the tuner's why. */
function formatProposal(p: TuningProposal): string[] {
  const change =
    p.kind === 'posting-hour'
      ? `post at ${fmtHour(p.recommendedValue)}`
      : `use hook ${fmtValue('hook', p.recommendedValue)}`;
  const basis = p.basis === 'exploration' ? 'ε-greedy exploration pick' : 'top recommendation';
  const prior =
    p.priorValue !== undefined ? fmtValue(p.kind, p.priorValue) : 'canon default (untuned)';
  return [
    `    [${p.id}] ${p.day} · ${p.pillarId} — ${change} (${basis}; prior: ${prior})`,
    `        why: ${p.rationale}`,
  ];
}

/**
 * Parse the operator's `--accept` / `--edit` / `--reject` flags into
 * {@link ProposalDecision}s, validating every referenced id against the live
 * proposal list (an unknown id, a valueless flag, a conflicting double
 * decision, or a malformed edit value is a usage error — nothing half-applies).
 */
function parseProposalDecisions(
  args: ParsedArgs,
  proposals: readonly TuningProposal[],
): { decisions: ProposalDecision[] } | { error: string } {
  // A bare `--accept` / `--edit` / `--reject` with no value parses as a flag.
  for (const key of ['accept', 'edit', 'reject'] as const) {
    if (flag(args, key)) {
      return { error: `--${key} expects a value (usage: --${key} <proposal-id>${key === 'edit' ? '=<value>' : ''})` };
    }
  }

  const byId = new Map(proposals.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const decisions: ProposalDecision[] = [];

  const lookup = (id: string): TuningProposal | { error: string } => {
    const p = byId.get(id);
    if (!p) {
      return {
        error: `unknown proposal id '${id}' — run \`run-week\` without decision flags to list the current proposals`,
      };
    }
    if (seen.has(id)) return { error: `conflicting decisions for proposal '${id}'` };
    seen.add(id);
    return p;
  };

  for (const id of multiOption(args, 'accept')) {
    const p = lookup(id);
    if ('error' in p) return p;
    decisions.push({ proposalId: id, action: 'accept' });
  }

  for (const pair of multiOption(args, 'edit')) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) {
      return { error: `--edit expects <proposal-id>=<value>, got '${pair}'` };
    }
    const id = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const p = lookup(id);
    if ('error' in p) return p;
    let editedValue: number | string;
    if (p.kind === 'posting-hour') {
      const h = Number(value);
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return { error: `--edit ${id}: '${value}' is not a posting hour (expected an integer 0..23)` };
      }
      editedValue = h;
    } else {
      if (value.trim() === '') return { error: `--edit ${id}: the hook id must be non-empty` };
      editedValue = value.trim();
    }
    decisions.push({ proposalId: id, action: 'accept', editedValue });
  }

  for (const id of multiOption(args, 'reject')) {
    const p = lookup(id);
    if ('error' in p) return p;
    decisions.push({ proposalId: id, action: 'reject' });
  }

  return { decisions };
}

async function cmdRunWeek(args: ParsedArgs, deps: CliDeps): Promise<CliResult> {
  const baseCfg = await deps.loadAutonomyConfig();
  const resolved = resolveCharacter(args, baseCfg);
  if ('error' in resolved) return { code: EXIT_USAGE, lines: [resolved.error] };

  const library = await deps.loadLibrary();

  // Story 8-11: growth signals → adapted template → EXPLICIT operator proposals.
  // Nothing tuned reaches the plan below unless the operator accepts it here.
  const insights = await deps.loadInsights();
  const adapted = adaptWeeklyTemplate({
    attribution: attributeEngagement(insights),
    slotRecs: recommendPostingTimes(insights),
    hookRecs: recommendHooks(insights),
    ...(deps.rng ? { rng: deps.rng } : {}),
  });
  const proposals = buildTuningProposals(adapted);

  const parsed = parseProposalDecisions(args, proposals);
  if ('error' in parsed) return { code: EXIT_USAGE, lines: [parsed.error] };

  // Apply ONLY the accepted decisions onto the canon base template; rejected
  // and undecided proposals leave the base values untouched (no silent tuning).
  const decided = applyProposalDecisions(
    WEEKLY_TEMPLATE as readonly WeeklySlot[],
    proposals,
    parsed.decisions,
  );
  const plan = deps.buildPlan({
    featuredCharacterId: resolved.characterId,
    library,
    baseTemplate: decided.slots,
  });

  const lines: string[] = [];
  lines.push(`Weekly content plan — ${resolved.characterId} (reuse-first / 4NE-22)`);
  for (const slot of plan.slots) {
    // reuse names the asset it would reuse (best on-canon library match).
    let detail: string;
    if (slot.decision === 'reuse') {
      const match = library.find((a) =>
        (a.tags ?? []).includes(`character:${resolved.characterId}`) &&
        (a.tags ?? []).includes(`pillar:${slot.pillarId}`),
      );
      detail = `reuse${match ? ` ${match.id}` : ''}`;
    } else {
      detail = 'generate (new)';
    }
    // Accepted tuning shows up on the planned slot itself (hour/hook carried
    // through the baseTemplate seam) — visible proof of what actually applied.
    const tuned: string[] = [];
    if (slot.recommendedHour !== undefined) tuned.push(`post ${fmtHour(slot.recommendedHour)}`);
    if (slot.hookId !== undefined) tuned.push(`hook "${slot.hookId}"`);
    lines.push(
      `  ${slot.day} · ${slot.pillarName} · ${detail}${tuned.length > 0 ? ` · ${tuned.join(' · ')}` : ''}`,
    );
  }
  lines.push(
    `  credit estimate: ${plan.newGenCount} new generation${plan.newGenCount === 1 ? '' : 's'} this week (${plan.reuseCount} reused)`,
  );

  // The proposal deck (Story 8-11 AC1): every posting-time/hook change as an
  // explicit proposal with its basis (top vs ε-greedy exploration) + rationale.
  if (proposals.length === 0) {
    lines.push(
      '  Growth proposals: none (no attributed insight history yet — the tuner needs posted engagement to learn from)',
    );
  } else {
    lines.push('');
    lines.push(
      `  Growth proposals (${proposals.length}) — nothing below changes the plan unless you accept it; ignored proposals keep the base template:`,
    );
    for (const p of proposals) lines.push(...formatProposal(p));
    lines.push('    decide with: --accept <id> · --edit <id>=<value> · --reject <id>');
  }

  // Decision outcomes (AC2/AC3): accepted values (edited wins) are named and
  // RECORDED to the durable tuning decision log; rejections are echoed.
  if (decided.applied.length > 0 || decided.rejected.length > 0) {
    lines.push('');
    lines.push('  Decisions:');
    for (const c of decided.applied) {
      lines.push(
        c.edited
          ? `    accepted [${c.proposalId}] → ${fmtValue(c.kind, c.appliedValue)} (operator-edited; recommended was ${fmtValue(c.kind, c.recommendedValue)})`
          : `    accepted [${c.proposalId}] → ${fmtValue(c.kind, c.appliedValue)} (as recommended)`,
      );
    }
    for (const id of decided.rejected) {
      lines.push(`    rejected [${id}] — base value kept, no change applied`);
    }
    if (decided.applied.length > 0) {
      const decidedAt = deps.now().getTime();
      await deps.recordTuningDecisions(decided.applied.map((c) => ({ ...c, decidedAt })));
      lines.push(
        `    ${decided.applied.length} accepted change${decided.applied.length === 1 ? '' : 's'} recorded to the tuning decision log (the A/B baseline for later measurement)`,
      );
    }
  }

  // SAFE DEFAULT: `--execute` does NOT spend. Surfacing the plan is read-only;
  // running the generate slots burns credits, so we refuse to do it unattended
  // and point the operator at the app (which has the director HIL + approval
  // gate). No spend without explicit, in-app confirmation.
  if (flag(args, 'execute')) {
    lines.push('');
    lines.push(
      '--execute: not run. Generating the new-gen slots spends credits, so the headless CLI never does it unattended.',
    );
    lines.push('  Run the generate slots from the app, where the director HIL + approval gate apply.');
  }

  return { code: EXIT_OK, lines };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(deps: CliDeps): Promise<CliResult> {
  const lines: string[] = ['Status (read-only)'];

  // MiniMax quota.
  const quota = await deps.readQuota();
  lines.push(quota ? `  MiniMax quota: ${quota.summary}` : '  MiniMax quota: unavailable');

  // Active budget ceiling.
  const budget = await deps.readBudget();
  lines.push(`  Autonomy daily budget: $${budget.dailyBudgetUsd.toFixed(2)} per tick`);
  lines.push(
    budget.creditCap !== undefined
      ? `  Higgsfield credits: ${budget.creditsUsed} / ${budget.creditCap}`
      : `  Higgsfield credits: ${budget.creditsUsed} used (no cap set)`,
  );

  // Connector-health summary.
  const health = await deps.checkAllConnectors();
  if (health.length === 0) {
    lines.push('  Connectors: none registered');
  } else {
    const ok = health.filter((h) => h.status === 'ok').length;
    const disabled = health.filter((h) => h.status === 'disabled').length;
    const unhealthy = health.length - ok - disabled;
    lines.push(`  Connectors: ${health.length} total — ${ok} ok, ${disabled} disabled, ${unhealthy} unhealthy`);
    for (const h of health) lines.push(formatHealthLine(h));
  }

  // Last few journal ticks.
  const journal = await deps.readJournal();
  const recent = journal.slice(0, 5);
  if (recent.length === 0) {
    lines.push('  Recent ticks: none');
  } else {
    lines.push('  Recent ticks:');
    for (const t of recent) {
      lines.push(`    ${t.day} · ${t.decision}${t.queued ? ' · queued' : ''} — ${t.note}`);
    }
  }

  return { code: EXIT_OK, lines };
}

// ---------------------------------------------------------------------------
// connectors
// ---------------------------------------------------------------------------

async function cmdConnectorsList(deps: CliDeps): Promise<CliResult> {
  const servers = await deps.listServers();
  const health = await deps.checkAllConnectors();
  const healthById = new Map(health.map((h) => [h.id, h]));

  const lines: string[] = ['Connectors'];
  if (servers.length === 0) {
    lines.push('  (none registered)');
    return { code: EXIT_OK, lines };
  }
  for (const srv of servers) {
    const red = deps.redactConfig(srv);
    const h = healthById.get(srv.id);
    const target = red.transport === 'http' ? red.url ?? '(no url)' : red.command ?? '(no command)';
    const flags = `${red.enabled ? 'enabled' : 'disabled'}, ${red.trusted ? 'trusted' : 'untrusted'}`;
    lines.push(`  ${red.id} — ${red.name} [${red.transport}] ${target} (${flags})`);
    if (h) lines.push(formatHealthLine(h));
  }
  return { code: EXIT_OK, lines };
}

async function cmdConnectorsTest(id: string | undefined, deps: CliDeps): Promise<CliResult> {
  if (!id) {
    return { code: EXIT_USAGE, lines: ['usage: aiart4never connectors test <id>'] };
  }
  const servers = await deps.listServers();
  const srv = servers.find((s) => s.id === id);
  if (!srv) {
    return { code: EXIT_RUNTIME, lines: [`no connector with id '${id}'`] };
  }
  const h = await deps.checkConnectorHealth(srv);
  return { code: EXIT_OK, lines: [`Connector test — ${id}`, formatHealthLine(h)] };
}

async function cmdConnectorsAdd(args: ParsedArgs, deps: CliDeps): Promise<CliResult> {
  const name = strOption(args, 'name');
  const url = strOption(args, 'url');
  if (!name || !url) {
    return {
      code: EXIT_USAGE,
      lines: ['usage: aiart4never connectors add --name <n> --url <u> [--header k=v ...] [--yes]'],
    };
  }

  // FR-22: install ONLY from this operator-provided input (source:'operator').
  let proposal;
  try {
    proposal = deps.proposeConnector({
      source: 'operator',
      name,
      transport: 'http',
      url,
      ...(Object.keys(args.headers).length > 0 ? { headers: args.headers } : {}),
    });
  } catch (e) {
    return { code: EXIT_RUNTIME, lines: [`could not propose connector: ${getErrorMessage(e)}`] };
  }

  const lines: string[] = [];
  lines.push(`Proposed connector — ${proposal.config.name} (${proposal.config.id})`);
  // Always print the REDACTED view — raw tokens never escape.
  const red = proposal.redactedView;
  lines.push(`  transport: ${red.transport}`);
  lines.push(`  url: ${red.url ?? '(none)'}`);
  if (red.headers && Object.keys(red.headers).length > 0) {
    lines.push(`  headers: ${Object.entries(red.headers).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  for (const w of proposal.warnings) lines.push(`  warning: ${w}`);

  const confirm: OperatorConfirm = deps.confirm(flag(args, 'yes'));
  if (!confirm.approved) {
    // No --yes → do NOT install. confirmAndInstall is never called.
    lines.push('  re-run with --yes to install');
    return { code: EXIT_OK, lines };
  }

  // --yes → mint a connector-activate token for THIS exact connector, then
  // confirmAndInstall (which re-verifies the token before any trust/enable).
  const req = buildConnectorActivateRequest(proposal.config);
  let token;
  try {
    token = await confirm.mintToken(req);
  } catch (e) {
    return { code: EXIT_RUNTIME, lines: [...lines, `  approval failed: ${getErrorMessage(e)}`] };
  }

  const outcome = await deps.confirmAndInstall(proposal, token);
  if (outcome.ok) {
    lines.push(`  installed: ${outcome.server.id} (trusted+enabled, ${outcome.tools.length} tools)`);
    return { code: EXIT_OK, lines };
  }
  lines.push(`  install failed at ${outcome.stage}: ${getErrorMessage(outcome.error)}`);
  return { code: EXIT_RUNTIME, lines };
}

async function cmdConnectorsRemove(
  id: string | undefined,
  args: ParsedArgs,
  deps: CliDeps,
): Promise<CliResult> {
  if (!id) {
    return { code: EXIT_USAGE, lines: ['usage: aiart4never connectors remove <id> [--yes]'] };
  }
  const confirm = deps.confirm(flag(args, 'yes'));
  if (!confirm.approved) {
    return {
      code: EXIT_OK,
      lines: [`Would remove connector '${id}'.`, '  re-run with --yes to remove'],
    };
  }
  const remaining = await deps.uninstallConnector(id);
  return {
    code: EXIT_OK,
    lines: [`Removed connector '${id}' (${remaining.length} remaining)`],
  };
}

async function cmdConnectors(args: ParsedArgs, deps: CliDeps): Promise<CliResult> {
  const sub = args.positionals[1];
  switch (sub) {
    case 'list':
      return cmdConnectorsList(deps);
    case 'test':
      return cmdConnectorsTest(args.positionals[2], deps);
    case 'add':
      return cmdConnectorsAdd(args, deps);
    case 'remove':
      return cmdConnectorsRemove(args.positionals[2], args, deps);
    default:
      return {
        code: EXIT_USAGE,
        lines: [`unknown connectors subcommand '${sub ?? ''}'`, '', USAGE],
      };
  }
}

// ---------------------------------------------------------------------------
// runCli — the entrypoint
// ---------------------------------------------------------------------------

/**
 * Parse `argv` (already sliced past node/script) and dispatch. Catches any
 * thrown error from a dependency and folds it into `{ code:1, lines:[…] }` so
 * the CLI never crashes the host process.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const args = parseArgs(argv);
  const command = args.positionals[0];

  // --help / no args → usage, exit 0.
  if (command === undefined || flag(args, 'help') || command === 'help') {
    return { code: EXIT_OK, lines: [USAGE] };
  }

  try {
    switch (command) {
      case 'run-beat':
        return await cmdRunBeat(args, deps);
      case 'tick':
        return await cmdTick(args, deps);
      case 'run-week':
        return await cmdRunWeek(args, deps);
      case 'status':
        return await cmdStatus(deps);
      case 'connectors':
        return await cmdConnectors(args, deps);
      default:
        // Unknown command → usage text, exit 2.
        return { code: EXIT_USAGE, lines: [`unknown command '${command}'`, '', USAGE] };
    }
  } catch (e) {
    return { code: EXIT_RUNTIME, lines: [`error: ${getErrorMessage(e)}`] };
  }
}
