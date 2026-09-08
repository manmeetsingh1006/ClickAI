import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import OpenAI from "openai";
import { store } from "./store";
import { withRetry, DEFAULT_CLIENT_TIMEOUT_MS } from "./retry";

const mammoth = require("mammoth");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const { convert: convertHtmlToText } = require("html-to-text");
const { parse: parseHtml } = require("node-html-parser");

const PLAIN_TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".log"]);
const EXCEL_EXTENSIONS = new Set([".xlsx", ".xlsm"]);
const POWERPOINT_EXTENSIONS = new Set([".pptx", ".pptm"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));
// Everything OpenAI's transcription endpoint accepts directly — mp4 (and
// webm) get their audio track transcribed server-side, no local ffmpeg
// step needed. 25MB is the endpoint's own file-size limit.
const AUDIO_VIDEO_EXTENSIONS = new Set([".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"]);
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

export function isSupportedDocument(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (
    ext === ".pdf" ||
    ext === ".docx" ||
    EXCEL_EXTENSIONS.has(ext) ||
    POWERPOINT_EXTENSIONS.has(ext) ||
    HTML_EXTENSIONS.has(ext) ||
    IMAGE_EXTENSIONS.has(ext) ||
    AUDIO_VIDEO_EXTENSIONS.has(ext) ||
    PLAIN_TEXT_EXTENSIONS.has(ext)
  );
}

// pdfjs-dist ships ESM-only, so it's loaded via dynamic import() from this
// CommonJS module (Node supports that natively) and cached after first use.
//
// On import, pdfjs-dist's Node.js entrypoint logs a handful of console.warn
// lines about @napi-rs/canvas / DOMMatrix / Path2D / standardFontDataUrl not
// being available. These are cosmetic: they only matter for pdfjsLib.render()
// (rasterizing a page to a canvas), which ClickAI never calls — text
// extraction here only ever uses page.getTextContent(). Verified harmless
// with a live smoke test; muted here (only for the duration of this one
// import, and only pdfjs's own known warning strings) so they stop showing
// up in the terminal on every startup.
// Scoped to exactly the 3 cosmetic canvas-related warnings pdfjs-dist emits
// on Node when @napi-rs/canvas isn't available — NOT standardFontDataUrl,
// which can indicate a real text-decoding failure on PDFs whose fonts
// aren't embedded with proper encoding, and should stay visible.
const PDFJS_STARTUP_WARNING_RE = /napi-rs\/canvas|Cannot polyfill `DOMMatrix`|Cannot polyfill `Path2D`/i;
let pdfjsLibPromise: Promise<any> | null = null;
function getPdfjs(): Promise<any> {
  if (!pdfjsLibPromise) {
    const originalWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      const text = args.map((a) => String(a)).join(" ");
      if (PDFJS_STARTUP_WARNING_RE.test(text)) return;
      originalWarn(...args);
    };
    pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs")
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
        return lib;
      })
      .finally(() => {
        console.warn = originalWarn;
      });
  }
  return pdfjsLibPromise;
}

async function extractPdfText(filePath: string): Promise<string> {
  const pdfjsLib = await getPdfjs();
  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer);

  const loadingTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
  });

  const pdf = await loadingTask.promise;
  try {
    // Each page's text is prefixed with an invisible page marker
    // (\u0001PAGE=<n>\u0001, 2026-09-02) so ragStore's chunker can tag
    // every chunk with the real PDF page it came from — real citations
    // ("p. 12") instead of a made-up section number. The marker uses a
    // control character that never appears in real document text, and is
    // stripped back out before a chunk's text is stored or shown.
    const pageTexts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => ("str" in item ? item.str : "")).join(" ");
      pageTexts.push(`\u0001PAGE=${i}\u0001\n${text}`);
    }
    return pageTexts.join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}

/** Renders a single ExcelJS cell value as plain text, unwrapping the
 * object shapes ExcelJS uses for formulas, errors, rich text, and
 * hyperlinks (recursively, since a formula's cached result can itself be
 * an error object) so nothing ever falls through to "[object Object]". */
