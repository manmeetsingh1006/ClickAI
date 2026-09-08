import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import { store } from "./store";
import { extractText, isSupportedDocument } from "./docParsers";
import { embedTexts, cosineSimilarity, DEFAULT_EMBEDDING_MODEL } from "./embeddings";
import { withRetry, DEFAULT_CLIENT_TIMEOUT_MS } from "./retry";
import { ChunkingStrategy, DEFAULT_CHUNKING_STRATEGY, splitProseSegment, chooseAutoStrategy } from "./chunking";
import { logError, logChunking } from "./debugLog";

interface Chunk {
  id: string;
  docId: string;
  docName: string;
  text: string;
  embedding: number[];
  /** Which embedding model produced `embedding` (2026-09-08, selectable
   * embedding models) — recorded per chunk rather than assumed from the
   * CURRENT setting, because a chunk's vector is fixed at upload time and
   * a user can change the setting afterward. Retrieval groups the pool by
   * this field and embeds the query once per distinct model present,
   * rather than comparing vectors from different models as if they were
   * compatible (they usually aren't even the same length). */
  embeddingModel: string;
  /** The PDF page this chunk's text starts on, when known (2026-09-02) —
   * real data from docParsers' page markers, never guessed. undefined for
   * non-paginated formats (DOCX/XLSX/etc.) where there's no reliable page
   * concept to report. */
  page?: number;
  /** Which concrete chunking strategy actually produced this chunk
   * (2026-09-07) — always a resolved concrete strategy, never "auto"
   * itself, since "auto" is resolved to a concrete strategy once per
   * document before any chunk is created. Recorded per chunk (not just
   * per document) so retrieval-time logging can report it directly. */
  chunkingStrategy: string;
}

export interface DocSummary {
  id: string;
  name: string;
  chunkCount: number;
}

export interface RetrievedExcerpt {
  index: number;
  docName: string;
  text: string;
  /** Real PDF page number this excerpt starts on, when known. Omitted
   * (never faked) for formats with no page concept. */
  page?: number;
  /** Added 2026-09-07 (logging system, "which chunk used" detail) — lets
   * the per-question debug log entry report exactly which chunk (by id),
   * from which document, with what relevance score and chunking
   * strategy, ended up in context for a given answer. */
  docId: string;
  chunkId: string;
  score: number;
  chunkingStrategy: string;
}

export interface RetrievedContext {
  contextText: string;
  sources: string[];
  /** The same excerpts that make up contextText, broken out individually
   * so the UI can show what's actually behind each [1]/[2] citation the
   * model uses, instead of asking the user to just trust the citation
   * number. Added 2026-09-01 per the user's request for verifiable
   * citations. */
  excerpts: RetrievedExcerpt[];
  /** Retrieval-stage timing/debug info (2026-09-08 logging system) — how
   * long query embedding and reranking took, whether reranking actually
   * ran, and how many candidates survived the pre-rerank sanity floor.
   * Consumed by askDocs() to build one combined per-question log entry;
   * not shown to the user. */
  perf: { embedMs: number; rerankMs: number; reranked: boolean; candidateCount: number };
}

/** One user's document index (2026-09-08, multi-session isolation): every
 * document, chunk/embedding, and the on-disk temp folder holding copies of
 * the uploaded files, all scoped to a single sessionId. Before this, the
 * whole module was ONE shared global index — fine for the single-user
 * desktop app, but wrong for the web app once real logins/sessions exist:
 * two different logged-in browser tabs would otherwise see (and could
 * delete) each other's documents. The desktop app still works exactly as
 * before by always passing the same fixed session id (see main.ts's
 * DESKTOP_SESSION_ID) — it just happens to have exactly one session for
 * its whole lifetime. */
interface SessionState {
  tempDir: string | null;
  chunks: Chunk[];
  docs: DocSummary[];
}

const sessions = new Map<string, SessionState>();

function getSessionState(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { tempDir: null, chunks: [], docs: [] };
    sessions.set(sessionId, s);
  }
  return s;
}

function ensureTempDir(sessionId: string): string {
  const s = getSessionState(sessionId);
  if (!s.tempDir) {
    s.tempDir = path.join(os.tmpdir(), `clickai-docs-${randomUUID()}`);
    fs.mkdirSync(s.tempDir, { recursive: true });
  }
  return s.tempDir;
}

