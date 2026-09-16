// ClickAI Web — "Clarity" evidence-panel redesign (2026-09-02, revised
// twice same day: documents moved to a persistent left column instead of
// a "Manage docs" toggle; uploaded documents now clear automatically on
// refresh/tab close; then per-document chat threading added so a
// question can be scoped to just one uploaded document instead of always
// being scored against every document together — explicit user request
// after noticing a two-document upload kept answering only from
// whichever doc actually matched the question). Talks to the local
// Express server (src/server/server.ts) over fetch() instead of Electron
// IPC, and uploads real file bytes via multipart/form-data.

// Session-expiry redirect (2026-09-08, login system): any API call that
// comes back 401 means the session cookie is missing/expired (idle
// timeout, or logged out in another tab) -- bounce to the login page
// rather than leaving the UI silently broken. Wrapping fetch() once here
// covers every call site below without threading auth-handling through
// each of them individually.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401) {
    window.location.href = "/login.html";
  }
  return res;
};

const settingsBtn = document.getElementById("settings-btn");
const exportBtn = document.getElementById("export-btn");
const logoutBtn = document.getElementById("logout-btn");
const settingsPanel = document.getElementById("settings-panel");
const apiKeyInput = document.getElementById("api-key-input");
const modelInput = document.getElementById("model-input");
const chunkingStrategyInput = document.getElementById("chunking-strategy-input");
const chunkingStrategyHint = document.getElementById("chunking-strategy-hint");
const chunkMaxCharsInput = document.getElementById("chunk-max-chars-input");
const chunkOverlapCharsInput = document.getElementById("chunk-overlap-chars-input");
const embeddingModelInput = document.getElementById("embedding-model-input");
const embeddingModelHint = document.getElementById("embedding-model-hint");
const rerankingEnabledInput = document.getElementById("reranking-enabled-input");
const saveSettingsBtn = document.getElementById("save-settings-btn");
const cancelSettingsBtn = document.getElementById("cancel-settings-btn");

const evalsBtn = document.getElementById("evals-btn");
const evalsPanel = document.getElementById("evals-panel");
const evalsInput = document.getElementById("evals-input");
const runEvalsBtn = document.getElementById("run-evals-btn");
const closeEvalsBtn = document.getElementById("close-evals-btn");
const evalsError = document.getElementById("evals-error");
const evalsResults = document.getElementById("evals-results");
const evalsHistory = document.getElementById("evals-history");
const flagsHistory = document.getElementById("flags-history");

const docCountLabel = document.getElementById("doc-count-label");
const docsLog = document.getElementById("docs-log");
const docsPromptInput = document.getElementById("docs-prompt-input");
const docsSendBtn = document.getElementById("docs-send-btn");
const docsTab = document.getElementById("docs-tab");

const evidenceList = document.getElementById("evidence-list");

const docsCol = document.getElementById("docs-col");
const docsUploadBtn = document.getElementById("docs-upload-btn");
const docsFileInput = document.getElementById("docs-file-input");
const docsClearBtn = document.getElementById("docs-clear-btn");
const docsList = document.getElementById("docs-list");
const docsStatus = document.getElementById("docs-status");
const docsStatusText = document.getElementById("docs-status-text");
const docsStatusEta = document.getElementById("docs-status-eta");
const docsStatusElapsed = document.getElementById("docs-status-elapsed");

// Loading-spinner + elapsed-time wrapper around docs-status (explicit
// user request, 2026-09-07: show loading while chunking/uploading, then
// "add time while chunking so person get understand how much time
// take"). `loading: true` adds a small CSS spinner plus a live
// "(Xs)"/"(M:SS)" counter that keeps running for the whole upload
// operation rather than resetting per message.
let statusTimerStart = null;
let statusTimerInterval = null;

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function stopStatusTimer() {
  if (statusTimerInterval) {
    clearInterval(statusTimerInterval);
    statusTimerInterval = null;
  }
  statusTimerStart = null;
  docsStatusElapsed.textContent = "";
  docsStatusEta.textContent = "";
}

// Very rough "how long will this take" estimate (2026-09-07, explicit
// user request: "show mins to chunk... depend on file"), computed
// CLIENT-SIDE from the selected Files' sizes — the web version has no
// live progress-streaming channel back from the server the way desktop's
// IPC does, so there's no server round trip to wait on before showing
// this; File objects already carry .size/.name synchronously the moment
// they're picked or dropped. Same sizing model as the desktop version
// (see estimateProcessingLabel in main.ts) — table-like files
// (csv/xlsx/xlsm) become ~900-char table-block chunks, everything else
// ~1400-char prose chunks, embedded in batches of 64 at an assumed
// ~2-4s/batch. Deliberately a wide range, not a promise.
const TABLE_LIKE_EXTENSIONS = new Set(["csv", "xlsx", "xlsm"]);
const EMBED_BATCH_SIZE = 64;

// "Should finish around HH:MM" (2026-09-08, explicit user request:
// "automatically find country time here") -- toLocaleTimeString() with
// NO explicit locale/timeZone args falls back to the BROWSER's own
// locale/timezone automatically, so this always lands in the viewer's
// real local time with no country lookup or setting needed.
function formatFinishTimeRange(lowMin, highMin) {
  const now = Date.now();
  const fmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const lowClock = fmt(now + lowMin * 60_000);
  const highClock = fmt(now + highMin * 60_000);
  return lowClock === highClock ? `around ${lowClock}` : `around ${lowClock}–${highClock}`;
}