function cellValueToText(raw: any): string {
  if (raw === null || raw === undefined) return "";
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw !== "object") return String(raw);

  if (raw.error !== undefined) return `#ERROR(${raw.error})`;
  if (raw.result !== undefined) return cellValueToText(raw.result);
  if (Array.isArray(raw.richText)) return raw.richText.map((r: any) => r.text).join("");
  if (typeof raw.text === "string") return raw.text; // hyperlink { text, hyperlink }
  if (typeof raw.formula === "string") return `=${raw.formula}`; // formula, no cached result
  if (typeof raw.sharedFormula === "string") return `=${raw.sharedFormula}`;
  return "";
}

/** Batches table rows into chunk-sized blocks with the header row repeated
 * at the top of EVERY batch, wrapped in \u0002TABLE\u0002...\u0002/TABLE\u0002
 * markers that ragStore's chunker (2026-09-02) recognizes and keeps intact
 * as a single atomic chunk instead of slicing through them by character
 * count. Without this, a chunk pulled from the middle of a wide table lost
 * its header row entirely — retrieval would hand the model a chunk like
 * "East | 120000 | 5%" with no idea what those columns mean, which is
 * exactly the kind of thing that made spreadsheet/HTML-table answers land
 * below the quality of prose answers even though retrieval itself was
 * working fine. Never splits a row in half; if a single row alone exceeds
 * the budget it just becomes an oversized batch of one rather than being
 * truncated. */
function buildTableBlocks(
  sourceLabel: string,
  header: string[],
  rows: string[][],
  maxBatchChars = 900
): string {
  if (rows.length === 0) return "";
  const headerLine = header.join(" | ");
  const blocks: string[] = [];
  let batchLines: string[] = [];
  let batchChars = headerLine.length;

  const flush = () => {
    if (batchLines.length === 0) return;
    const body = [headerLine, ...batchLines].filter(Boolean).join("\n");
    blocks.push(`\u0002TABLE\u0002${sourceLabel}\n${body}\u0002/TABLE\u0002`);
    batchLines = [];
    batchChars = headerLine.length;
  };

  // Some spreadsheet exports (Numbers -> Excel export summaries in
  // particular, 2026-09-03 real-world case) repeat the exact same
  // boilerplate/disclaimer text as its own "row" once per table on the
  // sheet — three identical rows all reading e.g. "This document was
  // exported from Numbers..." bloat a chunk with zero extra information
  // and crowd out the actually-different rows around them. Rows whose
  // formatted text exactly duplicates one already included are skipped
  // (kept once, not zero times) rather than re-included verbatim.
  const seenLines = new Set<string>();
  for (const row of rows) {
    const line = row.join(" | ");
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    if (batchLines.length > 0 && batchChars + line.length + 1 > maxBatchChars) {
      flush();
    }
    batchLines.push(line);
    batchChars += line.length + 1;
  }
  flush();

  return blocks.join("\n\n");
}

async function extractExcelText(filePath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheetBlocks: string[] = [];
  workbook.eachSheet((worksheet: any) => {
    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row: any) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        cells.push(cellValueToText(cell.value));
      });
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) rows.push(cells);
    });
    if (rows.length === 0) return;

    // First row is treated as the header, same convention as the HTML
    // table extractor below — repeated into every chunk-sized batch so a
    // chunk retrieved from anywhere in the sheet still says what its
    // columns mean.
    const header = rows[0];
    const dataRows = rows.slice(1);
    if (dataRows.length === 0) {
      sheetBlocks.push(`Sheet: ${worksheet.name}\n${header.join(" | ")}`);
      return;
    }
    const blocks = buildTableBlocks(`Sheet: ${worksheet.name}`, header, dataRows);
    if (blocks) sheetBlocks.push(blocks);
  });

  return sheetBlocks.join("\n\n");
}

