// ClickAI desktop renderer — "Clarity" redesign (2026-09-02, revised twice
// same day: documents moved to a persistent left column instead of a
// toggled drawer; then per-document chat threading added so a question
// can be scoped to just one uploaded document instead of always being
// scored against every document together — explicit user request after
// noticing a two-document upload kept answering only from whichever doc
// actually matched the question). Docs-only: strict, document-grounded
// Q&A with a running Evidence column, citation markers color-linked to
// their evidence card, and "Ask a follow-up" / "Copy with citations"
// actions.

const closeBtn = document.getElementById("close-btn");
const exportBtn = document.getElementById("export-btn");
const settingsBtn = document.getElementById("settings-btn");
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
const hotkeyInput = document.getElementById("hotkey-input");
const launchAtLoginInput = document.getElementById("launch-at-login-input");
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
const docsClearBtn = document.getElementById("docs-clear-btn");
const docsList = document.getElementById("docs-list");
const docsStatus = document.getElementById("docs-status");
const docsStatusText = document.getElementById("docs-status-text");
const docsStatusEta = document.getElementById("docs-status-eta");
const docsStatusElapsed = document.getElementById("docs-status-elapsed");

// Loading-spinner + elapsed-time wrapper around docs-status (explicit
// user request, 2026-09-07: show loading while chunking/uploading, then
// a follow-up request the same day: "add time while chunking so person
// get understand how much time take"). `loading: true` adds a small CSS
// spinner next to the text plus a live "(Xs)"/"(M:SS)" counter that keeps
// running across every progress message of one upload (Reading… ->
// Splitting… -> Embedding…) rather than resetting at each step, so the
// number reflects how long the WHOLE operation has taken so far. Every
// terminal message ("Added N documents.", an error, "Documents
// cleared.", "") clears it.
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

// Set once per operation by the main process's one-time "docs-status-eta"
// event (2026-09-07, explicit user request: "show mins to chunk... depend
// on file") — separate from the ever-changing progress text so the
// estimate stays visible across every Reading/Splitting/Embedding step
// instead of being overwritten by them.
window.clickai.onDocsEta((label) => {
  docsStatusEta.textContent = label ? ` — est. ${label}` : "";
});

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
  // "Thinking" indicator (explicit user request, 2026-09-07: show loading
  // while retrieval/embedding/reranking is happening, before the answer
  // actually starts streaming) — three bouncing dots, removed the moment
  // the first real delta arrives. finalizeTurn's own textContent/innerHTML
  // overwrite removes it too, in the no-streaming-content ("nothing
  // retrieved") path, since that replaces this whole element's children.
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

// ---- rendering a finished turn (shared by live asks and thread switches) ----
function buildTurnElement(prompt) {
  const turnEl = el("div", "turn");
  turnEl.appendChild(el("span", "q-label", "You asked"));
  turnEl.appendChild(el("p", "q-text", prompt));
  return turnEl;
}