function estimateProcessingLabel(files) {
  let totalEstimatedBatches = 0;
  for (const file of files) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const avgCharsPerChunk = TABLE_LIKE_EXTENSIONS.has(ext) ? 900 : 1400;
    const estimatedChunks = Math.max(1, Math.ceil(file.size / avgCharsPerChunk));
    totalEstimatedBatches += Math.ceil(estimatedChunks / EMBED_BATCH_SIZE);
  }
  if (totalEstimatedBatches === 0) return null;
  const lowMin = (totalEstimatedBatches * 2) / 60;
  const highMin = (totalEstimatedBatches * 4) / 60;
  if (highMin < 1) return null;
  const round = (m) => Math.max(1, Math.round(m));
  const durationLabel = lowMin < 1 ? `under ~${round(highMin)} min` : `~${round(lowMin)}-${round(highMin)} min`;
  return `${durationLabel} (${formatFinishTimeRange(lowMin, highMin)})`;
}

function setDocsEta(label) {
  docsStatusEta.textContent = label ? ` — est. ${label}` : "";
}

function setDocsStatus(text, loading) {
  docsStatusText.textContent = text;
  docsStatus.classList.toggle("loading", !!loading);
  if (loading) {
    if (!statusTimerStart) {
      statusTimerStart = Date.now();
      docsStatusElapsed.textContent = " (0s)";
      statusTimerInterval = setInterval(() => {
        docsStatusElapsed.textContent = ` (${formatElapsed(Date.now() - statusTimerStart)})`;
      }, 1000);
    }
  } else {
    stopStatusTimer();
  }
}

// ---- per-document chat threads (2026-09-02) ----
// Every uploaded document gets its own conversation: its own history sent
// to the model, its own Q&A log, its own running Evidence column and
// citation numbering. "__all__" is the combined thread that searches
// every uploaded document together (the original behavior, kept as the
// default view). Switching the active thread in the sidebar swaps which
// one is on screen — nothing is deleted, so flipping back to a document
// (or to "All documents") picks its conversation back up exactly where it
// left off.
const ALL_DOCS_KEY = "__all__";
let activeThreadKey = ALL_DOCS_KEY;
const threads = new Map(); // key -> { history, turns, citationCounter }

function getThread(key) {
  if (!threads.has(key)) {
    threads.set(key, { history: [], turns: [], citationCounter: 0 });
  }
  return threads.get(key);
}

const MAX_CLIENT_HISTORY = 20;
function pushThreadHistory(thread, role, text) {
  thread.history.push({ role, text });
  if (thread.history.length > MAX_CLIENT_HISTORY) thread.history = thread.history.slice(-MAX_CLIENT_HISTORY);
}

let docsCache = [];            // last known list of uploaded documents

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function confBand(confidence) {
  if (confidence === null || confidence === undefined) return "med";
  if (confidence >= 80) return "high";
  if (confidence >= 50) return "med";
  return "low";
}

function citeColorClass(globalIndex) {
  return "cite-" + (((globalIndex - 1) % 4) + 1);
}

// Maps a filename's extension to a short badge label + color class for
// the documents column — mirrors the reference design's colored file-type
// chips (DOC/PDF/XLS) instead of a generic document emoji.
function docTypeInfo(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "doc" || ext === "docx") return { label: "DOC", cls: "doc-badge-doc" };
  if (ext === "pdf") return { label: "PDF", cls: "doc-badge-pdf" };
  if (ext === "xls" || ext === "xlsx" || ext === "xlsm" || ext === "csv") return { label: "XLS", cls: "doc-badge-xls" };
  if (ext === "ppt" || ext === "pptx" || ext === "pptm") return { label: "PPT", cls: "doc-badge-doc" };
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return { label: "IMG", cls: "doc-badge-generic" };
  if (["mp3", "mp4", "wav", "m4a", "webm", "mpga", "mpeg"].includes(ext)) return { label: "REC", cls: "doc-badge-generic" };
  return { label: (ext || "FILE").toUpperCase().slice(0, 4), cls: "doc-badge-generic" };
}

/** Rewrites the model's raw "[1]"/"[2]" citation markers into small
 * color-coded badges, remapping each turn's LOCAL citation numbers (which
 * always restart at 1) to a running GLOBAL number so the whole Evidence
 * column reads as one consistent, ever-growing log across the
 * conversation instead of colliding "1"s from different turns. A bracket
 * number outside the current excerpt range is left as plain text rather
 * than guessed at. */
