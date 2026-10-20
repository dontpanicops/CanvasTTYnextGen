// B2: the words of the board (stage-b-board.md §4.3, §6), apart from the card so they are tested without a window.
import type { LocaleId } from "../../../../shared/contracts.ts";
import type { OrchestrationActivityEntry, OrchestrationPermissionRequest } from "../../../../shared/orchestration.ts";
import { isCopy, mergeMark, type AutopilotStop, type BoardHead, type BoardTask, type RunTaskFacts, type TaskStatus } from "../../../../shared/taskBoard.ts";
import { t, type TranslationKey } from "../../lib/i18n.ts";
import { runStatus } from "./runStatus.ts";
import { causeText } from "./runModel.ts";

export const tr = (locale: LocaleId, key: string, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(locale, key as TranslationKey) ?? key);

// One line of a task: «Done» of either kind, else the reason (§4.3), else what its run does now, else «not started».
type RunInput = Pick<Parameters<typeof runStatus>[1], "view" | "entries" | "open">;
// providerLimit (C4): the pause is a provider's usage limit — named, with its reset when known
export function taskLine(locale: LocaleId, status: TaskStatus, run: RunInput | null, limit: string | null, providerLimit: RunTaskFacts["providerLimit"] = null): string {
  if (status.done) return t(locale, status.done === "accepted" ? "boardDone_accepted" : "boardDone_confirmed");
  const keys = status.waitsFor.join(", ");
  if (status.reason === "waits_task" && status.cycle) return tr(locale, "boardReason_cycle", { keys });
  if (providerLimit && status.column !== "done") {
    return `${t(locale, "boardReason_paused_other")}: ${causeText(locale, { kind: "provider_limit", reason: "environment_error", provider: providerLimit.provider, resetsAt: null, resetsAtMs: providerLimit.resetsAt })}`;
  }
  if (status.reason === "limit_reached" && limit) return `${t(locale, "boardReason_limit_reached")}: ${t(locale, `orchLimit_${limit}` as TranslationKey) ?? limit}`;
  // E4 (stage-e-decomposition.md §10): the split's failure or pause in its own words
  if (status.reason === "decomposition_failed" || status.reason === "decomposition_paused") {
    const d = status.split?.detail ?? "";
    return tr(locale, `boardReason_${status.reason}`, { detail: splitWhy(locale, d), reason: pauseWord(locale, d) });
  }
  if (status.reason) return tr(locale, `boardReason_${status.reason}`, { keys, n: status.attempts });
  if (status.column === "queue" && status.split?.detail === "whole") return notSplit(locale);
  if (run && (status.column === "work" || status.column === "review")) return runStatus(locale, { ...run, stageTitles: null, now: Date.now() }).doing;
  return t(locale, "boardNotStarted");
}

// E4 (§10): a split's detail (rejected / failed / stopped / a §5.1 code) in words; the raw detail when none is known
export function splitWhy(locale: LocaleId, detail: string): string {
  return t(locale, `boardDecomposeWhy_${detail}` as TranslationKey) ?? detail;
}
// a pause reason of the split run as the pause texts say it (lowercase), else raw
const pauseWord = (locale: LocaleId, reason: string): string => {
  const w = t(locale, `orchPause_${reason}_what` as TranslationKey);
  return w ? w.charAt(0).toLocaleLowerCase(locale) + w.slice(1) : reason;
};
// ponytail: the lead's why of «whole» is in the split run's journal, not in the facts — the line says «not split» without it
export const notSplit = (locale: LocaleId): string => tr(locale, "boardNotSplit", { why: "" }).replace(/:\s*$/, "");

// E4 (§2.1, §10): a parent marked «Split» that is not split yet (the lead's «whole» ends the mark's meaning for a start)
export const unsplit = (task: Pick<BoardTask, "decompose" | "decomposedBy">, st: Pick<TaskStatus, "split">): boolean =>
  !!task.decompose && !task.decomposedBy && st.split?.detail !== "whole";