// Human-in-the-loop flagging (2026-09-08): lets a person mark an answer as
// wrong/questionable right from the turn, with an optional free-text note
// on what was wrong or what the correct answer should have said. Uses an
// inline revealed textarea rather than a native prompt()/confirm() dialog
// -- native dialogs render invisibly behind this frameless always-on-top
// overlay window and would hang the app.
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
        await window.clickai.flagAnswer({
          docId,
          docName,
          question: prompt,
          answer: result.answer,
          note: noteInput.value.trim() || undefined,
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

  window.clickai.askDocsStream(prompt, historyForThisAsk, docIdForAsk, {
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

closeBtn.addEventListener("click", () => window.clickai.hide());
exportBtn.addEventListener("click", exportConversation);

// ---- settings ----
// Cached on each Settings open so the change listener doesn't need a
// fresh IPC round-trip just to re-read the (static) strategy metadata.
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

settingsBtn.addEventListener("click", async () => {
  const settings = await window.clickai.getSettings();
  apiKeyInput.value = settings.apiKey || "";
  modelInput.value = settings.model || "gpt-5.4";
  hotkeyInput.value = settings.hotkey || "CommandOrControl+Shift+Space";
  launchAtLoginInput.checked = await window.clickai.getLaunchAtLogin();
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

chunkingStrategyInput.addEventListener("change", updateChunkingStrategyHint);
embeddingModelInput.addEventListener("change", updateEmbeddingModelHint);

cancelSettingsBtn.addEventListener("click", () => settingsPanel.classList.add("hidden"));

saveSettingsBtn.addEventListener("click", async () => {
  await window.clickai.saveSettings({
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value,
    hotkey: hotkeyInput.value.trim(),
    chunkingStrategy: chunkingStrategyInput.value,
    chunkMaxChars: Number(chunkMaxCharsInput.value) || undefined,
    chunkOverlapChars: Number(chunkOverlapCharsInput.value),
    embeddingModel: embeddingModelInput.value,
    rerankingEnabled: rerankingEnabledInput.checked,
  });
  await window.clickai.setLaunchAtLogin(launchAtLoginInput.checked);
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
  const [history, flags] = await Promise.all([
    window.clickai.getEvalHistory(),
    window.clickai.getFlaggedAnswers(),
  ]);
  renderEvalHistory(history);
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
    const run = await window.clickai.runEvals(cases);
    run.results.forEach((r) => {
      const row = el("div", `eval-result-row ${r.passed ? "eval-pass" : "eval-fail"}`);
      row.appendChild(el("span", "eval-result-label", `${r.passed ? "✓" : "✗"} ${r.label}`));
      if (!r.passed) row.appendChild(el("span", "eval-result-missing", `missing: ${r.missingKeywords.join(", ")}`));
      evalsResults.appendChild(row);
    });
    evalsResults.insertAdjacentElement("afterbegin", el("p", "setting-hint", `${run.passCount}/${run.totalCount} passed`));
    renderEvalHistory(await window.clickai.getEvalHistory());
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

  if (!docs || docs.length === 0) {
    docsList.appendChild(el("div", "doc-item empty-state", "No documents yet — click \"+ Add\" above, or drag files in."));
    return;
  }
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
    item.addEventListener("click", () => switchThread(doc.id));
    docsList.appendChild(item);
  }
  highlightActiveDocItem();
}

async function refreshDocsList() {
  const docs = await window.clickai.listDocs();
  docsCache = docs || [];
  renderDocsList(docsCache);
  docCountLabel.textContent = `${docsCache.length} document${docsCache.length === 1 ? "" : "s"}`;
}

function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
}

// Multiple upload BATCHES (2026-09-16, fixes "can't add another document
// while the last one is still chunking") can now run at once -- one from
// the file picker, another from a drag-and-drop, dropped while the first
// is still embedding. This counter is only here so the shared status
// line/timer don't get stopped by whichever batch happens to finish
// first while others are still going; it never blocks a NEW batch from
// starting.
let activeUploadBatches = 0;

async function handleUploadResult(resultPromise) {
  activeUploadBatches++;
  try {
    const result = await resultPromise;
    const stillOthersRunning = activeUploadBatches > 1;
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
    setDocsStatus(err.message || String(err), activeUploadBatches > 1);
  } finally {
    activeUploadBatches--;
  }
}

docsUploadBtn.addEventListener("click", async () => {
  // Only guards the native file-picker dialog itself (Electron's overlay
  // always-on-top toggling around it isn't safe to run twice at once) --
  // re-enabled the instant the dialog closes, NOT after the documents it
  // returns finish processing. That's the actual fix: picking more files
  // is never blocked by an earlier batch still chunking/embedding.
  docsUploadBtn.disabled = true;
  setDocsStatus("Opening file picker…", true);
  let filePaths;
  try {
    const result = await withTimeout(
      window.clickai.uploadDocuments(),
      120000,
      "File picker didn't respond. Try clicking \"+ Add\" again."
    );
    filePaths = result.filePaths || [];
  } catch (err) {
    docsUploadBtn.disabled = false;
    setDocsStatus(err.message || String(err), false);
    return;
  }
  docsUploadBtn.disabled = false;
  if (filePaths.length === 0) {
    if (activeUploadBatches === 0) setDocsStatus("", false);
    return;
  }
  // ETA display (desktop) comes from main.ts pushing "docs-status-eta"
  // itself once addDocumentPaths() there starts -- nothing to compute
  // client-side here.
  handleUploadResult(window.clickai.addDocumentPaths(filePaths));
});

// Drag-and-drop works over the whole panel regardless of where the docs
// column is, so a file can be dropped anywhere on the window.
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
  const filePaths = files.map((f) => f.path).filter(Boolean);
  if (filePaths.length === 0) return;
  // No dialog involved here, so nothing needs guarding at all -- this can
  // fire concurrently with the file-picker flow above, or with another
  // drop, without blocking anything (2026-09-16, same fix as the "+ Add"
  // button).
  setDocsStatus(`Adding ${filePaths.length} file${filePaths.length === 1 ? "" : "s"}…`, true);
  handleUploadResult(window.clickai.addDocumentPaths(filePaths));
});

docsClearBtn.addEventListener("click", async () => {
  await window.clickai.clearDocs();
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

window.clickai.onDocsStatus((message) => { setDocsStatus(message, !!message); });

refreshDocsList();
renderDocsLogHint();
renderEvidenceEmpty();
