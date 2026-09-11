import express from "express";
import multer from "multer";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { randomUUID } from "crypto";

import { store } from "../main/store";
import { askDocs, ConversationTurn } from "../main/openai";
import * as ragStore from "../main/ragStore";
import { CHUNKING_STRATEGY_INFO, isChunkingStrategy } from "../main/chunking";
import { isEmbeddingModel, EMBEDDING_MODEL_INFO } from "../main/embeddings";
import { runEvalSuite, getEvalHistory, isEvalCase, EvalCase } from "../main/evals";
import { flagAnswer, getFlaggedAnswers, isFlagInput } from "../main/flags";
import {
  validateCredentials,
  createSession,
  getSession,
  touchSession,
  destroySession,
  setSessionDestroyedHandler,
  parseCookies,
  serializeSessionCookie,
  serializeExpiredSessionCookie,
  SESSION_COOKIE_NAME,
} from "../main/authStore";

/**
 * ClickAI Web (2026-09-02) — a plain Node/Express server exposing the same
 * Docs (document Q&A) logic as the desktop app, for the user in a normal
 * browser tab instead of an installed .app. Built after packaging kept
 * hitting unsigned-app friction (Gatekeeper/XProtect scans on every
 * rebuild) — `npm run web` needs no code signing, no .dmg, no
 * notarization at all.
 *
 * Deliberately drops the desktop-only overlay features per explicit user
 * choice: no global hotkey, no always-on-top overlay window, no automatic
 * screen capture, no tray icon, no "Launch at Login". Chat mode (general
 * assistant + web search) was removed entirely (2026-09-02, explicit user
 * request) — Docs is ClickAI's only mode now, on both desktop and web.
 *
 * Shares src/main/{openai,ragStore,store,retry,embeddings,docParsers}.ts
 * verbatim with the desktop app (those were already Electron-free except
 * for two trivial calls — see store.ts and ragStore.ts's 2026-09-02
 * comments) — same settings file, same RAG pipeline, same confidence
 * badge/citation/retry behavior.
 *
 * Login + per-session document isolation (2026-09-08, explicit user
 * request: "create a login page and create temporary username superadmin
 * and password superadmin", plus the earlier request this unlocks — a
 * document, once processed, should stay available across a refresh or a
 * short absence, and should be wiped for good on logout or when the
 * session goes idle/abandoned). Every uploaded document lives in
 * ragStore's per-sessionId index (see ragStore.ts's SessionState) keyed
 * by an httpOnly session cookie minted at login — so two different
 * logged-in tabs never see each other's documents, a refresh keeps
 * whatever was already uploaded (no reprocessing, no re-login), and
 * logging out (or 30 minutes of inactivity — see authStore.ts's
 * IDLE_TIMEOUT_MS) deletes that session's documents/chunks/embeddings and
 * temp files for good. Nothing about a session is ever written to disk —
 * both the session record itself and its documents live only in this
 * process's memory, so a server restart also clears everything.
 *
 * Deliberately does NOT try to wipe a session's documents the instant a
 * tab is closed (there used to be a beforeunload -> sendBeacon("/api/
 * docs/clear") handler in public/app.js that did exactly this — removed
 * here). A browser's unload events fire on an ordinary REFRESH just as
 * much as on an actual close, and there's no reliable client-side way to
 * tell those apart — wiring immediate cleanup to it would have silently
 * broken the very "survives a refresh" behavior this feature exists to
 * provide. The idle-timeout sweep in authStore.ts is the honest
 * alternative: it can't react instantly, but it's the backstop that
 * actually works when a tab is closed without logging out — nothing
 * client-side is trustworthy enough to do better than that.
 */

const PORT = Number(process.env.PORT) || 4173;
const app = express();

app.use(express.json({ limit: "1mb" }));

