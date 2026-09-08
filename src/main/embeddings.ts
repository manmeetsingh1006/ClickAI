import OpenAI from "openai";
import { withRetry } from "./retry";

/** Selectable embedding models (2026-09-08) — previously hardcoded to
 * text-embedding-3-small. Each entry's `dimensions` is informational only
 * (shown in Settings) — OpenAI's embedding endpoint reports its own
 * vector length per response, nothing here assumes a fixed size. Costs
 * and quality are real trade-offs: -3-large is more accurate but ~5x the
 * per-token cost and roughly double the vector size (more storage, and a
 * touch slower per cosineSimilarity call) of -3-small; ada-002 is the
 * legacy model, kept as an option only for users standardizing on it
 * elsewhere, not recommended for a new setup. */
export const EMBEDDING_MODEL_INFO: Record<string, { label: string; description: string }> = {
  "text-embedding-3-small": {
    label: "text-embedding-3-small (default)",
    description: "Good accuracy for the cost — the right default for most documents.",
  },
  "text-embedding-3-large": {
    label: "text-embedding-3-large",
    description: "Higher accuracy, especially for nuanced or technical text. Costs roughly 5x more per token and produces larger vectors.",
  },
  "text-embedding-ada-002": {
    label: "text-embedding-ada-002 (legacy)",
    description: "OpenAI's older embedding model. Only worth picking if you're standardizing on it elsewhere — text-embedding-3-small is better and cheaper for a new setup.",
  },
};

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export function isEmbeddingModel(value: unknown): value is string {
  return typeof value === "string" && value in EMBEDDING_MODEL_INFO;
}

const BATCH_SIZE = 64;

// Shared, dependency-free concurrency limiter (2026-09-07, explicit user
// request: "run several in parallel... could cut this 20-45 minutes down
// to something closer to 5-10 minutes"). Every embedding batch call --
// from every document, even multiple documents uploading at once now
// that addDocumentPaths (main.ts) and the web upload handler
// (server.ts) process files concurrently rather than one-at-a-time --
// draws from this ONE global pool, so the real number of embedding API
// calls in flight at any moment stays capped regardless of how many
// batches or documents are queued up, instead of either running fully
// sequential (slow) or fully unbounded (risking rate limits/429s far
// past whatever the account's real throughput supports). withRetry's
// existing 429/5xx backoff (retry.ts) is the safety net underneath this
// for whatever does slip through.
const EMBEDDING_CONCURRENCY = 5;
let activeEmbeddingCalls = 0;
const embeddingWaitQueue: (() => void)[] = [];

/** Real bug found 2026-09-07 (a live user question got stuck on the
 * "thinking" indicator forever, no answer and no error, while a large
 * CSV was still uploading in the background): the FIRST version of this
 * limiter held a slot for the entire withRetry() cycle, backoff sleeps
 * included -- so during a 429's multi-second wait (see retry.ts's
 * extractRetryAfterMs), that slot sat "occupied" doing literally
 * nothing but sleeping, while every OTHER embedding call in the app --
 * including a live question's own one-off query embedding -- queued up
 * behind it with no way to jump ahead. Two fixes:
 *  1. A slot is now acquired ONLY for the duration of the actual network
 *     call (see embedTexts below, which wraps withRetry AROUND
 *     withEmbeddingSlot, not the other way around) -- a retry's backoff
 *     sleep now happens with NO slot held, freeing real concurrency for
 *     everything else waiting during that time.
 *  2. `priority: true` (used for interactive query embedding at ask-time
 *     -- see getRelevantContext in ragStore.ts) jumps to the FRONT of
 *     the wait queue instead of the back, so a live question is served
 *     by the next slot that frees up before any still-queued bulk
 *     upload batches, rather than waiting its turn behind however many
 *     hundred of them happened to queue first.
 */
async function withEmbeddingSlot<T>(fn: () => Promise<T>, priority = false): Promise<T> {
  if (activeEmbeddingCalls >= EMBEDDING_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      if (priority) embeddingWaitQueue.unshift(resolve);
      else embeddingWaitQueue.push(resolve);
    });
  }
  activeEmbeddingCalls++;
  try {
    return await fn();
  } finally {
    activeEmbeddingCalls--;
    const next = embeddingWaitQueue.shift();
    if (next) next();
  }
}

export async function embedTexts(
  client: OpenAI,
  texts: string[],
  model: string = DEFAULT_EMBEDDING_MODEL,
  /** True for a live question's own query embedding (a single short
   * call an actual person is waiting on) -- false (default) for bulk
   * document-upload chunk embedding, which can and should wait behind
   * nothing. See withEmbeddingSlot's comment above for why this exists. */
  priority = false
): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  // Batches run concurrently (through the shared slot pool above) instead
  // of strictly one after another -- a document with hundreds of batches
  // now finishes in a fraction of the previous wall-clock time. Retry-
  // wrapped per batch, same as before: a transient network blip or rate
  // limit on one batch shouldn't surface as a raw error if a couple of
  // quick retries would succeed. withRetry wraps AROUND withEmbeddingSlot
  // (not the reverse) so a slot is only held for the actual network call
  // on each attempt, never for the backoff sleep between attempts.
  const batchResults = await Promise.all(
    batches.map((batch, batchIndex) =>
      withRetry(
        () => withEmbeddingSlot(() => client.embeddings.create({ model, input: batch }), priority),
        // Rate limits here are expected and self-clearing (2026-09-07,
        // real user case: a large CSV's bulk embedding run legitimately
        // exceeds a per-minute TPM budget partway through) -- retries
        // bumped from the default 2 to 6, since retry.ts now waits out
        // the API's own suggested delay for a 429 rather than guessing,
        // so extra attempts here are patient, not wasteful.
        { retries: 6 }
      ).then((response) => ({ batchIndex, vectors: response.data.map((item) => item.embedding) }))
    )
  );

  // Concurrent batches can complete out of order -- sort back into the
  // original batch order before flattening, since every caller relies on
  // vectors[i] lining up positionally with texts[i] (chunk pieces, or
  // sentences for semantic-strategy grouping).
  batchResults.sort((a, b) => a.batchIndex - b.batchIndex);
  const vectors: number[][] = [];
  for (const { vectors: v } of batchResults) vectors.push(...v);
  return vectors;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