/** Splits text into overlapping chunks, preferring to break at paragraph or
 * sentence boundaries near the target size rather than mid-word.
 *
 * Accuracy fix (2026-09-01): the original break search only looked for a
 * paragraph break ("\n\n") or a sentence end (". ") within the tail of the
 * slice. Bullet-heavy documents (resumes, changelogs, spec sheets) often
 * have neither near the target size — most lines are single "\n"-separated
 * bullets with no trailing period — so it fell through to a hard cutoff at
 * exactly maxChars, which can and did land mid-word (confirmed on a real
 * resume: one chunk started with a lone "P", another with "s & SRE",
 * because the previous chunk was sliced right through "CI/CD" and
 * "Observability"). A word split across a chunk boundary can make that
 * word invisible to keyword matching in one chunk and confusing in the
 * next, which is exactly the kind of thing that can make a real answer
 * look like it's not in the documents. Fixed by widening the break search
 * to also accept a single newline, and by falling back to the nearest
 * whitespace at all (never a bare hard cutoff) when no better break is
 * found nearby. */
interface TextChunk {
  text: string;
  page?: number;
}

const PAGE_MARKER_RE = /\u0001PAGE=(\d+)\u0001\n?/g;

// Wraps a pre-batched table block from docParsers (an Excel sheet or HTML
// table, chunk-sized with its header row already repeated — see
// buildTableBlocks in docParsers.ts). Captured content excludes the
// markers themselves, so no separate strip step is needed the way PAGE
// markers need one.
const TABLE_BLOCK_RE = /\u0002TABLE\u0002([\s\S]*?)\u0002\/TABLE\u0002/g;

/** Scans a strategy's raw text pieces for invisible \u0001PAGE=<n>\u0001
 * markers, strips them, and records which page each resulting piece
 * starts on — factored out so every chunking strategy in chunking.ts can
 * stay strategy-only (just "how to split text") while page-citation
 * tracking (2026-09-02) stays uniform and correct regardless of which
 * strategy produced the pieces. */
function attachPageMarkers(
  rawPieces: string[],
  startPage: number | undefined
): { pieces: TextChunk[]; endPage: number | undefined } {
  const pieces: TextChunk[] = [];
  let currentPage = startPage;
  for (let piece of rawPieces) {
    piece = piece.trim();
    if (!piece) continue;
    PAGE_MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PAGE_MARKER_RE.exec(piece))) {
      currentPage = parseInt(m[1], 10);
      break; // first marker in the piece is what matters
    }
    piece = piece.replace(PAGE_MARKER_RE, "").trim();
    if (piece) pieces.push({ text: piece, page: currentPage });
  }
  return { pieces, endPage: currentPage };
}

/** Splits text into overlapping chunks, additionally tracking which PDF
 * page each chunk starts on (2026-09-02) and keeping any table blocks
 * from docParsers (Excel sheets, HTML tables — see buildTableBlocks)
 * intact as single atomic chunks (2026-09-02, revision) instead of
 * slicing them apart by character count. PDF text arrives with invisible
 * \u0001PAGE=<n>\u0001 markers inserted by docParsers between pages; text
 * from formats with no page concept (DOCX/XLSX/etc.) never contains these
 * markers at all, so `page` stays undefined throughout for those — no
 * fabricated numbers.
 *
 * Table-aware fix (2026-09-02): a table chunked by raw character count
 * could easily land in the middle of a wide sheet, producing a chunk like
 * "East | 120000 | 5%" with no column headers — the model had no way to
 * know what those values meant, which showed up as noticeably weaker
 * answers on Excel/HTML-table questions specifically. docParsers now
 * pre-batches tables into chunk-sized blocks with the header row repeated
 * in every batch and wraps each in \u0002TABLE\u0002...\u0002/TABLE\u0002
 * markers; this function splits the raw text into alternating prose/table
 * segments up front, runs the normal sliding-window chunker on the prose
 * segments only, and takes each table segment verbatim as its own chunk
 * (header included) with no further splitting.
 *
 * Accuracy fix (2026-09-01): the original break search only looked for a
 * paragraph break ("\n\n") or a sentence end (". ") within the tail of the
 * slice. Bullet-heavy documents (resumes, changelogs, spec sheets) often
 * have neither near the target size — most lines are single "\n"-separated
 * bullets with no trailing period — so it fell through to a hard cutoff at
 * exactly maxChars, which can and did land mid-word. Fixed by widening the
 * break search to also accept a single newline, and by falling back to the
 * nearest whitespace at all (never a bare hard cutoff) when no better
 * break is found nearby.
 *
 * Sizing tuned 2026-09-03: bumped from 1100/150 to 1400/190 chars. The
 * smaller size fragmented dense, list-heavy sections (e.g. a resume's
 * work-history entries) across multiple chunks more than necessary, which
 * made it easier for a genuinely relevant chunk to score low on hybrid
 * similarity purely because it only had half of a section's context — the
 * larger size keeps more of a section together per chunk. Overlap kept at
 * roughly the same ~13-14% ratio. Chunks are still capped well under the
 * embedding model's limits, so this trades a slightly larger per-chunk
 * embedding/context cost for fewer, more complete chunks.
 *
 * Selectable strategies (2026-09-07): PROSE splitting is now delegated to
 * chunking.ts's splitProseSegment(), which dispatches to whichever of the
 * 5 strategies (fixed/recursive/structure/semantic/llm) is selected in
 * Settings — see chunking.ts for what each one does. Table-block and
 * page-marker handling here stay exactly as before, unaffected by which
 * prose strategy is active: a table row never loses its header and a
 * citation never loses its page number regardless of strategy. `client`
 * and `model` are threaded through only because the "semantic" and "llm"
 * strategies need them (an embeddings call and a chat-model call,
 * respectively) — the other three ignore them entirely. */