function renderAnswerHtml(rawAnswer, excerptsLocal, globalStart) {
  const map = {};
  excerptsLocal.forEach((ex, i) => { map[ex.index] = globalStart + i; });
  const escaped = escapeHtml(rawAnswer);
  return escaped.replace(/\[(\d+)\]/g, (whole, numStr) => {
    const local = parseInt(numStr, 10);
    if (!(local in map)) return whole;
    const global = map[local];
    return `<span class="cite ${citeColorClass(global)}">${global}</span>`;
  });
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function actionButton(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "action-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// How many trailing characters of the streamed raw text to hold back from
// display — the model's answer ends with a raw "Confidence: NN%" line
// that's stripped server-side once the full response is known, but
// mid-stream there's no way to tell yet whether what just arrived is the
// start of that line or genuine answer content.
const STREAM_HOLDBACK_CHARS = 40;

function createStreamingAnswer(container) {
  const p = el("p", "a-text");
  // "Thinking" indicator (explicit user request, 2026-09-07) — three
  // bouncing dots, removed the moment the first real delta arrives.
  const dots = el("span", "thinking-dots");
  dots.appendChild(el("span"));
  dots.appendChild(el("span"));
  dots.appendChild(el("span"));
  p.appendChild(dots);
  container.appendChild(p);
  const textNode = document.createTextNode("");
  p.appendChild(textNode);
  let buffer = "";
  return {
    element: p,
    appendDelta(delta) {
      if (dots.parentNode) dots.remove();
      buffer += delta;
      const visibleLen = Math.max(0, buffer.length - STREAM_HOLDBACK_CHARS);
      textNode.textContent = buffer.slice(0, visibleLen);
      docsLog.scrollTop = docsLog.scrollHeight;
    },
  };
}

function renderDocsLogHint() {
  if (docsLog.children.length > 0) return;
  const label = activeThreadKey === ALL_DOCS_KEY
    ? "Ask a question below and I'll answer strictly from what's in your uploaded documents."
    : "Ask a question below and I'll answer strictly from this document.";
  docsLog.appendChild(el("div", "docs-log-hint", label));
}

function renderEvidenceEmpty() {
  if (evidenceList.children.length > 0) return;
  evidenceList.appendChild(el("div", "evidence-empty", "Citations and source excerpts will show up here once you ask a question."));
}

function clearEmptyState(container) {
  const hint = container.querySelector(".docs-log-hint, .evidence-empty");
  if (hint) hint.remove();
}

// ---- evidence column ----
// Rough length past which an excerpt's text gets a "Show more" toggle
// instead of always rendering in full (2026-09-03 density pass) — the
// actual visual clamp is CSS (4 lines, .ev-text), this just decides
// whether it's worth offering the toggle at all for a short excerpt.
const EV_TEXT_CLAMP_CHARS = 220;

function appendEvidenceForTurn(prompt, result, globalStart) {
  clearEmptyState(evidenceList);
  const excerpts = result.excerpts || [];
  const band = confBand(result.confidence);

  // Low-confidence turns start collapsed behind a one-line toggle —
  // their sources are the ones least likely to be worth reading in full
  // right away, and the running Evidence log gets long fast otherwise.
  const group = el("div", `ev-group${band === "low" ? " collapsed" : ""}`);
  group.appendChild(el("div", "ev-turn-note", truncate(prompt, 64)));

  if (band === "low" && excerpts.length > 0) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ev-group-toggle";
    const label = el("span", null, `${excerpts.length} low-confidence source${excerpts.length === 1 ? "" : "s"} — show`);
    const badge = el("span", `ev-conf conf-${band}`, `${result.confidence ?? "—"}%`);
    toggle.appendChild(label);
    toggle.appendChild(badge);
    toggle.addEventListener("click", () => group.classList.remove("collapsed"));
    group.appendChild(toggle);
  }

  excerpts.forEach((ex, i) => {
    const global = globalStart + i;
    const card = el("div", "ev-card");
    const head = el("div", "ev-head");
    const badge = el("span", `cite ${citeColorClass(global)}`, String(global));
    const doc = el("span", "ev-doc", ex.docName);
    if (ex.page) doc.appendChild(el("span", "ev-page", ` · p. ${ex.page}`));
    else if (ex.startTimestamp) doc.appendChild(el("span", "ev-page", ` · ${ex.startTimestamp}${ex.endTimestamp ? `–${ex.endTimestamp}` : ""}`));
    const conf = el("span", `ev-conf conf-${band}`, `${result.confidence ?? "—"}%`);
    head.appendChild(badge);
    head.appendChild(doc);
    head.appendChild(conf);
    const barTrack = el("div", "ev-bar-track");
    const barFill = el("div", `ev-bar-fill conf-${band}-fill`);
    barFill.style.width = `${Math.max(0, Math.min(100, result.confidence ?? 0))}%`;
    barTrack.appendChild(barFill);
    const text = el("p", "ev-text", `"${ex.text}"`);
    card.appendChild(head);
    card.appendChild(barTrack);
    card.appendChild(text);
    if (ex.text && ex.text.length > EV_TEXT_CLAMP_CHARS) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "ev-more-btn";
      moreBtn.textContent = "Show more";
      moreBtn.addEventListener("click", () => {
        const expanded = text.classList.toggle("expanded");
        moreBtn.textContent = expanded ? "Show less" : "Show more";
      });
      card.appendChild(moreBtn);
    }
    group.appendChild(card);
  });

  // Which documents this turn's retrieval actually covered — everything
  // when the thread is "All documents", just the one when it's scoped to
  // a single document (so a single-document thread doesn't wrongly claim
  // every OTHER uploaded file also came up empty).
  const scopedDocs = activeThreadKey === ALL_DOCS_KEY
    ? docsCache
    : docsCache.filter((d) => d.id === activeThreadKey);

  const citedNames = new Set((result.sources || []));
  const missing = scopedDocs.filter((d) => !citedNames.has(d.name));
  if (missing.length > 0 && scopedDocs.length > 0) {
    const note = el("div", "ev-nothing");
    const label = missing.length === scopedDocs.length && excerpts.length === 0
      ? (activeThreadKey === ALL_DOCS_KEY
          ? "Nothing found in any of your uploaded documents for this question."
          : "Nothing found in this document for this question.")
      : null;
    if (label) {
      note.textContent = label;
    } else {
      note.innerHTML = `Nothing found in ${missing.map((d) => `<b>${escapeHtml(d.name)}</b>`).join(", ")} for this question.`;
    }
    group.appendChild(note);
  }

  evidenceList.appendChild(group);
  evidenceList.scrollTop = evidenceList.scrollHeight;
}

