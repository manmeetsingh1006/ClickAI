import OpenAI from "openai";
import { withRetry } from "./retry";
import { embedTexts, cosineSimilarity } from "./embeddings";

/**
 * Selectable chunking strategies (2026-09-07, explicit user request: "we
 * need to add Fixed Size Chunking and add Recursive Character Chunking,
 * Document/Structure based chunking, Semantic Chunking and LLM Based
 * Chunking"). Each strategy only decides how to split one PROSE segment
 * of a document into pieces — table blocks (from docParsers.ts's
 * buildTableBlocks) are always kept atomic regardless of strategy, and
 * PDF page-marker tracking is handled uniformly in ragStore.ts's
 * chunkText() after a strategy returns its raw pieces. That separation
 * keeps every strategy implementation here simple: given a chunk of
 * prose text, return an ordered list of chunk-sized strings.
 */
export type ChunkingStrategy = "auto" | "fixed" | "recursive" | "structure" | "semantic" | "llm";

export const CHUNKING_STRATEGY_INFO: Record<ChunkingStrategy, { label: string; description: string }> = {
  auto: {
    label: "Auto (recommended)",
    description: "Picks a strategy per document from its own structure — paragraph/section breaks, length, how consistently it's formatted. May pick any of the 5 strategies below, including the slower/costlier Semantic or LLM-based ones when a document's structure calls for it.",
  },
  fixed: {
    label: "Fixed size",
    description: "Splits every N characters with fixed overlap. Fastest and cheapest, but can cut mid-sentence or mid-word.",
  },
  recursive: {
    label: "Recursive character",
    description: "Tries paragraph breaks first, then sentences, then lines, then words, recursively — a good balance of quality and speed with no extra API calls.",
  },
  structure: {
    label: "Document structure",
    description: "Follows the document's own paragraph/section breaks as chunk boundaries instead of a target character count. Keeps naturally-grouped content together.",
  },
  semantic: {
    label: "Semantic",
    description: "Groups sentences by topic using embeddings, so each chunk stays on one subject even across paragraph breaks. Slower and costs one extra embedding call per document.",
  },
  llm: {
    label: "LLM-based",
    description: "Asks the model itself to choose chunk boundaries. Most accurate for oddly-structured text, but the slowest and most expensive option per upload.",
  },
};

// "Auto" is now the default (2026-09-08, explicit user request: "can't we
// make system automatically choose chunking" after seeing the 5 concrete
// strategies as a bare dropdown with no guidance) — a fresh install picks
// per-document automatically rather than requiring a manual choice up
// front. A user who explicitly picks one of the 5 concrete strategies in
// Settings still gets exactly that strategy for every document, same as
// before "auto" existed.
export const DEFAULT_CHUNKING_STRATEGY: ChunkingStrategy = "auto";

// The concrete strategy auto/an unresolved edge case falls back to —
// cheap, safe, no extra API call. Also what splitProseSegment's own
// switch statement already falls back to for any strategy value it
// doesn't recognize, so this constant just names that same choice.
const FALLBACK_CONCRETE_STRATEGY: Exclude<ChunkingStrategy, "auto"> = "recursive";

export function isChunkingStrategy(value: unknown): value is ChunkingStrategy {
  return typeof value === "string" && value in CHUNKING_STRATEGY_INFO;
}

/**
 * "Auto" chunking strategy selection — resolved ONCE per document (in
 * ragStore.ts's addDocument(), before any actual chunking happens) from
 * cheap textual signals, not a learned/ML classifier. Chosen to mirror
 * the same reasoning a person would use picking from the dropdown by
 * hand: does this document have real paragraph structure? Is it short
 * enough that it barely matters? Is it a wall of text or irregularly
 * formatted with no real boundaries a simple splitter could find? Auto
 * CAN land on "semantic" or "llm" (2026-09-08, explicit user choice when
 * asked) — it is not restricted to the free/cheap strategies only.
 */
