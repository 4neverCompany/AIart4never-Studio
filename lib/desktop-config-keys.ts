/**
 * Shared constant for desktop configuration key metadata.
 * Safe to import from both client components and server API routes
 * (no node: imports, no server-only modules).
 */
// INSTAGRAM_* moved here from IndexedDB-backed UserSettings. IDB is
// origin-scoped; on desktop the origin can drift across launches if
// STORY-121's stable-port bind falls back to an ephemeral port (port
// 19782 already bound by another process, zombie sidecar, etc.). When
// that happens IDB reads the new origin's empty store and the user
// sees "credentials wiped." config.json lives on disk under a stable
// path, so anything listed here survives any webview origin drift.

export const PI_PROVIDER_OPTIONS = ['zai', 'anthropic', 'openai', 'google'] as const;
export type PiProvider = typeof PI_PROVIDER_OPTIONS[number];

interface BaseFieldMeta {
  key: string;
  label: string;
  hint: string;
}
interface SecretFieldMeta extends BaseFieldMeta { kind?: 'secret' }
interface SelectFieldMeta extends BaseFieldMeta {
  kind: 'select';
  options: readonly string[];
}
interface TextFieldMeta extends BaseFieldMeta { kind: 'text' }

export type DesktopConfigFieldMeta = SecretFieldMeta | SelectFieldMeta | TextFieldMeta;

