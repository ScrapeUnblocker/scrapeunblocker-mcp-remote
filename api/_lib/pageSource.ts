/**
 * Raw `/getPageSource` calls for what the `scrapeunblocker` npm client does not
 * (yet) model: browser `steps`, `list_elements` and `markdown`.
 *
 * The typed client's `getPageSource` hard-codes its query params and always
 * returns `.text()`, throwing a generic error on any non-2xx. `steps` and
 * `list_elements` need more than that: `steps` can come back as a structured
 * **422** (`step_failed` / `invalid_steps`) whose JSON body we must hand back
 * verbatim, and `list_elements` returns JSON, not HTML. So `rawGetPageSource`
 * makes the request directly, mirroring the client's transport (POST,
 * `x-scrapeunblocker-key` header, same default host) but surfacing the raw
 * status + body untouched.
 *
 * No automatic retries there: a `steps` request is non-idempotent (it clicks,
 * types, submits), so replaying it silently would be wrong. `readPageSource`
 * is the read path (`markdown=true`, for fetch_markdown and search_and_read):
 * it returns the body and retries like the client.
 */

import { errorForStatus } from "scrapeunblocker";

const DEFAULT_BASE_URL = "https://api.scrapeunblocker.com";
const API_KEY_HEADER = "x-scrapeunblocker-key";
const REQUEST_TIMEOUT_MS = 58_000; // rawGetPageSource; must stay under maxDuration in vercel.json

export type RawParams = Record<string, string | number | boolean | undefined | null>;

export interface RawResponse {
  status: number;
  ok: boolean;
  contentType: string;
  text: string;
  originStatus: string | null;
}

function buildQuery(params: RawParams): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) q.append(key, String(value));
  }
  return q.toString();
}

function pageSourceUrl(baseUrl: string | undefined, params: RawParams): string {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/getPageSource?${buildQuery(params)}`;
}

function requestHeaders(apiKey: string): Record<string, string> {
  return {
    [API_KEY_HEADER]: apiKey,
    "User-Agent": "scrapeunblocker-mcp-remote",
    Accept: "*/*",
  };
}

/** POST `/getPageSource` with arbitrary query params and return the raw result. */
export async function rawGetPageSource(
  apiKey: string,
  baseUrl: string | undefined,
  params: RawParams,
): Promise<RawResponse> {
  const response = await fetch(pageSourceUrl(baseUrl, params), {
    method: "POST",
    headers: requestHeaders(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") || "",
    text,
    originStatus: response.headers.get("x-origin-status"),
  };
}

/** The SDK client's defaults, so a page read as Markdown gets fetch_html's patience. */
const READ_TIMEOUT_MS = 180_000;
const READ_RETRIES = 2;
/** Busy (429) and gateway (502-504) answers: a later attempt can succeed. */
const RETRYABLE = new Set([429, 502, 503, 504]);

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 8_000)));
}

/**
 * POST `/getPageSource` for a read (fetch_markdown, search_and_read) and
 * return the body. Unlike `rawGetPageSource` this is safe to repeat, so its
 * transport and errors follow the SDK client: busy and gateway answers and
 * dropped connections are retried, and a failed call throws the SDK's typed
 * error, so a target's own 404/410 reaches `errorResult` as the APIError it
 * handles.
 */
export async function readPageSource(
  apiKey: string,
  baseUrl: string | undefined,
  params: RawParams,
): Promise<string> {
  const url = pageSourceUrl(baseUrl, params);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders(apiKey),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`No answer from ScrapeUnblocker within ${READ_TIMEOUT_MS / 1000} s.`);
      }
      if (attempt >= READ_RETRIES) {
        throw new Error(`Could not reach ScrapeUnblocker: ${err instanceof Error ? err.message : String(err)}`);
      }
      await backoff(attempt);
      continue;
    }
    if (RETRYABLE.has(response.status) && attempt < READ_RETRIES) {
      await response.body?.cancel();
      await backoff(attempt);
      continue;
    }
    const body = await response.text();
    if (!response.ok) throw errorForStatus(response.status, body, response.headers);
    return body;
  }
}

const TARGET_GONE = new Set([404, 410]);

/**
 * The target's own "page does not exist" answer (404/410), or null.
 *
 * `/getPageSource` always exists, so a 404/410 from it is the target site's
 * answer, sent with `X-Origin-Status`. Older API versions returned that same
 * answer as a 200 carrying the header, so the header is checked first.
 */
export function targetGoneStatus(status: number, originStatus?: string | null): number | null {
  const origin = Number(originStatus);
  if (TARGET_GONE.has(origin)) return origin;
  return TARGET_GONE.has(status) ? status : null;
}

/**
 * The rendered page when `parsed_data` found nothing to extract, or null.
 * The API still answers 200 (billed like fetch_html) with
 * `data_extracted: false` and the page in `html`.
 */
export function noDataExtractedHtml(raw: Record<string, unknown> | undefined): string | null {
  if (!raw || raw.data_extracted !== false) return null;
  return typeof raw.html === "string" ? raw.html : "";
}

export function noDataExtractedText(url: string, html: string): string {
  const head =
    `No structured data could be extracted from ${url}: the page loaded, but ` +
    "nothing on it matched a structured shape. The call was billed like fetch_html, " +
    "so the rendered page is returned instead.";
  return html.trim() ? `${head}\n\nThe rendered HTML follows:\n\n${html}` : head;
}

/**
 * Tool text for a target that answered 404/410. It is a result, not a tool
 * failure: the page was fetched and the call billed, and a retry returns the
 * same answer - so the model must not read it as an API error to retry.
 */
export function targetGoneText(url: string, code: number, page: string): string {
  const reason = code === 410 ? "Gone" : "Not Found";
  const head =
    `The target page does not exist: ${url} answered HTTP ${code} (${reason}). ` +
    "This is the website's own answer, not a block or an API failure. The call " +
    "was billed, and retrying returns the same result - check the URL instead.";
  return page.trim()
    ? `${head}\n\nThe target's own ${code} page follows:\n\n${page}`
    : `${head}\n\nThe target sent no page body.`;
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
