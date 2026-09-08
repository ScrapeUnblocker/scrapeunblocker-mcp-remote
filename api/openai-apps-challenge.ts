/**
 * OpenAI ChatGPT App Directory domain-verification challenge.
 *
 * The submission portal (platform.openai.com/plugins) verifies that we control
 * the MCP host by fetching this well-known URL and matching the token it shows
 * in the "Domain verification" step:
 *   https://mcp.scrapeunblocker.com/.well-known/openai-apps-challenge
 * Served here via a rewrite in vercel.json. The token is a public verification
 * value (like a DNS TXT record), not a secret. Override with the
 * OPENAI_APPS_CHALLENGE env var if the portal ever issues a new token.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

type Req = IncomingMessage;
type Res = ServerResponse & {
  status: (code: number) => Res;
  send: (body: string) => void;
};

const CHALLENGE_TOKEN =
  process.env.OPENAI_APPS_CHALLENGE || "fOO4xRXLz_Pa4um6-ZXTQ_BnhFjmJNJqo8tu-2k_z0U";

export default function handler(req: Req, res: Res): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  res.status(200).send(CHALLENGE_TOKEN);
}
