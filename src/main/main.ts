import { app, BrowserWindow, globalShortcut, ipcMain, screen, dialog, Tray, Menu, nativeImage } from "electron";
import * as path from "path";
import * as fs from "fs";
import { store } from "./store";
import { askDocs } from "./openai";
import * as ragStore from "./ragStore";
import { isChunkingStrategy, CHUNKING_STRATEGY_INFO } from "./chunking";
import { isEmbeddingModel, EMBEDDING_MODEL_INFO } from "./embeddings";
import { runEvalSuite, getEvalHistory, isEvalCase, EvalCase } from "./evals";
import { flagAnswer, getFlaggedAnswers, isFlagInput } from "./flags";

let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/** The desktop app's single, fixed session id (2026-09-08, multi-session
 * isolation) — desktop has no login/multi-user concept, so it always
 * passes this same constant to every ragStore/askDocs/evals call instead
 * of a real per-browser-tab session id the way the web app does (see
 * server.ts's per-request cookie-derived session id). Functionally
 * identical to how ragStore behaved before this change: exactly one
 * shared document index for the app's whole lifetime. */
const DESKTOP_SESSION_ID = "desktop-local";

/** Resolves an asset path that works both in dev (running from dist/main
 * against the project's top-level assets/ folder) and in a packaged build
 * (electron-builder copies "assets" into the app's resources directory —
 * see the "extraResources" entry in package.json's build config). */
function getAssetPath(...segments: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "assets")
    : path.join(__dirname, "../../assets");
  return path.join(base, ...segments);
}

function createOverlayWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const winWidth = 420;
  const winHeight = 620;

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: screenWidth - winWidth - 24,
    y: screenHeight - winHeight - 24,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));

  return win;
}

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = createOverlayWindow();
  }

  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
    return;
  }

  overlayWindow.show();
  overlayWindow.focus();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const hotkey = store.get("hotkey") || "CommandOrControl+Shift+Space";
  const ok = globalShortcut.register(hotkey, () => {
    console.log(`[ClickAI] Hotkey pressed: ${hotkey}`);
    toggleOverlay();
  });
  console.log(`[ClickAI] Hotkey "${hotkey}" registration ${ok ? "SUCCEEDED" : "FAILED"}`);
}

/** Menu-bar tray icon (2026-09-01) — a discoverable, always-visible way to
 * open ClickAI and quit it, since previously the ONLY way in was memorizing
 * the global hotkey, and the only way to actually quit (the app
 * deliberately keeps running when the overlay window closes, like a
 * menu-bar app) was Cmd+Q or Activity Monitor. Rebuilding the menu each
 * time isn't expensive and keeps the "Launch at Login" checkmark in sync
 * with the real OS-level setting rather than a separately stored value
 * that could drift from it. */
function buildTrayMenu(): Menu {
  const loginSettings = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    {
      label: "Show ClickAI",
      click: () => toggleOverlay(),
    },
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: loginSettings.openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    {
      label: "Quit ClickAI",
      click: () => app.quit(),
    },
  ]);
}

function createTray() {
  try {
    const iconPath = getAssetPath("trayTemplate.png");
    if (!fs.existsSync(iconPath)) {
      console.warn("[ClickAI] Tray icon not found at", iconPath, "— skipping tray.");
      return;
    }
    const icon = nativeImage.createFromPath(iconPath);
    // macOS "template image" convention: the OS recolors/inverts this
    // automatically for the light/dark menu bar, so the icon always looks
    // right regardless of system appearance.
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("ClickAI");
    tray.setContextMenu(buildTrayMenu());
    tray.on("click", () => toggleOverlay());
  } catch (err) {
    console.error("[ClickAI] Failed to create tray icon:", err);
  }
}

app.whenReady().then(() => {
  console.log("[ClickAI] App ready. Platform:", process.platform, "Screen recording perm:", require("electron").systemPreferences?.getMediaAccessStatus?.("screen"));

  overlayWindow = createOverlayWindow();
  overlayWindow.webContents.on("did-finish-load", () => {
    console.log("[ClickAI] Renderer finished loading.");
  });
  overlayWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[ClickAI] Renderer FAILED to load:", code, desc);
  });

  registerHotkey();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      overlayWindow = createOverlayWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Keep running in the background (tray-style behavior can be added later).
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  ragStore.teardown();
});

// ---- IPC handlers ----

