import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { configDir, store } from "./store";

/**
 * Cross-session processing cache (2026-09-11, spec section 17/18/46 --
 * "one of the most important cost-control mechanisms"; see store.ts's
 * processingCacheEnabled/processingCacheTtlHours for the on/off switch and
 * retention window).
 *
 * ragStore.ts already has an in-SESSION duplicate-document cache (see its
 * addDocument -- docCacheKeys) that reuses chunks/embeddings for the same
 * file content uploaded twice in one still-open session. This module is
 * the cross-session version of that same idea: the same file content
 * uploaded in a DIFFERENT session (a different login, or the same person
 * after logging out and back in) still skips OCR/parsing/chunking/
 * embedding, by persisting the processed result to disk keyed ONLY by a
 * content hash + the processing settings that affect the result.
 *
 * Privacy (spec section 18, "do not use the processing cache as a
 * backdoor to retain user identity or conversation history"): an entry
 * NEVER stores a sessionId, username, original filename, upload
 * timestamp-as-identity, or chat/question history -- only the resolved
 * chunk texts, embeddings, page numbers, and chunking strategy, addressed
 * by a hash of (file content + chunking settings + embedding model).
 * Given the file content back, anyone could reproduce the same hash and
 * get the same cache hit; there is nothing in an entry that identifies
 * WHO uploaded it or WHEN, beyond the coarse createdAt used for TTL
 * expiry below.
 */

export interface CachedChunk {
  text: string;
  embedding: number[];
  embeddingModel: string;
  page?: number;
  chunkingStrategy: string;
}

interface ProcessingCacheEntry {
  chunks: CachedChunk[];
  createdAt: number;
}

function cacheDir(): string {
  return path.join(configDir(), "processing-cache");
}

/** The in-session dedup key in ragStore.ts (content hash + chunking
 * settings + embedding model) is already exactly the right cache-address
 * for this too -- hashed again here purely to get a filesystem-safe,
 * fixed-length filename out of a key that otherwise contains colons. */
function cacheFilePath(cacheKey: string): string {
  const fileHash = createHash("sha256").update(cacheKey).digest("hex");
  return path.join(cacheDir(), `${fileHash}.json`);
}

function ttlMs(): number {
  const hours = store.get("processingCacheTtlHours");
  return (typeof hours === "number" && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

/** Returns the cached chunks for this content+settings key, or null on a
 * miss (never processed before, cache disabled, or the entry expired --
 * an expired entry is deleted here too, so stale files don't just sit
 * around forever between reads). */
export function readProcessingCache(cacheKey: string): CachedChunk[] | null {
  if (store.get("processingCacheEnabled") === false) return null;
  const filePath = cacheFilePath(cacheKey);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const entry: ProcessingCacheEntry = JSON.parse(raw);
    if (Date.now() - entry.createdAt > ttlMs()) {
      fs.unlinkSync(filePath);
      return null;
    }
    return entry.chunks;
  } catch {
    return null; // no entry, or a corrupt/unreadable one -- treat as a plain miss
  }
}

/** Persists this content+settings key's processed chunks for reuse by a
 * later session. Best-effort: a write failure (disk full, permissions)
 * never breaks the upload itself -- the caller already has its result in
 * memory regardless of whether this succeeds. */
export function writeProcessingCache(cacheKey: string, chunks: CachedChunk[]): void {
  if (store.get("processingCacheEnabled") === false) return;
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const entry: ProcessingCacheEntry = { chunks, createdAt: Date.now() };
    fs.writeFileSync(cacheFilePath(cacheKey), JSON.stringify(entry), "utf-8");
  } catch {
    // best-effort cache -- silently skip on any filesystem error
  }
}

/** Sweeps expired entries out of the cache directory (2026-09-11) -- run
 * once at process startup (see ragStore.ts's module-level call below) so
 * disk usage stays bounded by the TTL even for content that's never
 * re-requested (readProcessingCache's own expiry check only fires on a
 * read, so an entry nobody ever asks for again would otherwise sit on
 * disk forever). Best-effort and silent, same as writeProcessingCache. */
export function sweepExpiredProcessingCache(): void {
  try {
    const dir = cacheDir();
    const ttl = ttlMs();
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name);
      try {
        const entry: ProcessingCacheEntry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (now - entry.createdAt > ttl) fs.unlinkSync(filePath);
      } catch {
        // an unreadable/corrupt entry is also worth clearing out
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // cache dir doesn't exist yet, or isn't readable -- nothing to sweep
  }
}