// Wires a destroyed session (logout, or the idle sweep) to actually purge
// that session's documents/chunks/embeddings/temp files — see
// ragStore.ts's clearAll(sessionId). authStore.ts never imports ragStore
// itself; this is the one place the two are connected.
// Rate limiting (2026-09-11, spec-driven cost/abuse control -- section 39
// "Rate Limiting"): this is a small shared web deployment (one temporary
// login, not per-user billing), so the goal here is just bounding
// worst-case cost/abuse from a single misbehaving client, not fair-use
// accounting across many tenants. Both limits are in-memory and
// session-scoped, cleaned up alongside everything else when a session
// ends (see setSessionDestroyedHandler below).
const MAX_QUESTIONS_PER_MINUTE = 20;
const MAX_DOCS_PER_SESSION = 50;
const questionTimestamps = new Map<string, number[]>(); // sessionId -> recent question times (ms)

/** Sliding-window check: true if this session may ask another question
 * right now (and records that it did); false if it's over the per-minute
 * limit. A plain array-of-timestamps sliding window rather than a token
 * bucket -- simple, and at this scale (one shared login, <=20/min) the
 * O(n) prune on each call is negligible. */
function checkQuestionRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const recent = (questionTimestamps.get(sessionId) || []).filter((t) => t > windowStart);
  if (recent.length >= MAX_QUESTIONS_PER_MINUTE) {
    questionTimestamps.set(sessionId, recent);
    return false;
  }
  recent.push(now);
  questionTimestamps.set(sessionId, recent);
  return true;
}

setSessionDestroyedHandler((sessionId) => {
  ragStore.clearAll(sessionId);
  questionTimestamps.delete(sessionId);
});

/** Reads the session cookie off a request and returns its (still-valid,
 * not idle-timed-out) session record, or null. Does not create anything —
 * callers that require auth check the result themselves (see
 * requireAuth). */
function sessionFromRequest(req: express.Request): { sessionId: string; username: string } | null {
  const cookies = parseCookies(req.headers.cookie);
  const record = getSession(cookies[SESSION_COOKIE_NAME]);
  return record ? { sessionId: record.sessionId, username: record.username } : null;
}

/** Express middleware: every /api/* route except /api/login requires a
 * valid session cookie, otherwise responds 401 rather than silently
 * operating on no session (which, pre-login-system, is exactly what let
 * every visitor share one global document index). A successful check
 * also touches the session so normal usage keeps it alive across the
 * IDLE_TIMEOUT_MS window instead of expiring mid-conversation. */
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session = sessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "Not logged in." });
    return;
  }
  touchSession(session.sessionId);
  (req as any).sessionId = session.sessionId;
  next();
}

// Upload hardening (2026-09-11): the multi-modal RAG spec's cost/security
// controls explicitly call out per-file size and per-request file-count
// caps as baseline protection against a careless or malicious upload
// (e.g. someone uploading a multi-GB file) -- upload.array's "20" arg
// already caps file COUNT per request, but there was no cap on individual
// file SIZE at all before this, so multer would happily buffer an
// arbitrarily large file to disk. 100MB comfortably covers real documents
// (the in-app "large file" warning starts at 20MB) while still bounding
// worst-case disk/memory use per upload.
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const upload = multer({
  dest: path.join(os.tmpdir(), "clickai-web-uploads"),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES },
});

// ---- Auth ----
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || !validateCredentials(username, password)) {
    res.status(401).json({ error: "Incorrect username or password." });
    return;
  }
  const session = createSession(username);
  res.setHeader("Set-Cookie", serializeSessionCookie(session.sessionId));
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId) destroySession(sessionId); // also purges this session's documents, see setSessionDestroyedHandler above
  res.setHeader("Set-Cookie", serializeExpiredSessionCookie());
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  const session = sessionFromRequest(req);
  if (session) touchSession(session.sessionId);
  res.json({ loggedIn: !!session });
});

// ---- Static assets + the login gate on "/" ----
// `index: false` so express.static never auto-serves public/index.html
// for a bare "/" request -- that request instead falls through to the
// explicit app.get("/") below, which decides between the app and a
// redirect to the login page based on whether the request carries a
// valid session cookie. Every other static file (style.css, app.js,
// login.html itself, fonts, etc.) is still served normally by this same
// middleware -- none of that is sensitive, so it doesn't need gating.
app.use(express.static(path.join(__dirname, "../../public"), { index: false }));

app.get("/", (req, res) => {
  const session = sessionFromRequest(req);
  if (!session) {
    res.redirect("/login.html");
    return;
  }
  touchSession(session.sessionId);
  res.sendFile(path.join(__dirname, "../../public/index.html"));
});