async function chunkText(
  text: string,
  strategy: ChunkingStrategy,
  client: OpenAI,
  model: string,
  maxChars = 1400,
  overlapChars = 190
): Promise<TextChunk[]> {
  const cleanedRaw = text.replace(/\r\n/g, "\n").trim();
  if (!cleanedRaw) return [];

  const segments: { type: "prose" | "table"; content: string }[] = [];
  let cursor = 0;
  TABLE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TABLE_BLOCK_RE.exec(cleanedRaw))) {
    if (match.index > cursor) segments.push({ type: "prose", content: cleanedRaw.slice(cursor, match.index) });
    segments.push({ type: "table", content: match[1].trim() });
    cursor = TABLE_BLOCK_RE.lastIndex;
  }
  if (cursor < cleanedRaw.length) segments.push({ type: "prose", content: cleanedRaw.slice(cursor) });

  const chunks: TextChunk[] = [];
  let currentPage: number | undefined;
  for (const seg of segments) {
    if (seg.type === "table") {
      const piece = seg.content.trim();
      if (piece) chunks.push({ text: piece, page: currentPage });
      continue;
    }
    const rawPieces = await splitProseSegment(strategy, seg.content, maxChars, overlapChars, client, model);
    const { pieces, endPage } = attachPageMarkers(rawPieces, currentPage);
    chunks.push(...pieces);
    currentPage = endPage;
  }
  return chunks;
}

/** Copies the file into a session-scoped temp folder, extracts its text,
 * chunks and embeds it, and adds it to that session's in-memory index. The
 * temp folder (and everything in it) is deleted by clearAll(sessionId)/
 * teardown(). `sessionId` (2026-09-08, multi-session isolation) scopes
 * this document to one user's index only — see SessionState above. */
