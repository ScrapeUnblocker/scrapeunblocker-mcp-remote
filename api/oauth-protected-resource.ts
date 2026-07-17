/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata for the MCP server.
 *
 * Claude fetches this (either from the `WWW-Authenticate: ... resource_metadata`
 * hint on our 401, or the well-known URI directly) to learn which Authorization
 * Server to use. Served at both:
 *   /.well-known/oauth-protected-resource
 *   /.well-known/oauth-protected-resource/mcp   (path-aware form)
 * via rewrites in vercel.json.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

type Req = IncomingMessage;
type Res = ServerResponse & {
  status: (code: number) => Res;
  json: (body: unknown) => void;
};

export default function handler(req: Req, res: Res): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const resource = process.env.MCP_AUDIENCE || "https://mcp.scrapeunblocker.com/mcp";
  const issuer = process.env.AUTH0_ISSUER;

  res.status(200).json({
    resource,
    authorization_servers: issuer ? [issuer] : [],
    scopes_supported: ["mcp:use"],
    bearer_methods_supported: ["header"],
  });
}