// ---- Streaming helper ----
// /api/docs streams newline-delimited JSON events over a single chunked
// HTTP response body:
//   {"type":"delta","delta":"..."}
//   {"type":"done","result":{...}}
//   {"type":"error","message":"..."}
// The browser reads this with fetch()'s streaming body reader (see
// public/app.js) — no separate requestId tagging is needed the way the
// desktop app's shared-IPC-channel design needed it, because each HTTP
// request here already has its own private response stream.
function startStream(res: express.Response) {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  return {
    delta: (delta: string) => res.write(JSON.stringify({ type: "delta", delta }) + "\n"),
    done: (result: unknown) => {
      res.write(JSON.stringify({ type: "done", result }) + "\n");
      res.end();
    },
    error: (message: string) => {
      res.write(JSON.stringify({ type: "error", message }) + "\n");
      res.end();
    },
  };
}

app.post("/api/docs", requireAuth, async (req, res) => {
  const sessionId: string = (req as any).sessionId;
  if (!checkQuestionRateLimit(sessionId)) {
    res.status(429).json({ error: "You're asking questions faster than I can keep up with — wait a moment and try again." });
    return;
  }
  const stream = startStream(res);
  try {
    const prompt = String(req.body?.prompt || "");
    const history: ConversationTurn[] = Array.isArray(req.body?.history) ? req.body.history : [];
    const docId: string | undefined = typeof req.body?.docId === "string" ? req.body.docId : undefined;
    const result = await askDocs(sessionId, prompt, history, (delta: string) => stream.delta(delta), docId);
    stream.done(result);
  } catch (err: any) {
    stream.error(err.message || String(err));
  }
});

// ---- Settings ----
// Settings (API key, model, chunking config) stay GLOBAL, not per-session
// -- they're this deployment's own OpenAI account/preferences, not
// per-user data, and the login system here is one shared temporary
// credential rather than real multi-tenant accounts (see authStore.ts).
app.get("/api/settings", requireAuth, (_req, res) => {
  res.json({
    apiKey: store.get("apiKey"),
    model: store.get("model"),
    chunkingStrategy: store.get("chunkingStrategy"),
    chunkingStrategies: CHUNKING_STRATEGY_INFO,
    chunkMaxChars: store.get("chunkMaxChars"),
    chunkOverlapChars: store.get("chunkOverlapChars"),
    embeddingModel: store.get("embeddingModel"),
    embeddingModels: EMBEDDING_MODEL_INFO,
    rerankingEnabled: store.get("rerankingEnabled"),
  });
});

app.post("/api/settings", requireAuth, (req, res) => {
  const { apiKey, model, chunkingStrategy, chunkMaxChars, chunkOverlapChars, embeddingModel, rerankingEnabled } = req.body || {};
  if (typeof apiKey === "string") store.set("apiKey", apiKey);
  if (typeof model === "string") store.set("model", model);
  if (isChunkingStrategy(chunkingStrategy)) store.set("chunkingStrategy", chunkingStrategy);
  if (Number.isFinite(chunkMaxChars) && chunkMaxChars > 0) store.set("chunkMaxChars", Math.round(chunkMaxChars));
  if (Number.isFinite(chunkOverlapChars) && chunkOverlapChars >= 0) store.set("chunkOverlapChars", Math.round(chunkOverlapChars));
  if (isEmbeddingModel(embeddingModel)) store.set("embeddingModel", embeddingModel);
  if (typeof rerankingEnabled === "boolean") store.set("rerankingEnabled", rerankingEnabled);
  res.json({ ok: true });
});