export async function addDocument(
  sessionId: string,
  filePath: string,
  onProgress?: (message: string) => void
): Promise<DocSummary> {
  if (!isSupportedDocument(filePath)) {
    throw new Error(`Unsupported file type: ${path.basename(filePath)}`);
  }

  const apiKey = store.get("apiKey");
  if (!apiKey) {
    throw new Error("No OpenAI API key set. Open ClickAI settings and add your API key.");
  }

  const dir = ensureTempDir(sessionId);
  const originalName = path.basename(filePath);
  const docId = randomUUID();
  const copyPath = path.join(dir, `${docId}-${originalName}`);
  fs.copyFileSync(filePath, copyPath);

  // Everything from here on can genuinely fail mid-pipeline (extraction,
  // chunking, embedding) — logged as one "upload" stage error (2026-09-08
  // logging system) before rethrowing, so a failed upload leaves a trace
  // in debug-log.jsonl even though it still surfaces to the caller/UI
  // exactly as before.
  try {
    // Soft warning only — no hard cap here (unlike audio/video, which has a
    // real 25MB endpoint limit). A big PDF/DOCX/etc. will still work, it
    // just means more chunks and more embedding calls, so this just sets
    // expectations rather than blocking anything.
    const LARGE_FILE_WARNING_BYTES = 20 * 1024 * 1024;
    const fileStats = fs.statSync(copyPath);
    if (fileStats.size > LARGE_FILE_WARNING_BYTES) {
      const mb = (fileStats.size / (1024 * 1024)).toFixed(1);
      onProgress?.(`${originalName} is ${mb}MB — this may take a little while to read and embed…`);
    }

    onProgress?.(`Reading ${originalName}…`);
    const text = await extractText(copyPath);
    if (!text || !text.trim()) {
      throw new Error(`Couldn't extract any text from ${originalName}.`);
    }

    // Built here (rather than just before embedding, as before) because the
    // "semantic" and "llm" chunking strategies (2026-09-07) need a client
    // and model to chunk with in the first place, before any embedding call
    // happens at all.
    const client = new OpenAI({ apiKey, timeout: DEFAULT_CLIENT_TIMEOUT_MS });
    const model = store.get("model") || "gpt-5.4";
    const configuredStrategy: ChunkingStrategy = store.get("chunkingStrategy") || DEFAULT_CHUNKING_STRATEGY;
    // Chunk size (2026-09-08, user-adjustable) — falls back to the tuned
    // defaults (see chunkText's own signature) only if the store somehow
    // has no value, which shouldn't happen once defaults are written, but
    // keeps this call site safe either way.
    const maxChars = store.get("chunkMaxChars") || undefined;
    const overlapChars = store.get("chunkOverlapChars");
    const embeddingModel = store.get("embeddingModel") || DEFAULT_EMBEDDING_MODEL;

    // "Auto" (2026-09-08, explicit user request) is resolved to one of
    // the 5 concrete strategies HERE, once per document, before any
    // chunking happens — so a document is always chunked consistently
    // (never a mix of strategies across its own segments), and every
    // downstream consumer (chunkText/splitProseSegment) only ever sees a
    // real strategy, never "auto" itself.
    //
    // Resolved against the PROSE-only remainder (2026-09-07 CSV fix) —
    // table blocks (CSV rows via buildTableBlocks, XLSX/HTML tables) are
    // always taken verbatim as atomic chunks in chunkText() regardless of
    // strategy, so a document that's entirely (or mostly) tables should
    // never have its strategy choice, progress label, or debug log driven
    // by a heuristic reading the raw table markup as "one giant wall of
    // unstructured prose" — that misreading is exactly what used to send
    // large CSVs into LLM-based chunking even though no prose chunking
    // ever actually ran on them.
    const proseOnlyText = text.replace(/\u0002TABLE\u0002[\s\S]*?\u0002\/TABLE\u0002/g, "").trim();
    // A document that's ENTIRELY table blocks (a pure CSV, a spreadsheet
    // with no surrounding prose) has no prose segment for any strategy to
    // ever run on — chooseAutoStrategy's result would never be used, so
    // don't even run the heuristic against the leftover empty string
    // (which would otherwise fall back to the raw, table-marker-laden
    // `text` and reintroduce the exact mislabeling this fix is for).
    // FALLBACK_STRATEGY_WHEN_NO_PROSE mirrors chunking.ts's own safe
    // default (recursive) — never used for actual chunking, only for the
    // progress label / debug log when there's genuinely nothing to chunk
    // as prose.
    const strategy: Exclude<ChunkingStrategy, "auto"> =
      configuredStrategy === "auto"
        ? proseOnlyText.length > 0
          ? chooseAutoStrategy(proseOnlyText, maxChars ?? 1400)
          : "recursive"
        : configuredStrategy;

    const chunkingLabel = strategy === "semantic" || strategy === "llm" ? " (this may take a little longer — " + strategy + " chunking)" : "";
    const autoLabel = configuredStrategy === "auto" ? ` — auto-picked "${strategy}" chunking for this document` : "";
    onProgress?.(`Splitting ${originalName} into chunks${chunkingLabel}${autoLabel}…`);
    const pieces = await chunkText(text, strategy, client, model, maxChars, overlapChars);
    if (pieces.length === 0) {
      throw new Error(`${originalName} appears to be empty.`);
    }

    onProgress?.(`Embedding ${pieces.length} chunk${pieces.length === 1 ? "" : "s"} from ${originalName}…`);
    const vectors = await embedTexts(client, pieces.map((p) => p.text), embeddingModel);

    const session = getSessionState(sessionId);
    pieces.forEach((piece, i) => {
      session.chunks.push({ id: `${docId}-${i}`, docId, docName: originalName, text: piece.text, embedding: vectors[i], embeddingModel, page: piece.page, chunkingStrategy: strategy });
    });

    // Full chunking audit log (2026-09-07, "log everything, even chunking
    // and which chunk used") — every chunk this document was split into,
    // regardless of whether a question ever retrieves it, plus which
    // strategy was configured vs. actually resolved to (relevant for
    // "auto"). Separate from the per-question chunksUsed log below.
    logChunking({
      docId,
      docName: originalName,
      configuredStrategy,
      resolvedStrategy: strategy,
      chunkCount: pieces.length,
      sourceTextChars: text.length,
      chunks: pieces.map((piece, i) => ({
        index: i,
        id: `${docId}-${i}`,
        page: piece.page,
        charCount: piece.text.length,
        text: piece.text,
      })),
    });

    const summary: DocSummary = { id: docId, name: originalName, chunkCount: pieces.length };
    session.docs.push(summary);
    return summary;
  } catch (err: any) {
    logError({ stage: "upload", message: err.message || String(err), docName: originalName });
    throw err;
  }
}