export function chooseAutoStrategy(text: string, maxChars: number): Exclude<ChunkingStrategy, "auto"> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return FALLBACK_CONCRETE_STRATEGY; // addDocument() already rejects empty text before this is ever called; kept for type safety only.

  const length = trimmed.length;
  const paragraphs = trimmed.split(/\n\s*\n+/).filter((p) => p.trim().length > 0);
  const paragraphCount = paragraphs.length;
  const avgParaChars = length / Math.max(paragraphCount, 1);

  // A short document fits in a chunk or two regardless of strategy — no
  // point paying for semantic/llm's extra API call(s) when there's
  // nothing meaningful to be smart about yet.
  if (length <= maxChars * 1.5) return "recursive";

  // Clear paragraph/section structure (most PDFs, DOCX exports, articles,
  // reports) at a reasonable per-paragraph size — follow the document's
  // own boundaries rather than a target character count.
  if (paragraphCount >= 3 && avgParaChars >= 80 && avgParaChars <= maxChars * 2.5) {
    return "structure";
  }

  // Long text with almost no paragraph breaks at all is either one
  // continuous wall of prose or something irregularly formatted (a
  // bullet list pasted without blank lines between entries, OCR output,
  // a scraped page) — exactly the case LLM-based chunking exists for,
  // since neither a fixed-size nor a paragraph-based splitter has any
  // real boundary to work with here.
  if (paragraphCount <= 1 && length > maxChars * 4) {
    return "llm";
  }

  // Everything else: a normal-length document without strong paragraph
  // structure — group sentences by topic instead of blindly cutting at a
  // character count.
  return "semantic";
}

// ---- shared helpers ----

/** Cheap, dependency-free sentence splitter for text already extracted
 * from a document (PDF/DOCX/etc.) — good enough for chunking purposes,
 * not meant to be a linguistically precise tokenizer. Keeps the
 * trailing punctuation/whitespace attached to the sentence it ends. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?\n]+[.!?]?(\s+|\n+|$)/g);
  if (!matches) return text.trim() ? [text.trim()] : [];
  return matches.map((s) => s.trim()).filter(Boolean);
}

/** Stitches split pieces back together with `overlapChars` of the
 * previous piece's tail prepended to each following piece, so retrieval
 * doesn't lose context right at a chunk boundary. Shared by every
 * strategy that produces boundary-based (not raw fixed-size) pieces. */
function withOverlap(pieces: string[], overlapChars: number): string[] {
  if (overlapChars <= 0) return pieces;
  const result: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i === 0) {
      result.push(pieces[i]);
      continue;
    }
    const prevTail = pieces[i - 1].slice(-overlapChars);
    result.push((prevTail + " " + pieces[i]).trim());
  }
  return result;
}

// ---- 1. Fixed size ----

/** The naive baseline: cuts every `maxChars` characters with
 * `overlapChars` overlap, no regard for word/sentence/paragraph
 * boundaries at all. Offered as an explicit, honestly-labeled option
 * rather than something to silently avoid — useful as a fast default
 * for very large or unstructured files, and as a comparison point
 * against the smarter strategies. */
function chunkFixed(segment: string, maxChars: number, overlapChars: number): string[] {
  const cleaned = segment.replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return [];
  const pieces: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + maxChars, cleaned.length);
    pieces.push(cleaned.slice(start, end));
    if (end >= cleaned.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return pieces;
}

// ---- 2. Recursive character ----

// Tried in order, coarsest to finest: paragraph, line, sentence-ish,
// word, then (if truly desperate) character. Mirrors the standard
// "recursive character text splitter" approach used across RAG
// tooling — recursively re-split any piece that's still too big using
// the next, finer separator down the list.
const RECURSIVE_SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

function recursiveSplit(text: string, maxChars: number, separators: string[]): string[] {
  if (text.length <= maxChars) return [text];
  const [sep, ...rest] = separators;
  const parts = sep ? text.split(sep) : text.split("");
  if (parts.length <= 1 && rest.length > 0) {
    // This separator didn't actually split anything (e.g. no "\n\n" in
    // the text at all) — move straight to the next, finer one instead
    // of pointlessly merging a single giant part back into itself.
    return recursiveSplit(text, maxChars, rest);
  }

  const merged: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length > maxChars && current) {
      merged.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) merged.push(current);

  const result: string[] = [];
  for (const piece of merged) {
    if (piece.length > maxChars && rest.length > 0) {
      result.push(...recursiveSplit(piece, maxChars, rest));
    } else {
      result.push(piece);
    }
  }
  return result;
}

