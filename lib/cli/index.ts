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
 *   - `run-week`        — print the reuse-first weekly content plan (4NE-22).
 *                         Does NOT generate by default; `--execute` is the safe
 *                         no-spend stub (see below).
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

import type { CharacterId } from '@/lib/canon';
import { listCharacters } from '@/lib/canon';
import { buildConnectorActivateRequest } from '@/lib/connectors';
import type { AutonomyConfig } from '@/lib/autonomy';
import { shouldTick, nextTickAt } from '@/lib/autonomy';
import type { AutonomyTickDeps } from '@/lib/autonomy/loop';
import type { ConnectorHealth } from '@/lib/connectors/health';
import { getErrorMessage } from '@/lib/errors';

import { parseArgs, strOption, flag, type ParsedArgs } from './args';
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
  '  aiart4never run-week [--character <id>]    Print the reuse-first weekly content plan',
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
// run-week
// ---------------------------------------------------------------------------

async function cmdRunWeek(args: ParsedArgs, deps: CliDeps): Promise<CliResult> {
  const baseCfg = await deps.loadAutonomyConfig();
  const resolved = resolveCharacter(args, baseCfg);
  if ('error' in resolved) return { code: EXIT_USAGE, lines: [resolved.error] };

  const library = await deps.loadLibrary();
  const plan = deps.buildPlan({ featuredCharacterId: resolved.characterId, library });

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
    lines.push(`  ${slot.day} · ${slot.pillarName} · ${detail}`);
  }
  lines.push(
    `  credit estimate: ${plan.newGenCount} new generation${plan.newGenCount === 1 ? '' : 's'} this week (${plan.reuseCount} reused)`,
  );

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