/** Decodes the small set of XML entities that show up in OOXML text runs.
 * Not a full XML-entity decoder (no DTD/custom entities), but PowerPoint's
 * own text runs only ever use these plus numeric character references. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&"); // must be last, so it doesn't re-decode the above
}

/** Pulls the text out of every DrawingML <a:t> run in a slide/notes XML
 * string, in document order, and joins same-paragraph runs together.
 * PowerPoint splits a single sentence across multiple <a:t> runs whenever
 * formatting changes mid-run, so this deliberately doesn't try to be a full
 * XML parser — it just grabs run text and paragraph breaks, which is all a
 * RAG-style extractor needs. */
function extractRunText(xml: string): string {
  const paragraphs: string[] = [];
  const paraRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
  let paraMatch: RegExpExecArray | null;
  while ((paraMatch = paraRegex.exec(xml))) {
    const runTexts: string[] = [];
    const runRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let runMatch: RegExpExecArray | null;
    while ((runMatch = runRegex.exec(paraMatch[1]))) {
      runTexts.push(decodeXmlEntities(runMatch[1]));
    }
    const line = runTexts.join("");
    if (line.trim()) paragraphs.push(line);
  }
  return paragraphs.join("\n");
}

/** Renders a .pptx/.pptm deck as readable text: one "Slide N:" block per
 * slide (in slide order, not filename-sort order, which can differ), plus
 * a "Notes:" sub-block when that slide has speaker notes — those often
 * carry context/explanation that isn't on the slide itself. A .pptx is
 * just a zip of XML parts (Office Open XML), so this reads it directly
 * with jszip and regex-extracts text runs rather than pulling in a
 * dedicated (and mostly unmaintained) pptx-parsing package. */
async function extractPptxText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml$/)![1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml$/)![1], 10);
      return na - nb;
    });

  if (slideFiles.length === 0) {
    throw new Error("Couldn't find any slides in this PowerPoint file.");
  }

  const slideBlocks: string[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const slideXml = await zip.files[slideFiles[i]].async("string");
    const slideText = extractRunText(slideXml);

    const slideNumMatch = slideFiles[i].match(/slide(\d+)\.xml$/);
    const slideNum = slideNumMatch ? slideNumMatch[1] : String(i + 1);
    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    let notesText = "";
    if (zip.files[notesPath]) {
      const notesXml = await zip.files[notesPath].async("string");
      notesText = extractRunText(notesXml);
    }

    let block = `Slide ${i + 1}:\n${slideText || "(no text on this slide)"}`;
    if (notesText.trim()) {
      block += `\nNotes:\n${notesText}`;
    }
    slideBlocks.push(block);
  }

  return slideBlocks.join("\n\n");
}

/** Renders an HTML file as readable plain text: strips scripts/styles,
 * drops navigational chrome, keeps link targets inline as "text (url)" so a
 * citation-style question can still reference where something pointed, and
 * preserves basic structure (headings, paragraphs, list bullets, table
 * rows) as line breaks rather than collapsing everything to one run-on
 * paragraph. Uses html-to-text (a proper HTML parser under the hood, not
 * a regex strip) so malformed/real-world HTML is handled correctly. */
/** Reads every row of a parsed <table> element as an array of cell text
 * arrays (header row included, at index 0). Trailing empty cells on a row
 * are dropped the same way the Excel extractor drops them, so a ragged
 * real-world table doesn't leave a trail of empty " | " separators. */
