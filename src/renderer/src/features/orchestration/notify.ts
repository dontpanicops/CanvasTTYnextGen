// Notifications and the Dock badge (UX audit PR 3): which run states tell the person, once per change of state.
// Pure: the caller passes the runs it watches, what was notified before (kept outside the journal, across restarts)
// and whether the window has the focus; it gets back what to show, the badge and the new record. Tested under node.
import type { OrchestrationActivityEntry, OrchestrationRunView } from "../../../../shared/orchestration.ts";
import type { LocaleId, NotificationSettings } from "../../../../shared/contracts.ts";
import { t } from "../../lib/i18n.ts";
import { PAUSES, providerName, viewPauseLabel } from "./runModel.ts";
import { stopText, tr } from "./boardModel.ts";
import { boardStatuses, type AutopilotState, type Board, type BoardHead, type RunTaskFacts } from "../../../../shared/taskBoard.ts";

export type NotifySignal = "waiting" | "completed" | "completed_no_checks" | "failed";
export type NotifyPrefs = NotificationSettings;
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { waiting: true, completed: true, failed: true, dockBadge: true, bounce: false, board: true, boardHead: false };

// The state a notification is about, with what tells one state from another ("" — nothing to tell).
export function runSignal(view: OrchestrationRunView, onMac = true): { signal: NotifySignal; key: string } | null {
  if (view.permission) return { signal: "waiting", key: `waiting:permission:${view.permission.requestId}` };
  // the pauses the chip calls «Ждёт вас: …» (runModel PAUSES[reason].you), not «Пауза: …»
  if (view.status === "paused" && view.reason && PAUSES[view.reason]?.you !== false && viewPauseLabel("en", view, [], onMac) !== null)
    return { signal: "waiting", key: `waiting:${view.reason}` };
  if (view.status === "completed") return view.progress?.completion === "no_checks" ? { signal: "completed_no_checks", key: "completed_no_checks" } : { signal: "completed", key: "completed" };
  if (view.status === "failed") return { signal: "failed", key: "failed" };
  return null;
}

export interface NotifyRun { runId: string; view: OrchestrationRunView; place: string; entries?: readonly OrchestrationActivityEntry[] }
export interface Note { runId: string; signal: NotifySignal; title: string; body: string }
export interface NotifyStep { notes: Note[]; badge: number; bounce: boolean; notified: Record<string, string> }

// notified: the last state told per run ("" — none; absent — a run not seen before this record existed).
// A run seen for the first time without a record (older runs after an update) is only recorded, never told.
// accepting (B3, owner's decision 10): the board's tasks waiting for «Accept the result» — the person's too, on the badge.
export function notifyStep(locale: LocaleId, runs: readonly NotifyRun[], notified: Readonly<Record<string, string>>, prefs: NotifyPrefs, focused: boolean, onMac = true, accepting = 0): NotifyStep {
  const next: Record<string, string> = { ...notified };
  const notes: Note[] = [];
  let badge = 0;
  let bounce = false;
  for (const r of runs) {
    const s = runSignal(r.view, onMac);
    if (s?.signal === "waiting") badge++;
    const before = notified[r.runId];
    next[r.runId] = s?.key ?? "";
    if (!s || before === undefined || before === s.key) continue;
    if (s.signal === "waiting" && prefs.bounce && !focused) bounce = true;
    if (focused || !prefs[s.signal === "completed_no_checks" ? "completed" : s.signal]) continue;
    notes.push({ runId: r.runId, signal: s.signal, title: r.place, body: noteBody(locale, s.signal, r) });
  }
  return { notes, badge: prefs.dockBadge ? badge + accepting : 0, bounce, notified: next };
}

// The short reason only: never a path, a command or a file's text.
function noteBody(locale: LocaleId, signal: NotifySignal, r: NotifyRun): string {
  if (signal !== "waiting") return t(locale, `orchNotify_${signal}`);
  if (r.view.permission) return t(locale, "orchNotify_permission");
  return viewPauseLabel(locale, r.view, r.entries ?? []) ?? t(locale, "orchNotify_permission");
}

// The record kept between launches: bounded, so runs deleted long ago do not pile up.
export function pruneNotified(notified: Readonly<Record<string, string>>, keep = 500): Record<string, string> {
  const entries = Object.entries(notified);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - keep)));
}

// Set when macOS refused to show a notification (no permission, an unsigned build): the settings say how to allow
// them, and the window shows its own banner meanwhile. Cleared once a notification is shown again.
export const NOTIFY_UNAVAILABLE_KEY = "orch.notify.unavailable";
export const NOTIFIED_KEY = "orch.notified.v1";

// B4 (owner's decision 10): the board's autopilot stopped — why, or that every task is done. Once per stop (its time is
// the key, kept with the runs' record under board-<linkId>); a stop by the person keeps no reason and tells nothing.
export function boardNotes(locale: LocaleId, autopilot: Readonly<Record<string, AutopilotState>>, notified: Readonly<Record<string, string>>, prefs: NotifyPrefs, focused: boolean,
  place: (linkId: string) => string): { notes: Note[]; notified: Record<string, string> } {
  const next: Record<string, string> = { ...notified };
  const notes: Note[] = [];
  for (const [linkId, s] of Object.entries(autopilot)) {
    const id = `board-${linkId}`;
    const before = notified[id];
    next[id] = s.stop?.at ?? "";
    if (!s.stop || before === undefined || before === s.stop.at || focused || !prefs.board) continue;
    const title = s.stop.code === "all_done" ? t(locale, "boardApNoteDone") : tr(locale, "boardApNoteStopped", { reason: stopText(locale, s.stop) });
    notes.push({ runId: id, signal: s.stop.code === "all_done" ? "completed" : "failed", title: title.slice(0, 120), body: place(linkId) });
  }
  return { notes, notified: next };
}

