/**
 * 4NE-13 — headless CLI: dependency contract.
 *
 * The CLI core (`runCli`) is a PURE function of `(argv, deps)`: it parses
 * arguments, calls injected functions, and returns `{ code, lines }`. EVERY
 * side effect — the clock, the connector registry + health, the autonomy
 * runner, the content-plan builder, the MiniMax quota reader, the budget
 * reader, the journal reader, and the operator-confirm gate — is injected here.
 * That makes the whole CLI testable with no real LLM, network, or storage, and
 * lets the thin `bin/aiart4never.ts` wire the REAL `@/lib/*` surface.
 *
 * SAFETY: there is deliberately NO publish function anywhere in `CliDeps`. The
 * headless CLI can run a beat (which queues to the human approval gate) and can
 * activate/remove connectors (operator-gated), but it can NEVER publish — the
 * absence of a publish dep is the structural proof.
 */

import type {
  AutonomyConfig,
  AutonomyTickResult,
} from '@/lib/autonomy';
import type { AutonomyTickDeps } from '@/lib/autonomy/loop';
import type { WeeklyPlan, WeeklyPlanInput } from '@/lib/canon/content-plan';
import type { ConnectorHealth } from '@/lib/connectors/health';
import type { ConnectorProposal } from '@/lib/connectors';
import type { ProposeConnectorInput, InstallDeps } from '@/lib/connectors';
import type { InstallOutcome } from '@/lib/connectors';
import type { McpServerConfig } from '@/lib/mcp';
import type { ApprovalRequest, ApprovalToken } from '@/lib/approval';
import type { GeneratedImage } from '@/types/mashup';

/**
 * A snapshot of the active spend ceilings for `status`. `dailyBudgetUsd` is the
 * autonomy loop's per-tick director cap; the credit fields surface the
 * Higgsfield monthly credit budget (cap may be undefined = "no cap set").
 */
export interface CliBudgetSnapshot {
  dailyBudgetUsd: number;
  creditsUsed: number;
  creditCap?: number;
}

/**
 * A redaction-safe MiniMax quota snapshot for `status`, or `null` when no quota
 * source is configured (the CLI then reports quota "unavailable").
 */
export interface CliQuotaSnapshot {
  tokensUsed: number;
  /** Monthly allowance; 0 = no cap / tracking-only. */
  allowance: number;
  /** Pre-formatted "1.2B / 12.5B tokens this month (10%)" line. */
  summary: string;
}

/**
 * The operator-confirm gate. The CLI calls this for any irreversible action
 * (connector activate / remove); the `--yes` flag is what flips it to
 * auto-approve. `mintToken` MUST mint a real {@link ApprovalToken} bound to the
 * given request (the thin bin wires this through `@/lib/approval`'s
 * `assertApproved` with an auto-approving operator stub representing `--yes`).
 *
 *  - `approved:false` → the operator did NOT pass `--yes`; the CLI prints the
 *    proposal/preview and exits 0 without performing the action.
 *  - `approved:true`  → `--yes` was given; `mintToken(req)` is called to obtain
 *    the proof the side-effecting layer verifies.
 */
export interface OperatorConfirm {
  approved: boolean;
  mintToken: (req: ApprovalRequest) => Promise<ApprovalToken>;
}

/**
 * All side effects the CLI needs, injected. Real wiring lives in
 * `bin/aiart4never.ts`; tests pass spies.
 */
export interface CliDeps {
  /** Wall clock. Drives `run-beat`'s tick time and `checkedAt` stamps. */
  now: () => Date;

  /** The active autonomy config (active character + per-tick budget + cadence). */
  loadAutonomyConfig: () => Promise<AutonomyConfig>;

  // --- run-beat (one autonomy tick) ---
  /** Load the asset library (for the plan + reuse). */
  loadLibrary: () => Promise<GeneratedImage[]>;
  /**
   * The director runner, injected so generation is testable and gated by the
   * director's own HIL. Matches `AutonomyTickDeps['runDirector']`.
   */
  runDirector: AutonomyTickDeps['runDirector'];
  /**
   * Persist a produced asset as `approved:false` (the human approval queue).
   * Matches `AutonomyTickDeps['persistAsset']`.
   */
  persistAsset: AutonomyTickDeps['persistAsset'];
  /**
   * Run ONE autonomy tick now. Injected (rather than imported) so tests assert
   * the tick was invoked with the right config/deps. The real bin wires this to
   * `runAutonomyTick`. It is given the resolved tick deps so the CLI stays the
   * one place the director/persist are threaded.
   */
  runTick: (cfg: AutonomyConfig, tickDeps: AutonomyTickDeps) => Promise<AutonomyTickResult>;
  /**
   * Append a tick result to the autonomy journal. Story 8-13: the scheduled
   * `tick` command journals every fired tick — both as the audit trail and as
   * the dedup source it reads (newest entry's `at`) to decide "already ticked
   * today". Wraps `appendTick` from lib/autonomy.
   */
  appendTick: (result: AutonomyTickResult) => Promise<void>;

  // --- run-week (content plan) ---
  /** Build the reuse-first weekly content plan (wraps `buildWeeklyContentPlan`). */
  buildPlan: (input: WeeklyPlanInput) => WeeklyPlan;

  // --- status ---
  /** MiniMax quota snapshot, or null when no quota source is configured. */
  readQuota: () => Promise<CliQuotaSnapshot | null>;
  /** Active spend ceilings (autonomy daily budget + credit budget). */
  readBudget: () => Promise<CliBudgetSnapshot>;
  /** The autonomy journal, most-recent-first (wraps `readJournal`). */
  readJournal: () => Promise<AutonomyTickResult[]>;

  // --- connectors ---
  /** All registered connectors (wraps `listServers`). */
  listServers: () => Promise<McpServerConfig[]>;
  /** Redact a config for display (wraps `redactConfig`). */
  redactConfig: (cfg: McpServerConfig) => McpServerConfig;
  /** Health of all connectors (wraps `checkAllConnectors`). */
  checkAllConnectors: () => Promise<ConnectorHealth[]>;
  /** Health of one connector (wraps `checkConnectorHealth`). */
  checkConnectorHealth: (cfg: McpServerConfig) => Promise<ConnectorHealth>;
  /** Build an install proposal from operator input (wraps `proposeConnector`). */
  proposeConnector: (input: ProposeConnectorInput) => ConnectorProposal;
  /** Operator-confirmed install (wraps `confirmAndInstall`). */
  confirmAndInstall: (
    proposal: ConnectorProposal,
    token: ApprovalToken,
    installDeps?: InstallDeps,
  ) => Promise<InstallOutcome>;
  /** Remove a connector by id (wraps `uninstallConnector`). */
  uninstallConnector: (id: string) => Promise<McpServerConfig[]>;

  /**
   * The operator-confirm gate for irreversible actions. The CLI builds it from
   * the presence of `--yes`; see {@link OperatorConfirm}. Returns approved=false
   * when the user did not pass `--yes`.
   */
  confirm: (yes: boolean) => OperatorConfirm;
}

/** The CLI result: a numeric exit code plus the lines to print. */
export interface CliResult {
  code: number;
  lines: string[];
}
