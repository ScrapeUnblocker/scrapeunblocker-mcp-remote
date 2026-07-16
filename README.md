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

Get your key at https://app.scrapeunblocker.com. The key can be supplied three ways:

1. `?key=YOUR_KEY` (or `?token=YOUR_KEY`) in the URL - simplest for claude.ai.
2. `Authorization: Bearer YOUR_KEY` header.
3. `x-scrapeunblocker-key: YOUR_KEY` header.

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