// ---- copy / export ----
function copyWithCitations(result) {
  let text = result.answer.trim();
  if (result.excerpts && result.excerpts.length > 0) {
    text += "\n\nSources:\n" + result.excerpts
      .map((ex) => `[${ex.index}] ${ex.docName}${ex.page ? ` (p. ${ex.page})` : ex.startTimestamp ? ` (${ex.startTimestamp}${ex.endTimestamp ? `–${ex.endTimestamp}` : ""})` : ""}`)
      .join("\n");
  }
  navigator.clipboard.writeText(text).catch(() => {});
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function activeThreadLabel() {
  if (activeThreadKey === ALL_DOCS_KEY) return "All documents";
  const doc = docsCache.find((d) => d.id === activeThreadKey);
  return doc ? doc.name : "Document";
}

function exportConversation() {
  const stamp = new Date().toISOString().slice(0, 10);
  const thread = getThread(activeThreadKey);
  const lines = [`# ClickAI — Docs conversation (${stamp})`, ""];
  lines.push(`Thread: ${activeThreadLabel()}`, "");
  lines.push(`Documents: ${docsCache.length ? docsCache.map((d) => d.name).join(", ") : "(none)"}`, "");
  thread.turns.forEach((turn, i) => {
    lines.push(`## Q${i + 1}. ${turn.prompt}`, "");
    lines.push(turn.result.answer, "");
    if (turn.result.excerpts && turn.result.excerpts.length > 0) {
      lines.push("Sources:");
      turn.result.excerpts.forEach((ex) => {
        lines.push(`- [${ex.index}] ${ex.docName}${ex.page ? ` (p. ${ex.page})` : ex.startTimestamp ? ` (${ex.startTimestamp}${ex.endTimestamp ? `–${ex.endTimestamp}` : ""})` : ""}`);
      });
      lines.push("");
    }
  });
  downloadTextFile(`clickai-docs-${stamp}.md`, lines.join("\n"));
}

// ---- streaming transport ----
// The server streams newline-delimited JSON events over one chunked HTTP
// response body per request — read with fetch()'s streaming body reader.
// Each request has its own private stream, so no requestId tagging is
// needed to keep concurrent asks (e.g. Regenerate while a previous answer
// is still finishing) from cross-delivering chunks.
async function streamRequest(url, body, { onDelta, onDone, onError }) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      onError(`Request failed (${res.status})`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === "delta") onDelta(evt.delta);
        else if (evt.type === "done") onDone(evt.result);
        else if (evt.type === "error") onError(evt.message);
      }
    }
  } catch (err) {
    onError(err.message || String(err));
  }
}

// ---- rendering a finished turn (shared by live asks and thread switches) ----
function buildTurnElement(prompt) {
  const turnEl = el("div", "turn");
  turnEl.appendChild(el("span", "q-label", "You asked"));
  turnEl.appendChild(el("p", "q-text", prompt));
  return turnEl;
}

// Human-in-the-loop flagging (2026-09-08): lets a person mark an answer as
// wrong/questionable right from the turn, with an optional free-text note.
// Uses an inline revealed textarea rather than a native prompt()/confirm().
function currentDocIdName() {
  if (activeThreadKey === ALL_DOCS_KEY) return { docId: undefined, docName: undefined };
  const doc = docsCache.find((d) => d.id === activeThreadKey);
  return { docId: activeThreadKey, docName: doc ? doc.name : undefined };
}

function attachFlagButton(actionsRow, prompt, result) {
  const flagBtn = actionButton("\ud83d\udea9 Flag", () => {
    if (flagBtn.dataset.open === "1") return;
    flagBtn.dataset.open = "1";
    const wrap = el("div", "flag-note-wrap");
    const noteInput = document.createElement("textarea");
    noteInput.className = "flag-note-input";
    noteInput.rows = 2;
    noteInput.placeholder = "What's wrong with this answer? (optional)";
    wrap.appendChild(noteInput);
    const wrapActions = el("div", "flag-note-actions");
    const submitBtn = actionButton("Submit flag", async () => {
      const { docId, docName } = currentDocIdName();
      submitBtn.disabled = true;
      try {
        await fetch("/api/flags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docId,
            docName,
            question: prompt,
            answer: result.answer,
            note: noteInput.value.trim() || undefined,
          }),
        });
        wrap.remove();
        flagBtn.textContent = "\ud83d\udea9 Flagged";
        flagBtn.disabled = true;
      } catch (err) {
        submitBtn.disabled = false;
        noteInput.placeholder = "Couldn't save the flag — try again.";
      }
    });
    const cancelBtn = actionButton("Cancel", () => {
      wrap.remove();
      flagBtn.dataset.open = "";
    });
    wrapActions.appendChild(submitBtn);
    wrapActions.appendChild(cancelBtn);
    wrap.appendChild(wrapActions);
    actionsRow.insertAdjacentElement("afterend", wrap);
  });
  actionsRow.appendChild(flagBtn);
}

function attachTurnActions(turnEl, prompt, result, isError) {
  const actionsRow = el("div", "turn-actions");
  actionsRow.appendChild(actionButton("Ask a follow-up", () => {
    docsPromptInput.focus();
    docsPromptInput.scrollIntoView({ block: "nearest" });
  }));
  if (!isError) {
    actionsRow.appendChild(actionButton("Copy with citations", () => copyWithCitations(result)));
    attachFlagButton(actionsRow, prompt, result);
  }
  actionsRow.appendChild(actionButton("↻ Regenerate", () => runDocs(prompt)));
  turnEl.appendChild(actionsRow);
  return actionsRow;
}

/** Fully (non-streaming) renders one already-finished turn into the log —
 * used when replaying a thread's history after switching documents in
 * the sidebar. */
function renderStoredTurn(turn) {
  const turnEl = buildTurnElement(turn.prompt);
  const p = el("p", "a-text");
  if (turn.isError) {
    p.classList.add("msg-error");
    p.textContent = turn.result.answer;
  } else {
    const excerptsLocal = turn.result.excerpts || [];
    p.innerHTML = renderAnswerHtml(turn.result.answer, excerptsLocal, turn.globalStart);
    turnEl.appendChild(p);
    if (excerptsLocal.length === 0) {
      const band = confBand(turn.result.confidence);
      const inline = el("div", "inline-conf");
      inline.innerHTML = `<span class="dot conf-${band}-fill"></span><span>${turn.result.confidence != null ? turn.result.confidence + "% confident" : "confidence unknown"}</span>`;
      turnEl.appendChild(inline);
    }
    attachTurnActions(turnEl, turn.prompt, turn.result, false);
    docsLog.appendChild(turnEl);
    return;
  }
  turnEl.appendChild(p);
  attachTurnActions(turnEl, turn.prompt, turn.result, true);
  docsLog.appendChild(turnEl);
}

