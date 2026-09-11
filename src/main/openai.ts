import OpenAI from "openai";
import { randomUUID } from "crypto";
import { store } from "./store";
import { getRelevantContext, listDocuments, RetrievedExcerpt, getCachedAnswer, setCachedAnswer } from "./ragStore";
import { DEFAULT_CLIENT_TIMEOUT_MS } from "./retry";
import { logPerf, logError } from "./debugLog";

/** One prior turn in a conversation, used for Docs-mode conversation
 * memory (2026-09-01) — kept generic enough to reuse for Chat mode later
 * if that's ever wanted too. */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AskResult {
  answer: string;
  sources: string[];
  /** The model's own self-reported confidence in its answer, 0-100, or
   * null if it couldn't be parsed out of the response. This is a
   * heuristic self-assessment, NOT a measured/calibrated accuracy score —
   * LLMs don't have access to a true probability of being correct. Shown
   * to the user as a rough gut-check, not a guarantee. */
  confidence: number | null;
  /** The individual document excerpts behind this answer's [1]/[2]-style
   * citations, so the UI can show what was actually retrieved instead of
   * asking the user to trust a citation number blindly. Only set for Docs
   * mode answers that actually had retrieved context. */
  excerpts?: RetrievedExcerpt[];
}

/** Called with each raw text chunk as the model generates it (2026-09-01,
 * streaming). The chunks are the RAW model output including whatever
 * fragment of the trailing "Confidence: NN%" line has streamed in so far
 * — callers that don't want to show that line mid-stream should hold back
 * rendering the last little bit of text and use the final `AskResult.answer`
 * (which has it stripped) once streaming completes, rather than trying to
 * detect/strip it chunk-by-chunk here. */
export type OnDelta = (delta: string) => void;

/** gpt-5.x models are "reasoning" models — the Responses API can spend a
 * chunk of max_output_tokens on invisible internal reasoning before it
 * writes any visible answer text, and for a bounded, non-creative task
 * like these (short Q&A, strict document lookup) heavy reasoning effort
 * isn't needed and just eats into that budget. Passing `reasoning.effort:
 * "low"` for gpt-5.x models cuts that overhead; non-reasoning models
 * (gpt-4o/gpt-4o-mini) reject an unknown `reasoning` param outright, so
 * this is only added when the model name actually looks like a gpt-5.x
 * reasoning model. (2026-09-02, added alongside the max_output_tokens
 * bump below after a live report of Docs mode returning "(no response)"
 * — see streamResponseText's incomplete_details handling.) */
function reasoningParams(model: string): Record<string, any> {
  return model.startsWith("gpt-5") ? { reasoning: { effort: "low" } } : {};
}

function getClient(): { client: OpenAI; model: string } {
  const apiKey = store.get("apiKey");
  if (!apiKey) {
    throw new Error(
      "No OpenAI API key set. Open ClickAI settings and add your API key."
    );
  }
  return { client: new OpenAI({ apiKey, timeout: DEFAULT_CLIENT_TIMEOUT_MS }), model: store.get("model") || "gpt-5.4" };
}

/** Pulls a trailing "Confidence: NN%" (or "Confidence: NN") line off the
 * end of the model's answer and returns the cleaned answer text plus the
 * parsed 0-100 number (clamped, and null if the line wasn't found/parseable
 * so a missing confidence line never silently becomes "0% confident"). */
function extractConfidence(rawAnswer: string): { answer: string; confidence: number | null } {
  const match = rawAnswer.match(/\n?\s*Confidence:\s*(\d{1,3})\s*%?\s*$/i);
  if (!match) {
    return { answer: rawAnswer.trim(), confidence: null };
  }
  const value = Math.max(0, Math.min(100, parseInt(match[1], 10)));
  const answer = rawAnswer.slice(0, match.index).trim();
  return { answer, confidence: value };
}

