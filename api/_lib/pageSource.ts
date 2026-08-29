/**
 * Raw `/getPageSource` call for the two capabilities the `scrapeunblocker` npm
 * client does not (yet) model: browser `steps` and `list_elements`.
 *
 * The typed client's `getPageSource` hard-codes its query params and always
 * returns `.text()`, throwing a generic error on any non-2xx. Both new modes
 * need more than that: `steps` can come back as a structured **422**
 * (`step_failed` / `invalid_steps`) whose JSON body we must hand back verbatim,
 * and `list_elements` returns JSON, not HTML. So we make the request directly
 * here, mirroring the client's transport (POST, `x-scrapeunblocker-key` header,
 * same default host) but surfacing the raw status + body untouched.
 *
 * No automatic retries: a `steps` request is non-idempotent (it clicks, types,
 * submits), so replaying it silently would be wrong.
 */

const DEFAULT_BASE_URL = "https://api.scrapeunblocker.com";
const API_KEY_HEADER = "x-scrapeunblocker-key";
const REQUEST_TIMEOUT_MS = 58_000; // just under the Vercel function maxDuration

export type RawParams = Record<string, string | number | boolean | undefined | null>;

export interface RawResponse {
  status: number;
  ok: boolean;
  contentType: string;
  text: string;
}

function buildQuery(params: RawParams): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) q.append(key, String(value));
  }
  return q.toString();
}

/** POST `/getPageSource` with arbitrary query params and return the raw result. */
export async function rawGetPageSource(
  apiKey: string,
  baseUrl: string | undefined,
  params: RawParams,
): Promise<RawResponse> {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/getPageSource?${buildQuery(params)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      [API_KEY_HEADER]: apiKey,
      "User-Agent": "scrapeunblocker-mcp-remote",
      Accept: "*/*",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") || "",
    text,
  };
}

/**
 * Turn a `steps` 422 body into a readable, structured message. The API returns
 * `{error:"step_failed", step_index, action, reason, selector?, value?, html}`
 * for a run-time failure, or `{error:"invalid_steps", detail, step_index?}` for
 * a validation failure. We keep the machine-readable JSON but lead with a plain
 * sentence so the model sees exactly which step to fix.
 */
export function formatStepFailure(body: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(body);
    if (j && typeof j === "object") parsed = j as Record<string, unknown>;
  } catch {
    // not JSON - fall through and return the raw body below
  }
  if (!parsed) return `Steps failed (HTTP 422): ${body}`;

  const kind = parsed.error;
  let headline: string;
  if (kind === "step_failed") {
    const idx = parsed.step_index;
    const action = parsed.action;
    const reason = parsed.reason;
    const selector = parsed.selector;
    headline =
      `Browser step ${idx} ("${action}") failed: ${reason}` +
      (selector ? ` (selector: ${selector})` : "") +
      ". Fix that step and retry - steps are not replayed automatically.";
  } else if (kind === "invalid_steps") {
    const idx = parsed.step_index;
    headline =
      `Invalid steps: ${parsed.detail}` +
      (idx !== undefined && idx !== null ? ` (step ${idx})` : "") +
      ".";
  } else {
    headline = "Steps failed (HTTP 422).";
  }
  return `${headline}\n\n${JSON.stringify(parsed, null, 2)}`;
}
