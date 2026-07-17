/**
 * Resolve an authenticated user's email to their ScrapeUnblocker API key via the
 * utils-api `admin_metrics` Lambda (action `email_to_key`), SigV4-signed exactly
 * like the user-portal does (aws4, service `execute-api`).
 *
 * This is the token -> key mapping the MCP spec demands: the Auth0 token we
 * accept from Claude is NOT passed through to our backend; instead we look up the
 * user's own key server-side and it never leaves our infrastructure.
 */
import aws4 from "aws4";
import https from "node:https";

interface EmailToKeyResponse {
  api_key?: string;
}

export async function emailToKey(email: string): Promise<string | null> {
  const baseUrl = process.env.UTILS_API_BASE_URL || "https://utils-api.scrapeunblocker.com";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";
  const sessionToken = process.env.AWS_SESSION_TOKEN || undefined;
  const region = process.env.AWS_REGION || "eu-central-1";
  if (!email || !accessKeyId || !secretAccessKey) return null;

  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/admin_metrics`);
  const body = JSON.stringify({ action: "email_to_key", email });

  const signOpts: aws4.Request = {
    host: url.hostname,
    method: "POST",
    path: url.pathname + url.search,
    service: "execute-api",
    region,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body).toString(),
    },
    body,
  };
  aws4.sign(signOpts, { accessKeyId, secretAccessKey, sessionToken });

  return new Promise<string | null>((resolve) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        method: "POST",
        path: url.pathname + url.search,
        headers: signOpts.headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            let parsed: unknown = JSON.parse(data);
            // Lambda proxy format: { statusCode, body: "json-string" }
            if (
              parsed &&
              typeof parsed === "object" &&
              "statusCode" in parsed &&
              "body" in parsed
            ) {
              const lp = parsed as { statusCode: number; body: unknown };
              let inner: unknown = lp.body;
              if (typeof inner === "string") {
                try {
                  inner = JSON.parse(inner);
                } catch {
                  /* leave as string */
                }
              }
              if (lp.statusCode >= 200 && lp.statusCode < 300) {
                const key = (inner as EmailToKeyResponse)?.api_key;
                return resolve(typeof key === "string" && key ? key : null);
              }
              return resolve(null);
            }
            const key = (parsed as EmailToKeyResponse)?.api_key;
            resolve(typeof key === "string" && key ? key : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.end(body);
  });
}
