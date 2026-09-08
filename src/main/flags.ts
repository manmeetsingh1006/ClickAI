import * as fs from "fs";
import * as path from "path";
import { configDir } from "./store";

/**
 * Human-in-the-loop feedback log (2026-09-08, explicit user request). A
 * person reviewing an answer can flag it as wrong/questionable directly
 * from the turn it came from — this is the "human in the loop" step:
 * ClickAI's own confidence score is a self-reported heuristic (see
 * openai.ts), not a real accuracy measure, so a person's judgment is the
 * actual signal this logs. Every flag is appended (never overwritten) to
 * flagged-answers.jsonl, durable across restarts, and doubles as a
 * natural source of eval cases (see evals.ts) — a flagged
 * question/answer pair is exactly the kind of thing worth turning into a
 * regression case with the CORRECT expected keywords once you know what
 * the answer should have said.
 */

export interface FlaggedAnswer {
  timestamp: string;
  docId?: string;
  docName?: string;
  question: string;
  answer: string;
  /** Optional free-text note on WHY it was flagged — what was wrong,
   * what the correct answer should have been, etc. */
  note?: string;
}

function flagsPath(): string {
  return path.join(configDir(), "flagged-answers.jsonl");
}

export function isFlagInput(value: any): value is Omit<FlaggedAnswer, "timestamp"> {
  return value && typeof value.question === "string" && value.question.trim().length > 0 && typeof value.answer === "string";
}

export function flagAnswer(flag: Omit<FlaggedAnswer, "timestamp">): FlaggedAnswer {
  const record: FlaggedAnswer = { ...flag, timestamp: new Date().toISOString() };
  fs.mkdirSync(configDir(), { recursive: true });
  fs.appendFileSync(flagsPath(), JSON.stringify(record) + "\n", "utf-8");
  return record;
}

const FLAG_HISTORY_LIMIT_DEFAULT = 50;

export function getFlaggedAnswers(limit: number = FLAG_HISTORY_LIMIT_DEFAULT): FlaggedAnswer[] {
  try {
    const raw = fs.readFileSync(flagsPath(), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const flags = lines.map((l) => JSON.parse(l) as FlaggedAnswer);
    return flags.slice(-limit).reverse(); // most recent first
  } catch {
    return [];
  }
}
