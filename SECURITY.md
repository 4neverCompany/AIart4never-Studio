# Security Policy

## Supported Versions

The following versions of MashupForge receive security updates:

| Version | Supported          |
|---------|--------------------|
| 1.0.x   | ✅ Active          |
| 0.9.x   | ⚠️ Critical fixes only |
| < 0.9   | ❌ End of life     |

The latest tagged release is always the recommended version. The desktop
app auto-updates via Tauri's updater; web users on `main` always get the
latest.

## Reporting a Vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Report privately to: **[security@4nevercompany.com](mailto:security@4nevercompany.com)**

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Impact assessment (your best guess is fine)
- Any known mitigations

We will:
1. Acknowledge within 48 hours
2. Provide an initial assessment within 5 business days
3. Coordinate a fix and disclosure timeline with you
4. Credit you in the release notes (unless you prefer to remain anonymous)

## Scope

In-scope:
- Tauri desktop app (any platform)
- Web app at https://mashup-studio.vercel.app
- Public API routes (e.g. `/api/leonardo/*`, `/api/social/*`, `/api/upload/*`)
- Authentication and authorization for the desktop and web surfaces
- Image generation pipeline (prompt injection, content escaping)
- Scheduled post lifecycle (orphaned metadata, data integrity)
- Tauri auto-update channel integrity (signature verification, update URLs)

Out-of-scope:
- Third-party API keys (Leonardo.ai, OpenAI, etc.) — those are user-managed
- Social platform (Instagram, Twitter) account compromise via those
  platforms' own mechanisms
- Rate limiting or quota issues with upstream image-generation providers

## Security Best Practices for Users

- Use a long-lived Instagram Graph API token, **or** use the in-app
  browser-based credentials flow (recommended). Avoid checking tokens
  into version control.
- The Tauri desktop app stores the Leonardo.ai key in the OS keychain
  (post-v1.0). On older versions, the key is in `.env.local`; treat
  that file as sensitive and do not commit it.
- The Tauri updater verifies release signatures automatically. Do not
  disable updater signature verification.

## Coordinated Disclosure

We follow a 90-day coordinated disclosure timeline by default. If a
vulnerability is severe (active exploitation, data exposure), we may
shorten the timeline and ship an out-of-band fix.

## Recognition

We appreciate responsible disclosure. Reporters are credited in the
release notes unless anonymity is requested.