// PI_PROVIDER + PI_DEFAULT_MODEL come first so the dropdown sits at the
// top of the panel — provider choice gates which API key matters most.
export const DESKTOP_CONFIG_KEYS: readonly DesktopConfigFieldMeta[] = [
  { key: 'PI_PROVIDER',            label: 'Pi.dev Provider',        hint: 'AI backend used by pi for chat / ideas / captions.', kind: 'select', options: PI_PROVIDER_OPTIONS },
  { key: 'PI_DEFAULT_MODEL',       label: 'Default Model',          hint: 'Model ID for the chosen provider (e.g. glm-4.6, claude-sonnet-4-5, gpt-4o, gemini-2.5-pro).', kind: 'text' },
  { key: 'LEONARDO_API_KEY',       label: 'Leonardo AI API Key',    hint: 'From app.leonardo.ai/api-access' },
  { key: 'ZAI_API_KEY',            label: 'Z.AI API Key',           hint: 'From console.z.ai — used when provider = zai (GLM).' },
  { key: 'ANTHROPIC_API_KEY',      label: 'Anthropic API Key',      hint: 'From console.anthropic.com — used when provider = anthropic (Claude).' },
  { key: 'OPENAI_API_KEY',         label: 'OpenAI API Key',         hint: 'From platform.openai.com — used when provider = openai (GPT).' },
  { key: 'GOOGLE_API_KEY',         label: 'Google API Key',         hint: 'From aistudio.google.com — used when provider = google (Gemini).' },
  { key: 'MINIMAX_API_KEY',        label: 'MiniMax API Key',        hint: 'From platform.minimax.io — used by the nca AI agent (default provider). Same key the legacy mmx CLI uses.' },
  { key: 'NCA_MODEL',              label: 'nca model override',     hint: 'Optional. e.g. MiniMax-M2.5 (default), MiniMax-M2.7, MiniMax-M2.7-highspeed. Leave empty for nca default.', kind: 'text' },
  { key: 'SERPER_API_KEY',         label: 'Serper.dev API Key',     hint: 'Default web-search backend for trending. Free 2,500 one-time credits at serper.dev. Leave empty to fall back to Brave / DuckDuckGo.', kind: 'secret' },
  { key: 'BRAVE_API_KEY',          label: 'Brave Search API Key',   hint: 'Optional secondary web-search backend. Get a key at brave.com/api. Used only when Serper is empty or returns nothing; DuckDuckGo is the final fallback.', kind: 'secret' },
  { key: 'INSTAGRAM_ACCOUNT_ID',   label: 'Instagram Account ID',   hint: 'Business account ID from Meta for Developers' },
  { key: 'INSTAGRAM_ACCESS_TOKEN', label: 'Instagram Access Token', hint: 'Long-lived Facebook Page Token (starts with EAA)' },
  { key: 'TWITTER_APP_KEY',        label: 'Twitter App Key',        hint: 'OAuth 1.0a consumer key from developer.x.com' },
  { key: 'TWITTER_APP_SECRET',     label: 'Twitter App Secret',     hint: 'OAuth 1.0a consumer secret' },
  { key: 'TWITTER_ACCESS_TOKEN',   label: 'Twitter Access Token',   hint: 'OAuth 1.0a access token' },
  { key: 'TWITTER_ACCESS_SECRET',  label: 'Twitter Access Secret',  hint: 'OAuth 1.0a access token secret' },
  { key: 'PINTEREST_ACCESS_TOKEN', label: 'Pinterest Access Token', hint: 'From developers.pinterest.com (pins:write scope)' },
  { key: 'PINTEREST_BOARD_ID',     label: 'Pinterest Board ID',     hint: 'Target board ID (optional — defaults to first board)' },
  { key: 'DISCORD_WEBHOOK_URL',    label: 'Discord Webhook URL',    hint: 'Channel webhook URL from Server Settings → Integrations' },
  // V060-002: per-platform enable flags. Stored as '1' (on) / '' (off).
  // Empty string is treated as "absent" by the PATCH endpoint and removed
  // from config.json — that is the off state. The UI computes the default
  // from existing creds so users with already-configured platforms see
  // their fields expanded on first load (graceful migration).
  { key: 'INSTAGRAM_ENABLED',      label: 'Instagram enabled',      hint: 'Internal toggle — managed by the Platforms section.' },
  { key: 'TWITTER_ENABLED',        label: 'Twitter enabled',        hint: 'Internal toggle — managed by the Platforms section.' },
  { key: 'PINTEREST_ENABLED',      label: 'Pinterest enabled',      hint: 'Internal toggle — managed by the Platforms section.' },
  { key: 'DISCORD_ENABLED',        label: 'Discord enabled',        hint: 'Internal toggle — managed by the Platforms section.' },
  // HIGGSFIELD-INTEGRATION: OAuth client_id (registered once at first
  // /api/higgsfield/oauth/authorize call, persisted for reuse). The
  // AES salt for the token-encryption key is written to config.json
  // by the same flow — both are non-secrets (the client_id is public
  // in OAuth 2.0; the salt's paired with origin/machineId in IDB).
  { key: 'HIGGSFIELD_OAUTH_CLIENT_ID', label: 'Higgsfield OAuth client id', hint: 'Internal — auto-generated on first Higgsfield connect. Safe to share.', kind: 'text' },
  { key: 'HIGGSFIELD_OAUTH_SALT',     label: 'Higgsfield OAuth salt',     hint: 'Internal — random per-install salt for token encryption. Regenerating disconnects Higgsfield.', kind: 'text' },
  // FEAT-006: tri-state gate for UpdateChecker's launch-time behavior.
  // Kept for backwards compat; AutoUpdateSettings renders the granular
  // toggles below instead. Both sets live in UPDATER_KEYS so the generic
  // FieldRouter loop never renders them a second time.
  { key: 'UPDATE_BEHAVIOR',        label: 'Update behavior',        hint: 'Auto: install silently. Notify: show banner. Off: only manual checks.', kind: 'select', options: ['auto', 'notify', 'off'] },
  // AutoUpdateSettings — granular per-step toggles (rendered by AutoUpdateSettings, not the generic loop).
  { key: 'AUTO_CHECK_ON_STARTUP',  label: 'Auto-check on startup',  hint: 'Run an update check each time the app launches.', kind: 'text' },
  { key: 'AUTO_DOWNLOAD',          label: 'Auto-download',          hint: 'Download in the background when a new version is found.', kind: 'text' },
  { key: 'AUTO_INSTALL',           label: 'Auto-install',           hint: 'Install immediately after download — app will relaunch.', kind: 'text' },
  { key: 'WIN_INSTALL_MODE',       label: 'Windows install mode',   hint: 'passive | basicUi | quiet', kind: 'select', options: ['passive', 'basicUi', 'quiet'] },
] as const;

