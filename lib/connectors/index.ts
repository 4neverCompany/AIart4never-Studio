/**
 * M2 — Connectors & Skills manager: public surface.
 *
 * Built ON TOP of the read-only `@/lib/mcp` registry. Import from
 * `@/lib/connectors` rather than reaching into the individual files.
 *
 * What lives here:
 *   - the FR-22 agentic-install flow (`proposeConnector` / `confirmAndInstall`
 *     / `uninstallConnector`) — the ONLY way a connector enters the registry,
 *     and the only place trust is granted;
 *   - the Skills layer (least-privilege tool bundles, persisted) with CRUD,
 *     `validateSkill`, and `resolveSkillTools`.
 */

export type { ConnectorProposal, InstallOutcome, Skill } from './types';

export {
  proposeConnector,
  confirmAndInstall,
  uninstallConnector,
  slugifyName,
  ApprovalRequiredError,
  buildConnectorActivateRequest,
} from './install';
export type { ProposeConnectorInput, InstallDeps } from './install';

export {
  SKILLS_KEY,
  listSkills,
  getSkill,
  saveSkill,
  removeSkill,
  validateSkill,
  resolveSkillTools,
} from './skills';
export type { SkillValidationResult, ResolvedSkillTools } from './skills';

export { checkConnectorHealth, checkAllConnectors } from './health';
export type {
  ConnectorHealth,
  ConnectorHealthStatus,
  HealthDeps,
} from './health';

// Server-backed probe deps: route the connect-probe through POST
// /api/mcp/probe (Node side) instead of connecting from the browser, so the
// add/test/health flow works on the public web (no CORS). Inject these as the
// `connect`/`list` deps for confirmAndInstall / checkConnectorHealth /
// checkAllConnectors from the hook/component layer.
export { serverProbeDeps } from './probe-client';
