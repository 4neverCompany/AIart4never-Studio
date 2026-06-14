/**
 * MCP client wrapper for the Higgsfield MCP server.
 *
 * Wraps `@modelcontextprotocol/sdk/client/streamableHttp.js` with:
 *   1. Lazy client creation per process (the SDK keeps a long-lived
 *      HTTP/2 connection; we open one per worker and reuse).
 *   2. Per-request Bearer token injection. The MCP SDK accepts a
 *      custom fetch with headers; we set Authorization: Bearer
 *      from the OAuth access token.
 *   3. Typed result parsing. The MCP `tools/call` returns a generic
 *      `content: Array<{ type: 'text' | 'image' | ...; text?: string }>`
 *      array — we narrow it to the shapes MashupForge cares about
 *      (image URLs, video URLs, request IDs for polling).
 *
 * The MCP server is the user-facing multi-tenant surface. Each user
 * OAuths in with their own subscription. The server is a thin layer
 * over the same REST API the official SDK uses; we get a 7-tool
 * curated surface (not the full 30+ models) but enough for
 * Instagram-first content.
 */

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getErrorMessage } from '@/lib/errors';
import {
  HIGGSFIELD_MCP_SERVER_URL,
  type TokenResponse,
} from './oauth';
import {
  isTokenExpiringSoon,
  loadTokens,
  saveTokens,
  type StoredTokens,
} from './token-store';
import { refreshAccessToken } from './oauth';

// One process-wide client. The MCP SDK is designed for long-lived
// sessions; creating a new client per request defeats its connection
// pooling. We key by access token hash so users with distinct
// accounts (in multi-user SaaS mode) get distinct connections.
let cachedClientKey: string | null = null;
let cachedClient: McpClient | null = null;

interface CallToolArgs {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  /** True if the call succeeded and the tool returned a final
   * image/video URL. False if the tool is async and we need to
   * poll the result later via a returned requestId. */
  completed: boolean;
  /** Direct image URL if the tool returns one synchronously. */
  imageUrl?: string;
  /** Direct video URL if the tool returns one synchronously. */
  videoUrl?: string;
  /** Underlying job/request id (poll via the /status endpoint or
   * come back later — the MCP `higgsfield_generate` tool returns
   * these when generation is async). */
  requestId?: string;
  /** Raw text content from the tool (status messages, model output, etc.). */
  text?: string;
  /** True if the tool was rejected for content moderation. */
  blocked?: boolean;
  /** Free-form error string. */
  error?: string;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
        const t = (c as { text?: unknown }).text;
        return typeof t === 'string' ? t : '';
      }
      return '';
    })
    .join('\n')
    .trim();
}

/**
 * Get a valid access token. Refreshes automatically if expiring
 * within 60s. Returns null if no tokens are stored (caller should
 * redirect to /api/higgsfield/oauth/authorize).
 */
export async function getValidAccessToken(args: {
  clientId: string;
}): Promise<{ accessToken: string; tokens: StoredTokens } | null> {
  const tokens = await loadTokens();
  if (!tokens) return null;
  if (isTokenExpiringSoon(tokens)) {
    if (!tokens.refreshToken) {
      // Expired access + no refresh → user must re-auth.
      return null;
    }
    try {
      const refreshed: TokenResponse = await refreshAccessToken({
        clientId: args.clientId,
        refreshToken: tokens.refreshToken,
      });
      const next: StoredTokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || tokens.refreshToken,
        accessTokenExpiresAt: refreshed.expires_in
          ? Date.now() + refreshed.expires_in * 1000
          : 0,
        email: tokens.email,
        orgId: tokens.orgId,
        name: tokens.name,
      };
      await saveTokens(next);
      return { accessToken: next.accessToken, tokens: next };
    } catch (e) {
      // Refresh failed — surface the original tokens but mark them
      // as potentially-stale. The MCP call below will 401 and the
      // caller will redirect to re-auth.
      return { accessToken: tokens.accessToken, tokens };
    }
  }
  return { accessToken: tokens.accessToken, tokens };
}