// Keys owned by a dedicated subsection in DesktopSettingsPanel. The
// generic FieldRouter loop filters these out so they don't render twice.
export const UPDATER_KEYS: ReadonlySet<string> = new Set([
  'UPDATE_BEHAVIOR',
  'AUTO_CHECK_ON_STARTUP',
  'AUTO_DOWNLOAD',
  'AUTO_INSTALL',
  'WIN_INSTALL_MODE',
]);

// V060-002: platform groupings for the Desktop tab. Each group renders
// as a single compact row when toggled OFF and expands to show its
// fieldKeys when toggled ON. V1.9.2 (#47b): Instagram is now toggleable too
// (was alwaysOn) — every platform has an `enabledKey`. An absent flag falls
// back to "on if any creds exist" (platformEnabledDefault), so existing
// setups keep working; `alwaysOn` remains for any future always-on group.
export interface PlatformGroupMeta {
  id: 'instagram' | 'twitter' | 'pinterest' | 'discord';
  label: string;
  enabledKey: string | null;
  fieldKeys: readonly string[];
  alwaysOn: boolean;
}

export const PLATFORM_GROUPS: readonly PlatformGroupMeta[] = [
  {
    // V1.9.2 (#47b): Instagram gained an enable toggle (was hard-coded
    // alwaysOn). Defaults enabled when creds are present (platformEnabledDefault),
    // so existing setups are unchanged, but the user can now turn IG off like
    // any other platform.
    id: 'instagram',
    label: 'Instagram',
    enabledKey: 'INSTAGRAM_ENABLED',
    fieldKeys: ['INSTAGRAM_ACCOUNT_ID', 'INSTAGRAM_ACCESS_TOKEN'],
    alwaysOn: false,
  },
  {
    id: 'twitter',
    label: 'Twitter / X',
    enabledKey: 'TWITTER_ENABLED',
    fieldKeys: ['TWITTER_APP_KEY', 'TWITTER_APP_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET'],
    alwaysOn: false,
  },
  {
    id: 'pinterest',
    label: 'Pinterest',
    enabledKey: 'PINTEREST_ENABLED',
    fieldKeys: ['PINTEREST_ACCESS_TOKEN', 'PINTEREST_BOARD_ID'],
    alwaysOn: false,
  },
  {
    id: 'discord',
    label: 'Discord',
    enabledKey: 'DISCORD_ENABLED',
    fieldKeys: ['DISCORD_WEBHOOK_URL'],
    alwaysOn: false,
  },
] as const;

// Union of every key that belongs to a platform group, plus the enable
// flags. Used by DesktopSettingsPanel to filter the generic FieldRouter
// loop so platform fields don't render twice (once flat, once grouped).
export const PLATFORM_OWNED_KEYS: ReadonlySet<string> = new Set(
  PLATFORM_GROUPS.flatMap((g) => [...g.fieldKeys, ...(g.enabledKey ? [g.enabledKey] : [])]),
);

// Default toggle state when the user hasn't explicitly set the flag.
// Returns true if any of the platform's field keys already has a value
// — preserves existing setups so first-load doesn't hide working creds.
export function platformEnabledDefault(
  group: PlatformGroupMeta,
  values: Record<string, string>,
): boolean {
  if (group.alwaysOn) return true;
  return group.fieldKeys.some((k) => (values[k] ?? '').trim().length > 0);
}

// Read the current toggle state from a values map. Honors an explicit
// '1' / '' flag if set, otherwise falls back to platformEnabledDefault.
export function isPlatformEnabled(
  group: PlatformGroupMeta,
  values: Record<string, string>,
): boolean {
  if (group.alwaysOn) return true;
  if (!group.enabledKey) return true;
  const raw = values[group.enabledKey];
  if (raw === '1') return true;
  if (raw === '0') return false;
  return platformEnabledDefault(group, values);
}

// Default when UPDATE_BEHAVIOR is missing from config.json — safe choice
// (user is informed before any download happens).
export const UPDATE_BEHAVIOR_DEFAULT = 'notify' as const;
export type UpdateBehavior = 'auto' | 'notify' | 'off';

export type DesktopConfigKey = typeof DESKTOP_CONFIG_KEYS[number]['key'];
