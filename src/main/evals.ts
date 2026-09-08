import * as fs from "fs";
import * as path from "path";
import { askDocs, AskResult } from "./openai";
import { configDir } from "./store";

/**
 * Lightweight eval harness (2026-09-08, explicit user request). Each case
 * is a real question run through the REAL askDocs() pipeline (same code
 * path a user hits — embed, hybrid score, rerank, answer), graded by
 * whether the answer contains all of a case's expected keywords
 * (case-insensitive substring match). Deliberately NOT graded by a second
 * LLM call — that would add its own cost, latency, and judgment-quality
 * question on top of the thing being measured, for a self-hosted app
 * where the person running the eval already knows what a correct answer
 * should mention.
 *
 * Running a suite costs real API calls (embeddings + retrieval + an
 * answer per case), same as asking those questions normally — this
 * module builds the harness, it doesn't avoid that cost, since there's no
 * way to meaningfully eval real retrieval quality without actually
 * retrieving.
 */

export interface EvalCase {
  /** Optional label for readability in results/history — defaults to the
   * question itself if omitted. */
  label?: string;
  question: string;
  /** Restricts this case to one uploaded document's chunks, same as the
   * docId param elsewhere — omit to search all uploaded documents. */
  docId?: string;
  /** Every one of these must appear (case-insensitive substring) in the
   * answer for the case to pass. */
  expectedKeywords: string[];
}

export interface EvalCaseResult {
  label: string;
  question: string;
  passed: boolean;
  answer: string;
  confidence: number | null;
  missingKeywords: string[];
}

export interface EvalRun {
  timestamp: string;
  passCount: number;
  totalCount: number;
  results: EvalCaseResult[];
}

function evalHistoryPath(): string {
  return path.join(configDir(), "eval-results.jsonl");
}

export function isEvalCase(value: any): value is EvalCase {
  return (
    value &&
    typeof value.question === "string" &&
    value.question.trim().length > 0 &&
    Array.isArray(value.expectedKeywords) &&
    value.expectedKeywords.every((k: any) => typeof k === "string")
  );
}

export async function runEvalCase(sessionId: string, evalCase: EvalCase): Promise<EvalCaseResult> {
  const result: AskResult = await askDocs(sessionId, evalCase.question, [], () => {}, evalCase.docId);
  const answerLower = result.answer.toLowerCase();
  const missingKeywords = evalCase.expectedKeywords.filter((kw) => !answerLower.includes(kw.toLowerCase()));
  return {
    label: evalCase.label || evalCase.question,
    question: evalCase.question,
    passed: missingKeywords.length === 0,
    answer: result.answer,
    confidence: result.confidence,
    missingKeywords,
  };
}

const MAX_EVAL_CASES_PER_RUN = 25; // sanity cap — a suite is meant to be a curated regression set, not a bulk job

/** Runs every case (sequentially — the point is to see how retrieval
 * behaves under normal, one-question-at-a-time conditions, not to stress
 * the API) and appends the run as ONE line to eval-results.jsonl —
 * "checkpointing" in the sense that nothing is overwritten, so a user can
 * compare pass rates across runs made before/after a settings change
 * (chunking strategy, chunk size, embedding model, reranking toggle). */
export async function runEvalSuite(sessionId: string, cases: EvalCase[]): Promise<EvalRun> {
  if (cases.length === 0) {
    throw new Error("No eval cases provided.");
  }
  if (cases.length > MAX_EVAL_CASES_PER_RUN) {
    throw new Error(`Too many eval cases (${cases.length}) — max ${MAX_EVAL_CASES_PER_RUN} per run.`);
  }
  const invalid = cases.find((c) => !isEvalCase(c));
  if (invalid) {
    throw new Error('Each eval case needs a non-empty "question" and an "expectedKeywords" array of strings.');
  }

  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    results.push(await runEvalCase(sessionId, c));
  }

  const run: EvalRun = {
    timestamp: new Date().toISOString(),
    passCount: results.filter((r) => r.passed).length,
    totalCount: results.length,
    results,
  };

  fs.mkdirSync(configDir(), { recursive: true });
  fs.appendFileSync(evalHistoryPath(), JSON.stringify(run) + "\n", "utf-8");

  return run;
}

const EVAL_HISTORY_LIMIT_DEFAULT = 20;

export function getEvalHistory(limit: number = EVAL_HISTORY_LIMIT_DEFAULT): EvalRun[] {
  try {
    const raw = fs.readFileSync(evalHistoryPath(), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const runs = lines.map((l) => JSON.parse(l) as EvalRun);
    return runs.slice(-limit).reverse(); // most recent first
  } catch {
    return [];
  }
}