export function listDocuments(sessionId: string): DocSummary[] {
  return getSessionState(sessionId).docs;
}

export function hasDocuments(sessionId: string): boolean {
  return getSessionState(sessionId).chunks.length > 0;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "is", "are",
  "was", "were", "be", "been", "with", "as", "at", "by", "it", "this",
  "that", "these", "those", "what", "which", "who", "how", "why", "when",
  "does", "do", "did", "can", "could", "would", "should", "will", "i",
  "you", "we", "my", "me", "our", "your", "me", "tell", "give", "please",
]);

/** Pulls out the "real" search terms from a question — lowercased words of
 * 2+ chars, minus common stopwords. Numbers and codes (e.g. "PO-4471",
 * "2024") are kept, since those are exactly the kind of exact-match terms
 * embedding similarity alone tends to under-weight. */
function extractTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9\-_.]*/g) || [];
  return Array.from(new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w))));
}

/** Fraction of the query's search terms that literally appear in the chunk
 * (case-insensitive). This is a lightweight lexical/keyword signal that
 * complements embedding similarity: embeddings are great at "meaning" but
 * can under-rank a chunk that contains the exact number, name, or code the
 * user asked about if the surrounding wording differs a lot. */
function keywordOverlapScore(queryTerms: string[], chunkText: string): number {
  if (queryTerms.length === 0) return 0;
  const lower = chunkText.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    if (lower.includes(term)) hits++;
  }
  return hits / queryTerms.length;
}

const MAX_CANDIDATES = 16;
const MAX_CONTEXT_CHUNKS = 10;
const MAX_CHUNKS_PER_DOC = 4;
const CONTEXT_CHAR_BUDGET = 9000;
const MIN_RELEVANCE_SCORE = 0.18; // fallback relevance floor when reranking doesn't run
const PRE_RERANK_SANITY_FLOOR = 0.05; // loose floor BEFORE reranking — just keeps obvious garbage out of the reranker prompt; the real cutoff is RERANK_MIN_SCORE/MIN_RELEVANCE_SCORE after

/** Embeds `question` and returns the most relevant document excerpts as a
 * ready-to-inject context string, or null if no documents are uploaded or
 * none of them look actually relevant to the question. This is the
 * retrieval half of RAG — the chat call itself happens alongside the
 * screen-vision call in openai.ts, so a question can draw on the screen
 * and uploaded documents together in one answer.
 *
 * Retrieval quality tuning (2026-09-01): combines embedding similarity with
 * a lexical keyword-overlap score (hybrid retrieval) so exact terms like
 * numbers, IDs, and names aren't missed just because embeddings alone
 * under-ranked them; caps how many chunks can come from a single document
 * so one large doc can't crowd out a smaller, more relevant one when
 * several docs are uploaded; and fills a character budget rather than a
 * fixed chunk count, so short/dense answers use fewer, more focused
 * excerpts while genuinely broad questions can pull in more. Chunks that
 * don't clear a minimum relevance bar are dropped instead of force-fed to
 * the model, so it can honestly say "the documents don't cover that"
 * instead of guessing from a weak/irrelevant match.
 */
/** gpt-5.x models accept a `reasoning.effort` param that non-reasoning
 * models (gpt-4o/gpt-4o-mini) reject outright — duplicated here (rather
 * than imported from openai.ts) to avoid a circular import, since
 * openai.ts already imports from this file. */
