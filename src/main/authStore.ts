import { randomUUID } from "crypto";

/**
 * Web login/session store (2026-09-08, explicit user request: "create a
 * login page and create temporary username superadmin and password
 * superadmin"). Desktop-only ClickAI never needed this (one person, one
 * machine) — the web version, reachable by anyone who can hit the
 * server's URL, does. This is deliberately minimal: one hardcoded
 * temporary credential, not a real accounts system. The user asked for
 * exactly this as a stopgap; swapping in real accounts later only means
 * replacing validateCredentials()'s body, since every session-handling
 * piece below (cookie, idle timeout, document-store isolation) is already
 * credential-agnostic.
 *
 * What this unlocks (the actual point of the request): every session gets
 * its OWN document index (see ragStore.ts's per-sessionId SessionState) —
 * so refreshing the page, or even closing and reopening the tab within
 * the idle window, keeps a user's uploaded documents and lets them keep
 * chatting with them without re-uploading, while a DIFFERENT logged-in
 * session can never see or clear another session's documents. Documents
 * are still never written to disk outside the session's own temp folder,
 * and are wiped for good the moment the session ends (explicit logout, or
 * the idle-timeout sweep below).
 */

// Temporary, single, hardcoded credential (2026-09-08, explicit user
// request) — replace with a real accounts system when this app needs
// more than one person to log in. Deliberately not stored in the
// settings file or anywhere persisted; it's a fixed constant so it's
// easy to find and change later.
const TEMP_USERNAME = "superadmin";
const TEMP_PASSWORD = "superadmin";

export const SESSION_COOKIE_NAME = "clickai_session";

// How long a session can sit idle before it's treated as abandoned and
// its documents are purged (2026-09-08). This is the reliable backstop
// for "the user closed the tab without clicking Logout" — a browser
// cannot be trusted to tell the server it's going away (see server.ts's
// removed beforeunload-wipe: it fired on refresh too, which is exactly
// what this feature needs to NOT do). 30 minutes balances "don't make
// someone re-upload a big file just because they stepped away" against
// "don't leave a stranger's documents sitting in memory indefinitely".
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface SessionRecord {
  sessionId: string;
  username: string;
  createdAt: number;
  lastActiveAt: number;
}

const sessions = new Map<string, SessionRecord>();

/** Wired by server.ts so a session's ragStore documents are always purged
 * the moment its session record is destroyed — kept as an injected
 * callback (rather than authStore importing ragStore directly) purely to
 * avoid entangling this module with the RAG pipeline; auth has no reason
 * to know what a "document" is. */
let onSessionDestroyed: ((sessionId: string) => void) | null = null;
export function setSessionDestroyedHandler(fn: (sessionId: string) => void): void {
  onSessionDestroyed = fn;
}

export function validateCredentials(username: string, password: string): boolean {
  return username === TEMP_USERNAME && password === TEMP_PASSWORD;
}

export function createSession(username: string): SessionRecord {
  const now = Date.now();
  const record: SessionRecord = { sessionId: randomUUID(), username, createdAt: now, lastActiveAt: now };
  sessions.set(record.sessionId, record);
  return record;
}

/** Returns the session record for a cookie value, or null if it doesn't
 * exist or has gone idle-timeout stale (and destroys it in that case, so
 * a stale cookie can never be "revived" by one more request slipping in
 * right at the boundary). Does NOT touch lastActiveAt itself — callers
 * that want to keep a session alive call touchSession() explicitly once
 * they've decided the request is a legitimate authenticated action. */
export function getSession(sessionId: string | undefined | null): SessionRecord | null {
  if (!sessionId) return null;
  const record = sessions.get(sessionId);
  if (!record) return null;
  if (Date.now() - record.lastActiveAt > IDLE_TIMEOUT_MS) {
    destroySession(sessionId);
    return null;
  }
  return record;
}

export function touchSession(sessionId: string): void {
  const record = sessions.get(sessionId);
  if (record) record.lastActiveAt = Date.now();
}

/** Ends a session for good — removes the session record AND (via the
 * handler wired in server.ts) wipes every document/chunk/embedding and
 * temp file that session ever uploaded. Called on explicit logout and by
 * the idle-timeout sweep below; idempotent (destroying an already-gone
 * session is a no-op). */
export function destroySession(sessionId: string): void {
  if (!sessions.delete(sessionId)) return;
  onSessionDestroyed?.(sessionId);
}

// Idle-session sweep (2026-09-08) — runs independently of any particular
// request, so a session is eventually cleaned up even if its owner closes
// the tab/laptop and never sends another request at all. `.unref()` so
// this timer alone doesn't keep the Node process alive.
const sweepHandle = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, record] of sessions) {
    if (now - record.lastActiveAt > IDLE_TIMEOUT_MS) destroySession(sessionId);
  }
}, 5 * 60 * 1000);
sweepHandle.unref();

// ---- Minimal cookie helpers (no new dependency) ----
// Express 5 doesn't parse cookies on its own (that's cookie-parser's job,
// not installed here) -- this app's cookie usage is a single opaque
// session-id value, so a tiny hand-rolled parser/serializer is simpler
// and lighter than adding a dependency for it.

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function serializeSessionCookie(sessionId: string): string {
  // httpOnly (not readable from page JS -- irrelevant to XSS-stealing it)
  // + sameSite=lax (sent on normal navigation, not on cross-site POSTs).
  // No `secure` flag: this app is explicitly designed to run over plain
  // http://localhost (see server.ts's own comments on why -- no
  // signing/notarization friction), so requiring https here would break
  // the cookie entirely for every existing user of the web app.
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(IDLE_TIMEOUT_MS / 1000)}`;
}

export function serializeExpiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
