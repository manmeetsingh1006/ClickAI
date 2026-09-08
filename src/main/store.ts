import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChunkingStrategy, DEFAULT_CHUNKING_STRATEGY } from "./chunking";

/**
 * Small JSON-file-backed settings store (2026-09-02) — replaces
 * electron-store so this module has no Electron dependency and can be
 * shared by both the desktop app (main.ts) and the standalone web server
 * (src/server/server.ts), which runs as plain Node with no `electron`
 * module available at all. Both versions read/write the SAME file, so
 * settings (API key, model) saved from one are visible in the other.
 *
 * Location matches where Electron's `app.getPath("userData")` would have
 * put it on macOS, so existing desktop-app users keep their saved
 * settings after this change.
 */
interface ClickAIConfig {
  apiKey: string;
  model: string;
  hotkey: string;
  /** Selected chunking strategy (2026-09-07) — see chunking.ts. Persisted
   * so a choice made in Settings survives a restart/relaunch, same as
   * apiKey/model/hotkey. */
  chunkingStrategy: ChunkingStrategy;
  /** Target chunk size / overlap in characters (2026-09-08) — previously
   * hardcoded defaults in ragStore.ts's chunkText(), now user-adjustable
   * in Settings. Only affects documents uploaded AFTER a change; existing
   * chunks keep whatever size they were created with (same rule as
   * chunkingStrategy). */
  chunkMaxChars: number;
  chunkOverlapChars: number;
  /** Embedding model (2026-09-08) — see embeddings.ts's EMBEDDING_MODEL_INFO
   * for the allowed set. Only affects documents embedded AFTER a change;
   * each chunk records which model it was embedded with (Chunk.embeddingModel
   * in ragStore.ts) so retrieval can embed the query with the matching
   * model per chunk rather than assuming every chunk in the pool used the
   * model currently selected. */
  embeddingModel: string;
  /** Whether the LLM reranking pass (ragStore.ts's rerankCandidates())
   * runs at all (2026-09-08) — lets a user compare hybrid-only retrieval
   * against hybrid+rerank, or turn reranking off entirely to save the
   * extra API call/latency per question. Defaults to on: reranking is
   * what fixed two real relevance bugs this project hit (2026-09-03,
   * 2026-09-08), so it should stay on unless the user deliberately wants
   * it off. */
  rerankingEnabled: boolean;
}

const defaults: ClickAIConfig = {
  apiKey: "",
  model: "gpt-5.4",
  hotkey: "CommandOrControl+Shift+Space",
  chunkingStrategy: DEFAULT_CHUNKING_STRATEGY,
  chunkMaxChars: 1400,
  chunkOverlapChars: 190,
  embeddingModel: "text-embedding-3-small",
  rerankingEnabled: true,
};

export function configDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "ClickAI");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), "ClickAI");
  }
  return path.join(os.homedir(), ".config", "ClickAI");
}

const CONFIG_PATH = path.join(configDir(), "config.json");

function readAll(): ClickAIConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

function writeAll(config: ClickAIConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

class JsonStore {
  get<K extends keyof ClickAIConfig>(key: K): ClickAIConfig[K] {
    return readAll()[key];
  }
  set<K extends keyof ClickAIConfig>(key: K, value: ClickAIConfig[K]): void {
    const config = readAll();
    config[key] = value;
    writeAll(config);
  }
}

export const store = new JsonStore();