// C4 (stage-c4-limits.md §4): the board's own notes — a merge that waits for the person (once per merge and reason), the
// autopilot continuing a run after a provider's limit (once per continuation), and, when asked for, the board's result
// moved (once per commit, with the tasks merged since the last one told). Their keys are kept with the runs' record, so a
// restart repeats none; a merge or a head seen for the first time is only recorded. waiting: the merges that wait for
// the person, for the Dock badge. A merge's note opens the board (merge-<runId>), a continuation its run.
const MERGE_WAITS = new Set(["merge_conflict", "merge_checks_failed", "merge_agent_failed", "merge_budget"]);
export function boardHeadNotes(locale: LocaleId, heads: readonly BoardHead[], autopilot: Readonly<Record<string, AutopilotState>>, notified: Readonly<Record<string, string>>,
  prefs: NotifyPrefs, focused: boolean, place: (project: string) => string): { notes: Note[]; notified: Record<string, string>; waiting: number } {
  const next: Record<string, string> = { ...notified };
  const notes: Note[] = [];
  let waiting = 0;
  const tell = prefs.board && !focused;
  for (const h of heads) {
    const title = place(h.project);
    for (const m of h.merges) {
      const waits = m.status === "paused" && MERGE_WAITS.has(m.reason ?? "");
      if (waits) waiting++;
      const id = `merge:${m.runId}`;
      const before = notified[id];
      next[id] = waits ? m.reason! : "";
      if (!waits || before === undefined || before === m.reason || !tell) continue;
      notes.push({ runId: `merge-${m.runId}`, signal: "waiting", title, body: tr(locale, `boardNoteMerge_${m.reason}`, { key: m.task.key }).slice(0, 240) });
    }
    // the merges come newest first; the completed ones since the last told
    const done = h.merges.filter((m) => m.status === "completed" && m.reason !== "already");
    const id = `head:${h.ref}`;
    const before = notified[id];
    const last = done.length ? Math.max(...done.map((m) => m.createdAt)) : 0;
    next[id] = String(last);
    if (before === undefined || Number(before) >= last || !tell || !prefs.boardHead) continue;
    const keys = [...done].filter((m) => m.createdAt > Number(before)).reverse().map((m) => (m.source === "head" ? "HEAD" : m.task.key));
    const checked = done.every((m) => m.completion === "confirmed");
    notes.push({ runId: `head-${h.n}-${last}`.slice(0, 80), signal: "completed", title,
      body: tr(locale, checked ? "boardNoteHead" : "boardNoteHeadNoChecks", { keys: keys.join(", ") }).slice(0, 240) });
  }
  for (const [linkId, s] of Object.entries(autopilot)) {
    const id = `resumed:${linkId}`;
    const before = notified[id];
    next[id] = s.resumed?.at ?? before ?? "";
    if (!s.resumed || before === undefined || before === s.resumed.at || !tell) continue;
    notes.push({ runId: s.resumed.runId, signal: "completed", title: tr(locale, "boardNoteResumed", { key: s.resumed.key }).slice(0, 120), body: providerName(s.resumed.provider) });
  }
  return { notes, notified: next, waiting };
}

// E4 (stage-e-decomposition.md §10): the board's decomposition runs that wait for the person. The state of each run is
// kept under split:<runId> — "question" (the lead asks; the same «waiting for an answer» note as runs), "failed" (the
// parent is in decomposition_failed by that run: «The split of T-1 failed», once per run), "" otherwise. A run seen
// for the first time is only recorded, so a restart repeats none. waiting: the splits that wait (question,
// decomposition_failed, decomposition_paused), for the Dock badge.
export function splitNotes(locale: LocaleId, board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], heads: readonly BoardHead[], notified: Readonly<Record<string, string>>,
  prefs: NotifyPrefs, focused: boolean, place: (project: string) => string): { notes: Note[]; notified: Record<string, string>; waiting: number } {
  const next: Record<string, string> = { ...notified };
  const notes: Note[] = [];
  let waiting = 0;
  const statuses = boardStatuses(board, facts, heads);
  for (const task of board.tasks) {
    const st = statuses.get(task.id);
    if (!task.decompose || !st?.split) continue;
    const id = `split:${st.split.runId}`;
    const state = st.reason === "decomposition_failed" ? "failed" : st.reason === "waits_answer" ? "question" : "";
    if (state || st.reason === "decomposition_paused") waiting++;
    const before = notified[id];
    next[id] = state;
    if (!state || before === undefined || before === state || focused || !prefs.board) continue;
    const key = task.key;
    notes.push({ runId: st.split.runId, signal: state === "failed" ? "failed" : "waiting", title: place(task.project),
      body: tr(locale, state === "failed" ? "boardNoteSplitFailed" : "boardNoteSplitQuestion", { key }).slice(0, 240) });
  }
  return { notes, notified: next, waiting };
}