/** Clears and rebuilds the whole log + evidence column from the given
 * thread's stored turns — used on every thread switch. */
function renderThread(key) {
  const thread = getThread(key);
  docsLog.innerHTML = "";
  evidenceList.innerHTML = "";
  thread.turns.forEach((turn) => {
    renderStoredTurn(turn);
    if (!turn.isError) appendEvidenceForTurn(turn.prompt, turn.result, turn.globalStart);
  });
  renderDocsLogHint();
  renderEvidenceEmpty();
}

// ---- asking ----
function finalizeTurn(turnEl, streamMsg, actionsRow, prompt, result, isError, thread) {
  if (isError) {
    streamMsg.element.classList.add("msg-error");
    streamMsg.element.textContent = result.answer;
  } else {
    const excerptsLocal = result.excerpts || [];
    const globalStart = thread.citationCounter + 1;
    streamMsg.element.innerHTML = renderAnswerHtml(result.answer, excerptsLocal, globalStart);

    if (excerptsLocal.length === 0) {
      const band = confBand(result.confidence);
      const inline = el("div", "inline-conf");
      inline.innerHTML = `<span class="dot conf-${band}-fill"></span><span>${result.confidence != null ? result.confidence + "% confident" : "confidence unknown"}</span>`;
      streamMsg.element.insertAdjacentElement("afterend", inline);
    }

    appendEvidenceForTurn(prompt, result, globalStart);
    thread.citationCounter += excerptsLocal.length;
    thread.turns.push({ prompt, result, isError: false, globalStart });
  }

  if (isError) thread.turns.push({ prompt, result, isError: true });

  actionsRow.style.display = "flex";
  actionsRow.innerHTML = "";
  actionsRow.appendChild(actionButton("Ask a follow-up", () => {
    docsPromptInput.focus();
    docsPromptInput.scrollIntoView({ block: "nearest" });
  }));
  if (!isError) {
    actionsRow.appendChild(actionButton("Copy with citations", () => copyWithCitations(result)));
    attachFlagButton(actionsRow, prompt, result);
  }
  actionsRow.appendChild(actionButton("↻ Regenerate", () => runDocs(prompt)));

  docsLog.scrollTop = docsLog.scrollHeight;
}

function runDocs(prompt) {
  const askedThreadKey = activeThreadKey;
  const thread = getThread(askedThreadKey);
  const docIdForAsk = askedThreadKey === ALL_DOCS_KEY ? undefined : askedThreadKey;

  // Only touch the visible log if the user is still on the thread this
  // question was asked from — if they've switched documents mid-answer,
  // the result still gets saved into the right thread's history below,
  // it just doesn't render live.
  const isStillActive = () => activeThreadKey === askedThreadKey;

  let turnEl, streamMsg, actionsRow;
  if (isStillActive()) {
    clearEmptyState(docsLog);
    turnEl = buildTurnElement(prompt);
    streamMsg = createStreamingAnswer(turnEl);
    actionsRow = el("div", "turn-actions");
    actionsRow.style.display = "none";
    turnEl.appendChild(actionsRow);
    docsLog.appendChild(turnEl);
    docsLog.scrollTop = docsLog.scrollHeight;
  }

  docsSendBtn.disabled = true;
  const historyForThisAsk = thread.history.slice();

  streamRequest("/api/docs", { prompt, history: historyForThisAsk, docId: docIdForAsk }, {
    onDelta: (delta) => { if (isStillActive() && streamMsg) streamMsg.appendDelta(delta); },
    onDone: (result) => {
      pushThreadHistory(thread, "user", prompt);
      pushThreadHistory(thread, "assistant", result.answer);
      if (isStillActive() && turnEl) {
        finalizeTurn(turnEl, streamMsg, actionsRow, prompt, result, false, thread);
      } else {
        const excerptsLocal = result.excerpts || [];
        const globalStart = thread.citationCounter + 1;
        thread.citationCounter += excerptsLocal.length;
        thread.turns.push({ prompt, result, isError: false, globalStart });
      }
      docsSendBtn.disabled = false;
    },
    onError: (message) => {
      const errResult = { answer: message };
      if (isStillActive() && turnEl) {
        finalizeTurn(turnEl, streamMsg, actionsRow, prompt, errResult, true, thread);
      } else {
        thread.turns.push({ prompt, result: errResult, isError: true });
      }
      docsSendBtn.disabled = false;
    },
  });
}

function sendDocs() {
  const prompt = docsPromptInput.value.trim();
  if (!prompt) return;
  docsPromptInput.value = "";
  runDocs(prompt);
}

docsSendBtn.addEventListener("click", sendDocs);
docsPromptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendDocs();
  }
});
docsPromptInput.focus();

exportBtn.addEventListener("click", exportConversation);

// ---- settings ----
// Cached on each Settings open so the change listener doesn't need a
// fresh fetch just to re-read the (static) strategy metadata.
let chunkingStrategiesCache = {};
let embeddingModelsCache = {};

function populateChunkingStrategyOptions(strategies) {
  chunkingStrategyInput.innerHTML = "";
  for (const [id, info] of Object.entries(strategies || {})) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info.label;
    chunkingStrategyInput.appendChild(opt);
  }
}