export type SplitAction = "run" | "again" | "whole" | "open" | "answer";
// The person's actions on a parent's card by its row of §2.1. A parent with a run of its own or with subtasks is an ordinary task.
export function splitActions(task: Pick<BoardTask, "decompose" | "parentId" | "decomposedBy">, st: TaskStatus): SplitAction[] {
  if (!task.decompose || task.parentId || st.attempts > 0) return [];
  const open: SplitAction[] = st.split ? ["open"] : [];
  switch (st.reason) {
    case "decomposing": case "decomposition_paused": return open;
    case "waits_answer": case "waits_permission": return st.split ? ["answer"] : [];
    case "decomposition_failed": case "subtasks_gone": return ["again", "whole", ...open];
    default:
      if (st.split) return open; // «whole»: started as an ordinary task
      if (task.decomposedBy) return []; // subtasks exist: an ordinary task waiting for them
      return st.column === "queue" && !st.reason && !st.depsWait ? ["run"] : [];
  }
}

// E4 (§10): a parent's subtasks — how many are in the board's result (a copy: merged; the project folder: done), the
// archived ones, and whether the requirements changed after the split. ponytail: the requirements' count against the
// highest R the subtasks cover — an edit of a requirement's text is not seen (the split goal's copy is not kept)
export interface SubtaskInfo { all: BoardTask[]; live: BoardTask[]; archived: BoardTask[]; done: number; criteriaChanged: boolean }
export function subtaskInfo(parent: BoardTask, tasks: readonly BoardTask[], statuses: ReadonlyMap<string, TaskStatus>, facts: readonly RunTaskFacts[], heads: readonly BoardHead[]): SubtaskInfo | null {
  const all = tasks.filter((x) => x.parentId === parent.id).sort((a, b) => a.order - b.order);
  if (!all.length) return null;
  const live = all.filter((x) => !x.archivedAt);
  const inResult = (x: BoardTask): boolean => {
    const st = statuses.get(x.id);
    if (!st?.done) return false;
    const f = facts.find((r) => r.runId === st.current);
    if (!isCopy(f?.workMode)) return true;
    return mergeMark(x.id, heads.find((h) => h.workspaceId === x.workspaceId && h.project === x.project), st.current)?.kind === "in_board";
  };
  const top = Math.max(0, ...all.flatMap((x) => x.covers ?? []).map((r) => Number(r.slice(1)) || 0));
  return { all, live, archived: all.filter((x) => x.archivedAt), done: live.filter(inResult).length, criteriaChanged: !!parent.decomposedBy && top !== parent.criteria.length };
}

// «Waits for a permission: <what>» with the CLI's own reason (§5.3 п. 4), as it said it — never retold
export function permissionLine(locale: LocaleId, base: string, permission: Pick<OrchestrationPermissionRequest, "summary" | "why"> | null | undefined): string {
  if (!permission) return base;
  const why = permission.why?.text || permission.why?.type;
  return `${base}: ${permission.summary}${why ? ` (${t(locale, "orchCliWhy")}: ${why})` : ""}`;
}

// The person's permission prompts in a run (§5.3 п. 3): shown, never a ground for a decision. Questions, plans and
// forms are not about rights; the host's own answers (permission_applied) are not prompts.
export const ASKS_HINT_OVER = 3; // the read-only button's threshold (readOnly.asks > 3)
const RIGHTS = new Set(["command", "file_change", "permissions", "tool"]);
export function askCount(entries: readonly OrchestrationActivityEntry[]): number {
  return entries.filter((e) => e.kind === "permission_requested" && RIGHTS.has(String(e.detail?.kind))).length;
}

// B4: why the board's autopilot stopped, in the person's words (the tasks it left waiting with their own reasons)
export function stopText(locale: LocaleId, stop: AutopilotStop): string {
  const waiting = (stop.waiting ?? []).map((w) => `${w.key} — ${w.reason ? tr(locale, `boardReason_${w.reason}`, { keys: w.waitsFor.join(", "), n: 0, detail: "", reason: "" }).replace(/:\s*$/, "") : t(locale, "boardNotStarted")}`).join("; ");
  return tr(locale, `boardApStop_${stop.code}`, { key: stop.key ?? "", detail: stop.detail ?? "", waiting });
}
