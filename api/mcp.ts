/**
 * Remote (HTTP) MCP server for ScrapeUnblocker, as a Vercel serverless function.
 *
 * Stateless Streamable HTTP: every POST builds a fresh MCP server + transport,
 * handles the one request, and tears down. No session state is kept between
 * requests, which is exactly what a serverless function wants.
 *
 * Each user brings their own ScrapeUnblocker API key. It is read, in order, from:
 *   1. the `key` (or `token`) query parameter  -> https://.../mcp?key=YOUR_KEY
 *   2. the `Authorization: Bearer <key>` header
 *   3. the `x-scrapeunblocker-key` header
 * The query-parameter form lets a claude.ai user simply paste a personalised URL.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ScrapeUnblockerClient } from "scrapeunblocker";

const VERSION = "0.1.0";

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

/** Pull the user's API key from query param or header. */
function resolveApiKey(req: VercelRequest): string | undefined {
  const q = req.query || {};
  const fromQuery = firstValue(q.key) || firstValue(q.token);
  if (fromQuery) return fromQuery;

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const custom = req.headers["x-scrapeunblocker-key"];
  if (typeof custom === "string" && custom) return custom;

  return undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build a fresh MCP server whose tools use this request's API key. */
function buildServer(apiKey: string): McpServer {
  const baseUrl = process.env.SCRAPEUNBLOCKER_BASE_URL || undefined;
  const client = new ScrapeUnblockerClient({ apiKey, baseUrl });
  const server = new McpServer({ name: "scrapeunblocker", version: VERSION });

  server.registerTool(
    "fetch_html",
    {
      title: "Fetch page HTML",
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

  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Missing ScrapeUnblocker API key. Append ?key=YOUR_KEY to the URL, or send " +
          "an 'Authorization: Bearer <key>' header. Get a key at https://app.scrapeunblocker.com",
      },
      id: null,
    });
    return;
  }

  const server = buildServer(apiKey);
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