function rerankReasoningParams(model: string): Record<string, any> {
  return model.startsWith("gpt-5") ? { reasoning: { effort: "low" } } : {};
}

/** Pulls the actual answer text out of a plain (non-streamed)
 * client.responses.create() response — checks the SDK's `output_text`
 * convenience property first, but falls back to walking `response.output`
 * directly, the same lesson learned the hard way with the streaming path
 * in openai.ts (that property isn't always populated). */
function extractResponseText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text) {
    return response.output_text;
  }
  return (response?.output || [])
    .filter((item: any) => item?.type === "message")
    .flatMap((item: any) => item.content || [])
    .filter((c: any) => c?.type === "output_text")
    .map((c: any) => c.text)
    .join("");
}

// Rerank whenever there's at least 1 candidate (2026-09-08, bug fix — was
// 3). The old "skip reranking below N candidates" heuristic backfired
// exactly where it mattered most: a document that only produced 1-2
// chunks (a short file, or almost any image/screenshot upload, since OCR
// output is usually well under one chunk's worth of text) could NEVER
// reach the reranker, so a genuinely relevant single chunk fell back to
// the strict MIN_RELEVANCE_SCORE hybrid-only floor with no rescue — the
// exact same class of bug as the 2026-09-03 "list of companies" relevance-
// floor bug, just reachable through a different door (small candidate
// pools instead of a loose pre-filter). Reranking 1-2 candidates is also
// the CHEAPEST possible rerank call, so there's no real cost reason to
// skip it for small pools either.
const RERANK_MIN_CANDIDATES = 1;
// 900 chars covers the vast majority of a chunk (chunks target ~1400 chars,
// see chunkText's maxChars) — bumped from 500 (2026-09-03) after noticing
// the reranker was judging candidates on less than half their text, which
// risked scoring a chunk low simply because its relevant part fell past
// the truncation point rather than because it was actually irrelevant.
const RERANK_EXCERPT_CHARS = 900;
const RERANK_MIN_SCORE = 0.15; // post-rerank relevance floor (0-1, comparable to MIN_RELEVANCE_SCORE)
// The reranker is a background scoring step, not something the user
// watches stream in — it should fail fast and fall back to hybrid-only
// ranking rather than hold up the whole answer for the full client
// timeout (2026-09-03).
const RERANK_TIMEOUT_MS = 20_000;

/** Retrieve-then-rerank (2026-09-03): the hybrid semantic+lexical score
 * above is good at finding a plausible SHORTLIST fast, but it's still
 * just similarity math — it can rank a chunk that merely shares
 * vocabulary with the question above one that actually answers it. This
 * takes that shortlist (already capped small) and asks the model itself
 * to judge each excerpt's real relevance to the question, then re-sorts
 * by that judgment instead. Standard "retrieve-then-rerank" RAG — this is
 * NOT a second full search over every chunk, just a re-scoring of the
 * candidates the first pass already found.
 *
 * Fails soft: any parsing/API problem falls back to the original
 * hybrid-scored order for the affected candidates rather than breaking
 * retrieval — a reranker should never be a single point of failure for
 * whether ClickAI can answer at all. */