// Docs mode gets its own confidence instruction: a "your documents don't
// cover this" answer being a CORRECT read of the excerpts is a different
// thing from being a CONFIDENT, USEFUL answer to the user's actual
// question — showing a high % next to "I couldn't find this" reads as
// contradictory even when it's technically self-consistent. So this
// instruction ties the number to how well the question got answered, not
// just to how sure the model is that it read the excerpts correctly.
const DOCS_CONFIDENCE_INSTRUCTION =
  "After your answer, on its own new line, add exactly: Confidence: NN% — where NN is your own honest 0-100 estimate of how CONFIDENTLY AND FULLY the excerpts answer the user's actual question, not just how sure you are that you read the excerpts correctly. If the excerpts don't contain the answer, or only partially cover it, use a LOW number (well under 30) — 'I'm confident the documents don't say this' is still a low number here, because it means the user's question wasn't actually answered. Only use a high number (80+) when the excerpts directly and clearly answer what was asked. Do not explain the confidence number, just the single 'Confidence: NN%' line.";

// Safety net for the instruction above: don't trust the model to always
// follow it. If the answer text itself reads as a "not found in your
// documents" response, force the confidence number down (never hide it —
// the user explicitly asked to always see a number, even on a "not
// found" answer) rather than trust whatever the model happened to output.
// This doesn't depend on the model having picked a low number correctly.
const NOT_FOUND_PATTERN =
  /\b(don't|does not|doesn't|didn't|do not)\s+(mention|cover|contain|include|say|state|address)|\bnot\s+(mention|cover|contain|find|found|clear|available|present)\b|\bcouldn't find\b|\bno (information|mention|indication)\b|\bunclear (whether|if)\b|\bisn't (mentioned|clear|covered)\b/i;

function looksLikeNotFound(answer: string): boolean {
  return NOT_FOUND_PATTERN.test(answer);
}

// Cap applied to "not found" answers so the badge always reads low/honest
// regardless of what number the model actually picked.
const NOT_FOUND_CONFIDENCE_CAP = 15;

/** How many prior turns (user+assistant pairs) of Docs-mode conversation
 * history to carry forward. Kept short deliberately — this is meant to
 * resolve immediate follow-ups ("how long at the first one"), not act as
 * long-term memory, and a long history would eat into the character
 * budget better spent on actual document excerpts. */
const MAX_HISTORY_TURNS = 4;

/** How much of the most recent history to fold into the retrieval query
 * itself (see getRelevantContext's retrievalHint) — kept short so it
 * nudges retrieval toward the right chunk without drowning out the
 * current question's own terms. */
const RETRIEVAL_HINT_CHAR_BUDGET = 500;

function formatHistoryForPrompt(history: ConversationTurn[]): string {
  return history
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((t) => `${t.role === "user" ? "User" : "ClickAI"}: ${t.text}`)
    .join("\n");
}

function buildRetrievalHint(history: ConversationTurn[]): string | undefined {
  if (history.length === 0) return undefined;
  // Most recent turns carry the most useful pronoun/reference context —
  // take the tail end, trimmed to a char budget so one long previous
  // answer can't dominate the retrieval query.
  const recent = history.slice(-2).map((t) => t.text).join(" ");
  return recent.slice(-RETRIEVAL_HINT_CHAR_BUDGET) || undefined;
}

/** Runs a streamed Responses API call, forwarding each output-text delta to
 * `onDelta` as it arrives, and returns the full raw text once the stream
 * completes. Used by askDocs (2026-09-01, streaming) so
 * the actual streaming plumbing — wiring the delta event, awaiting
 * finalResponse() — only exists in one place.
 *
 * Deliberately NOT wrapped in withRetry: a transient failure could occur
 * after some deltas have already reached the renderer, and retrying would
 * either duplicate that text or require the caller to track and discard a
 * partial in-progress answer — not worth the complexity for what should be
 * a rare mid-stream failure. If it fails, it fails visibly and the user's
 * existing "↻ Regenerate" button re-asks cleanly from scratch. Retry
 * coverage stays on the calls that matter most for silently-transient
 * blips: embeddings (used on every single question, not just for Chat/Docs
 * responses) and OCR/transcription.
 */
async function streamResponseText(
  client: OpenAI,
  params: Record<string, any>,
  onDelta: OnDelta
): Promise<string> {
  // ROOT CAUSE FOUND (2026-09-02, live debugging with real request/response
  // logs): this used to read the final answer off `response.output_text`,
  // a convenience property the openai SDK normally computes for us. It
  // turns out that property is only ever populated on the SDK's
  // auto-parsing code path (structured outputs / .parse()) — for a plain
  // streamed call like this one, `finalResponse()`'s snapshot never gets
  // `output_text` set at all, even though the real answer text (confirmed
  // live, including the trailing "Confidence: NN%" line) is sitting right
  // there in `response.output[].content[].text`. This made every Chat/Docs
  // answer look like an empty "(no response)" even though the model was
  // answering correctly the whole time and the deltas were streaming in
  // fine — the bug was purely in how the FINAL text was read afterward,
  // not in the model call itself. (An earlier attempted fix guessed this
  // was a reasoning-token-budget issue and bumped max_output_tokens /
  // lowered reasoning effort — that guess was wrong, though the settings
  // are harmless to keep.)
  //
  // Fix: accumulate the text ourselves from the same
  // "response.output_text.delta" events already being forwarded to
  // `onDelta` — this is the actual text the model streamed, with no
  // dependency on the SDK's (buggy, for this code path) convenience
  // property. Falls back to walking response.output directly (mirroring
  // what output_text SHOULD contain) only in the unlikely case streaming
  // produced no deltas at all, e.g. a genuinely empty completion.
  let accumulated = "";
  const stream = (client.responses as any).stream(params);
  stream.on("response.output_text.delta", (event: any) => {
    if (event?.delta) {
      accumulated += event.delta;
      onDelta(event.delta);
    }
  });
  const response: any = await stream.finalResponse();

  if (accumulated) return accumulated;

  const fallbackText = (response?.output || [])
    .filter((item: any) => item?.type === "message")
    .flatMap((item: any) => item.content || [])
    .filter((c: any) => c?.type === "output_text")
    .map((c: any) => c.text)
    .join("");
  if (fallbackText) return fallbackText;

  console.error(
    "[ClickAI] No answer text from the model at all. status:", response?.status,
    "incomplete_details:", JSON.stringify(response?.incomplete_details),
    "output:", JSON.stringify(response?.output)?.slice(0, 2000)
  );
  const reason = response?.incomplete_details?.reason;
  throw new Error(
    reason === "max_output_tokens"
      ? "The model ran out of room to answer (it used its whole response budget on internal reasoning before writing anything). Try Regenerate, or ask a shorter/more specific question."
      : `The model didn't return any answer text (status: ${response?.status || "unknown"}${reason ? `, reason: ${reason}` : ""}). Try Regenerate.`
  );
}

/**
 * Docs mode: strict, document-grounded Q&A. Answers ONLY from whatever's
 * actually retrieved from the user's uploaded documents — no screenshot,
 * no web search, no filling gaps from the model's own general knowledge.
 * If nothing relevant is found, this says so plainly (and skips the model
 * call entirely in that case) rather than letting the model guess or
 * answer from outside knowledge, which is exactly the "made up answer"
 * behavior the user asked to eliminate. This is how the "R" in RAG is
 * supposed to work: retrieval defines and BOUNDS what the model is allowed
 * to answer from, not just a suggestion it can wander away from.
 *
 * `history` (2026-09-01): short recent conversation memory so a follow-up
 * like "how long at the first one" can resolve "the first one" against
 * what was just discussed. It's used two ways: (1) folded into the
 * retrieval query so the RIGHT chunks get found for a vague follow-up, and
 * (2) included as plain context text in the prompt so the model can
 * resolve the reference — but the instructions are explicit that the
 * documents' excerpts, not the conversation history, remain the only
 * source of actual facts in the answer.
 *
 * `onDelta` (2026-09-01, streaming): called with each raw text chunk as it
 * streams in, so the UI can show the answer materializing. Optional and
 * defaults to a no-op, so this still works as a plain one-shot call for
 * anything that doesn't care about streaming.
 * by default. When retrieval finds nothing (the early-return path below),
 * there's no model call at all, so onDelta simply never fires — the caller
 * just gets the canned answer directly in the returned AskResult.
 */
/** Answer cache (2026-09-11, spec section 29 "Answer Cache"): a repeated
 * IDENTICAL question (same session, same document scope, same model, same
 * prior conversation, same exact wording modulo case/whitespace) skips
 * retrieval, reranking, AND generation entirely and returns the same
 * AskResult instantly. Deliberately narrow -- history is part of the key,
 * not ignored, so a follow-up question is never accidentally served a
 * cached answer meant for a different conversational context. Invalidated
 * automatically whenever this session's documents change at all (see
 * ragStore.ts's addDocument, which clears the whole per-session answer
 * cache on every upload) -- there's no plausible way for a cached answer
 * to go stale otherwise, since nothing else in a session's document set
 * changes underneath a question. */
function normalizeQuestionForCache(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildAnswerCacheKey(model: string, docId: string | undefined, history: ConversationTurn[], prompt: string): string {
  const historyKey = history.map((h) => `${h.role}:${h.text}`).join("||");
  return `${model}::${docId ?? "ALL"}::${historyKey}::${normalizeQuestionForCache(prompt)}`;
}

export async function askDocs(
  /** Which user/session this question belongs to (2026-09-08,
   * multi-session isolation) — threaded through to ragStore so a
   * question only ever draws on ITS OWN uploaded documents, never
   * another logged-in browser tab's. The desktop app always passes the
   * same fixed id (main.ts's DESKTOP_SESSION_ID). */
  sessionId: string,
  prompt: string,
  history: ConversationTurn[] = [],
  onDelta: OnDelta = () => {},
  /** Restricts this question to one uploaded document instead of all of
   * them (2026-09-02, "separate chat per document") — set when the user
   * has a specific document selected in the sidebar rather than "All
   * documents". */
  docId?: string
): Promise<AskResult> {
  const requestId = randomUUID();
  const askStart = Date.now();

  const cacheKey = buildAnswerCacheKey(store.get("model") || "gpt-5.4", docId, history, prompt);
  const cached = getCachedAnswer(sessionId, cacheKey);
  if (cached) {
    return cached as AskResult;
  }

  const retrievalHint = buildRetrievalHint(history);
  let docContext;
  try {
    docContext = await getRelevantContext(sessionId, prompt, retrievalHint, docId);
  } catch (err: any) {
    logError({ stage: "retrieval", message: err.message || String(err), question: prompt, docId });
    throw err;
  }

  if (!docContext) {
    const scopedDoc = docId ? listDocuments(sessionId).find((d) => d.id === docId) : undefined;
    // Logged even on the "nothing retrieved" path (2026-09-08 logging
    // system) — this is exactly the case the small-candidate-pool bug
    // (2026-09-08) and the relevance-floor bug (2026-09-03) both produced,
    // so it's worth being able to see how often it's happening over time,
    // not just when something outright errors.
    logPerf({
      requestId,
      question: prompt,
      docId,
      docName: scopedDoc?.name,
      candidateCount: 0,
      reranked: false,
      confidence: NOT_FOUND_CONFIDENCE_CAP,
      embedMs: Date.now() - askStart,
      rerankMs: 0,
      answerMs: 0,
      totalMs: Date.now() - askStart,
      chunksUsed: [],
    });
    const notFoundResult: AskResult = {
      answer: scopedDoc
        ? `I couldn't find anything relevant to that in "${scopedDoc.name}". Try rephrasing the question, or switch to a different document.`
        : "I couldn't find anything relevant to that in your uploaded documents. Try rephrasing the question, or check that you've uploaded the right document.",
      sources: [],
      // Always show a number, even here — the user asked never to hide the
      // badge, so a "nothing retrieved at all" answer gets the same low,
      // honest confidence as any other not-found answer rather than no
      // badge at all.
      confidence: NOT_FOUND_CONFIDENCE_CAP,
    };
    setCachedAnswer(sessionId, cacheKey, notFoundResult);
    return notFoundResult;
  }

  const { client, model } = getClient();

  const historyText = formatHistoryForPrompt(history);
  const textPrompt = `${
    historyText
      ? `Conversation so far (for resolving references like "it" or "the first one" ONLY — not a source of facts):\n${historyText}\n\n`
      : ""
  }Document excerpts:\n\n${docContext.contextText}\n\nUser's question: ${prompt}`;

  const instructionLines = [
    "You are ClickAI's document assistant. Answer STRICTLY and ONLY using the document excerpts provided below — nothing else.",
    "Do not use your own general knowledge, do not search the web (you have no web access here), and do not guess or fill in gaps with assumptions.",
    "The conversation-so-far text, if present, is ONLY there to help you resolve what a pronoun or phrase like 'it' or 'the first one' refers to — never treat anything stated only in the prior conversation as a fact by itself; every fact in your answer must still come from the document excerpts.",
    "Cite which excerpt number(s) you used inline like [1] or [2] — don't cite excerpts you didn't actually use.",
    "If the excerpts only partially answer the question, say plainly what they do cover and what they don't — do not extrapolate beyond what's written.",
    "If the excerpts don't contain the answer at all, say clearly that your uploaded documents don't cover this — do not attempt to answer from anything else.",
    "Give clear, concise answers.",
    DOCS_CONFIDENCE_INSTRUCTION,
  ];

  const answerStart = Date.now();
  let rawAnswer: string;
  try {
    rawAnswer = await streamResponseText(
      client,
      {
        model,
        instructions: instructionLines.join(" "),
        input: [{ role: "user", content: [{ type: "input_text", text: textPrompt }] }],
        // Deliberately NO tools/web_search here — Docs mode must stay grounded
        // in the uploaded documents only.
        // Bumped 1000 -> 3000 (2026-09-02) — this is the exact bug a live "leave policy"
        // question hit (retrieval worked, sources/excerpts were correct, but
        // the answer text came back empty).
        max_output_tokens: 3000,
        ...reasoningParams(model),
      },
      onDelta
    );
  } catch (err: any) {
    logError({ stage: "answer", message: err.message || String(err), question: prompt, docId });
    throw err;
  }
  const answerMs = Date.now() - answerStart;

  const { answer, confidence } = extractConfidence(rawAnswer);

  // Belt-and-suspenders: even if the model didn't follow the low-confidence
  // instruction above, force a "not found in your documents" style answer
  // down to a low, honest number — always a real badge, never hidden, and
  // never allowed to read as falsely confident.
  let safeConfidence = confidence;
  if (looksLikeNotFound(answer)) {
    safeConfidence = Math.min(confidence ?? NOT_FOUND_CONFIDENCE_CAP, NOT_FOUND_CONFIDENCE_CAP);
  } else if (safeConfidence === null) {
    // The model always adds a confidence line per the instruction above,
    // but if parsing ever fails, still show something rather than no badge.
    safeConfidence = 50;
  }

  // One combined per-question log entry (2026-09-08 logging system) —
  // retrieval's own embed/rerank timing came back attached to docContext,
  // this call's own answer timing was just measured above.
  logPerf({
    requestId,
    question: prompt,
    docId,
    docName: docId ? listDocuments(sessionId).find((d) => d.id === docId)?.name : undefined,
    candidateCount: docContext.perf.candidateCount,
    reranked: docContext.perf.reranked,
    confidence: safeConfidence,
    embedMs: docContext.perf.embedMs,
    rerankMs: docContext.perf.rerankMs,
    answerMs,
    totalMs: Date.now() - askStart,
    // Full per-chunk detail (2026-09-07, "log everything, even chunking
    // and which chunk used") — exactly the excerpts this answer was
    // grounded in, with id/doc/page/score/strategy/full text.
    chunksUsed: docContext.excerpts.map((e) => ({
      index: e.index,
      chunkId: e.chunkId,
      docId: e.docId,
      docName: e.docName,
      page: e.page,
      score: e.score,
      chunkingStrategy: e.chunkingStrategy,
      text: e.text,
    })),
  });

  const result: AskResult = {
    answer,
    sources: docContext.sources,
    confidence: safeConfidence,
    excerpts: docContext.excerpts,
  };
  setCachedAnswer(sessionId, cacheKey, result);
  return result;
}