// Streaming (2026-09-01): these were plain request/response `ipcMain.handle`
// calls before — now `ipcMain.on` (fire-and-forget) since a single
// request/response round-trip can't carry incremental chunks. Each chunk
// and the final result/error are pushed back to the renderer as separate
// events, tagged with the request's `requestId` so the renderer can match
// them to the right in-flight ask (see preload.ts's streamRequest()).
ipcMain.on("ask-docs-stream", async (event, { requestId, prompt, history, docId }) => {
  try {
    const result = await askDocs(
      DESKTOP_SESSION_ID,
      prompt,
      Array.isArray(history) ? history : [],
      (delta) => {
        event.sender.send("stream-delta", { requestId, delta });
      },
      typeof docId === "string" ? docId : undefined
    );
    event.sender.send("stream-done", { requestId, result });
  } catch (err: any) {
    event.sender.send("stream-error", { requestId, message: err.message || String(err) });
  }
});

ipcMain.handle("get-settings", () => {
  return {
    apiKey: store.get("apiKey"),
    model: store.get("model"),
    hotkey: store.get("hotkey"),
    chunkingStrategy: store.get("chunkingStrategy"),
    chunkingStrategies: CHUNKING_STRATEGY_INFO,
    chunkMaxChars: store.get("chunkMaxChars"),
    chunkOverlapChars: store.get("chunkOverlapChars"),
    embeddingModel: store.get("embeddingModel"),
    embeddingModels: EMBEDDING_MODEL_INFO,
    rerankingEnabled: store.get("rerankingEnabled"),
  };
});

ipcMain.handle("save-settings", (_event, settings) => {
  if (typeof settings.apiKey === "string") store.set("apiKey", settings.apiKey);
  if (typeof settings.model === "string") store.set("model", settings.model);
  if (typeof settings.hotkey === "string") {
    store.set("hotkey", settings.hotkey);
    registerHotkey();
  }
  if (isChunkingStrategy(settings.chunkingStrategy)) store.set("chunkingStrategy", settings.chunkingStrategy);
  if (Number.isFinite(settings.chunkMaxChars) && settings.chunkMaxChars > 0) {
    store.set("chunkMaxChars", Math.round(settings.chunkMaxChars));
  }
  if (Number.isFinite(settings.chunkOverlapChars) && settings.chunkOverlapChars >= 0) {
    store.set("chunkOverlapChars", Math.round(settings.chunkOverlapChars));
  }
  if (isEmbeddingModel(settings.embeddingModel)) store.set("embeddingModel", settings.embeddingModel);
  if (typeof settings.rerankingEnabled === "boolean") store.set("rerankingEnabled", settings.rerankingEnabled);
  return true;
});

// Evals (2026-09-08): runs each case through the real askDocs() pipeline —
// costs real API calls, same as the user asking those questions normally.
ipcMain.handle("run-evals", async (_event, cases) => {
  if (!Array.isArray(cases) || cases.length === 0 || !cases.every(isEvalCase)) {
    throw new Error('Provide a non-empty array of eval cases, each with a "question" and an "expectedKeywords" array.');
  }
  return runEvalSuite(DESKTOP_SESSION_ID, cases as EvalCase[]);
});

ipcMain.handle("get-eval-history", () => {
  return getEvalHistory();
});

// Human-in-the-loop flagging (2026-09-08).
ipcMain.handle("flag-answer", (_event, flag) => {
  if (!isFlagInput(flag)) {
    throw new Error('A flag needs at least "question" and "answer".');
  }
  return flagAnswer(flag);
});

ipcMain.handle("get-flagged-answers", () => {
  return getFlaggedAnswers();
});

ipcMain.on("hide-overlay", () => {
  overlayWindow?.hide();
});


const DOCUMENT_EXTENSIONS = [
  "pdf", "docx", "xlsx", "xlsm", "pptx", "pptm", "html", "htm",
  "png", "jpg", "jpeg", "gif", "webp", "bmp",
  "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm",
  "txt", "md", "csv", "json", "log",
];

/** Very rough "how long will this take" estimate (2026-09-07, explicit
 * user request: "can we show mins to chunk 20-45 minutes total depend on
 * file we show how long take") — shown ONCE up front when an add-
 * documents operation starts, separate from the per-step progress text
 * and the live elapsed-time counter (both already existed). Deliberately
 * a wide range, not a promise: actual time depends on network/API
 * latency and load, which this has no way to know in advance. Modeled
 * on the same sizing this project already reasoned through for the CSV
 * chunking fix — table-like files (csv/xlsx/xlsm) become ~900-char
 * table-block chunks, everything else becomes ~1400-char prose chunks
 * (this project's tuned default chunk size), each embedded in batches of
 * 64 at an assumed ~2-4s per batch call (a real-world OpenAI embeddings
 * latency range, not a guarantee). Returns null for small/fast files —
 * not worth showing an estimate for something that'll finish in seconds. */