function extractTableRows(tableEl: any): string[][] {
  const rows: string[][] = [];
  for (const tr of tableEl.querySelectorAll("tr")) {
    const cells = tr
      .querySelectorAll("th, td")
      .map((c: any) => c.text.replace(/\s+/g, " ").trim());
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

async function extractHtmlText(filePath: string): Promise<string> {
  const html = await fs.readFile(filePath, "utf-8");
  const root = parseHtml(html, { lowerCaseTagName: true });

  // Tables are pulled out and batched the same table-aware way as Excel
  // sheets (header row repeated into every chunk-sized batch, see
  // buildTableBlocks above) — html-to-text's built-in "dataTable" format
  // linearizes a table into plain rows with no header repetition, which
  // left the same header-less-chunk problem as the old Excel extractor.
  // Each table is removed from the DOM after extraction so the remaining
  // html-to-text pass over the rest of the page doesn't double-count it.
  const tableBlocks: string[] = [];
  const tableEls = root.querySelectorAll("table");
  tableEls.forEach((tableEl: any, i: number) => {
    const rows = extractTableRows(tableEl);
    const header = rows[0];
    const dataRows = rows.slice(1);
    if (header && dataRows.length > 0) {
      const blocks = buildTableBlocks(`Table ${i + 1}`, header, dataRows);
      if (blocks) tableBlocks.push(blocks);
    }
    tableEl.remove();
  });

  const proseText = convertHtmlToText(root.toString(), {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: false, linkBrackets: false } },
    ],
  }).trim();

  return [proseText, tableBlocks.join("\n\n")].filter(Boolean).join("\n\n");
}

/** OCRs an image (photo of a document, scanned page saved as an image
 * file, screenshot of text, etc.) via the vision model rather than a
 * dedicated OCR engine like Tesseract — this app already requires an
 * OpenAI API key for everything else, vision-model OCR handles messy
 * real-world photos/scans noticeably better than a classic OCR engine,
 * and it avoids bundling a multi-megabyte-per-language WASM+traineddata
 * OCR engine into an Electron app that isn't packaged/distributed yet.
 * Costs a small API call per image; that's an acceptable tradeoff here
 * since document upload is already an explicit, occasional user action,
 * not something on a hot path. */
async function extractImageText(filePath: string): Promise<string> {
  const apiKey = store.get("apiKey");
  if (!apiKey) {
    throw new Error("No OpenAI API key set. Open ClickAI settings and add your API key.");
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[ext] || "image/png";
  const buffer = await fs.readFile(filePath);
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

  const client = new OpenAI({ apiKey, timeout: DEFAULT_CLIENT_TIMEOUT_MS });
  const model = store.get("model") || "gpt-5.4";

  const response = await withRetry(() =>
    client.responses.create({
      model,
      instructions:
        "You are an OCR transcription tool. Transcribe ALL visible text in the image exactly as it appears, preserving reading order, line breaks, and structure (headings, lists, table rows) as best you can from the layout. Output ONLY the transcribed text — no commentary, no translation, no description of the image, no markdown formatting. If the image genuinely has no readable text in it, output exactly: (no text detected)",
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: dataUrl, detail: "high" }],
        },
      ],
      max_output_tokens: 4000,
    } as any)
  );

  const text = ((response as any).output_text ?? "").trim();
  return text === "(no text detected)" ? "" : text;
}

/** Transcribes an audio or video file (mp3/mp4/mpeg/mpga/m4a/wav/webm) via
 * OpenAI's transcription endpoint. mp4/webm are submitted as-is — the
 * endpoint extracts and transcribes the audio track server-side, so no
 * local ffmpeg step (and no extra native/binary dependency) is needed here.
 * Enforces the endpoint's own 25MB file-size limit up front with a clear
 * error rather than letting a large file fail with an opaque API error. */
async function extractAudioText(filePath: string): Promise<string> {
  const apiKey = store.get("apiKey");
  if (!apiKey) {
    throw new Error("No OpenAI API key set. Open ClickAI settings and add your API key.");
  }

  const stats = await fs.stat(filePath);
  if (stats.size > MAX_TRANSCRIBE_BYTES) {
    const mb = (stats.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `This file is ${mb}MB — audio/video transcription is limited to 25MB. Try a shorter clip or a compressed/lower-bitrate version.`
    );
  }

  const client = new OpenAI({ apiKey, timeout: DEFAULT_CLIENT_TIMEOUT_MS });
  const transcription = await withRetry(() =>
    client.audio.transcriptions.create({
      file: fsSync.createReadStream(filePath) as any,
      model: "gpt-transcribe",
    })
  );

  return (transcription.text ?? "").trim();
}