async function getOrCreateClient(accessToken: string): Promise<McpClient> {
  if (cachedClient && cachedClientKey === accessToken) {
    return cachedClient;
  }
  // Disconnect any previous client (token rotation, account switch).
  if (cachedClient) {
    try { await cachedClient.close(); } catch { /* ignore */ }
    cachedClient = null;
    cachedClientKey = null;
  }
  const client = new McpClient(
    { name: 'mashupforge', version: '1.0.4' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(HIGGSFIELD_MCP_SERVER_URL),
    {
      // The MCP SDK lets us inject headers via the requestInit
      // option. We set the Bearer token here so every call
      // authenticates as the current user.
      requestInit: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'mashupforge/1.0.4',
        },
      },
    },
  );
  await client.connect(transport);
  cachedClient = client;
  cachedClientKey = accessToken;
  return client;
}

function parseToolResult(tool: string, raw: unknown): McpToolResult {
  // MCP `tools/call` returns { content: Array, isError?: boolean }.
  // The Higgsfield tools embed their results in the text content
  // (e.g. "https://...image.jpg" or "Job started, request_id: abc")
  // — there is no structured `data` field. We pattern-match common
  // shapes; anything we don't recognise falls through to `text`.
  const obj = raw as { content?: unknown; isError?: boolean; isBlocked?: boolean } | undefined;
  if (!obj || obj.isError) {
    return { completed: false, error: getErrorMessage(raw) || 'MCP tool call failed' };
  }
  const text = textFromContent(obj.content);
  if (obj.isBlocked) {
    return { completed: false, blocked: true, text, error: text || 'Generation blocked' };
  }
  // Image: looks for https URLs ending in jpg/jpeg/png/webp
  const imgMatch = text.match(/https?:\/\/\S+\.(?:jpg|jpeg|png|webp)(?:\?\S*)?/i);
  if (imgMatch) {
    return { completed: true, imageUrl: imgMatch[0], text };
  }
  // Video: looks for https URLs ending in mp4/webm/mov
  const videoMatch = text.match(/https?:\/\/\S+\.(?:mp4|webm|mov)(?:\?\S*)?/i);
  if (videoMatch) {
    return { completed: true, videoUrl: videoMatch[0], text };
  }
  // Async job: look for "request_id: ..." or "Job started" patterns.
  const requestIdMatch = text.match(/request[_\s-]?id[:\s]+([a-z0-9-]+)/i)
    || text.match(/job[_\s-]?id[:\s]+([a-z0-9-]+)/i);
  if (requestIdMatch) {
    return { completed: false, requestId: requestIdMatch[1], text };
  }
  return { completed: false, text };
}

/**
 * Call a Higgsfield MCP tool. Returns the parsed result. Throws on
 * network / auth failures — callers should catch and map to a
 * user-friendly error string.
 *
 * `clientId` is the registered OAuth client_id (from
 * HIGGSFIELD_OAUTH_CLIENT_ID in config.json). `accessToken` is the
 * current user's access token (from IDB after OAuth callback).
 */
export async function callHiggsfieldTool(args: {
  clientId: string;
  accessToken: string;
  tool: string;
  arguments: Record<string, unknown>;
}): Promise<McpToolResult> {
  const client = await getOrCreateClient(args.accessToken);
  try {
    const raw = await client.callTool({
      name: args.tool,
      arguments: args.arguments,
    });
    return parseToolResult(args.tool, raw);
  } catch (e) {
    return { completed: false, error: getErrorMessage(e) || 'MCP call threw' };
  }
}

/**
 * Disconnect the cached client. Use when the user disconnects
 * their Higgsfield account or the OAuth token is revoked.
 */
export async function disconnectMcp(): Promise<void> {
  if (cachedClient) {
    try { await cachedClient.close(); } catch { /* ignore */ }
    cachedClient = null;
    cachedClientKey = null;
  }
}