function updateChunkingStrategyHint() {
  const info = chunkingStrategiesCache[chunkingStrategyInput.value];
  chunkingStrategyHint.textContent = info ? info.description : "";
}

function populateEmbeddingModelOptions(models) {
  embeddingModelInput.innerHTML = "";
  for (const [id, info] of Object.entries(models || {})) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info.label;
    embeddingModelInput.appendChild(opt);
  }
}

function updateEmbeddingModelHint() {
  const info = embeddingModelsCache[embeddingModelInput.value];
  embeddingModelHint.textContent = info ? info.description : "";
}

chunkingStrategyInput.addEventListener("change", updateChunkingStrategyHint);
embeddingModelInput.addEventListener("change", updateEmbeddingModelHint);

settingsBtn.addEventListener("click", async () => {
  const res = await fetch("/api/settings");
  const settings = await res.json();
  apiKeyInput.value = settings.apiKey || "";
  modelInput.value = settings.model || "gpt-5.4";
  chunkingStrategiesCache = settings.chunkingStrategies || {};
  populateChunkingStrategyOptions(chunkingStrategiesCache);
  chunkingStrategyInput.value = settings.chunkingStrategy || "auto";
  updateChunkingStrategyHint();
  chunkMaxCharsInput.value = settings.chunkMaxChars || 1400;
  chunkOverlapCharsInput.value = settings.chunkOverlapChars || 190;
  embeddingModelsCache = settings.embeddingModels || {};
  populateEmbeddingModelOptions(embeddingModelsCache);
  embeddingModelInput.value = settings.embeddingModel || "text-embedding-3-small";
  updateEmbeddingModelHint();
  rerankingEnabledInput.checked = settings.rerankingEnabled !== false;
  settingsPanel.classList.remove("hidden");
});

cancelSettingsBtn.addEventListener("click", () => settingsPanel.classList.add("hidden"));

saveSettingsBtn.addEventListener("click", async () => {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value,
      chunkingStrategy: chunkingStrategyInput.value,
      chunkMaxChars: Number(chunkMaxCharsInput.value) || undefined,
      chunkOverlapChars: Number(chunkOverlapCharsInput.value),
      embeddingModel: embeddingModelInput.value,
      rerankingEnabled: rerankingEnabledInput.checked,
    }),
  });
  settingsPanel.classList.add("hidden");
});

// ---- evals + flagged answers panel ----
function renderEvalHistory(runs) {
  evalsHistory.innerHTML = "";
  if (!runs || runs.length === 0) {
    evalsHistory.appendChild(el("p", "setting-hint", "No runs yet."));
    return;
  }
  runs.forEach((run) => {
    const row = el("div", "eval-history-row");
    const when = new Date(run.timestamp).toLocaleString();
    row.appendChild(el("span", null, `${when} — ${run.passCount}/${run.totalCount} passed`));
    evalsHistory.appendChild(row);
  });
}

function renderFlagsHistory(flags) {
  flagsHistory.innerHTML = "";
  if (!flags || flags.length === 0) {
    flagsHistory.appendChild(el("p", "setting-hint", "No flagged answers yet."));
    return;
  }
  flags.forEach((flag) => {
    const row = el("div", "flag-history-row");
    const when = new Date(flag.timestamp).toLocaleString();
    row.appendChild(el("p", "flag-history-q", `${when}${flag.docName ? " — " + flag.docName : ""}: ${flag.question}`));
    if (flag.note) row.appendChild(el("p", "flag-history-note", flag.note));
    flagsHistory.appendChild(row);
  });
}

async function openEvalsPanel() {
  evalsError.textContent = "";
  evalsResults.innerHTML = "";
  const [historyRes, flagsRes] = await Promise.all([
    fetch("/api/evals/history"),
    fetch("/api/flags"),
  ]);
  const { runs } = await historyRes.json();
  const { flags } = await flagsRes.json();
  renderEvalHistory(runs);
  renderFlagsHistory(flags);
  evalsPanel.classList.remove("hidden");
}

evalsBtn.addEventListener("click", openEvalsPanel);
closeEvalsBtn.addEventListener("click", () => evalsPanel.classList.add("hidden"));

runEvalsBtn.addEventListener("click", async () => {
  evalsError.textContent = "";
  evalsResults.innerHTML = "";
  let cases;
  try {
    cases = JSON.parse(evalsInput.value);
    if (!Array.isArray(cases)) throw new Error("Expected a JSON array of cases.");
  } catch (err) {
    evalsError.textContent = "Invalid JSON: " + err.message;
    return;
  }
  runEvalsBtn.disabled = true;
  runEvalsBtn.textContent = "Running…";
  try {
    const res = await fetch("/api/evals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cases }),
    });
    const run = await res.json();
    if (!res.ok) throw new Error(run.error || "Eval run failed.");
    run.results.forEach((r) => {
      const row = el("div", `eval-result-row ${r.passed ? "eval-pass" : "eval-fail"}`);
      row.appendChild(el("span", "eval-result-label", `${r.passed ? "✓" : "✗"} ${r.label}`));
      if (!r.passed) row.appendChild(el("span", "eval-result-missing", `missing: ${r.missingKeywords.join(", ")}`));
      evalsResults.appendChild(row);
    });
    evalsResults.insertAdjacentElement("afterbegin", el("p", "setting-hint", `${run.passCount}/${run.totalCount} passed`));
    const historyRes = await fetch("/api/evals/history");
    const { runs } = await historyRes.json();
    renderEvalHistory(runs);
  } catch (err) {
    evalsError.textContent = err.message || String(err);
  } finally {
    runEvalsBtn.disabled = false;
    runEvalsBtn.textContent = "Run evals";
  }
});