const TABLE_LIKE_EXTENSIONS = new Set([".csv", ".xlsx", ".xlsm"]);
const EMBED_BATCH_SIZE = 64; // mirrors embeddings.ts's BATCH_SIZE
const ASSUMED_SEC_PER_BATCH_LOW = 2;
const ASSUMED_SEC_PER_BATCH_HIGH = 4;

/** Formats a "should finish around HH:MM" (or "HH:MM–HH:MM" for a wider
 * range) clock-time string (2026-09-08, explicit user request:
 * "automatically find country time here") — added alongside the plain
 * duration range because "~22-43 min" makes someone do the math
 * themselves to know when to check back. Uses toLocaleTimeString() with
 * NO explicit locale/timeZone arguments, which makes JS fall back to the
 * OS's own locale and timezone automatically — for the desktop app that
 * IS the user's own machine, so this always lands in their real local
 * time with no country/timezone lookup, setting, or guesswork needed. */
function formatFinishTimeRange(lowMin: number, highMin: number): string {
  const now = Date.now();
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const lowClock = fmt(now + lowMin * 60_000);
  const highClock = fmt(now + highMin * 60_000);
  return lowClock === highClock ? `around ${lowClock}` : `around ${lowClock}–${highClock}`;
}

function estimateProcessingLabel(filePaths: string[]): string | null {
  let totalEstimatedBatches = 0;
  for (const filePath of filePaths) {
    let sizeBytes: number;
    try {
      sizeBytes = fs.statSync(filePath).size;
    } catch {
      continue; // unreadable/missing — skip rather than guess
    }
    const ext = path.extname(filePath).toLowerCase();
    // Table-like files' real average chunk size jumped considerably
    // (2026-09-16, docParsers.ts's buildTableBlocks fix) -- wide tables
    // now batch several rows per chunk instead of the old flat 900-char
    // budget, which for a wide-column table left room for barely one row
    // per chunk. 4000 is a conservative mid-estimate of the new
    // (header-width-scaled, up to an 8000-char ceiling) effective batch
    // size without this estimator needing to actually read the file's
    // header -- it only has the file's size on disk to go on.
    const avgCharsPerChunk = TABLE_LIKE_EXTENSIONS.has(ext) ? 4000 : 1400;
    const estimatedChunks = Math.max(1, Math.ceil(sizeBytes / avgCharsPerChunk));
    totalEstimatedBatches += Math.ceil(estimatedChunks / EMBED_BATCH_SIZE);
  }
  if (totalEstimatedBatches === 0) return null;
  const lowMin = (totalEstimatedBatches * ASSUMED_SEC_PER_BATCH_LOW) / 60;
  const highMin = (totalEstimatedBatches * ASSUMED_SEC_PER_BATCH_HIGH) / 60;
  if (highMin < 1) return null; // finishes in well under a minute either way
  const round = (m: number) => Math.max(1, Math.round(m));
  const durationLabel = lowMin < 1 ? `under ~${round(highMin)} min` : `~${round(lowMin)}-${round(highMin)} min`;
  return `${durationLabel} (${formatFinishTimeRange(lowMin, highMin)})`;
}

/** Shared by both the "+ Add documents" dialog flow and the drag-and-drop
 * flow (2026-09-01) — both end up with a list of local file paths and need
 * the exact same per-file add/error handling, so this is the one place
 * that does it. */
async function addDocumentPaths(
  filePaths: string[]
): Promise<{ added: ragStore.DocSummary[]; errors: { fileName: string; message: string }[] }> {
  const added: ragStore.DocSummary[] = [];
  const errors: { fileName: string; message: string }[] = [];

  const etaLabel = estimateProcessingLabel(filePaths);
  overlayWindow?.webContents.send("docs-status-eta", etaLabel || "");

  // Multiple selected/dropped files now process CONCURRENTLY (2026-09-07,
  // explicit user request: "allow multiple upload file currently we can
  // upload wait till its chunk then we can add document") instead of one
  // strictly after another -- while file A is embedding, file B's
  // reading/chunking can already be underway, rather than sitting queued
  // behind A's entire pipeline. Safe to do because the embedding call
  // volume itself is capped by the shared concurrency limiter in
  // embeddings.ts regardless of how many documents are in flight.
  // Promise.all + a per-file try/catch (not Promise.allSettled) so one
  // file's failure doesn't stop the others -- each result lands in
  // `added`/`errors` independently, same outcome as the old sequential
  // loop just without waiting on each other. Progress messages from
  // different files can interleave on the single status line, but every
  // message already names its own file (see ragStore.ts's onProgress
  // calls), so it stays legible even interleaved.
  await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        const summary = await ragStore.addDocument(DESKTOP_SESSION_ID, filePath, (message) => {
          overlayWindow?.webContents.send("docs-status", message);
        });
        added.push(summary);
      } catch (err: any) {
        errors.push({ fileName: filePath.split("/").pop() || filePath, message: err.message || String(err) });
      }
    })
  );

  return { added, errors };
}

