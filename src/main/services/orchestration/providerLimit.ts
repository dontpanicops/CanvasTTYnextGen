// C4 (docs/agent-orchestration/implementation/stage-c4-limits.md §1): a provider's usage limit, seen in a turn's frames
// as they come (a turn's history keeps only its first frames, the limit comes at its end). Pure.
// - Claude (stream-json): a frame carrying rate_limit_info — the rate_limit_event, or the refusal's
//   api_error_params.rate_limit_info; status "rejected" is the limit, resetsAt its reset (seconds of the epoch). The last
//   such frame wins: a "rejected" then "allowed" is no limit.
// - Codex (app-server, or exec): codexErrorInfo "usageLimitExceeded" on `error` or on turn/completed's turn.error is the
//   limit; its reset is the latest window of the turn's account/rateLimits/updated that is used up, else the CLI's text
//   «try again at Sep 28th, 2026 11:51 PM» (local time). rateLimitExceeded is a throttle the CLI retries: not a limit.
// - Codex's text alone (older CLIs, exec mode) is a limit too. Claude's text is never read: the feed does not keep it.
import type { EventFrame, OrchestrationProvider } from "./types.ts";

export interface ProviderLimitSignal {
  provider: OrchestrationProvider;
  hit: boolean;
  resetsAt: number | null; // ms of the epoch
  source: "rate_limit_info" | "codex_error" | "codex_text";
  windows: number | null; // Codex: the latest reset (ms) among the used-up windows of the last account/rateLimits/updated
  text: string | null; // the CLI's message, bounded
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const secs = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null);
const USAGE_LIMIT = /\bhit your usage limit\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// «try again at Sep 28th, 2026 11:51 PM» in the Mac's local time (the one recorded Codex message, codex-cli 0.155.1)
export function codexTryAgain(text: string): number | null {
  const m = /try again at ([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}):(\d{2})\s*([AaPp][Mm])/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  const hour12 = Number(m[4]);
  if (month < 0 || hour12 < 1 || hour12 > 12) return null;
  const hour = (hour12 % 12) + (m[6]!.toLowerCase() === "pm" ? 12 : 0);
  const d = new Date(Number(m[3]), month, Number(m[2]), hour, Number(m[5]));
  return d.getMonth() === month ? d.getTime() : null;
}

// rate_limit_info anywhere shallow in a Claude frame (the event's own, or an error's api_error_params)
function rateLimitInfo(v: Record<string, unknown>, depth = 0): Record<string, unknown> | null {
  const own = rec(v.rate_limit_info);
  if (own) return own;
  if (depth >= 3) return null;
  for (const k of ["error", "api_error_params", "message"]) {
    const inner = rec(v[k]);
    const found = inner && rateLimitInfo(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

// The signal after one more frame of the turn (null: nothing about a limit yet).
export function noteLimit(prev: ProviderLimitSignal | null, provider: OrchestrationProvider, f: EventFrame): ProviderLimitSignal | null {
  const v = f.value;
  if (provider === "claude") {
    const info = rateLimitInfo(v);
    if (!info || typeof info.status !== "string") return prev;
    const hit = info.status === "rejected";
    return { provider, hit, resetsAt: hit ? secs(info.resetsAt) : null, source: "rate_limit_info", windows: null, text: null };
  }
  const p = rec(v.params) ?? {};
  if (f.type === "account/rateLimits/updated") {
    const limits = rec(p.rateLimits) ?? {};
    const used = [rec(limits.primary), rec(limits.secondary)].filter((w): w is Record<string, unknown> => !!w && typeof w.usedPercent === "number" && w.usedPercent >= 100);
    const resets = used.map((w) => secs(w.resetsAt)).filter((x): x is number => x !== null);
    const windows = resets.length ? Math.max(...resets) : null;
    return prev ? { ...prev, windows, resetsAt: prev.hit && prev.source === "codex_error" ? windows ?? prev.resetsAt : prev.resetsAt } : { provider, hit: false, resetsAt: null, source: "codex_error", windows, text: null };
  }
  // the error itself: app-server `error` / turn/completed's turn.error; exec's turn.failed / error
  const err = f.type === "error" ? rec(p.error) ?? rec(v.error) ?? (str(v.message) ? v : null)
    : f.type === "turn/completed" ? rec(rec(p.turn)?.error)
    : f.type === "turn.failed" ? rec(v.error) : null;
  if (!err) return prev;
  const text = str(err.message)?.slice(0, 1000) ?? null;
  const info = err.codexErrorInfo;
  if (info === "usageLimitExceeded") {
    const resetsAt = prev?.windows ?? (text ? codexTryAgain(text) : null);
    return { provider, hit: true, resetsAt, source: "codex_error", windows: prev?.windows ?? null, text };
  }
  if (text && USAGE_LIMIT.test(text) && info !== "rateLimitExceeded") {
    if (prev?.hit && prev.source === "codex_error") return prev; // the same limit, said again (turn/completed after error)
    return { provider, hit: true, resetsAt: prev?.windows ?? codexTryAgain(text), source: "codex_text", windows: prev?.windows ?? null, text };
  }
  return prev;
}

// What is written to the turn's feed (§1.2): the reset is judged once, against the turn's end — more than 7 days ahead,
// or more than an hour behind, reads as unknown; a reset just behind is kept (the autopilot continues at once).
export const LIMIT_AHEAD_MS = 7 * 24 * 3600_000;
export const LIMIT_BEHIND_MS = 3600_000;
export function limitEntry(s: ProviderLimitSignal, endedAt: number): { text: string; detail: { limitProvider: string; limitResetsAt: string | null; limitSource: string } } {
  const at = s.resetsAt !== null && s.resetsAt <= endedAt + LIMIT_AHEAD_MS && s.resetsAt >= endedAt - LIMIT_BEHIND_MS ? s.resetsAt : null;
  const iso = at === null ? null : new Date(at).toISOString();
  const name = s.provider === "claude" ? "Claude" : "Codex";
  return {
    text: `${name}: usage limit reached${iso ? ` · resets ${iso.slice(0, 16).replace("T", " ")} UTC` : " · reset time unknown"}`,
    detail: { limitProvider: s.provider, limitResetsAt: iso, limitSource: s.source }
  };
}
