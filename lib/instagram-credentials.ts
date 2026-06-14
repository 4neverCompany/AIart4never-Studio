// IG-STALE-FIX helper. Body-first resolution: the browser snapshot is
// the source of truth when present, env is the fallback. Both manual
// posts and cron-fired scheduled posts forward the user's current
// `settings.apiKeys.instagram` through to /api/social/post as
// `credentials.instagram`, so body is the freshest signal we have.
//
// Inverts the previous env-first INSTAGRAM-CRED-FIX decision. That
// design assumed "env set" implied a desktop user whose config.json
// hydrated process.env at boot, and "env unset" implied web. Maurice
// hit the failure mode where Vercel production had stale
// INSTAGRAM_ACCESS_TOKEN env vars set 19+ days ago (from earlier
// testing), so the resolver always picked them over the browser's
// freshly-updated credential — manual posts intermittently worked
// (the env token might still be inside its 60-day Facebook Page
// Access Token window) but cron-fired scheduled posts failed silently
// as the env token drifted further from refresh.
//
// Body-first now means: whenever the request carries a non-empty
// credential, it wins. Env stays as a fallback for server-only flows
// (none exist today, but the pattern leaves room — e.g. an admin
// recovery cron that wants to bypass user state). Desktop callers
// pass the same body via the browser shell, so this doesn't regress
// their flow.
//
// Short-circuit semantics use `||` deliberately (not `??`) so empty
// strings — which a user clearing a field might send — fall through
// to the env fallback instead of locking in an empty token.

// Index signature — NodeJS.ProcessEnv is `{ [key: string]: string | undefined }`,
// so a named-key interface would fail structural compatibility at the call site.
export type InstagramCredentialSources = Readonly<Record<string, string | undefined>>;

export interface InstagramCredentialBody {
  igAccountId?: string;
  accessToken?: string;
  // Unix ms when the long-lived token expires. Optional because legacy
  // configs predate the refresh flow; resolver ignores this field.
  expiresAt?: number;
}

export interface ResolvedInstagramCredentials {
  igAccountId: string;
  igAccessToken: string;
}

export function resolveInstagramCredentials(
  env: InstagramCredentialSources,
  body: InstagramCredentialBody | undefined,
): ResolvedInstagramCredentials {
  return {
    igAccountId: body?.igAccountId?.trim() || env.INSTAGRAM_ACCOUNT_ID || '',
    igAccessToken: body?.accessToken?.trim() || env.INSTAGRAM_ACCESS_TOKEN || '',
  };
}
