/**
 * Remote (HTTP) MCP server for ScrapeUnblocker, as a Vercel serverless function.
 *
 * Stateless Streamable HTTP: every POST builds a fresh MCP server + transport,
 * handles the one request, and tears down. No session state is kept between
 * requests, which is exactly what a serverless function wants.
 *
 * Auth is dual-mode:
 *   A) Static key ("bring your own key") - for custom connectors:
 *        1. the `key` (or `token`) query parameter -> https://.../mcp?key=YOUR_KEY
 *        2. the `x-scrapeunblocker-key` header
 *        3. a non-JWT `Authorization: Bearer <key>` header
 *   B) OAuth 2.1 (for the claude.ai Connectors Directory): a JWT
 *      `Authorization: Bearer <access_token>` minted by Auth0. We verify it as an
 *      OAuth Resource Server (audience-bound per RFC 8707), read the user's email
 *      claim, and resolve THAT user's ScrapeUnblocker key server-side (the token
 *      is never passed through). OAuth activates only when AUTH0_ISSUER +
 *      MCP_AUDIENCE are set; otherwise the server is static-key only, as before.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ScrapeUnblockerClient } from "scrapeunblocker";
import { oauthConfig, looksLikeJwt, verifyAccessToken, wwwAuthenticate } from "./_lib/oauth.js";
import { emailToKey } from "./_lib/resolveKey.js";

const VERSION = "0.2.0";

const RESOURCE_METADATA_URL =
  process.env.MCP_RESOURCE_METADATA_URL ||
  "https://mcp.scrapeunblocker.com/.well-known/oauth-protected-resource";

type VercelRequest = IncomingMessage & {
  query: Record<string, string | string[]>;
  body?: unknown;
  headers: IncomingMessage["headers"];
};
type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

function firstValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

type AuthOk = { key: string };
type AuthNoAccount = { needsAccount: true; message: string };
type AuthFail = { status: number; error: string; challenge: boolean };

/**
 * Resolve the ScrapeUnblocker key for this request, from a static key (query /
 * header) or an OAuth JWT (verified, then email -> key). `challenge` marks the
 * failures where we should emit a WWW-Authenticate header (missing / invalid
 * token), vs a plain authorization failure (valid token, but no key for the
 * account).
 */
async function authenticate(req: VercelRequest): Promise<AuthOk | AuthNoAccount | AuthFail> {
  const q = req.query || {};
  const fromQuery = firstValue(q.key) || firstValue(q.token);
  if (fromQuery) return { key: fromQuery };

  const custom = req.headers["x-scrapeunblocker-key"];
  if (typeof custom === "string" && custom) return { key: custom };

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    // OAuth path: a JWT Bearer token, only when the AS is configured.
    if (token && oauthConfig() && looksLikeJwt(token)) {
      const verified = await verifyAccessToken(token);
      if (!verified) return { status: 401, error: "invalid_token", challenge: true };
      if (!verified.email) {
        return { status: 403, error: "token has no email claim", challenge: false };
      }
      const key = await emailToKey(verified.email);
      if (!key) {
        // Signed in fine, but no ScrapeUnblocker account yet. Let the connection
        // succeed and surface the guidance as a tool result (visible in chat),
        // rather than failing the whole connection with an opaque error.
        return {
          needsAccount: true,
          message:
            "You're signed in, but there is no ScrapeUnblocker account for this email yet. " +
            "Create a free account at https://app.scrapeunblocker.com (same email), then try again.",
        };
      }
      return { key };
    }
    // Back-compat: a non-JWT Bearer is a raw ScrapeUnblocker key.
    if (token) return { key: token };
  }

  return { status: 401, error: "missing token", challenge: true };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a fresh MCP server whose tools use this request's API key. When `apiKey`
 * is null the connection still succeeds (so the connector shows "Connected"), but
 * every tool returns `noAccountMessage` - that's the case where the user signed in
 * via OAuth but has no ScrapeUnblocker account yet. Surfacing it as a tool result
 * means the guidance shows up right in the chat, where the user will see it.
 */