// Deliberately returns just the picked paths, NOT the processed result
// (2026-09-16, fixes "can't add another document while the last one is
// still chunking") -- this used to call addDocumentPaths() and make the
// whole IPC call (and therefore the renderer's disabled-button window)
// wait for the ENTIRE chunk/embed pipeline to finish before the dialog
// itself was even considered "done". Splitting it means the renderer can
// re-enable "+ Add" the instant the native dialog closes, and kick off
// addDocumentPaths() (below) as its own independent call -- so a second
// "+ Add" click (or a drag-and-drop) can start a NEW batch while an
// earlier one is still embedding, instead of being blocked behind it.
ipcMain.handle("upload-documents", async () => {
  if (!overlayWindow) return { filePaths: [] };
  const win = overlayWindow;

  // The overlay is a frameless, always-on-top window. Attaching the native
  // open-file dialog to it as a "sheet" can render the dialog BEHIND the
  // window on macOS (no titlebar for the sheet to dock under), which makes
  // the dialog invisible and unresponsive -- the promise never resolves,
  // so the button stays disabled forever. Temporarily drop always-on-top
  // and open the dialog as an independent window to avoid that.
  win.setAlwaysOnTop(false);
  // Real-world case (2026-09-07): a user running ClickAI via `npm run
  // dev`/`npm start` from a Terminal window clicked "+ Add" and saw
  // "Opening file picker..." hang indefinitely with no dialog visible.
  // Cause: the app was launched from Terminal, so macOS never made
  // ClickAI the frontmost/active app -- the native open-file dialog still
  // opened, just BEHIND Terminal (or whatever app had focus), completely
  // invisible, with the promise sitting there unresolved until the
  // 120s renderer-side timeout eventually fired. `app.focus({steal:
  // true})` explicitly steals focus to bring the app (and therefore the
  // dialog it's about to open) to the front before showOpenDialog runs,
  // same as clicking the app's own window would have done.
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  let result;
  try {
    result = await dialog.showOpenDialog({
      title: "Add documents",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Documents", extensions: DOCUMENT_EXTENSIONS }],
    });
  } finally {
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(true, "floating");
      win.focus();
    }
  }

  if (result.canceled || result.filePaths.length === 0) {
    return { filePaths: [] };
  }

  return { filePaths: result.filePaths };
});

// Drag-and-drop upload (2026-09-01): the renderer reads dropped files'
// local paths (Electron exposes File.path even with contextIsolation on)
// and hands them here — same underlying add logic as the file picker, no
// native dialog involved at all.
ipcMain.handle("add-document-paths", async (_event, { filePaths }) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { added: [], errors: [] };
  }
  const supported = filePaths.filter((p: string) => {
    const ext = p.split(".").pop()?.toLowerCase();
    return !!ext && DOCUMENT_EXTENSIONS.includes(ext);
  });
  const unsupported = filePaths.filter((p: string) => !supported.includes(p));

  const result = await addDocumentPaths(supported);
  for (const p of unsupported) {
    result.errors.push({
      fileName: p.split("/").pop() || p,
      message: "Unsupported file type.",
    });
  }
  return result;
});

ipcMain.handle("list-docs", () => {
  return ragStore.listDocuments(DESKTOP_SESSION_ID);
});

ipcMain.handle("clear-docs", () => {
  ragStore.clearAll(DESKTOP_SESSION_ID);
  return true;
});

// Launch-at-login (2026-09-01) — reads/writes the real OS-level login item
// setting directly (app.getLoginItemSettings/setLoginItemSettings) rather
// than a separately stored preference, so the Settings panel checkbox and
// the tray menu's checkbox can never drift out of sync with each other or
// with what's actually registered with the OS.
ipcMain.handle("get-launch-at-login", () => {
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle("set-launch-at-login", (_event, enabled: boolean) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  // Keep the tray menu's checkbox in sync immediately rather than waiting
  // for it to be rebuilt on next open.
  tray?.setContextMenu(buildTrayMenu());
  return app.getLoginItemSettings().openAtLogin;
});