/** Extracts plain text from a document. Supports PDF, DOCX, Excel
 * (.xlsx/.xlsm), PowerPoint (.pptx/.pptm), HTML, images via OCR
 * (png/jpg/jpeg/gif/webp/bmp), audio/video via transcription
 * (mp3/mp4/mpeg/mpga/m4a/wav/webm), and common plain-text formats
 * (txt/md/csv/json/log). PDF
 * parsing uses pdfjs-dist directly (not the abandoned pdf-parse wrapper) —
 * it's actively maintained and far more tolerant of real-world PDFs with
 * imperfect structure. Excel parsing uses exceljs rather than the popular
 * "xlsx" (SheetJS) npm package, which has unpatched high-severity
 * prototype-pollution/ReDoS advisories on the public npm registry (the
 * SheetJS-recommended fix — installing their own CDN tarball instead of
 * the npm package — isn't reachable from this network's egress policy). */
/** Minimal RFC4180-ish CSV row parser — handles quoted fields (embedded
 * commas, newlines, and doubled "" escaped quotes). Used for .csv uploads
 * (2026-09-07 fix: a real user hit a 42MB/48MB CSV pair that took hours
 * to upload). Root cause: CSVs previously fell through to
 * PLAIN_TEXT_EXTENSIONS and got treated as generic prose text, same as a
 * PDF or DOCX. Every CSV row is single-\n-separated with no blank-line
 * paragraph breaks, so Auto chunking's heuristic (see chooseAutoStrategy
 * in chunking.ts) always read a big CSV as "a huge wall of text with no
 * structure" and fell through to its worst case — LLM-based chunking,
 * which calls the model once per ~6000-char window. For a 40MB+ file
 * that's thousands of sequential model calls just to guess at chunk
 * boundaries in what is already perfectly structured, comma-delimited
 * data. Fixed by parsing CSV into real rows and routing it through the
 * same buildTableBlocks batching XLSX sheets already use below — clean,
 * chunk-sized row batches with the header repeated in every batch, no
 * LLM guessing needed, and rows are never split down the middle the way
 * prose chunking could do to them. */
function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = content.length;
  while (i < len) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing field/row when the file has no final newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-blank rows (a trailing blank line is common in CSV exports).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

async function extractCsvText(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf-8");
  const rows = parseCsvRows(raw);
  if (rows.length === 0) return "";
  const header = rows[0];
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) return header.join(" | ");
  const label = `CSV: ${path.basename(filePath)}`;
  // Same batching buildTableBlocks already does for Excel sheets (header
  // repeated into every ~900-char batch, kept atomic downstream in
  // ragStore.ts's chunkText — never split by any prose strategy).
  return buildTableBlocks(label, header, dataRows);
}

export async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    return extractPdfText(filePath);
  }

  if (ext === ".csv") {
    return extractCsvText(filePath);
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (EXCEL_EXTENSIONS.has(ext)) {
    return extractExcelText(filePath);
  }

  if (POWERPOINT_EXTENSIONS.has(ext)) {
    return extractPptxText(filePath);
  }

  if (HTML_EXTENSIONS.has(ext)) {
    return extractHtmlText(filePath);
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return extractImageText(filePath);
  }

  if (AUDIO_VIDEO_EXTENSIONS.has(ext)) {
    return extractAudioText(filePath);
  }

  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    return fs.readFile(filePath, "utf-8");
  }

  throw new Error(`Unsupported file type: ${ext || "(no extension)"}. Supported: PDF, DOCX, XLSX, PPTX, HTML, PNG/JPG/GIF/WEBP/BMP (OCR), MP3/MP4/WAV/M4A/WEBM (transcription), TXT, MD, CSV, JSON.`);
}
