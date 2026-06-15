/**
 * M2 — Generic MCP (Model Context Protocol) client manager: shared types.
 *
 * This module is the clean, generic replacement for the old hardcoded
 * Higgsfield MCP client. Nothing here depends on a specific server; the
 * registry stores arbitrary connectors and the client wrapper connects to
 * whichever transport the config declares.
 *
 * These types are intentionally framework-free (no SDK imports) so they can
 * be shared by registry persistence, the client wrapper, and the future
 * in-app Connectors manager UI without dragging the MCP SDK into the bundle.
 */

/**
 * Which transport an MCP server speaks.
 * - `http`  — Streamable HTTP (the modern MCP web transport). Fully supported.
 * - `stdio` — local subprocess over stdin/stdout. DEFERRED: desktop stdio
 *   sandboxing is a later increment (see `lib/mcp/client.ts`); connecting a
 *   `stdio` server currently throws a clear `not-yet-supported` error.
 */
export type McpTransportKind = 'http' | 'stdio';

/**
 * A persisted connector definition. One row in the registry.
 *
 * Secret material (bearer tokens in `headers`, API keys in `env`) lives here
 * because the registry has to reconnect without re-prompting — but it MUST be
 * run through `redactConfig` before being logged. Never log a raw config.
 */
export interface McpServerConfig {
  /** Stable opaque id (caller-supplied or generated). Used as the map key. */
  id: string;
  /** Human-facing label shown in the Connectors manager. */
  name: string;
  /** Transport discriminator — see {@link McpTransportKind}. */
  transport: McpTransportKind;

  // --- http transport ---
  /** Endpoint URL. Required when `transport === 'http'`. */
  url?: string;
  /** Extra HTTP headers (e.g. `Authorization`). Values may be secret. */
  headers?: Record<string, string>;

  // --- stdio transport (deferred) ---
  /** Executable to spawn. Required when `transport === 'stdio'`. */
  command?: string;
  /** Arguments passed to `command`. */
  args?: string[];
  /** Environment overrides for the subprocess. Values may be secret. */
  env?: Record<string, string>;

  /**
   * OAuth 2.1 credential material for OAuth-only MCP servers (e.g. Higgsfield).
   *
   * Filled in by the CLIENT-side OAuth flow (`lib/mcp/oauth.ts`) after the user
   * completes the browser authorize → callback round-trip. The flow persists
   * the SDK's `OAuthTokens` here AND mirrors `accessToken` into
   * `headers.Authorization` as a `Bearer` so the EXISTING "client passes config
   * → server connects with the header" path (`connectMcp` / the probe route)
   * authenticates with zero server-side changes.
   *
   * `clientInformation` is the result of RFC 7591 Dynamic Client Registration
   * (no pre-registered `client_id` needed) — stored so a later token refresh can
   * reuse the same dynamically-registered client without re-registering.
   *
   * SECRET: every field is secret-equivalent. Never log a raw config — pipe
   * through `redactConfig` first (it masks the whole `oauth` block).
   */
  oauth?: {
    /** Current OAuth 2.1 access token. Mirrored into `headers.Authorization`. */
    accessToken: string;
    /** Refresh token, when the server issued one (used by the client refresh). */
    refreshToken?: string;
    /** Unix-ms expiry (derived from the token response's `expires_in`), if known. */
    expiresAt?: number;
    /** Granted scope string, when the server returned one. */
    scope?: string;
    /**
     * The dynamically-registered (RFC 7591) client info — `client_id` and
     * optionally `client_secret` — kept so a refresh reuses the same client.
     */
    clientInformation?: {
      clientId: string;
      clientSecret?: string;
    };
  };

  /** When false the connector is kept but never auto-connected. */
  enabled: boolean;
  /**
   * Trust-on-first-use flag. The operator must explicitly confirm a connector
   * before it is marked trusted (FR-22). Connecting/calling never auto-sets
   * this — see the security notes in `lib/mcp/registry.ts`.
   */
  trusted: boolean;
  /** Unix-ms timestamp the connector was first added. */
  addedAt: number;
}

/**
 * A tool advertised by a connected MCP server, normalised to the minimal
 * shape the app cares about. `inputSchema` is left as `unknown` (it is a raw
 * JSON Schema object) so callers validate it where they use it.
 */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Lifecycle state of a single connector connection. Owned by the UI/manager
 * layer; the client wrapper itself is stateless (connect → handle → close).
 */
export type McpConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';