// ---- Evals (2026-09-08) ----
app.post("/api/evals", requireAuth, async (req, res) => {
  const sessionId: string = (req as any).sessionId;
  try {
    const cases = req.body?.cases;
    if (!Array.isArray(cases) || cases.length === 0 || !cases.every(isEvalCase)) {
      res.status(400).json({ error: 'Provide a non-empty array of eval cases, each with a "question" and an "expectedKeywords" array.' });
      return;
    }
    const run = await runEvalSuite(sessionId, cases as EvalCase[]);
    res.json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/evals/history", requireAuth, (_req, res) => {
  res.json({ runs: getEvalHistory() });
});

// ---- Human-in-the-loop flagging (2026-09-08) ----
app.post("/api/flags", requireAuth, (req, res) => {
  const flag = req.body;
  if (!isFlagInput(flag)) {
    res.status(400).json({ error: 'A flag needs at least "question" and "answer".' });
    return;
  }
  res.json(flagAnswer(flag));
});

app.get("/api/flags", requireAuth, (_req, res) => {
  res.json({ flags: getFlaggedAnswers() });
});

// ---- Documents ----
app.get("/api/docs/list", requireAuth, (req, res) => {
  res.json({ docs: ragStore.listDocuments((req as any).sessionId) });
});

app.post("/api/docs/clear", requireAuth, (req, res) => {
  ragStore.clearAll((req as any).sessionId);
  res.json({ ok: true });
});

// multer's file-size/count limit errors (MulterError) throw BEFORE the
// route handler runs, so they'd otherwise fall through to Express's
// default HTML error page -- this wraps upload.array(...) so a
// too-large file or too-many-files request gets the same clean JSON
// error shape as every other failure mode in this route (2026-09-11).
function handleUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
  upload.array("files", 20)(req, res, (err: any) => {
    if (!err) {
      next();
      return;
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: `File too large — the max upload size is ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)}MB per file.` });
      return;
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(400).json({ error: "Too many files in one upload — try uploading fewer at a time." });
      return;
    }
    res.status(400).json({ error: err.message || "Upload failed." });
  });
}

app.post("/api/docs/upload", requireAuth, handleUpload, async (req, res) => {
  const sessionId: string = (req as any).sessionId;
  const files = (req.files as Express.Multer.File[]) || [];

  // Per-session document count cap (2026-09-11, spec section 39/40) --
  // bounds worst-case in-memory growth (every chunk/embedding for every
  // document lives in process memory for the life of the session, see
  // ragStore.ts's SessionState) from one session uploading an unbounded
  // number of documents.
  const existingCount = ragStore.listDocuments(sessionId).length;
  if (existingCount + files.length > MAX_DOCS_PER_SESSION) {
    res.status(400).json({
      error: `This session already has ${existingCount} document${existingCount === 1 ? "" : "s"} — the limit is ${MAX_DOCS_PER_SESSION} per session. Clear some documents first, or log out and back in to start a fresh session.`,
    });
    return;
  }

  const added: ragStore.DocSummary[] = [];
  const errors: { fileName: string; message: string }[] = [];

  // Multiple uploaded files now process CONCURRENTLY (2026-09-07, same
  // fix as the desktop app's addDocumentPaths in main.ts) instead of one
  // strictly after another -- safe because the embedding call volume
  // itself is capped by the shared concurrency limiter in embeddings.ts
  // regardless of how many files/documents are in flight at once.
  await Promise.all(
    files.map(async (file) => {
      // multer names the temp file with a random hash and no extension;
      // ragStore.addDocument needs the ORIGINAL extension to detect the
      // file type, so copy it once more under its real name before
      // handing it off — the original upload temp file is removed either
      // way. randomUUID() keeps concurrent same-named files from
      // colliding on the same temp path.
      const namedPath = path.join(path.dirname(file.path), `${randomUUID()}-${file.originalname}`);
      fs.renameSync(file.path, namedPath);
      try {
        const summary = await ragStore.addDocument(sessionId, namedPath, () => {});
        added.push(summary);
      } catch (err: any) {
        errors.push({ fileName: file.originalname, message: err.message || String(err) });
      } finally {
        fs.unlink(namedPath, () => {});
      }
    })
  );

  res.json({ added, errors });
});

// Bind with no explicit host so Node listens on both IPv4 and IPv6
// loopback (127.0.0.1 AND ::1) — binding to "127.0.0.1" alone caused
// "localhost" to fail with connection-refused for users whose browser/OS
// resolves "localhost" to the IPv6 loopback address first (common on
// modern macOS), even though the server was running fine the whole time.
app.listen(PORT, () => {
  console.log(`[ClickAI Web] Listening at http://localhost:${PORT}`);
});
