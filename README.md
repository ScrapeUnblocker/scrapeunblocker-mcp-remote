# ScrapeUnblocker remote MCP server

A hosted (HTTP) [Model Context Protocol](https://modelcontextprotocol.io) server for
[ScrapeUnblocker](https://scrapeunblocker.com), deployed as a Vercel serverless
function. It lets **claude.ai** (web and mobile), Claude Desktop, Claude Code, and any
other MCP client fetch any web page's HTML - or AI-parsed JSON, or Google results -
through ScrapeUnblocker's anti-bot API, using **your own API key**.

> Prefer a local install with no hosting? Use the stdio package instead:
> [`scrapeunblocker-mcp`](https://www.npmjs.com/package/scrapeunblocker-mcp).

## Endpoint

```
https://mcp.scrapeunblocker.com/mcp?key=YOUR_API_KEY
```

Get your key at https://app.scrapeunblocker.com. Auth is dual-mode:

**A. Bring your own key** (custom connector) - the key can be supplied three ways:

1. `?key=YOUR_KEY` (or `?token=YOUR_KEY`) in the URL - simplest for claude.ai.
2. `Authorization: Bearer YOUR_KEY` header (a non-JWT value).
3. `x-scrapeunblocker-key: YOUR_KEY` header.

**B. OAuth 2.1** (for the claude.ai Connectors Directory) - the server is an OAuth
Resource Server (MCP auth spec rev 2025-11-25) backed by Auth0 as the Authorization
Server. Claude runs the OAuth flow, sends an Auth0 JWT as `Authorization: Bearer`, and
the server resolves that user's ScrapeUnblocker key server-side (the token is never
passed through to the backend, per RFC 8707). OAuth activates only when the env vars
below are set; without them the server is static-key only.

### OAuth configuration (maintainers)

| Env var | Purpose |
|---------|---------|
| `AUTH0_ISSUER` | Auth0 issuer URL, e.g. `https://TENANT.auth0.com/` (trailing slash). Enables OAuth together with `MCP_AUDIENCE`. |
| `MCP_AUDIENCE` | Canonical MCP URI = the Auth0 API Identifier, `https://mcp.scrapeunblocker.com/mcp`. The token `aud` must match this. |
| `MCP_EMAIL_CLAIM` | Optional namespaced claim carrying the user's email (set by an Auth0 Post-Login Action), e.g. `https://scrapeunblocker.com/email`. Falls back to the standard `email` claim. |
| `MCP_RESOURCE_METADATA_URL` | Optional override for the RFC 9728 metadata URL advertised in `WWW-Authenticate`. |
| `UTILS_API_BASE_URL` | utils-api base for the `email_to_key` lookup, e.g. `https://utils-api.scrapeunblocker.com`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | IAM creds (SigV4, `execute-api`) for calling utils-api. |

Discovery endpoints served (via `vercel.json` rewrites):
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.

## Add it to claude.ai

1. Settings → Connectors → **Add custom connector**.
2. Paste your personalised URL: `https://mcp.scrapeunblocker.com/mcp?key=YOUR_API_KEY`
3. Save. The tools appear across claude.ai web, mobile, and Claude Desktop.

## Add it to Claude Code

```bash
claude mcp add --transport http scrapeunblocker "https://mcp.scrapeunblocker.com/mcp?key=YOUR_API_KEY"
```

## Tools

| Tool | What it does |
|------|--------------|
| `fetch_html` | Fetch the fully rendered HTML of a URL. |
| `fetch_parsed` | Fetch a page and return AI-parsed structured JSON. |
| `google_search` | Run a Google search and return organic results as JSON. |

## Deploy (maintainers)

This is a standard Vercel project - no build step, the function lives in `api/mcp.ts`.

```bash
vercel            # preview
vercel --prod     # production
```

Then point the `mcp.scrapeunblocker.com` domain at the Vercel project. Scraping calls
can be slow, so the function's `maxDuration` is set to 60s (raise it on a paid Vercel
plan if you hit timeouts on heavy pages).

## License

MIT
