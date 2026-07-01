#!/usr/bin/env bun
/**
 * 4NE-13 — headless CLI entrypoint (thin wiring shell).
 *
 * This is the ONLY place real side effects are wired: it builds a {@link CliDeps}
 * from the real `@/lib/*` surface, calls `runCli(process.argv.slice(2), real)`,
 * prints the returned lines, and exits with the returned code. ALL logic lives
 * in the testable `lib/cli` core — this file has no branching of its own.
 *
 * SAFETY: there is no publish dependency anywhere in `CliDeps`, so this binary
 * cannot publish. `run-beat` only queues to the human approval gate; connector
 * activate/remove are gated by `--yes` (which mints a real approval token).
 *
 * Run it (no build step needed under bun):
 *   bun bin/aiart4never.ts status
 *   bun bin/aiart4never.ts run-week --character kael
 */

import { runCli } from '@/lib/cli';
import type { CliDeps, CliBudgetSnapshot, CliQuotaSnapshot, OperatorConfirm } from '@/lib/cli';

import { runAutonomyTick } from '@/lib/autonomy/loop';
import { readJournal, appendTick } from '@/lib/autonomy';
import type { AutonomyConfig } from '@/lib/autonomy';
import { buildWeeklyContentPlan } from '@/lib/canon/content-plan';
import {
  listServers,
  redactConfig,
} from '@/lib/mcp';
import {
  checkAllConnectors,
  checkConnectorHealth,
} from '@/lib/connectors/health';
import {
  proposeConnector,
  confirmAndInstall,
  uninstallConnector,
} from '@/lib/connectors';
import { assertApproved } from '@/lib/approval';
import type { ApprovalRequest } from '@/lib/approval';
import { runDirectorLoop } from '@/lib/agent-loop';
import { executePersistAsset } from '@/lib/agent-tools/persist-asset';
import type { PersistAssetInput } from '@/lib/agent-tools/schemas';
import type { GeneratedImage } from '@/types/mashup';
import { loadCreditUsage } from '@/lib/credit-budget';
import {
  loadQuotaUsage,
  resolveAllowance,
  formatQuota,
} from '@/lib/minimax-quota';
import { get } from '@/lib/persistence';

/**
 * Default autonomy config when none is persisted. The operator can persist a
 * real one under `aiart4never_autonomy_config`; we read it best-effort.
 */
const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  enabled: false,
  cadence: 'manual',
  activeCharacterId: 'kael',
  dailyBudgetUsd: 0.5,
  tickHourLocal: 9,
};

async function loadAutonomyConfig(): Promise<AutonomyConfig> {
  try {
    const raw = await get<Partial<AutonomyConfig>>('aiart4never_autonomy_config');
    if (raw && typeof raw === 'object') {
      return { ...DEFAULT_AUTONOMY_CONFIG, ...raw };
    }
  } catch {
    /* best-effort — fall through to the default */
  }
  return DEFAULT_AUTONOMY_CONFIG;
}

async function loadLibrary(): Promise<GeneratedImage[]> {
  try {
    const raw = await get<GeneratedImage[]>('mashup_saved_images');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function readBudget(): Promise<CliBudgetSnapshot> {
  const cfg = await loadAutonomyConfig();
  const usage = await loadCreditUsage();
  return { dailyBudgetUsd: cfg.dailyBudgetUsd, creditsUsed: usage.used };
}

async function readQuota(): Promise<CliQuotaSnapshot | null> {
  try {
    const usage = await loadQuotaUsage();
    // No tier/cap source plumbed into the headless context → tracking-only.
    const allowance = resolveAllowance(undefined);
    return { tokensUsed: usage.tokensUsed, allowance, summary: formatQuota(usage, allowance) };
  } catch {
    return null;
  }
}

/** `--yes` is the explicit operator confirmation; it auto-approves the gate. */
function confirm(yes: boolean): OperatorConfirm {
  return {
    approved: yes,
    mintToken: (req: ApprovalRequest) =>
      // The auto-approving operator stub REPRESENTS the explicit `--yes`.
      assertApproved(req, { askOperator: async () => ({ verdict: 'approved' }) }),
  };
}

const deps: CliDeps = {
  now: () => new Date(),
  loadAutonomyConfig,
  loadLibrary,
  runDirector: (input) => runDirectorLoop(input),
  persistAsset: async (input: PersistAssetInput) => {
    const res = await executePersistAsset(input);
    if (!res.ok) throw res.error;
    return { assetId: res.value.assetId };
  },
  runTick: (cfg, tickDeps) => runAutonomyTick(cfg, tickDeps),
  appendTick: async (result) => {
    await appendTick(result); // discard the returned journal — the CLI dep is void
  },
  buildPlan: (input) => buildWeeklyContentPlan(input),
  readQuota,
  readBudget,
  readJournal: () => readJournal(),
  listServers: () => listServers(),
  redactConfig,
  checkAllConnectors: () => checkAllConnectors(),
  checkConnectorHealth: (cfg) => checkConnectorHealth(cfg),
  proposeConnector,
  confirmAndInstall: (proposal, token, installDeps) =>
    confirmAndInstall(proposal, token, installDeps),
  uninstallConnector: (id) => uninstallConnector(id),
  confirm,
};

runCli(process.argv.slice(2), deps)
  .then(({ code, lines }) => {
    if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n');
    process.exit(code);
  })
  .catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