async function rerankCandidates(
  client: OpenAI,
  model: string,
  question: string,
  candidates: { chunk: Chunk; score: number }[]
): Promise<{ results: { chunk: Chunk; score: number }[]; reranked: boolean }> {
  if (candidates.length < RERANK_MIN_CANDIDATES) return { results: candidates, reranked: false };

  const listing = candidates
    .map((c, i) => `[${i + 1}] (from "${c.chunk.docName}") ${c.chunk.text.slice(0, RERANK_EXCERPT_CHARS)}`)
    .join("\n\n");

  try {
    // Retry-wrapped (2026-09-03) so a transient 429/5xx doesn't immediately
    // give up and fall back to the plain hybrid order — a couple of quick
    // backoff retries first, same policy as embeddings. A tighter
    // RERANK_TIMEOUT_MS (rather than the client's 60s default) keeps a
    // stuck reranker call from holding up the whole answer, since falling
    // back to hybrid-only ranking is always a safe, fast option here.
    const response: any = await withRetry(() =>
      (client.responses as any).create(
        {
          model,
          instructions:
            'You are a relevance-scoring assistant for a document search system. Given a user question and a numbered list of excerpts, score EACH excerpt 0-100 for how directly and usefully it helps answer the question (100 = directly answers it, 0 = completely unrelated). Respond with ONLY a JSON object, no other text, in exactly this shape: {"scores":[{"i":1,"s":72},{"i":2,"s":5}]} — one entry per excerpt number, covering every excerpt.',
          input: [
            { role: "user", content: [{ type: "input_text", text: `Question: ${question}\n\nExcerpts:\n${listing}` }] },
          ],
          max_output_tokens: 800,
          ...rerankReasoningParams(model),
        },
        { timeout: RERANK_TIMEOUT_MS }
      )
    );

    const text = extractResponseText(response);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { results: candidates, reranked: false };

    const parsed = JSON.parse(jsonMatch[0]);
    const scoreByIndex = new Map<number, number>();
    for (const entry of parsed?.scores || []) {
      if (typeof entry?.i === "number" && typeof entry?.s === "number") {
        scoreByIndex.set(entry.i, Math.max(0, Math.min(100, entry.s)) / 100);
      }
    }
    if (scoreByIndex.size === 0) return { results: candidates, reranked: false };

    const results = candidates
      .map((c, i) => {
        const rerankScore = scoreByIndex.get(i + 1);
        return rerankScore !== undefined ? { chunk: c.chunk, score: rerankScore } : c;
      })
      .sort((a, b) => b.score - a.score);
    return { results, reranked: true };
  } catch (err: any) {
    console.error("[ClickAI] Reranking failed, falling back to hybrid-only ranking:", err);
    logError({ stage: "rerank", message: err.message || String(err), question });
    return { results: candidates, reranked: false };
  }
}

