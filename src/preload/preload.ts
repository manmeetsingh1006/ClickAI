import { contextBridge, ipcRenderer } from "electron";
import { randomUUID } from "crypto";

interface StreamCallbacks<T> {
  onDelta: (delta: string) => void;
  onDone: (result: T) => void;
  onError: (message: string) => void;
}

/** Shared plumbing for the two streaming asks (2026-09-01) — sends a
 * request tagged with a fresh requestId over `channel`, and filters the
 * shared "stream-delta"/"stream-done"/"stream-error" events down to just
 * the ones matching that id (so two in-flight asks, e.g. a regenerate
 * fired while a previous answer is still finishing, never cross-deliver
 * chunks to each other). Listeners are torn down as soon as the request
 * finishes one way or the other. */
function streamRequest<T>(
  channel: string,
  payload: Record<string, unknown>,
  callbacks: StreamCallbacks<T>
): void {
  const requestId = randomUUID();

  const onDeltaEvent = (_e: unknown, msg: { requestId: string; delta: string }) => {
    if (msg.requestId === requestId) callbacks.onDelta(msg.delta);
  };
  const onDoneEvent = (_e: unknown, msg: { requestId: string; result: T }) => {
    if (msg.requestId === requestId) {
      cleanup();
      callbacks.onDone(msg.result);
    }
  };
  const onErrorEvent = (_e: unknown, msg: { requestId: string; message: string }) => {
    if (msg.requestId === requestId) {
      cleanup();
      callbacks.onError(msg.message);
    }
  };
  function cleanup() {
    ipcRenderer.removeListener("stream-delta", onDeltaEvent);
    ipcRenderer.removeListener("stream-done", onDoneEvent);
    ipcRenderer.removeListener("stream-error", onErrorEvent);
  }

  ipcRenderer.on("stream-delta", onDeltaEvent);
  ipcRenderer.on("stream-done", onDoneEvent);
  ipcRenderer.on("stream-error", onErrorEvent);

  ipcRenderer.send(channel, { requestId, ...payload });
}

contextBridge.exposeInMainWorld("clickai", {
  askDocsStream: (
    prompt: string,
    history: { role: "user" | "assistant"; text: string }[] | undefined,
    docId: string | undefined,
    callbacks: StreamCallbacks<unknown>
  ) => streamRequest("ask-docs-stream", { prompt, history: history || [], docId }, callbacks),

  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: {
    apiKey?: string;
    model?: string;
    hotkey?: string;
    chunkingStrategy?: string;
    chunkMaxChars?: number;
    chunkOverlapChars?: number;
    embeddingModel?: string;
    rerankingEnabled?: boolean;
  }) => ipcRenderer.invoke("save-settings", settings),
  hide: () => ipcRenderer.send("hide-overlay"),

  runEvals: (cases: unknown[]) => ipcRenderer.invoke("run-evals", cases),
  getEvalHistory: () => ipcRenderer.invoke("get-eval-history"),
  flagAnswer: (flag: { docId?: string; docName?: string; question: string; answer: string; note?: string }) =>
    ipcRenderer.invoke("flag-answer", flag),
  getFlaggedAnswers: () => ipcRenderer.invoke("get-flagged-answers"),

  uploadDocuments: () => ipcRenderer.invoke("upload-documents"),
  addDocumentPaths: (filePaths: string[]) => ipcRenderer.invoke("add-document-paths", { filePaths }),
  listDocs: () => ipcRenderer.invoke("list-docs"),
  clearDocs: () => ipcRenderer.invoke("clear-docs"),
  onDocsStatus: (cb: (message: string) => void) =>
    ipcRenderer.on("docs-status", (_e, message) => cb(message)),
  // One-time rough time estimate, sent once at the start of an
  // add-documents operation (2026-09-07) — see estimateProcessingLabel
  // in main.ts. Empty string means "no estimate for this one" (small/fast
  // files), not an error.
  onDocsEta: (cb: (label: string) => void) =>
    ipcRenderer.on("docs-status-eta", (_e, label) => cb(label)),

  getLaunchAtLogin: () => ipcRenderer.invoke("get-launch-at-login"),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke("set-launch-at-login", enabled),
});