function buildServer(apiKey: string | null, noAccountMessage?: string): McpServer {
  const baseUrl = process.env.SCRAPEUNBLOCKER_BASE_URL || undefined;
  const client = apiKey ? new ScrapeUnblockerClient({ apiKey, baseUrl }) : null;
  const server = new McpServer({ name: "scrapeunblocker", version: VERSION });

  const noAccount = () => ({
    content: [
      {
        type: "text" as const,
        text:
          noAccountMessage ||
          "No ScrapeUnblocker account for this login. Create a free account at " +
            "https://app.scrapeunblocker.com and try again.",
      },
    ],
    isError: true,
  });

  server.registerTool(
    "fetch_html",
    {
      title: "Fetch page HTML",
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "Fetch the fully rendered HTML of any web page through ScrapeUnblocker, " +
        "bypassing anti-bot protection (Cloudflare, DataDome, PerimeterX, Akamai, " +
        "Shape). Use when a normal fetch is blocked (403/429, captcha) or the page " +
        "needs a real browser. Returns raw HTML.",
      inputSchema: {
        url: z.string().url().describe("The absolute URL to fetch (http/https)."),
        proxy_country: z
          .string()
          .length(2)
          .optional()
          .describe("Optional ISO country code to route through, e.g. 'US'."),
        wait_method: z
          .enum(["css", "js"])
          .optional()
          .describe("Optional render-wait: 'css' selector or 'js' expression."),
        wait_value: z
          .string()
          .optional()
          .describe("The selector/expression paired with wait_method."),
        sleep_seconds: z
          .number()
          .positive()
          .optional()
          .describe("Extra seconds to wait after load."),
      },
    },
    async (args) => {
      if (!client) return noAccount();
      try {
        const html = await client.getPageSource(args.url, {
          proxyCountry: args.proxy_country,
          method: args.wait_method,
          value: args.wait_value,
          timeSleep: args.sleep_seconds,
        });
        return { content: [{ type: "text", text: html }] };
      } catch (err) {
        return { content: [{ type: "text", text: errorText(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "fetch_parsed",
    {
      title: "Fetch AI-parsed page data",
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "Fetch a web page and return AI-parsed structured JSON instead of raw HTML " +
        "(product details, article content, listings).",
      inputSchema: {
        url: z.string().url().describe("The absolute URL to fetch and parse."),
        proxy_country: z
          .string()
          .length(2)
          .optional()
          .describe("Optional ISO country code, e.g. 'US'."),
        rules_hint: z
          .string()
          .optional()
          .describe("Optional hint about what to extract."),
      },
    },
    async (args) => {
      if (!client) return noAccount();
      try {
        const parsed = await client.getParsed(args.url, {
          proxyCountry: args.proxy_country,
          rulesHint: args.rules_hint,
        });
        return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: errorText(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "google_search",
    {
      title: "Google search results",
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "Run a Google search through ScrapeUnblocker and return organic results as JSON.",
      inputSchema: {
        keyword: z.string().min(1).describe("The search query."),
        proxy_country: z
          .string()
          .length(2)
          .optional()
          .describe("Optional ISO country code to search from, e.g. 'US'."),
        pages_to_check: z
          .number()
          .int()
          .positive()
          .max(10)
          .optional()
          .describe("How many result pages to collect (default 1)."),
      },
    },
    async (args) => {
      if (!client) return noAccount();
      try {
        const results = await client.serp(args.keyword, {
          proxyCountry: args.proxy_country,
          pagesToCheck: args.pages_to_check,
        });
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: errorText(err) }], isError: true };
      }
    },
  );

  return server;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Basic CORS so browser-based inspectors can reach the endpoint.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-scrapeunblocker-key, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const auth = await authenticate(req);
  let server: McpServer;
  if ("key" in auth) {
    server = buildServer(auth.key);
  } else if ("needsAccount" in auth) {
    // Valid login, no account yet: connect anyway so the tools can return the
    // "create an account" guidance in-chat (see buildServer).
    server = buildServer(null, auth.message);
  } else {
    if (auth.challenge && oauthConfig()) {
      // Only advertise OAuth once the AS is actually configured; otherwise this
      // stays a plain static-key 401 (no WWW-Authenticate) as before, so we never
      // point a client at an empty authorization_servers list.
      res.setHeader("WWW-Authenticate", wwwAuthenticate(RESOURCE_METADATA_URL, auth.error));
    }
    res.status(auth.status).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          `Unauthorized (${auth.error}). Connect via OAuth, or bring your own key: ` +
          "append ?key=YOUR_KEY to the URL or send 'Authorization: Bearer <key>'. " +
          "Get a key at https://app.scrapeunblocker.com",
      },
      id: null,
    });
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error: " + errorText(err) },
        id: null,
      });
    }
  }
}
