/**
 * Detect whether the current Node runtime is a known serverless platform
 * where local subprocess execution (tmux, spawnSync, etc.) is unavailable.
 *
 * Used as a defense-in-depth guard on every API route that spawns a
 * child process. The Tauri desktop build never matches any of these,
 * so the routes still work locally — they only short-circuit on
 * Vercel / Lambda / Netlify / Cloudflare Pages.
 */
export function isServerless(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.NETLIFY ||
      process.env.CF_PAGES,
  );
}
