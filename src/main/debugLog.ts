import * as fs from "fs";
import * as path from "path";
import { configDir } from "./store";

/**
 * Logging/debug system (2026-09-08, explicit user request: "make logging
 * n debug system to check how its perform"). File-only by design (no UI
 * panel was asked for) — writes to debug-log.jsonl in the same config dir
 * as everything else (settings, eval history, flagged answers).
 *
 * Two entry shapes share one file, discriminated by `type`:
 *  - "perf": one entry per question asked through askDocs(), with a
 *    per-stage latency breakdown (embed / rerank / answer / total),
 *    candidate count, whether reranking actually ran, and the answer's
 *    self-reported confidence.
 *  - "error": one entry per pipeline failure (retrieval, reranking,
 *    answer generation, document upload), tagged with the stage it came
 *    from — a lighter-weight signal than a full perf entry when
 *    something just plain failed rather than ran slow.
 *
 * `getPerfStats()` reads the recent tail of this same file and rolls it
 * up into an at-a-glance health check (avg latency per stage, rerank
 * hit rate, error rate) without needing to read every entry by hand.
 */

/** One retrieved-and-used chunk, attached to the PerfLogEntry for the
 * question it was used to answer (2026-09-07, "log everything, including
 * chunking and which chunk was used" — user explicitly opted into full
 * chunk text in the log, not just metadata, so this carries the whole
 * chunk text rather than a truncated preview). */
export interface ChunkUsedDetail {
  index: number;
  chunkId: string;
  docId: string;
  docName: string;
  page?: number;
  score: number;
  chunkingStrategy: string;
  text: string;
}

export interface PerfLogEntry {
  type: "perf";
  timestamp: string;
  requestId: string;
  question: string;
  docId?: string;
  docName?: string;
  candidateCount: number;
  reranked: boolean;
  confidence: number | null;
  embedMs: number;
  rerankMs: number;
  answerMs: number;
  totalMs: number;
  /** The actual chunks that ended up in context for this answer — empty
   * on the "nothing retrieved" path, since there's nothing to list. */
  chunksUsed: ChunkUsedDetail[];
}

export interface ErrorLogEntry {
  type: "error";
  timestamp: string;
  /** Which pipeline stage failed — "retrieval" | "rerank" | "answer" |
   * "upload" (or another short label at the call site). Not a closed
   * enum since new stages may get instrumented later. */
  stage: string;
  message: string;
  question?: string;
  docId?: string;
  docName?: string;
}

/** One chunk actually created for a document at upload time (2026-09-07)
 * — the full chunking result, not just the chunks that later happen to
 * get retrieved for a question. Carries full chunk text per explicit user
 * choice (same as ChunkUsedDetail). */
export interface ChunkCreatedDetail {
  index: number;
  id: string;
  page?: number;
  charCount: number;
  text: string;
}

/** Logged once per document upload (2026-09-07, "log everything, even
 * chunking and which chunk used") — records which chunking strategy was
 * configured vs. actually resolved to (relevant when "auto" is selected),
 * and the full list of chunks that document was split into. Separate from
 * PerfLogEntry/ChunkUsedDetail, which record chunks at the point they're
 * RETRIEVED for a question — this entry records chunks at the point
 * they're CREATED, regardless of whether any question ever uses them. */
export interface ChunkingLogEntry {
  type: "chunking";
  timestamp: string;
  docId: string;
  docName: string;
  configuredStrategy: string;
  resolvedStrategy: string;
  chunkCount: number;
  sourceTextChars: number;
  chunks: ChunkCreatedDetail[];
}

export type DebugLogEntry = PerfLogEntry | ErrorLogEntry | ChunkingLogEntry;

function debugLogPath(): string {
  return path.join(configDir(), "debug-log.jsonl");
}

