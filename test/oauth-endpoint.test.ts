// /mcp answers discovery calls without credentials; /mcp/oauth (rewritten by
// vercel.json to /api/mcp?auth=oauth) challenges them, so a client that starts
// its OAuth flow only on a 401 (Cursor with a static client ID) signs in.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import handler from "../api/mcp.js";

process.env.AUTH0_ISSUER = "https://login.example/";
process.env.MCP_AUDIENCE = "https://mcp.example/mcp";

let mcp: Server;
let base: string;

async function vercel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const vreq = Object.assign(req, {
    query: Object.fromEntries(url.searchParams),
    body: raw ? JSON.parse(raw) : undefined,
  });
  const vres = Object.assign(res, {
    status(code: number) {
      res.statusCode = code;
      return vres;
    },
    json(body: unknown) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    },
  });
  await handler(vreq, vres);
}

before(async () => {
  mcp = createServer((req, res) => void vercel(req, res));
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
});

after(async () => {
  mcp.closeAllConnections();
  await new Promise((resolve) => mcp.close(resolve));
});

function initialize(path: string): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
}

test("/mcp answers initialize without credentials", async () => {
  const res = await initialize("/mcp");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("www-authenticate"), null);
});

test("/mcp/oauth challenges initialize without credentials", async () => {
  const res = await initialize("/mcp?auth=oauth");
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer resource_metadata="https:\/\/[^"]+\/\.well-known\/oauth-protected-resource"/);
  assert.match(challenge, /scope="mcp:use"/);
});

test("/mcp/oauth still accepts a static key", async () => {
  const res = await initialize("/mcp?auth=oauth&key=test-key");
  assert.equal(res.status, 200);
});
