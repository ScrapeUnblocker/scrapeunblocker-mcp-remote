# ScrapeUnblocker remote MCP server

A hosted (HTTP) [Model Context Protocol](https://modelcontextprotocol.io) server for
[ScrapeUnblocker](https://scrapeunblocker.com?utm_source=mcp&utm_medium=integration&utm_campaign=mcp-remote), deployed as a Vercel serverless
function. It lets **claude.ai** (web and mobile), Claude Desktop, Claude Code, and any
other MCP client fetch any web page's HTML - or AI-parsed JSON, or Google results -
through ScrapeUnblocker's anti-bot API, billed to your own account.

> Prefer a local install with no hosting? Use the stdio package instead:
> [`scrapeunblocker-mcp`](https://www.npmjs.com/package/scrapeunblocker-mcp).

## Endpoint

```
https://mcp.scrapeunblocker.com/mcp
```

You need a ScrapeUnblocker account - [create a free one](https://app.scrapeunblocker.com?utm_source=mcp&utm_medium=integration&utm_campaign=mcp-remote).
There are two ways to authenticate, and **you only need one of them**.

**A. Sign in with OAuth (recommended)** - nothing to copy or paste. The server is an
OAuth 2.1 Resource Server backed by Auth0, so the client runs a standard PKCE flow, and
the server resolves your ScrapeUnblocker key server-side from the account you signed in
with (the token is never passed through to the backend, per RFC 8707).

If your client asks for an OAuth client ID, use the public one - it is a PKCE client,
so it carries no secret and is safe to share:

```
5BM5Wk2dE4ABkDITmuKfemPLnn3QQ8jd
```

Leave the client secret field empty.

**B. Bring your own API key** - handy for scripts and clients without an OAuth flow.
Supply the key any of three ways:

1. `?key=YOUR_KEY` (or `?token=YOUR_KEY`) in the URL.
2. `Authorization: Bearer YOUR_KEY` header (a non-JWT value).
3. `x-scrapeunblocker-key: YOUR_KEY` header.

Listing the tools (`initialize`, `tools/list`) needs no credentials at all, so MCP
directories and inspectors can introspect the server; actually running a tool does.

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
2. **URL:** `https://mcp.scrapeunblocker.com/mcp`
3. Under **Advanced settings**, set **OAuth Client ID** to `5BM5Wk2dE4ABkDITmuKfemPLnn3QQ8jd`
   and leave **OAuth Client Secret** empty.
4. **Add**, then sign in and **Authorize**. The tools appear across claude.ai web,
   mobile, and Claude Desktop.

Or skip OAuth entirely and paste a personalised URL instead:
`https://mcp.scrapeunblocker.com/mcp?key=YOUR_API_KEY`

## Add it to Claude Code

```bash
claude mcp add --transport http scrapeunblocker "https://mcp.scrapeunblocker.com/mcp?key=YOUR_API_KEY"
```

## Tools

| Tool | What it does |
|------|--------------|
| `fetch_html` | Fetch the fully rendered HTML of a URL. Optionally pass `steps` to interact with the page (search, click, type, paginate) in a real browser before capture. |
| `fetch_parsed` | Fetch a page and return AI-parsed structured JSON. |
| `google_search` | Run a Google search and return organic results as JSON. |
| `list_elements` | Return a page's interactive elements (buttons, inputs, selects, links, forms) with ready-to-use selectors, as JSON, to build `steps`. |

### Interacting with a page (`steps`)

`fetch_html` accepts an optional `steps` array - an ordered list of browser
actions run in a real browser **after** the page loads, before the HTML is
captured. Supported actions: `wait_for`, `wait_for_text`, `wait`, `click`,
`type` (human-like keystrokes), `select`, `press_key`, `scroll`. A typical flow
is: call `list_elements` to discover selectors, then call `fetch_html` with
`steps` to drive the page.

Steps are **non-idempotent** - the request runs once and is not retried. If a
step fails (bad selector, element never appeared), the tool returns an HTTP 422
result naming the offending step (`step_index`, `action`, `reason`, `selector`)
plus the page HTML at the point of failure, so you can correct the step.

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