// Rolling cap: this file grows once per question asked plus once per
// failure, with no natural cleanup otherwise. Trimmed back to the most
// recent MAX_LOG_ENTRIES_KEPT lines whenever it crosses TRIM_CHECK_BYTES,
// so a long-running install never accumulates an unbounded log file —
// same "checkpointing, but bounded" spirit as eval-results.jsonl, just
// with an actual cap since this one grows on every single question
// rather than only on explicit eval runs.
const MAX_LOG_ENTRIES_KEPT = 500;
const TRIM_CHECK_BYTES = 2 * 1024 * 1024; // 2MB

function trimIfNeeded(): void {
  try {
    const p = debugLogPath();
    const stat = fs.statSync(p);
    if (stat.size < TRIM_CHECK_BYTES) return;
    const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
    if (lines.length <= MAX_LOG_ENTRIES_KEPT) return;
    fs.writeFileSync(p, lines.slice(-MAX_LOG_ENTRIES_KEPT).join("\n") + "\n", "utf-8");
  } catch {
    // Best-effort trim only — never let housekeeping break logging itself.
  }
}

function appendEntry(entry: DebugLogEntry): void {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.appendFileSync(debugLogPath(), JSON.stringify(entry) + "\n", "utf-8");
    trimIfNeeded();
  } catch {
    // Logging must never break the feature it's observing — fail silently,
    // same fail-soft philosophy as the reranker's own fallback path.
  }
}

export function logPerf(entry: Omit<PerfLogEntry, "type" | "timestamp">): void {
  appendEntry({ type: "perf", timestamp: new Date().toISOString(), ...entry });
}

export function logError(entry: Omit<ErrorLogEntry, "type" | "timestamp">): void {
  appendEntry({ type: "error", timestamp: new Date().toISOString(), ...entry });
  // Also surface immediately in the terminal/console, not just on-disk —
  // this is a debugging aid, and a log entry no one looks at until later
  // shouldn't be the ONLY place a failure is visible.
  console.error(`[ClickAI][${entry.stage}]`, entry.message);
}

export function logChunking(entry: Omit<ChunkingLogEntry, "type" | "timestamp">): void {
  appendEntry({ type: "chunking", timestamp: new Date().toISOString(), ...entry });
}

export function getRecentLogs(limit = 100): DebugLogEntry[] {
  try {
    const raw = fs.readFileSync(debugLogPath(), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as DebugLogEntry);
    return entries.slice(-limit).reverse(); // most recent first
  } catch {
    return [];
  }
}

export interface PerfStats {
  windowSize: number;
  perfCount: number;
  errorCount: number;
  /** errors / (perfCount + errorCount) over the window — 0 when the
   * window is empty, not null, so callers can render it directly. */
  errorRate: number;
  avgEmbedMs: number | null;
  avgRerankMs: number | null;
  avgAnswerMs: number | null;
  avgTotalMs: number | null;
  /** Fraction of perf entries where reranking actually ran — null when
   * there are no perf entries in the window at all. */
  rerankRate: number | null;
}

/** Aggregate stats over the last `limit` log entries (perf + error mixed,
 * same window `getRecentLogs` would return) — a quick health check ("is
 * this getting slower / erroring more") without reading per-question
 * detail by hand. */
export function getPerfStats(limit = 50): PerfStats {
  const entries = getRecentLogs(limit);
  const perfEntries = entries.filter((e): e is PerfLogEntry => e.type === "perf");
  const errorEntries = entries.filter((e) => e.type === "error");
  const avg = (nums: number[]): number | null =>
    nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  return {
    windowSize: entries.length,
    perfCount: perfEntries.length,
    errorCount: errorEntries.length,
    errorRate: entries.length ? errorEntries.length / entries.length : 0,
    avgEmbedMs: avg(perfEntries.map((e) => e.embedMs)),
    avgRerankMs: avg(perfEntries.map((e) => e.rerankMs)),
    avgAnswerMs: avg(perfEntries.map((e) => e.answerMs)),
    avgTotalMs: avg(perfEntries.map((e) => e.totalMs)),
    rerankRate: perfEntries.length
      ? perfEntries.filter((e) => e.reranked).length / perfEntries.length
      : null,
  };
}
