// capture_xhr end to end: the Vercel function (api/mcp.ts) serves MCP over HTTP,
// with a ?key= like a custom connector, against a local stand-in for the
// ScrapeUnblocker API that records every request.

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import handler from "../api/mcp.js";

const CAPTURED = {
  html: "<html>" + "x".repeat(5000) + "</html>",
  xhr: [
    { url: "https://api.shop.example/v2/items?page=1", method: "GET", status: 200,
      content_type: "application/json", body: '{"items":[1,2]}' },
    { url: "https://api.shop.example/v2/items?page=2", method: "GET", status: 403,
      content_type: "text/plain", body: null, body_omitted: "binary" },
  ],
  xhr_truncated: false,
  proxy: "us",
};
const STEP_FAILED = {
  error: "step_failed", step_index: 1, action: "click", reason: "selector not found",
  selector: "#more", html: "<html/>", xhr: [CAPTURED.xhr[0]],
};

let requests: Record<string, string>[] = [];
let api: Server;
let mcp: Server;
let client: Client;

function answer(req: IncomingMessage, res: ServerResponse): void {
  const query = Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams);
  requests.push(query);
  if (query.url === "https://shop.example/fail") {
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify(STEP_FAILED));
  } else if (query.url === "https://shop.example/none") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...CAPTURED, xhr: [] }));
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CAPTURED));
  }
}

/** The request and response helpers the Vercel Node runtime adds. */
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

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name: "capture_xhr", arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text).join(""), isError: Boolean(result.isError) };
}

before(async () => {
  api = createServer(answer);
  process.env.SCRAPEUNBLOCKER_BASE_URL = `http://127.0.0.1:${await listen(api)}`;
  mcp = createServer((req, res) => void vercel(req, res));
  const port = await listen(mcp);
  client = new Client({ name: "capture-xhr-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?key=test-key`)),
  );
});

after(async () => {
  await client?.close();
  mcp.closeAllConnections();
  await new Promise((resolve) => mcp.close(resolve));
  await new Promise((resolve) => api.close(resolve));
});

beforeEach(() => {
  requests = [];
});

test("capture_xhr sends the fragment and steps, and returns the calls without the HTML", async () => {
  const steps = [{ action: "click", selector: "#more" }];
  const result = await call({
    url: "https://shop.example/search",
    capture_xhr: "/v2/items",
    steps,
    proxy_country: "US",
  });
  const sent = requests.find((r) => r.capture_xhr);
  assert.ok(sent);
  assert.equal(sent.capture_xhr, "/v2/items");
  assert.equal(sent.proxy_country, "US");
  assert.deepEqual(JSON.parse(sent.steps), steps);
  assert.equal(result.isError, false);
  assert.match(result.text, /Captured 2 call\(s\) matching "\/v2\/items", served from US\./);
  assert.match(result.text, /\[0\] 200 GET https:\/\/api\.shop\.example\/v2\/items\?page=1 \(application\/json\)\n\{"items":\[1,2\]\}/);
  assert.match(result.text, /\[1\] 403 GET .*\n\(no body: binary\)/);
  assert.ok(!result.text.includes("xxxxx"), "the page HTML is not returned");
});

test("capture_xhr says when nothing matched and sends no steps without them", async () => {
  const result = await call({ url: "https://shop.example/none", capture_xhr: "/v2/items" });
  assert.equal(requests.find((r) => r.capture_xhr)?.steps, undefined);
  assert.equal(result.isError, false);
  assert.match(result.text, /No XHR\/fetch call matched/);
});

test("capture_xhr reports a failed step with the calls made before it", async () => {
  const result = await call({
    url: "https://shop.example/fail",
    capture_xhr: "/v2/items",
    steps: [{ action: "click", selector: "#more" }],
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /Browser step 1 \("click"\) failed: selector not found/);
  assert.match(result.text, /Calls the page made before the step failed:\n\n\[0\] 200 GET/);
});

test("capture_xhr caps the text at max_chars", async () => {
  const result = await call({ url: "https://shop.example/search", capture_xhr: "/v2", max_chars: 40 });
  assert.match(result.text, /\[Cut at 40 of \d+ characters\./);
});