// ---- documents column ----
function switchThread(key) {
  if (key === activeThreadKey) return;
  activeThreadKey = key;
  renderThread(activeThreadKey);
  highlightActiveDocItem();
  docsPromptInput.focus();
}

function highlightActiveDocItem() {
  docsList.querySelectorAll(".doc-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.threadKey === activeThreadKey);
  });
}

// Per-document upload status rows (2026-09-16, explicit user request:
// "separate document tab where we upload multiple document and on
// processing and then chat button appear ... click its goes to chat for
// that document which process successfully") -- previously the ONLY
// upload feedback was one shared status line at the bottom ("Adding 1
// file... -- est. ~1-3 min"), with no way to tell which of several
// uploaded files was done, still going, or failed, and no obvious way to
// jump into a specific document's chat (the completed rows WERE already
// clickable, but nothing on screen said so). Now every file in a batch
// gets its own row the moment the batch starts, showing a spinner while
// it's still processing; on success the row is simply replaced by the
// real (now clickable, with a visible "Chat" button) document row once
// refreshDocsList() picks it up; on failure the row turns into a
// dismissible error instead of just vanishing.
let pendingUploadSeq = 0;
const pendingUploads = new Map(); // id -> { id, fileName, status: "processing" | "error", message }

function beginPendingUploads(fileNames) {
  for (const fileName of fileNames) {
    const id = `pending-${++pendingUploadSeq}`;
    pendingUploads.set(id, { id, fileName, status: "processing", message: "Processing…" });
  }
  renderDocsList(docsCache);
}

// Matches a just-resolved filename back to its pending row. Deliberately
// only matches rows still "processing" (not already-resolved ones), so
// two files with the identical name in the same batch each get matched
// to their OWN row rather than both hitting the first one found.
function findPendingByName(fileName) {
  for (const p of pendingUploads.values()) {
    if (p.fileName === fileName && p.status === "processing") return p;
  }
  return null;
}

function dismissPendingUpload(id) {
  pendingUploads.delete(id);
  renderDocsList(docsCache);
}

function scheduleAutoDismiss(id) {
  setTimeout(() => {
    if (pendingUploads.has(id)) dismissPendingUpload(id);
  }, 15000);
}

function renderDocsList(docs) {
  docsList.innerHTML = "";

  // "All documents" is always shown when there's at least one document —
  // it's the combined thread that searches every uploaded file together.
  if (docs && docs.length > 0) {
    const allItem = el("div", "doc-item doc-item-all");
    allItem.dataset.threadKey = ALL_DOCS_KEY;
    const badge = el("span", "doc-badge doc-badge-all", "∗");
    const meta = el("div", "doc-info");
    meta.appendChild(el("div", "doc-name", "All documents"));
    meta.appendChild(el("div", "doc-meta", "Searches every uploaded file"));
    allItem.appendChild(badge);
    allItem.appendChild(meta);
    allItem.addEventListener("click", () => switchThread(ALL_DOCS_KEY));
    docsList.appendChild(allItem);
  }

  for (const p of pendingUploads.values()) {
    const isError = p.status === "error";
    const info = docTypeInfo(p.fileName);
    const item = el("div", `doc-item doc-item-pending${isError ? " doc-item-error" : ""}`);
    const badge = el("span", `doc-badge ${isError ? "doc-badge-error" : info.cls}`, isError ? "!" : info.label);
    const meta = el("div", "doc-info");
    meta.appendChild(el("div", "doc-name", p.fileName));
    meta.appendChild(el("div", "doc-meta", p.message));
    item.appendChild(badge);
    item.appendChild(meta);
    if (isError) {
      const dismiss = el("button", "doc-pending-dismiss", "✕");
      dismiss.title = "Dismiss";
      dismiss.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissPendingUpload(p.id);
      });
      item.appendChild(dismiss);
    } else {
      item.appendChild(el("span", "doc-item-spinner"));
    }
    docsList.appendChild(item);
  }

  if ((!docs || docs.length === 0) && pendingUploads.size === 0) {
    docsList.appendChild(el("div", "doc-item empty-state", "No documents yet — click \"+ Add\" above, or drag files in."));
    return;
  }
  if (docs) {
    for (const doc of docs) {
      const info = docTypeInfo(doc.name);
      const item = el("div", "doc-item");
      item.dataset.threadKey = doc.id;
      item.title = "View this document's own chat";
      const badge = el("span", `doc-badge ${info.cls}`, info.label);
      const meta = el("div", "doc-info");
      meta.appendChild(el("div", "doc-name", doc.name));
      meta.appendChild(el("div", "doc-meta", `${doc.chunkCount} chunk${doc.chunkCount === 1 ? "" : "s"}`));
      item.appendChild(badge);
      item.appendChild(meta);
      const chatBtn = el("button", "doc-chat-btn", "Chat →");
      chatBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        switchThread(doc.id);
      });
      item.appendChild(chatBtn);
      item.addEventListener("click", () => switchThread(doc.id));
      docsList.appendChild(item);
    }
  }
  highlightActiveDocItem();
}

async function refreshDocsList() {
  const res = await fetch("/api/docs/list");
  const { docs } = await res.json();
  docsCache = docs || [];
  renderDocsList(docsCache);
  docCountLabel.textContent = `${docsCache.length} document${docsCache.length === 1 ? "" : "s"}`;
}

// Shared by both the file-picker upload flow and the drag-and-drop flow —
// both end up with an { added, errors } result from the server and need
// the exact same status/list handling.
//
// Multiple upload BATCHES can now run at once (2026-09-16, fixes "can't
// add another document while the last one is still chunking") -- a
// second file-picker selection, or a drop, fired while an earlier batch
// is still uploading/embedding. activeUploadBatches only exists so the
// shared status line/timer isn't stopped by whichever batch happens to
// finish first while others are still going; it never blocks a NEW batch
// from starting (see the two listeners below, which no longer disable
// anything while a batch is in flight).
let activeUploadBatches = 0;