function chunkRecursive(segment: string, maxChars: number, overlapChars: number): string[] {
  const cleaned = segment.replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return [];
  const pieces = recursiveSplit(cleaned, maxChars, RECURSIVE_SEPARATORS).filter((p) => p.trim());
  return withOverlap(pieces, overlapChars);
}

// ---- 3. Document structure ----

// A hard ceiling on a single structural unit (e.g. one giant paragraph
// with no internal blank lines) before we reluctantly fall back to the
// recursive splitter just for that one oversized piece — otherwise a
// document with no paragraph breaks at all would produce one enormous
// "chunk" that defeats the point of chunking.
const STRUCTURE_HARD_CEILING_MULTIPLE = 2.5;

/** Chunks along the document's own paragraph/section breaks rather than
 * a target character count — a structural unit (a paragraph, in the
 * plain-text case) is kept whole and merged with adjacent ones up to
 * ~maxChars, instead of being sliced by length first. */
function chunkStructure(segment: string, maxChars: number, overlapChars: number): string[] {
  const cleaned = segment.replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return [];
  const paragraphs = cleaned
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const merged: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    const candidate = current ? current + "\n\n" + para : para;
    if (candidate.length > maxChars && current) {
      merged.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) merged.push(current);

  const ceiling = maxChars * STRUCTURE_HARD_CEILING_MULTIPLE;
  const pieces: string[] = [];
  for (const piece of merged) {
    if (piece.length > ceiling) {
      pieces.push(...recursiveSplit(piece, maxChars, RECURSIVE_SEPARATORS));
    } else {
      pieces.push(piece);
    }
  }
  return withOverlap(pieces, overlapChars);
}

// ---- 4. Semantic ----

// Below this cosine-similarity between consecutive sentences, treat it
// as a topic shift worth starting a new chunk at. Chosen conservatively
// (fairly low) so normal topic drift within one section doesn't
// fragment a chunk unnecessarily — this is meant to catch clear section
// changes, not every small shift in wording.
const SEMANTIC_SIMILARITY_THRESHOLD = 0.55;
const SEMANTIC_MIN_SENTENCES_PER_CHUNK = 2;

/** Embeds each sentence and cuts a new chunk wherever consecutive
 * sentences' similarity drops below SEMANTIC_SIMILARITY_THRESHOLD, so a
 * chunk stays topically coherent even when it doesn't line up with a
 * paragraph break. Costs one extra embeddings call per document (all
 * sentences batched together, same batching as embedTexts already
 * does) — the user explicitly accepted that cost for the accuracy
 * gain. Fails soft to recursive chunking on any embedding error. */
async function chunkSemantic(
  segment: string,
  maxChars: number,
  overlapChars: number,
  client: OpenAI
): Promise<string[]> {
  const cleaned = segment.replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return [];
  const sentences = splitSentences(cleaned);
  if (sentences.length <= SEMANTIC_MIN_SENTENCES_PER_CHUNK) {
    return chunkRecursive(cleaned, maxChars, overlapChars);
  }

  let vectors: number[][];
  try {
    vectors = await withRetry(() => embedTexts(client, sentences));
  } catch (err) {
    console.error("[ClickAI] Semantic chunking: sentence embedding failed, falling back to recursive:", err);
    return chunkRecursive(cleaned, maxChars, overlapChars);
  }

  const groups: string[][] = [[sentences[0]]];
  for (let i = 1; i < sentences.length; i++) {
    const sim = cosineSimilarity(vectors[i - 1], vectors[i]);
    const currentGroup = groups[groups.length - 1];
    const currentLen = currentGroup.join(" ").length;
    const topicShift = sim < SEMANTIC_SIMILARITY_THRESHOLD && currentGroup.length >= SEMANTIC_MIN_SENTENCES_PER_CHUNK;
    const tooBig = currentLen + sentences[i].length > maxChars;
    if (topicShift || tooBig) {
      groups.push([sentences[i]]);
    } else {
      currentGroup.push(sentences[i]);
    }
  }

  const pieces = groups.map((g) => g.join(" ").trim()).filter(Boolean);
  return withOverlap(pieces, overlapChars);
}

