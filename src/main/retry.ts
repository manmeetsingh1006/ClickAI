/**
 * Small retry-with-backoff helper for transient OpenAI API failures
 * (network blips, 429 rate limits, 5xx server errors). Added 2026-09-01 in
 * response to the user asking for better error resilience — right now a
 * transient failure just surfaces the raw error to the user with no retry
 * at all.
 *
 * Deliberately narrow about what counts as "retryable": a bad API key
 * (401), a bad request (400, e.g. an unsupported file sent to the wrong
 * endpoint), or any other 4xx should fail immediately and clearly rather
 * than silently retrying something that will never succeed — retrying
 * those just delays a clear error message for no benefit.
 */

/** Default per-request timeout for OpenAI API calls (2026-09-03). The SDK's
 * own default is 10 minutes, which means a genuinely stuck request (not an
 * error, just hung) sits silently with no feedback for far longer than any
 * user would wait — this caps it so a stuck call fails visibly and can be
 * retried/regenerated instead.
 *
 * Set to 2 minutes rather than something tighter: this same client/timeout
 * is shared by the streamed answer call in openai.ts, and the SDK's
 * timeout is a hard wall-clock abort (via AbortController) that does NOT
 * reset as chunks stream in — so too short a value could cut off a long,
 * still-actively-streaming answer from a reasoning model, not just a truly
 * stuck request. 2 minutes comfortably covers a normal answer while still
 * being 5x tighter than the SDK default. The reranker uses its own
 * shorter RERANK_TIMEOUT_MS override instead, since it's a background
 * step, not something the user watches stream in. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 120_000;

interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  /** Called before each retry with the attempt number (1-based) and the
   * error that triggered it, e.g. to surface a status message to the user. */
  onRetry?: (attempt: number, err: any) => void;
}

function getStatus(err: any): number | undefined {
  return err?.status ?? err?.response?.status ?? err?.statusCode;
}

/** Pulls a rate-limit's own "wait this long" hint out of a 429 error,
 * rather than guessing blind with exponential backoff (2026-09-07, real
 * user case: embedding a 397,570-row CSV hit "429 Rate limit reached...
 * on tokens per min (TPM): Limit 1000000, Used 995032, Requested 15281.
 * Please try again in 618ms" — a bulk embedding job for a large file
 * can genuinely exhaust a per-minute TPM budget partway through, which
 * isn't a bug, just real throughput math (a 37MB file needs far more
 * tokens than a 1M/min ceiling allows in one window) -- the fix is
 * waiting out what the API itself says to wait, not retrying too fast
 * or giving up too soon). Tries the SDK's parsed headers first
 * (retry-after-ms, then retry-after in seconds), then falls back to
 * parsing the exact wording OpenAI's error message uses ("try again in
 * 618ms" / "try again in 1.2s"), since the header isn't always present
 * on every account/error shape. Returns null (caller falls back to
 * exponential backoff) if neither is found. */
function extractRetryAfterMs(err: any): number | null {
  const headers = err?.headers;
  if (headers && typeof headers.get === "function") {
    const msHeader = headers.get("retry-after-ms");
    if (msHeader) {
      const ms = parseFloat(msHeader);
      if (!isNaN(ms)) return ms;
    }
    const secHeader = headers.get("retry-after");
    if (secHeader) {
      const sec = parseFloat(secHeader);
      if (!isNaN(sec)) return sec * 1000;
    }
  }
  const msg = err?.message || err?.error?.message || "";
  const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(msg);
  if (match) {
    const value = parseFloat(match[1]);
    if (!isNaN(value)) return match[2].toLowerCase() === "s" ? value * 1000 : value;
  }
  return null;
}

/** Whether an error looks like a transient/retryable failure: a rate limit
 * (429), a server error (5xx), or a network-level failure with no HTTP
 * status at all (timeout, connection reset, DNS blip). Anything else
 * (401 bad key, 400 bad request, 404, etc.) is treated as permanent. */
function isRetryable(err: any): boolean {
  const status = getStatus(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  if (status === undefined) {
    // No HTTP status at all usually means the request never reached the
    // server — a network-level failure, which is exactly the transient
    // case worth retrying.
    const code = err?.code || err?.cause?.code;
    if (code && typeof code === "string") {
      return ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code);
    }
    // Unknown shape with no status — err on the side of one retry rather
    // than assuming it's permanent.
    return true;
  }
  return false;
}

/** Runs `fn`, retrying up to `retries` times (default 2, so 3 attempts
 * total) with exponential backoff (default base 500ms: ~500ms, ~1000ms)
 * plus a little jitter, but only for errors that look transient. A
 * permanent-looking error (bad API key, bad request) is thrown on the
 * first attempt with no delay. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 500;

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) {
        throw err;
      }
      opts.onRetry?.(attempt + 1, err);
      const status = getStatus(err);
      let delay: number;
      if (status === 429) {
        // Rate limits tell you almost exactly how long to wait -- use
        // that instead of blind exponential backoff, capped at 65s as a
        // sanity ceiling (TPM windows reset every 60s, so a real wait
        // should never need to be much longer than that).
        const suggested = extractRetryAfterMs(err);
        delay = Math.min(suggested ?? baseDelayMs * Math.pow(2, attempt), 65_000) + Math.floor(Math.random() * 150);
      } else {
        delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable, but keeps TypeScript happy about the return type.
  throw lastErr;
}