async function handleUploadResult(resultPromise, batchFileNames) {
  activeUploadBatches++;
  try {
    const result = await resultPromise;
    const stillOthersRunning = activeUploadBatches > 1;

    // Resolve each per-file pending row into either "gone" (success --
    // the real, now-clickable doc row takes its place once
    // refreshDocsList() runs below) or a dismissible error.
    for (const added of result.added || []) {
      const match = findPendingByName(added.name);
      if (match) pendingUploads.delete(match.id);
    }
    for (const err of result.errors || []) {
      const match = findPendingByName(err.fileName);
      if (match) {
        match.status = "error";
        match.message = err.message;
        scheduleAutoDismiss(match.id);
      }
    }
    // Anything in this batch that's neither in added nor errors
    // (shouldn't normally happen) still gets its pending row cleared
    // rather than leaving it stuck on "Processing…" forever.
    for (const name of batchFileNames || []) {
      const stale = findPendingByName(name);
      if (stale) pendingUploads.delete(stale.id);
    }

    for (const err of result.errors || []) {
      setDocsStatus(`Couldn't add ${err.fileName}: ${err.message}`, stillOthersRunning);
    }
    if ((result.added || []).length > 0) {
      setDocsStatus(`Added ${result.added.length} document${result.added.length === 1 ? "" : "s"}.`, stillOthersRunning);
    } else if ((result.errors || []).length === 0) {
      setDocsStatus("", stillOthersRunning);
    }
    await refreshDocsList();
  } catch (err) {
    // The whole batch failed outright (e.g. a network error) -- mark
    // every one of this batch's pending rows as errored instead of
    // leaving them stuck on "Processing…" forever.
    for (const name of batchFileNames || []) {
      const match = findPendingByName(name);
      if (match) {
        match.status = "error";
        match.message = err.message || String(err);
        scheduleAutoDismiss(match.id);
      }
    }
    renderDocsList(docsCache);
    setDocsStatus(err.message || String(err), activeUploadBatches > 1);
  } finally {
    activeUploadBatches--;
  }
}

// Browsers don't expose real filesystem paths for File objects (unlike
// Electron), so both the file-picker and drag-and-drop paths here upload
// the actual file bytes via multipart/form-data to /api/docs/upload.
async function uploadFiles(files) {
  const formData = new FormData();
  for (const file of files) formData.append("files", file);
  const res = await fetch("/api/docs/upload", { method: "POST", body: formData });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return res.json();
}

docsUploadBtn.addEventListener("click", () => docsFileInput.click());

docsFileInput.addEventListener("change", () => {
  const files = Array.from(docsFileInput.files || []);
  docsFileInput.value = "";
  if (files.length === 0) return;
  // The browser's own file picker is safe to reopen at any time (unlike
  // Electron's native dialog, there's no shared window state to guard),
  // so nothing here blocks starting this batch while an earlier one is
  // still processing.
  setDocsStatus(`Adding ${files.length} file${files.length === 1 ? "" : "s"}…`, true);
  setDocsEta(estimateProcessingLabel(files));
  const fileNames = files.map((f) => f.name);
  beginPendingUploads(fileNames);
  handleUploadResult(uploadFiles(files), fileNames);
});

// Drag-and-drop works over the whole panel, so a file can be dropped
// anywhere on the page, not just onto the documents column.
let dragDepth = 0;

docsTab.addEventListener("dragover", (e) => e.preventDefault());
docsTab.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  docsTab.classList.add("drag-over");
});
docsTab.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) docsTab.classList.remove("drag-over");
});
docsTab.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  docsTab.classList.remove("drag-over");
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;
  setDocsStatus(`Adding ${files.length} file${files.length === 1 ? "" : "s"}…`, true);
  setDocsEta(estimateProcessingLabel(files));
  const fileNames = files.map((f) => f.name);
  beginPendingUploads(fileNames);
  handleUploadResult(uploadFiles(files), fileNames);
});

docsClearBtn.addEventListener("click", async () => {
  await fetch("/api/docs/clear", { method: "POST" });
  setDocsStatus("Documents cleared.", false);
  // Clearing docs also clears every document's conversation and evidence
  // log — a leftover Q&A referencing documents that no longer exist, or
  // citation numbers pointing at excerpts that no longer resolve to
  // anything, would just be confusing.
  threads.clear();
  activeThreadKey = ALL_DOCS_KEY;
  docsLog.innerHTML = "";
  evidenceList.innerHTML = "";
  renderDocsLogHint();
  renderEvidenceEmpty();
  await refreshDocsList();
});

// Uploaded documents are per-LOGIN-SESSION now, not per-tab (2026-09-08,
// superseding the 2026-09-02 behavior this comment used to describe).
// They now survive a refresh or a short absence — the previous
// beforeunload -> sendBeacon("/api/docs/clear") handler that lived here
// was removed because a browser's unload events fire on an ordinary
// REFRESH just as much as an actual close, with no reliable way to tell
// the two apart client-side; wiring immediate cleanup to it would have
// silently broken "survives a refresh". Documents are cleared for good
// only by an explicit Log out (see logoutBtn below) or, if a tab is
// closed without logging out, by the server's own idle-timeout sweep
// (see authStore.ts's IDLE_TIMEOUT_MS) — nothing client-side is
// trustworthy enough to do better than that.
logoutBtn.addEventListener("click", async () => {
  logoutBtn.disabled = true;
  try {
    await fetch("/api/logout", { method: "POST" });
  } finally {
    window.location.href = "/login.html";
  }
});

refreshDocsList();
renderDocsLogHint();
renderEvidenceEmpty();