export async function getRelevantContext(
  sessionId: string,
  question: string,
  retrievalHint?: string,
  /** When set, restricts retrieval to just this one document's chunks
   * (2026-09-02, "separate chat per document" feature) — lets a user pin
   * a conversation to a single uploaded file instead of every question
   * being scored against every document's chunks together. */
  docId?: string
): Promise<RetrievedContext | null> {
  const allChunks = getSessionState(sessionId).chunks;
  const pool = docId ? allChunks.filter((c) => c.docId === docId) : allChunks;
  if (pool.length === 0) return null;

  const apiKey = store.get("apiKey");
  if (!apiKey) {
    throw new Error("No OpenAI API key set. Open ClickAI settings and add your API key.");
  }

  // `retrievalHint` lets a caller fold recent conversation context into the
  // retrieval query itself (2026-09-01, for Docs-mode conversation memory)
  // — e.g. a follow-up like "how long at the first one" has almost no
  // retrievable signal on its own, but combined with the previous
  // answer/question it can still find the right chunk. The hint only
  // affects WHAT gets retrieved, never what the model is told it can
  // answer from beyond the retrieved excerpts themselves.
  const retrievalQuery = retrievalHint ? `${retrievalHint}

${question}` : question;

  const client = new OpenAI({ apiKey, timeout: DEFAULT_CLIENT_TIMEOUT_MS });

  // Selectable embedding models (2026-09-08): a chunk's vector was
  // produced by whatever model was configured when its document was
  // uploaded (Chunk.embeddingModel), which may not be the model
  // currently selected in Settings — comparing vectors from two
  // different models with cosineSimilarity is meaningless (they're
  // usually not even the same length). So the query is embedded ONCE PER
  // DISTINCT MODEL actually present in the pool, and each chunk is
  // scored against the query vector that matches ITS OWN model. In the
  // common case (the user never changed the embedding model) that's
  // still just one embed call, same cost as before.
  const modelsInPool = Array.from(new Set(pool.map((c) => c.embeddingModel || DEFAULT_EMBEDDING_MODEL)));
  const queryVectorByModel = new Map<string, number[]>();
  const embedStart = Date.now();
  for (const embModel of modelsInPool) {
    // priority: true (2026-09-07 fix) -- a live question waiting on an
    // answer must never queue behind a large document's bulk upload
    // embedding work; see withEmbeddingSlot's comment in embeddings.ts
    // for the real bug this fixes (a question stuck on the "thinking"
    // indicator forever while a big CSV was still embedding).
    const [vec] = await embedTexts(client, [retrievalQuery], embModel, true);
    queryVectorByModel.set(embModel, vec);
  }
  const embedMs = Date.now() - embedStart;
  const queryTerms = extractTerms(retrievalQuery);

  const scored = pool
    .map((c) => {
      const queryVector = queryVectorByModel.get(c.embeddingModel || DEFAULT_EMBEDDING_MODEL)!;
      const semanticScore = cosineSimilarity(queryVector, c.embedding);
      const lexicalScore = keywordOverlapScore(queryTerms, c.text);
      // Weighted blend: semantic similarity carries most of the weight
      // (it's what generalizes across phrasing), lexical overlap is a
      // smaller boost that rescues exact-term matches.
      const score = semanticScore * 0.75 + lexicalScore * 0.25;
      return { chunk: c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .filter((r) => r.score >= PRE_RERANK_SANITY_FLOOR);

  if (scored.length === 0) return null;

  // Retrieve-then-rerank (2026-09-03, relevance-floor fix 2026-09-03): the
  // real relevance decision happens HERE, after reranking, not on the raw
  // hybrid score above — the hybrid score is only a loose sanity floor now
  // (see PRE_RERANK_SANITY_FLOOR) so a chunk that genuinely answers the
  // question but happens to share little vocabulary/embedding-similarity
  // with how the question was phrased still gets a fair look from the
  // reranker instead of being silently dropped beforehand. `model` reuses
  // whatever the user has configured for Docs answers, so reranking
  // behaves the same as the answer itself for a given API key/account.
  const model = store.get("model") || "gpt-5.4";
  // Reranking toggle (2026-09-08): when a user turns it off in Settings,
  // skip the extra model call entirely rather than calling rerankCandidates
  // and ignoring its result — no point paying for a call whose answer is
  // discarded. Falls back to the original hybrid-only relevance floor,
  // same as when reranking is skipped automatically (see rerankCandidates).
  const rerankingEnabled = store.get("rerankingEnabled");
  const rerankStart = Date.now();
  const { results: rerankedResults, reranked: didRerank } =
    rerankingEnabled === false
      ? { results: scored, reranked: false }
      : await rerankCandidates(client, model, retrievalQuery, scored);
  const rerankMs = Date.now() - rerankStart;
  const relevanceFloor = didRerank ? RERANK_MIN_SCORE : MIN_RELEVANCE_SCORE;
  const reranked = rerankedResults.filter((r) => r.score >= relevanceFloor);

  if (reranked.length === 0) return null;

  const perDocCount = new Map<string, number>();
  const selected: typeof reranked = [];
  let charTotal = 0;

  for (const r of reranked) {
    if (selected.length >= MAX_CONTEXT_CHUNKS) break;
    const docCount = perDocCount.get(r.chunk.docId) || 0;
    if (docCount >= MAX_CHUNKS_PER_DOC) continue;
    if (selected.length > 0 && charTotal + r.chunk.text.length > CONTEXT_CHAR_BUDGET) continue;
    selected.push(r);
    perDocCount.set(r.chunk.docId, docCount + 1);
    charTotal += r.chunk.text.length;
  }

  if (selected.length === 0) return null;

  const contextText = selected
    .map((r, i) => `[${i + 1}] (from "${r.chunk.docName}")\n${r.chunk.text}`)
    .join("\n\n---\n\n");

  const sources = Array.from(new Set(selected.map((r) => r.chunk.docName)));

  const excerpts: RetrievedExcerpt[] = selected.map((r, i) => ({
    index: i + 1,
    docName: r.chunk.docName,
    text: r.chunk.text,
    page: r.chunk.page,
    docId: r.chunk.docId,
    chunkId: r.chunk.id,
    score: r.score,
    chunkingStrategy: r.chunk.chunkingStrategy,
  }));

  return {
    contextText,
    sources,
    excerpts,
    perf: { embedMs, rerankMs, reranked: didRerank, candidateCount: scored.length },
  };
}

/** Wipes one session's uploaded documents, their extracted chunks/
 * embeddings, and its temp folder on disk, and forgets the session entry
 * entirely (2026-09-08, multi-session isolation — previously this reset
 * the one shared global index; now it only ever touches the caller's own
 * session, so logging out or clearing docs in one browser tab can never
 * affect another user's documents). Called from the "Clear" button, on
 * app quit (desktop), and on logout / idle-session expiry (web — see
 * authStore.ts's destroy hook wired in server.ts). */
export function clearAll(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.tempDir) {
    try {
      fs.rmSync(s.tempDir, { recursive: true, force: true });
    } catch {
      // best effort — app/session is going away anyway
    }
  }
  sessions.delete(sessionId);
}

/** Clears every session's documents — used on full app quit (desktop),
 * where there's always exactly one long-lived session. */
export function teardown() {
  for (const sessionId of Array.from(sessions.keys())) {
    clearAll(sessionId);
  }
}