// ---- 5. LLM-based ----

// The LLM is only asked to re-segment WINDOWS of text this big at once
// — never a whole document in one call. Keeps the prompt (and the
// model's max_output_tokens budget for echoing the chunked text back)
// bounded regardless of document size.
const LLM_CHUNK_WINDOW_CHARS = 6000;
const LLM_CHUNK_TIMEOUT_MS = 30_000;

function llmChunkReasoningParams(model: string): Record<string, any> {
  return model.startsWith("gpt-5") ? { reasoning: { effort: "low" } } : {};
}

// Small local duplicate of the same output_text-extraction fallback used
// in openai.ts and ragStore.ts (see those files' comments) — kept local
// rather than imported to avoid a circular import back into ragStore.ts.
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

/** Asks the configured chat model to propose chunk boundaries for a
 * window of text, aiming for topically coherent chunks near maxChars.
 * Pre-splits with the cheap recursive splitter into windows first so
 * the LLM's job (and cost) stays bounded, and only actually calls the
 * model for windows that are meaningfully larger than one target chunk
 * — a window already close to maxChars is used as-is. Fails soft to
 * the recursive splitter, per-window, on any API error or a response
 * that doesn't parse into the expected shape. */
async function chunkLLM(
  segment: string,
  maxChars: number,
  overlapChars: number,
  client: OpenAI,
  model: string
): Promise<string[]> {
  const cleaned = segment.replace(/[ \t]+/g, " ").trim();
  if (!cleaned) return [];

  const windows = recursiveSplit(cleaned, LLM_CHUNK_WINDOW_CHARS, RECURSIVE_SEPARATORS);
  const allPieces: string[] = [];

  for (const window of windows) {
    if (window.length <= maxChars * 1.3) {
      allPieces.push(window);
      continue;
    }
    try {
      const response: any = await withRetry(() =>
        (client.responses as any).create(
          {
            model,
            instructions:
              `Split the given text into topically coherent chunks, each roughly ${maxChars} characters and never much larger. Break only at natural topic or section boundaries — never mid-sentence. Respond with ONLY a JSON object, no other text, in exactly this shape: {"chunks":["...","..."]} — the chunks, concatenated in order, must reproduce the original text's content (whitespace differences are fine).`,
            input: [{ role: "user", content: [{ type: "input_text", text: window }] }],
            max_output_tokens: 3000,
            ...llmChunkReasoningParams(model),
          },
          { timeout: LLM_CHUNK_TIMEOUT_MS }
        )
      );
      const text = extractResponseText(response);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      const chunks = Array.isArray(parsed?.chunks)
        ? parsed.chunks.filter((c: any) => typeof c === "string" && c.trim())
        : null;
      if (chunks && chunks.length > 0) {
        allPieces.push(...chunks.map((c: string) => c.trim()));
      } else {
        allPieces.push(...chunkRecursive(window, maxChars, overlapChars));
      }
    } catch (err) {
      console.error("[ClickAI] LLM-based chunking failed for a window, falling back to recursive:", err);
      allPieces.push(...chunkRecursive(window, maxChars, overlapChars));
    }
  }

  return allPieces;
}

// ---- dispatch ----

/** Splits one prose segment using the given strategy. `client` and
 * `model` are only actually used by the "semantic" and "llm" strategies
 * — always passed through regardless, so callers don't need to branch. */
export async function splitProseSegment(
  strategy: ChunkingStrategy,
  segment: string,
  maxChars: number,
  overlapChars: number,
  client: OpenAI,
  model: string
): Promise<string[]> {
  switch (strategy) {
    case "fixed":
      return chunkFixed(segment, maxChars, overlapChars);
    case "structure":
      return chunkStructure(segment, maxChars, overlapChars);
    case "semantic":
      return chunkSemantic(segment, maxChars, overlapChars, client);
    case "llm":
      return chunkLLM(segment, maxChars, overlapChars, client, model);
    case "recursive":
    default:
      return chunkRecursive(segment, maxChars, overlapChars);
  }
}
