// The task board (stage B, docs/agent-orchestration/implementation/stage-b-board.md). What the person set is kept in
// orchestration/board.json; a task's status is never kept: it is worked out here from the task's runs, by the same
// rules for the board, the agent cards, the activity widget and the summary (the cycle's principle 8).
import type { OrchestrationBaseRef, OrchestrationGoalInput, OrchestrationProjectProfile, OrchestrationRunStatus, OrchestrationRunView, OrchestrationTurnPurpose, OrchestrationWorkMode } from "./orchestration.ts";

export const BOARD_VERSION = 1;

export interface BoardTask {
  id: string; // UUID, permanent
  key: string; // "T-<n>": its number in the workspace for people; n is never reused
  workspaceId: string; // the owner, like a run's; it does not follow the cards
  project: string; // the project folder (realpath): only a link of this folder runs it
  title: string; // 1..200
  text: string; // 1..8000, becomes goal.text
  criteria: string[]; // 1..32 × 1..500, become goal.criteria
  dependsOn: string[]; // tasks of the same workspace, no cycles
  order: number; // its place in the queue
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  // «Accept the result» (owner's decision 2): the person's decision about one run completed without checks. It counts
  // only while that run is the task's latest and its journal says completed / no_checks (taskStatus checks both), so
  // editing the file can never make a confirmed «Done», nor «accepted» of another run.
  accepted: { runId: string; at: string } | null;
  // E2 (stage-e-decomposition.md §2): kept only when set; a stored `decompose` is `true`, never `false`
  decompose?: true; // the person marked «Split into subtasks»
  decomposedBy?: string; // a parent: the decomposition run its subtasks were made by (written by the same write as they are)
  parentId?: string; // a subtask: its parent (same workspace and folder)
  covers?: string[]; // a subtask: the parent's requirements it covers, "R1".."R32"
  // F1 (stage-f-external-projects.md §5.1): a task imported from a board-tasks/v1 file — its ref there (the upsert key
  // within the workspace) and where it came from. A bad value in the file is dropped, the board is never set aside
  ref?: string;
  origin?: BoardTaskOrigin;
  // F2 (§6, T-3): an external task — no run of its own; its «Done» is only the person's mark «Выполнено» (externalDone),
  // a decision of the person kept apart from accepted. A task that has runs of its own goes by them (external_has_runs).
  // T-4: a role's model of this task over the profile's (no key: the profile's)
  external?: true;
  externalDone?: BoardExternalDone;
  models?: TaskModels;
  // F3 (T-6, T-7): the task's external id for the profile's branch template ({issue}; Loom does not read it) and its
  // commit's title (one line ≤72, in place of the text's first line)
  issue?: string;
  commitTitle?: string;
}
export interface BoardTaskOrigin { kind: "import"; source: string | null; file: string; sha256: string }
export interface BoardExternalDone { at: string; by: "person"; note: string | null }
export type TaskModels = Partial<Record<"lead" | "executor" | "reviewer", string>>;
// T-3: the one requirement Loom writes to an external task the file gives none — builds before F2 need ≥1 (isTask)
export const EXTERNAL_CRITERION = "Отметка человека «Выполнено»";
// T-3: an external task in force — marked external and never run (one with runs of its own goes by them)
export const externalInForce = (t: Pick<BoardTask, "external">, s: Pick<TaskStatus, "attempts"> | undefined): boolean => !!t.external && (s?.attempts ?? 0) === 0;

// F1 (§5.4): the report of a board-tasks/v1 file, board-tasks-report/v1
export interface ImportReport {
  format: "board-tasks-report/v1";
  file: string;
  sha256: string;
  at: string;
  status: "checked" | "imported" | "rejected" | "invalid_file" | "refused";
  code: string | null; // a file-level code (§5.3), only with refused and invalid_file
  workspaceId: string | null;
  created: { ref: string; key: string }[];
  updated: { ref: string; key: string }[];
  unchanged: string[];
  refused: { ref: string | null; code: string; detail: string }[]; // ref null: the file-level refusal
}

export interface BoardTaskInput {
  workspaceId: string;
  project: string;
  title: string;
  text: string;
  criteria: string[];
  dependsOn?: string[];
  decompose?: boolean; // E2: false (patch) — «Do it whole»; on a create/update only true is stored
}
export type BoardTaskPatch = Partial<Pick<BoardTaskInput, "title" | "text" | "criteria" | "dependsOn" | "decompose">> & { order?: number };

// What main gives the renderer: the board as stored (readOnly: a newer version's file, or a damaged one that could not
// be set aside) and the facts of the runs that name a task.
export interface BoardView {
  board: Board;
  readOnly: null | "newer_version" | "damaged_unmoved";
  facts: RunTaskFacts[];
  autopilot: Record<string, AutopilotState>; // linkId → the board's autopilot of that link, as main holds it now
  heads?: BoardHead[]; // C1: the board's merged head of each workspace and project that has one
  queued?: QueuedStart[]; // C2 (owner's decision 12): task starts waiting for a free place, in order
  inbox?: InboxRow[]; // F1 (stage-f-external-projects.md §5.4): the files of inbox/ as main last checked them
  // F3 (T-13a): the places (workspaceId\0project, as heads) whose profile has a remote base (runBase), and whose branch
  // template needs the task's issue ({issue}); every screen passes them to boardStatuses (boardOptsOf)
  remoteBase?: string[];
  issueRequired?: string[];
}

// F3 (T-13a): the options of one place, from its profile — the last parameter of autopilotParallelStep (F4 adds pushFields)
export interface PlaceOpts { remoteBase?: boolean; issueRequired?: boolean }
// the same for every place at once: sets of place keys
export interface BoardOpts { remoteBase?: ReadonlySet<string>; issueRequired?: ReadonlySet<string> }
export const placeKey = (p: { workspaceId: string; project: string }): string => `${p.workspaceId}\0${p.project}`;
export const placeOpts = (at: { workspaceId: string; project: string }, o: PlaceOpts): BoardOpts => ({
  ...(o.remoteBase ? { remoteBase: new Set([placeKey(at)]) } : {}), ...(o.issueRequired ? { issueRequired: new Set([placeKey(at)]) } : {})
});
export const boardOptsOf = (v: Pick<BoardView, "remoteBase" | "issueRequired">): BoardOpts => ({
  ...(v.remoteBase?.length ? { remoteBase: new Set(v.remoteBase) } : {}), ...(v.issueRequired?.length ? { issueRequired: new Set(v.issueRequired) } : {})
});

// F1 (§5.4, §5.6): a file of <userData>/orchestration/inbox/ — checked (waits for «Import» / «Reject»), or set aside to
// done/ at once (invalid_file, refused: shown with its code, no decision). tasks: the file's rows as written there, for
// the window's list (ref, title, project, dependsOn); [] when the file could not be read
export interface InboxRow { file: string; sha256: string; workspaceId: string | null; report: ImportReport; tasks: InboxTask[] }
export interface InboxTask { ref: string; title: string; project: string; dependsOn: string[]; external?: boolean }

// C2 (owner's decision 12): a person's start of a task that waits for a free place of the project (in main's memory)
export interface QueuedStart {
  taskId: string;
  linkId: string;
  at: number;
  busy: number; // the project's runs that hold a place now
  limit: number; // the places: the link's parallelism
  failed: string | null; // the code its start was refused with last (it left the queue)
}

// C1 (stage-c-parallel.md §4): the board's merged head — a ref of the project outside refs/heads that only a merge run
// moves — and the merge runs into it, as their v3 journals say (never board.json: principle 8).
export interface BoardHead {
  workspaceId: string;
  project: string;
  ref: string; // refs/raoden/board/<workspaceId>/<n>
  n: number;
  commit: string;
  merges: BoardMerge[]; // into this head, the newest first
  // C2 (owner's decision 13): the commits of the project's HEAD not in the head (the person committed after it started);
  // null: HEAD unknown (no commit, detached at nothing)
  behind?: number | null;
  branch?: string | null; // the branch HEAD is on now (null: detached)
  otherLine?: boolean; // HEAD does not go on from the head's start (another branch checked out, a history rewritten)
}
export type BoardMergeStatus = "preparing" | "running" | "paused" | "completed" | "stopped" | "failed";
export interface BoardMerge {
  runId: string;
  source?: "head"; // C2 (decision 13): an update of the head from the project's HEAD, not a task (task.key "HEAD")
  board: string; // the head's ref
  base: string; // the head it was built on
  task: { id: string; key: string; runId: string; commit: string };
  status: BoardMergeStatus;
  // paused: merge_conflict | merge_checks_failed | merge_prepare_failed | merge_prepare_changed | recovered;
  // C3: merge_agent_failed (detail: limit:<kind> | replan | stopped | failed | markers | copy_changed | checks_after) |
  // merge_waits_slot | merge_budget;
  // stopped: skipped | interrupted; failed: head_moved | error; completed: null | already (the result was in the head)
  reason: string | null;
  detail: string | null;
  completion: "confirmed" | "no_checks" | null;
  conflicts: string[];
  outside: string[]; // files out of the conflict the resolution changed (the mechanical condition)
  interference: boolean; // the checks failed twice: possibly another task's port or process
  retrying: boolean; // the first checks failed; the retry waits for the project to be quiet
  dir: string | null; // the merge copy, where the person resolves
  createdAt: number;
  // C3 (stage-c3-conflicts.md §2): the latest try of an agent — its resolution run; pending while the merge waits for it
  agent?: { attempt: number; reason: "conflict" | "checks"; resolutionRunId: string; pending: boolean;
    // C4 (stage-c4-limits.md §3): its resolution run paused — at a provider's limit, or for the person (main fills it)
    waits?: { kind: "limit"; provider: string; resetsAt: number | null } | { kind: "person" } };
}

// A task's mark on the board (§4.4): its latest merge into the current head of its place — of its current run (a task
// run again is a new result: an older merge says nothing of it)
// already (decision 15): the result was in the head before, nothing was merged
export type MergeMark = { kind: "in_board"; checks: boolean; already: boolean } | { kind: "merging"; agent?: true } | { kind: "not_merged"; reason: string; waits: boolean; runId: string } | null;
export const mergeOfTask = (head: Pick<BoardHead, "merges"> | null | undefined, taskId: string, runId?: string | null): BoardMerge | undefined =>
  head?.merges.find((x) => x.task.id === taskId && (runId === undefined || x.task.runId === runId));
export function mergeMark(taskId: string, head: BoardHead | undefined, runId?: string | null): MergeMark {
  const m = mergeOfTask(head, taskId, runId);
  if (!m) return null;
  if (m.status === "completed") return { kind: "in_board", checks: m.completion === "confirmed", already: m.reason === "already" };
  // C3: an agent resolves its conflict meanwhile
  if (m.status === "preparing" || m.status === "running") return m.agent?.pending ? { kind: "merging", agent: true } : { kind: "merging" };
  return { kind: "not_merged", reason: m.reason ?? m.status, waits: m.status === "paused", runId: m.runId };
}

// B4 (§5.1): the board's autopilot of a link. on — never stored (a restart turns it off); the budget is board.json's;
// used — the runs it started since it was turned on and their working minutes; stop — why it turned itself off last.
// parallel (C1, §2.1): tasks at once, 1..4, in a separate copy only; absent: 2
// conflicts (C3, stage-c3-conflicts.md §7.1): a merge conflict or its checks failing twice — handed to an agent or left
// to the person; absent: to an agent
export interface AutopilotBudget { runs: number; minutes: number; parallel?: number; conflicts?: "agent" | "person" }
export const AUTOPILOT_BUDGET: AutopilotBudget = { runs: 5, minutes: 240 };
export const AUTOPILOT_PARALLEL = 2;
export const conflictsOf = (b: AutopilotBudget): "agent" | "person" => (b.conflicts === "person" ? "person" : "agent");
export const parallelOf = (b: AutopilotBudget): number => (Number.isInteger(b.parallel) && b.parallel! >= 1 && b.parallel! <= 4 ? b.parallel! : AUTOPILOT_PARALLEL);
export type AutopilotStopCode = "all_done" | "others_wait" | "budget_runs" | "budget_minutes" | "run_stopped" | "run_failed" | "limit_reached"
  | "run_paused" | "run_unreadable" | "settings_changed" | "grant_added" | "not_ready" | "take_failed" | "start_failed" | "worktree_base" | "link_gone" | "task_gone"
  | "head_moved" | "merge_failed" | "resume_failed" | "decomposition_failed" | "base_fetch_failed" | "base_remote_mismatch";
export interface AutopilotWaiting { key: string; reason: TaskReason | null; waitsFor: string[] }
export interface AutopilotStop { code: AutopilotStopCode; detail: string | null; key: string | null; at: string; waiting?: AutopilotWaiting[] }
export interface AutopilotState {
  on: boolean;
  budget: AutopilotBudget;
  used: { runs: number; minutes: number };
  waits: string | null; // on, and waiting: for what (a run, the person, provider_limit; F2: external)
  waitsKey?: string | null; // F2 (T-3): with waits "external" — the key of the external task it waits to be marked
  stop: AutopilotStop | null;
  // C4 (stage-c4-limits.md §2): the provider's limit it waits for (the earliest known reset), and its last continuation
  limit?: AutopilotLimit | null;
  resumed?: { runId: string; key: string; provider: string; at: string } | null;
  splitting?: string | null; // E4 (stage-e-decomposition.md §10): the key of the parent whose own split goes on
}

// C4 (stage-c4-limits.md §2): a run of the place paused at a provider's limit — a task's (facts) or a resolution run's
// (C3); own: the autopilot started it, so it may continue it; resumes: its continuations in a row so far
export interface LimitedRun { runId: string; key: string; provider: string; resetsAt: number | null; own: boolean; resumes: number }
export interface AutopilotLimit { provider: string; resetsAt: number | null; key: string; repeated: boolean; others: number }
export const LIMIT_MARGIN_MS = 60_000; // the provider's clock and the Mac's may differ
export const LIMIT_RESUMES = 3; // continuations of one run in a row, then the person's
// What the limits leave the autopilot to do: continue its own run whose reset has come (the earliest first), else wait
// for the earliest known reset. null: no run of the place is at a limit.
export function limitStep(limited: readonly LimitedRun[], now: number): { kind: "resume"; runId: string; key: string; provider: string } | { kind: "wait"; why: "provider_limit"; limit: AutopilotLimit } | null {
  if (!limited.length) return null;
  const due = limited.filter((r) => r.own && r.resetsAt !== null && now >= r.resetsAt + LIMIT_MARGIN_MS && r.resumes < LIMIT_RESUMES)
    .sort((a, b) => a.resetsAt! - b.resetsAt!)[0];
  if (due) return { kind: "resume", runId: due.runId, key: due.key, provider: due.provider };
  const known = limited.filter((r) => r.resetsAt !== null && !(r.own && r.resumes >= LIMIT_RESUMES)).sort((a, b) => a.resetsAt! - b.resetsAt!)[0];
  const shown = known ?? limited[0]!;
  const repeated = shown.own && shown.resumes >= LIMIT_RESUMES;
  return { kind: "wait", why: "provider_limit", limit: { provider: shown.provider, resetsAt: repeated ? null : shown.resetsAt, key: shown.key, repeated, others: limited.length - 1 } };
}

export interface Board {
  v: typeof BOARD_VERSION;
  tasks: BoardTask[];
  counters: Record<string, number>; // workspaceId → the last n given
  // B2: where the board card is on each workspace's canvas (absent: not shown there). Here and not in canvas.json:
  // 1.5.12/1.5.13 write canvas.json back with the keys they know only (stage-b-board.md §6).
  places?: Record<string, BoardPlace>;
  // B4: the budget of the board's autopilot of each link (only the budget: whether it is on is never stored)
  autopilot?: Record<string, AutopilotBudget>;
}
export interface BoardPlace { position: { x: number; y: number }; size: { width: number; height: number } }

// What the board needs of one run: from its view (the snapshot every screen reads) and its journal, worked out in main.
export interface RunTaskFacts {
  runId: string;
  taskId: string | null; // goal.task.id
  taskKey: string | null; // goal.task.key
  // the goal's createdAt: the latest run of a task is its current one. ponytail: the wall clock of the start; a clock
  // set back between two runs of one task would order them wrong (a journal sequence across runs does not exist)
  createdAt: number;
  workspaceId: string; // the run's owner (canvas.json owners): only its workspace's tasks count it
  status: OrchestrationRunStatus | "unreadable";
  reason: string | null;
  newer: boolean; // a newer version's journal: read only
  halted: boolean; // running, but stopped by a condition in main (the view's halted)
  limit: string | null; // the limit a limit_reached pause stopped at (view.progress.budget.reached)
  // C4 (stage-c4-limits.md §1.3): a pause that is a provider's usage limit, with its reset (ms; null: unknown)
  providerLimit?: { provider: string; resetsAt: number | null } | null;
  completion: "confirmed" | "no_checks" | null;
  phase: "work" | "review"; // the active turn's, else the last turn's (no column flickers between turns)
  permission: boolean; // a permission request waits for the person
  workMode: OrchestrationWorkMode | null;
  // «Take the result» of its current result (taken.json): the branch made and the commit it points to, applied or not
  taken: { branch: string | null; commit?: string | null; applied: boolean } | null;
  board?: string | null; // C1: the board head ref its copy started from (goal.base.branch), else null
  files?: string[]; // C2 (§4.7): the paths its work changed, from its base to its last checkpoint (a copy or a worktree)
  named?: string[]; // C2 (§4.7): the paths its goal and the lead's plan name
  // E2 (stage-e-decomposition.md §2.1, §7): a decomposition run names its parent here (taskId stays null: it is no task run);
  // split — its completion kind (kept out of `completion`, which stays the task runs'); splitFailed — the §5.1 code main
  // could not create the subtasks with
  decompositionOf?: string | null;
  split?: "proposed" | "whole" | "rejected" | null;
  splitFailed?: string | null;
}

export type TaskColumn = "queue" | "work" | "review" | "done";
export type TaskReason =
  | "run_unreadable" | "waits_permission" | "waits_answer" | "waits_decision" | "limit_reached" | "waits_task"
  | "waits_result" | "waits_merge" | "waits_head" | "last_stopped" | "last_failed" | "no_checks" | "stopping" | "run_newer" | "paused_other"
  // E2 (stage-e-decomposition.md §2.1): a parent task
  | "decomposing" | "decomposition_paused" | "decomposition_failed" | "subtasks_gone"
  // F2 (stage-f-external-projects.md §6): waits for the person's mark of an external task; an external task with runs
  | "waits_external" | "external_has_runs"
  // F3 (T-13a, T-6): with a remote base, a direct dependency on an ordinary task (its MR is not merged yet); the branch
  // template needs the task's issue and it has none
  | "waits_mr" | "branch_template_field";

export interface TaskStatus {
  column: TaskColumn;
  // «Done» confirmed by checks, accepted by the person without checks, or (F2) an external task the person marked «Выполнено»
  done: "confirmed" | "accepted" | "external" | null;
  reason: TaskReason | null;
  waitsFor: string[]; // the keys of the tasks it waits for (waits_task, waits_result, waits_merge)
  cycle: boolean; // waits_task because its dependencies make a cycle (a hand-edited board.json)
  attempts: number;
  current: string | null; // runId of the latest run
  completion: "confirmed" | "no_checks" | null;
  // B3 (§4.2): what its dependencies are now, whatever its own column: «waits_task» (one not «Done», or a cycle),
  // «waits_result» (a result where this task would not see it), or null — ready. main refuses a start without «Start
  // anyway» unless it is null; the board offers «Start» or «Start anyway» by it.
  // C2: «waits_head» — a dependency «Done» and not in the board's merged head of the place yet (decision 9)
  // F2: «waits_external» — every dependency not «Done» is an external task not marked yet
  // F3: «waits_mr» — with a remote base, a dependency «Done» that is an ordinary task (not an external one marked)
  depsWait: { reason: "waits_task" | "waits_result" | "waits_merge" | "waits_head" | "waits_external" | "waits_mr"; waitsFor: string[]; cycle: boolean } | null;
  // B3 (§4.2): a «Done» task on a dependency that is not «Done» now — never rolled back, only said: «changed» (it was
  // «Done» when this task's run started, then lost it), «not_ready» (it was not: this task was started anyway). It goes
  // on to the tasks after it. Recomputing a result is stage D.
  depsNote: null | "changed" | "not_ready";
  // E2 (§2.1): the decomposition run the status shows, and its detail (a pause reason, whole, rejected / failed / stopped, a §5.1 code)
  split?: { runId: string; detail: string | null } | null;
}

const REVIEW_PURPOSES: readonly OrchestrationTurnPurpose[] = ["review", "final_review"];
const DECISIONS = new Set(["plan_review", "awaiting_checks_decision", "awaiting_finish_confirmation", "awaiting_person_decision",
  "coverage_lost", "check_needs_permissions", "finish_unconfirmed"]);

// The column of a run that works: a check or a review turn is «Review», anything else «Work». Between turns, the last
// turn's purpose (from the journal) decides.
export function runPhase(view: Pick<OrchestrationRunView, "active">, lastPurpose: OrchestrationTurnPurpose | null): "work" | "review" {
  const a = view.active;
  if (a?.kind === "check") return "review";
  if (a?.kind === "turn") return REVIEW_PURPOSES.includes(a.purpose) ? "review" : "work";
  if (a) return "work";
  return lastPurpose && REVIEW_PURPOSES.includes(lastPurpose) ? "review" : "work";
}

const isDone = (s: TaskStatus | undefined) => !!s?.done;

// The statuses of all tasks of a board from the facts of all runs. Dependencies are followed without trusting the file:
// the tasks on a cycle (a hand-edited board.json) are found first; one not started waits («waits_task», cycle), and
// nothing loops. A run counts for a task of its own workspace only.
// heads (C2): the board's merged heads — a task of a place that has one waits for its dependencies there (decision 9)
// E2 (stage-e-decomposition.md §2.2): an archived subtask does not hold its parent; an ordinary dependency, archived,
// still does (stage B). d: the dependency as the board has it (undefined: not there, holds nothing).
export const holds = (t: Pick<BoardTask, "id">, d: Pick<BoardTask, "archivedAt" | "parentId"> | undefined): boolean => !!d && !(d.archivedAt && d.parentId === t.id);
// the dependencies of t that hold it (and exist)
export const heldDeps = (t: Pick<BoardTask, "id" | "dependsOn">, tasks: readonly BoardTask[]): string[] =>
  t.dependsOn.filter((d) => holds(t, tasks.find((x) => x.id === d)));

// F3 (T-13a): opts — the places with a remote base (their heads are not read: a dependency counts once «Done» and its
// result is where the base is, which an ordinary task's never is before its MR is merged — waits_mr; an external task
// waits only for its own dependencies «Done»), and the places whose branch template needs the task's issue
// (branch_template_field on a task in the queue without one). No opts: as before
export function boardStatuses(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], heads: readonly BoardHead[] = [], opts: BoardOpts = {}): Map<string, TaskStatus> {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const depsOf = (t: BoardTask) => t.dependsOn.filter((d) => holds(t, byId.get(d)));
  const runsOf = new Map<string, RunTaskFacts[]>();
  const splitsOf = new Map<string, RunTaskFacts[]>(); // E2: the decomposition runs of a parent
  for (const f of facts) {
    const t = f.taskId ? byId.get(f.taskId) : undefined;
    if (t && f.workspaceId === t.workspaceId) runsOf.set(t.id, [...(runsOf.get(t.id) ?? []), f]);
    const p = f.decompositionOf ? byId.get(f.decompositionOf) : undefined;
    if (p && f.workspaceId === p.workspaceId) splitsOf.set(p.id, [...(splitsOf.get(p.id) ?? []), f]);
  }
  // ponytail: a search from each task, O(n·(n+e)); the board holds at most 2000 tasks of a few dependencies each
  const onCycle = new Set<string>();
  for (const t of board.tasks) {
    const seen = new Set<string>();
    const stack = depsOf(t);
    while (stack.length) {
      const id = stack.pop()!;
      if (id === t.id) { onCycle.add(t.id); break; }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...depsOf(byId.get(id)!));
    }
  }
  const out = new Map<string, TaskStatus>();
  const statusOf = (id: string): TaskStatus => {
    const known = out.get(id);
    if (known) return known;
    const task = byId.get(id)!;
    const mine = own(task, runsOf.get(id) ?? []);
    // a task off every cycle depends only on tasks off cycles or on them (never recursed into): this ends
    const remote = !!opts.remoteBase?.has(placeKey(task));
    const depsWait: TaskStatus["depsWait"] = onCycle.has(id)
      ? { reason: "waits_task", cycle: true, waitsFor: depsOf(task).filter((d) => onCycle.has(d)).map((d) => byId.get(d)!.key) }
      : remote ? remoteDependencies(task, depsOf(task).map((d) => [byId.get(d)!, statusOf(d)] as const))
        : dependencies(depsOf(task).map((d) => [byId.get(d)!, statusOf(d)] as const), runsOf,
          heads.find((h) => h.workspaceId === task.workspaceId && h.project === task.project));
    let s: TaskStatus = { ...mine, depsWait };
    if (s.done && !onCycle.has(id)) s = { ...s, depsNote: noteOf(task, s, depsOf(task).map((d) => [byId.get(d)!, statusOf(d)] as const), runsOf) };
    // the queue shows what it waits for; a task at work or in review keeps its run's reason
    else if (depsWait && s.column === "queue" && s.reason !== "run_newer") s = { ...s, reason: depsWait.reason, waitsFor: depsWait.waitsFor, cycle: depsWait.cycle };
    // T-6: a task the branch template cannot name (no issue) — said where nothing else holds it
    if (!s.done && s.column === "queue" && s.reason === null && !task.external && !task.issue && opts.issueRequired?.has(placeKey(task))) s = { ...s, reason: "branch_template_field" };
    if (task.decompose && s.attempts === 0) s = parentStatus(task, s, splitsOf.get(id) ?? [], board.tasks);
    out.set(id, s);
    return s;
  };
  for (const t of board.tasks) statusOf(t.id);
  return out;
}

// E2 (stage-e-decomposition.md §2.1): a parent task with no run of its own, by its decomposition runs and its subtasks.
// The table's rows; a task with subtasks is an ordinary task waiting for its dependencies (rows of the table: as now).
function parentStatus(task: BoardTask, s: TaskStatus, splits: readonly RunTaskFacts[], tasks: readonly BoardTask[]): TaskStatus {
  const by = (f: RunTaskFacts, over: Partial<TaskStatus>): TaskStatus => ({ ...s, waitsFor: [], cycle: false, ...over, split: { runId: f.runId, detail: null, ...(over.split ?? {}) } });
  const subs = tasks.some((x) => x.parentId === task.id && !x.archivedAt);
  // the run the subtasks were made by is over; a later one (the person's «Split again») decides
  const later = splits.filter((f) => f.runId !== task.decomposedBy);
  const latest = [...later].sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId)).at(-1);
  if (task.decomposedBy) {
    if (subs) return s;
    if (!latest) return { ...s, column: "review", reason: "subtasks_gone", waitsFor: [], cycle: false };
  } else if (!latest) return s;
  const f = latest!;
  const failed = (detail: string): TaskStatus => by(f, { column: "review", reason: "decomposition_failed", split: { runId: f.runId, detail } });
  if (f.newer) return by(f, { column: "queue", reason: "run_newer" });
  if (f.status === "unreadable") return by(f, { column: "queue", reason: "run_unreadable" });
  if (f.permission) return by(f, { column: "work", reason: "waits_permission" });
  switch (f.status) {
    case "paused":
      return f.reason === "awaiting_answer" ? by(f, { column: "work", reason: "waits_answer" })
        : by(f, { column: "work", reason: "decomposition_paused", split: { runId: f.runId, detail: f.reason ?? "unknown" } });
    case "completed":
      if (f.split === "whole") return { ...s, split: { runId: f.runId, detail: "whole" } };
      if (f.split === "proposed") return f.splitFailed ? failed(f.splitFailed) : by(f, { column: "work", reason: "decomposing" });
      return failed(f.split === "rejected" ? "rejected" : "failed");
    case "failed": return failed("failed");
    case "stopped": return failed("stopped");
    default: return by(f, { column: "work", reason: "decomposing" }); // preparing, running, pausing, stopping
  }
}

// A task by its own runs only. F2 (T-3): an external task without runs — «Done» only by the person's mark; one with runs
// goes by them, said so (external_has_runs) where its runs leave no reason of their own
export function own(task: Pick<BoardTask, "accepted"> & Partial<Pick<BoardTask, "external" | "externalDone">>, runs: readonly RunTaskFacts[]): TaskStatus {
  if (task.external && !runs.length) {
    const marked = !!task.externalDone;
    return { attempts: 0, waitsFor: [], cycle: false, depsWait: null, depsNote: null, current: null, completion: null, reason: null,
      column: marked ? "done" : "queue", done: marked ? "external" : null };
  }
  const s = byRuns(task, runs);
  return task.external && !s.done && !s.reason ? { ...s, reason: "external_has_runs" } : s;
}
function byRuns(task: Pick<BoardTask, "accepted">, runs: readonly RunTaskFacts[]): TaskStatus {
  const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  const base = { attempts: sorted.length, waitsFor: [] as string[], cycle: false, done: null, depsWait: null, depsNote: null };
  const current = sorted.at(-1);
  if (!current) return { ...base, column: "queue", reason: null, current: null, completion: null };
  const readable = [...sorted].reverse().find((r) => r.status !== "unreadable" && !r.newer);
  const head = { ...base, current: current.runId, completion: current.completion };
  if (current.newer) return { ...head, column: "queue", reason: "run_newer" };
  if (current.status === "unreadable") {
    // the column of the last run that can be read, the reason of this one
    const prev = readable ? byRuns({ accepted: null }, [readable]) : null;
    return { ...head, column: prev?.column === "done" ? "review" : prev?.column ?? "queue", reason: "run_unreadable" };
  }
  const phase: TaskColumn = current.phase === "review" ? "review" : "work";
  switch (current.status) {
    case "completed": {
      if (current.completion === "confirmed") return { ...head, column: "done", done: "confirmed", reason: null };
      if (current.completion === "no_checks") {
        return task.accepted?.runId === current.runId ? { ...head, column: "done", done: "accepted", reason: null } : { ...head, column: "review", reason: "no_checks" };
      }
      return { ...head, column: "review", reason: "paused_other" }; // a completed run without its completion kind: not «Done»
    }
    case "stopped": return { ...head, column: "queue", reason: "last_stopped" };
    case "failed": return { ...head, column: "queue", reason: "last_failed" };
    case "stopping": case "pausing": return { ...head, column: phase, reason: "stopping" };
    case "paused": {
      const r = current.reason ?? "";
      const reason: TaskReason = current.permission ? "waits_permission" : r === "awaiting_answer" ? "waits_answer"
        : DECISIONS.has(r) ? "waits_decision" : r === "limit_reached" ? "limit_reached" : "paused_other";
      return { ...head, column: phase, reason };
    }
    default: return { ...head, column: phase, reason: current.permission ? "waits_permission" : current.halted ? "paused_other" : null }; // preparing, running
  }
}

// What a task's dependencies make it wait for: the tasks not «Done», then a result that is not where a dependent task
// would see it (stage-b-board.md §5.2, the base rule); null — ready.
function dependencies(all: readonly (readonly [BoardTask, TaskStatus])[], runsOf: Map<string, RunTaskFacts[]>, head?: BoardHead): TaskStatus["depsWait"] {
  const open = all.filter(([, d]) => !isDone(d));
  // F2 (T-3): only external tasks not marked yet — the person's mark, not a run, is what it waits for
  if (open.length) return { reason: open.every(([t, d]) => externalInForce(t, d)) ? "waits_external" : "waits_task", waitsFor: open.map(([t]) => t.key), cycle: false };
  // F2: a marked external task has no result anywhere — nothing to see, nothing to merge
  const deps = all.filter(([, d]) => d.done !== "external");
  if (!deps.length) return null;
  // C2 (decision 9): with the board's merged head, a dependency counts once its current result is in it — or in the
  // working folder (it worked there, or was applied), which the head started from; no merge is left to the person
  // A dependency of another project never gets into this head: B's rule for it
  if (head) {
    const here = deps.filter(([t]) => t.project === head.project);
    const out = here.filter(([t, d]) => mergeOfTask(head, t.id, d.current)?.status !== "completed"
      && resultOf(runsOf.get(t.id)?.find((r) => r.runId === d.current)) !== "folder").map(([t]) => t.key);
    if (out.length) return { reason: "waits_head", waitsFor: out, cycle: false };
    // a result in the folder and one in a copy (in the head, or a branch) at once: no base has both — the person's, as in B
    const where = here.map(([t, d]) => resultOf(runsOf.get(t.id)?.find((r) => r.runId === d.current)));
    if (where.includes("folder") && where.some((w) => w !== "folder")) return { reason: "waits_merge", waitsFor: here.map(([t]) => t.key), cycle: false };
    const others = deps.filter(([t]) => t.project !== head.project);
    return others.length ? dependencies(others, runsOf) : null;
  }
  const where = deps.map(([t, d]) => [t, resultOf(runsOf.get(t.id)?.find((r) => r.runId === d.current))] as const);
  const notTaken = where.filter(([, w]) => w === "none").map(([t]) => t.key);
  if (notTaken.length) return { reason: "waits_result", waitsFor: notTaken, cycle: false };
  // owner's decision 11: a result in a branch is the base of a separate copy — one of them, and nothing else to join
  // with it; a second result (another branch, or one in the folder) would need a merge: stage C, the person's
  if (where.some(([, w]) => w === "branch") && where.length > 1) return { reason: "waits_merge", waitsFor: where.map(([t]) => t.key), cycle: false };
  return null;
}

// F3 (T-13a, О4): a place with a remote base — the base is the remote's branch, which holds a dependency's result only
// after its MR is merged: an ordinary task «Done» is waited for (waits_mr) — the person's external «MR merged» task stands
// for it. An external task waits only for its own dependencies «Done». ponytail: every ordinary dependency, of this
// project or another, is waits_mr — a result in the working folder (a run in it, an applied one) is no more on the remote
function remoteDependencies(task: Pick<BoardTask, "external">, all: readonly (readonly [BoardTask, TaskStatus])[]): TaskStatus["depsWait"] {
  const open = all.filter(([, d]) => !isDone(d));
  if (open.length) return { reason: open.every(([t, d]) => externalInForce(t, d)) ? "waits_external" : "waits_task", waitsFor: open.map(([t]) => t.key), cycle: false };
  if (task.external) return null;
  const ordinary = all.filter(([, d]) => d.done !== "external").map(([t]) => t.key);
  return ordinary.length ? { reason: "waits_mr", waitsFor: ordinary, cycle: false } : null;
}

// A «Done» task's dependencies now: one not «Done» was «Done» by a run before this task's run started (it changed after),
// or it never was (this task was started anyway); a dependency's own note goes on to the tasks after it.
function noteOf(task: BoardTask, s: TaskStatus, deps: readonly (readonly [BoardTask, TaskStatus])[], runsOf: Map<string, RunTaskFacts[]>): TaskStatus["depsNote"] {
  const since = runsOf.get(task.id)?.find((r) => r.runId === s.current)?.createdAt ?? Infinity;
  // the dependency's latest run before this task's run started, and it ended «Done» (review of B3: not any earlier one)
  const wasDone = (t: BoardTask) => {
    const r = (runsOf.get(t.id) ?? []).filter((x) => x.createdAt < since).sort((a, b) => a.createdAt - b.createdAt).at(-1);
    return !!r && r.status === "completed" && (r.completion === "confirmed" || (r.completion === "no_checks" && t.accepted?.runId === r.runId));
  };
  const notes = deps.map(([t, d]) => (!isDone(d) ? (wasDone(t) ? "changed" : "not_ready") : d.depsNote));
  return notes.includes("not_ready") ? "not_ready" : notes.includes("changed") ? "changed" : null;
}

// Where a dependency's result is for a task after it: in the project folder (it worked there, or its result was applied),
// in a branch of the project only («Create a branch»), or not taken at all.
export function resultOf(run: RunTaskFacts | undefined): "folder" | "branch" | "none" {
  if (!run || (run.workMode !== "copy" && run.workMode !== "worktree") || run.taken?.applied) return "folder";
  return run.taken?.branch && run.taken.commit ? "branch" : "none";
}

// C2: what a person's start of a task offers to start from — the board's merged head of its place; but a dependency
// whose result is in the working folder (it worked there, or was applied) may not be in the head: then B's base (the
// folder, or a dependency's branch). ponytail: a folder result from before the head started is in it too; told apart
// only by «Начать новый итог доски»
export function startBase(task: Pick<BoardTask, "id" | "dependsOn" | "workspaceId" | "project">, board: Pick<Board, "tasks">, statuses: ReadonlyMap<string, TaskStatus>,
  facts: readonly RunTaskFacts[], heads: readonly BoardHead[]): { branch: string; commit: string; key: string } | null {
  const head = heads.find((h) => h.workspaceId === task.workspaceId && h.project === task.project);
  // F2: a marked external task has no result: it says nothing of where to start from
  const inFolder = heldDeps(task, board.tasks).some((id) => resultOf(facts.find((f) => f.runId === statuses.get(id)?.current)) === "folder"
    && !!statuses.get(id)?.done && statuses.get(id)?.done !== "external");
  return head && !inFolder ? { branch: head.ref, commit: head.commit, key: "T-0" } : baseOf(task, board, statuses, facts);
}

// B4 (owner's decision 11): what a task's separate copy starts from — the working folder (null), or the one dependency
// result that is in a branch only. Asked only of a task without a reason (all dependencies «Done», nothing to merge).
export function baseOf(task: Pick<BoardTask, "id" | "dependsOn">, board: Pick<Board, "tasks">, statuses: ReadonlyMap<string, TaskStatus>,
  facts: readonly RunTaskFacts[]): { branch: string; commit: string; key: string } | null {
  for (const id of heldDeps(task, board.tasks)) {
    const dep = board.tasks.find((t) => t.id === id);
    const run = facts.find((f) => f.runId === statuses.get(id)?.current);
    if (dep && run && resultOf(run) === "branch") return { branch: run.taken!.branch!, commit: run.taken!.commit!, key: dep.key };
  }
  return null;
}

// E3 (stage-e-decomposition.md §7): a parent marked «Split» that is not split is not run whole by the autopilot —
// unless the lead answered «whole». (A parent in decomposition_failed / decomposition_paused / subtasks_gone is out of
// the queue-with-no-reason already, by parentStatus.)
const notYetSplit = (t: BoardTask, s: TaskStatus): boolean => !!t.decompose && !t.decomposedBy && s.split?.detail !== "whole";

// B4 (§5.1): the board's autopilot takes, of the tasks of the link's workspace and the lead's folder, not archived, in
// the queue without a reason and never tried (a retry after stopped or failed is the person's), the first by order.
// E3 (§2.2): a subtask whose parent is in the archive is not taken (a missing parent: taken)
const parentArchived = (t: Pick<BoardTask, "parentId">, tasks: readonly BoardTask[]): boolean => !!t.parentId && !!tasks.find((x) => x.id === t.parentId)?.archivedAt;

// F3 (T-6): opts.issueRequired — a task without its issue is never taken (the branch template cannot name it)
export function nextTask(board: Pick<Board, "tasks">, statuses: ReadonlyMap<string, TaskStatus>, at: { workspaceId: string; project: string }, opts: PlaceOpts = {}): BoardTask | null {
  return board.tasks.filter((t) => {
    const s = statuses.get(t.id);
    // a dependency «Done» on a shaky base (its own dependency changed, or it was started anyway) is the person's call
    // F2 (T-3): an external task is never started — the person marks it
    return t.workspaceId === at.workspaceId && t.project === at.project && !t.archivedAt && !t.external && !(opts.issueRequired && !t.issue) && s?.column === "queue" && s.reason === null && s.attempts === 0
      && !heldDeps(t, board.tasks).some((d) => statuses.get(d)?.depsNote) && !notYetSplit(t, s) && !parentArchived(t, board.tasks);
  }).sort((a, b) => a.order - b.order)[0] ?? null;
}

// Why there is no next task: every task of the place «Done», or the ones left wait (their keys with their reasons)
export function idleOf(board: Pick<Board, "tasks">, statuses: ReadonlyMap<string, TaskStatus>, at: { workspaceId: string; project: string }):
  { allDone: boolean; waiting: { key: string; reason: TaskReason | null; waitsFor: string[] }[] } {
  const mine = board.tasks.filter((t) => t.workspaceId === at.workspaceId && t.project === at.project && !t.archivedAt);
  const left = mine.filter((t) => !statuses.get(t.id)?.done);
  return { allDone: left.length === 0, waiting: left.map((t) => ({ key: t.key, reason: statuses.get(t.id)?.reason ?? null, waitsFor: statuses.get(t.id)?.waitsFor ?? [] })) };
}

// Owner's decision 8: in the board's autopilot, a task that became «Done» (confirmed or accepted) gets its result taken
// as a branch in the project — the safe action that touches no working folder. Nothing to do for a run in the project
// folder (its changes are there) or one whose result is in a branch already. The call is B4's.
// F3 (T-13a, T-6): with a remote base no take — the run's branch carries its commit already
export function autoTakeOnDone(status: TaskStatus, run: Pick<RunTaskFacts, "runId" | "workMode" | "taken"> | undefined, opts: PlaceOpts = {}): "branch" | null {
  if (opts.remoteBase || !status.done || !run || run.runId !== status.current) return null;
  if (run.workMode !== "copy" && run.workMode !== "worktree") return null;
  return run.taken?.branch ? null : "branch";
}

// B4 (§5.1): what a start takes from the project settings — the same for the goal dialog (its defaults, which the
// person may change) and for the board's autopilot (as they are). Main fills the rest in (resolveGoal: rights,
// preparation). The actions after success: the commit only, as the dialog offers it, never in a separate copy.
export function profileGoal(profile: Pick<OrchestrationProjectProfile, "checks" | "workMode" | "finish" | "models">) {
  return {
    commands: [...profile.checks],
    workMode: profile.workMode,
    finish: { commit: profile.finish.commit, push: false, qa: false },
    models: profile.models ?? { lead: null, executor: null, reviewer: null }
  };
}

// The goal of a task's start by the autopilot: the task's text and requirements, the settings as they are, in the
// autopilot mode, from the base its dependency left (owner's decision 11). F2 (T-4): the task's own model of a role over
// the profile's — passed, as the profile's, only with journal v2 (optionalChecks)
export function goalFor(task: Pick<BoardTask, "id" | "key" | "ref" | "text" | "criteria" | "decompose" | "decomposedBy"> & Partial<Pick<BoardTask, "models">>, profile: Pick<OrchestrationProjectProfile, "checks" | "workMode" | "finish" | "models">,
  opts: { optionalChecks: boolean; language: "ru" | "en"; base: OrchestrationBaseRef | null; tasks?: readonly BoardTask[] }): OrchestrationGoalInput {
  const p = profileGoal(profile);
  const finish = p.workMode !== "copy" && p.finish.commit ? { finish: p.finish } : {};
  return {
    ...(opts.optionalChecks ? { models: { ...p.models, ...(task.models ?? {}) } } : {}),
    text: taskText(task, opts.tasks ?? [], opts.language), criteria: [...task.criteria], checks: [], commands: p.commands, workMode: p.workMode, mode: "autopilot", reviewPlan: false,
    language: opts.language, task: { id: task.id, key: task.key, ...(task.ref ? { ref: task.ref } : {}) }, ...finish, limits: {},
    ...(opts.base && (p.workMode === "copy" || p.workMode === "worktree") ? { base: opts.base } : {})
  };
}

// E2 (stage-e-decomposition.md §6): the texts the application adds. Task text is 8000 at most (checkGoal).
export const TASK_TEXT_MAX = 8000;
export const SPLIT_TEXT_MAX = 7600; // a task marked «Split» leaves 400 for the closing run's paragraph
const SUBTASKS_PARAGRAPH_MAX = 400;

// A subtask's text: the lead's text and, after it, the requirements of the parent it covers — verbatim while all fits in
// 8000, the rest cut with «…» (every R number stays). Context for the run, not its requirements: it is accepted by its own.
export function subtaskText(leadText: string, parent: Pick<BoardTask, "key" | "title" | "criteria">, covers: readonly string[], language: "ru" | "en"): string {
  const head = `${leadText}\n\n${language === "ru" ? `Часть задачи ${parent.key} «${parent.title}». Закрывает её требования:` : `Part of task ${parent.key} «${parent.title}». It covers these of its requirements:`}`;
  const lines = covers.map((r) => ({ r, text: parent.criteria[Number(r.slice(1)) - 1] ?? "" }));
  const least = (r: string) => `\n${r} — …`;
  let room = TASK_TEXT_MAX - head.length;
  let out = head;
  for (const [i, l] of lines.entries()) {
    const reserve = lines.slice(i + 1).reduce((n, x) => n + least(x.r).length, 0); // the later ones keep their number at least
    const full = `\n${l.r} — ${l.text}`;
    const part = full.length <= room - reserve ? full
      : room - reserve > least(l.r).length ? `\n${l.r} — ${l.text.slice(0, room - reserve - least(l.r).length)}…` : least(l.r);
    out += part;
    room -= part.length;
  }
  return out.slice(0, TASK_TEXT_MAX); // ponytail: a lead text of 4000 (the check's limit) always leaves room; a longer one is cut at the end
}

// The text of a task's run: a parent whose subtasks were made gets a paragraph for the closing run (§6): check its own
// requirements on the current code and finish what is missing. Any other task: its text.
export function taskText(task: Pick<BoardTask, "id" | "text" | "decompose" | "decomposedBy">, tasks: readonly BoardTask[], language: "ru" | "en"): string {
  if (!task.decompose || !task.decomposedBy) return task.text;
  const keys = tasks.filter((t) => t.parentId === task.id && !t.archivedAt).sort((a, b) => a.order - b.order).map((t) => t.key);
  if (!keys.length) return task.text;
  const say = (n: number) => {
    const list = keys.slice(0, n).join(", ") + (n < keys.length ? (language === "ru" ? ` и ещё ${keys.length - n}` : ` and ${keys.length - n} more`) : "");
    return language === "ru"
      ? `Подзадачи ${list} выполнены и влиты в итог доски. Проверьте требования этой задачи на текущем коде и доделайте только недостающее.`
      : `Subtasks ${list} are done and merged into the board's result. Check this task's requirements on the current code and finish only what is missing.`;
  };
  let n = keys.length;
  while (n > 1 && say(n).length > SUBTASKS_PARAGRAPH_MAX) n--;
  return `${task.text}\n\n${say(n)}`;
}

// B4 (§5.2): the pauses of a run the autopilot waits through — the person answers, the run goes on
export const WAIT_PAUSES = new Set(["awaiting_answer", "plan_review", "awaiting_checks_decision", "awaiting_finish_confirmation", "awaiting_person_decision",
  "stage_done", "step_done"]);
const ACTIVE = new Set(["created", "preparing", "running", "pausing", "stopping"]);

// The working time of a run by its journal: from its first record, without the pauses that wait for the person, to its
// end or now. A permission request is not journaled: it counts as work (§5.2 — the budget ends sooner, never later).
// waits: the pauses that wait for the person — a merge run's are all of them (C2, decision 14: its preparation and checks count)
// C4 (stage-c4-limits.md §2.4): limitTurns — the turns a provider's limit ended (from the run's feed): the
// environment_error pause after one is a wait too
export function activeMs(records: readonly { ts: string; type: string; data: Record<string, unknown> }[], now: number,
  waits: (reason: string) => boolean = (r) => WAIT_PAUSES.has(r), limitTurns: ReadonlySet<string> = new Set()): number {
  let total = 0;
  let from: number | null = records.length ? Date.parse(records[0]!.ts) : null;
  let lastTurn: string | null = null;
  for (const r of records) {
    if (r.type === "turn.finished" && typeof r.data.turnId === "string") lastTurn = r.data.turnId;
    if (r.type !== "run.status") continue;
    const at = Date.parse(r.ts);
    const status = String(r.data.status ?? "");
    const reason = String(r.data.reason ?? "");
    const working = status !== "paused" ? ACTIVE.has(status) : !(waits(reason) || (reason === "environment_error" && lastTurn !== null && limitTurns.has(lastTurn)));
    if (from !== null && !working) { total += Math.max(0, at - from); from = null; } else if (from === null && working) from = at;
  }
  return total + (from !== null ? Math.max(0, now - from) : 0);
}

// E3 (stage-e-decomposition.md §7): the autopilot's own decomposition runs (splits: their ids) as the steps read them —
// halt: stops it; person: waits for the person; moving: goes on by itself (or main is making the subtasks). A run paused at
// a provider's limit is limitStep's. Only these runs stop the autopilot: a person's split never does.
function ownSplits(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], splits: readonly string[], limited: readonly LimitedRun[]):
  { halt: { code: AutopilotStopCode; detail: string | null; key: string | null } | null; person: string | null; moving: boolean } {
  let halt: { code: AutopilotStopCode; detail: string | null; key: string | null } | null = null;
  let person: string | null = null;
  let moving = false;
  for (const id of splits) {
    const f = facts.find((x) => x.runId === id);
    if (!f) { moving = true; continue; } // its journal is not there yet
    const t = board.tasks.find((x) => x.id === f.decompositionOf);
    if (!t) { halt ??= { code: "task_gone", detail: null, key: null }; continue; }
    const key = t.key;
    const failed = (detail: string | null) => { halt ??= { code: "decomposition_failed", detail, key }; };
    if (f.newer || f.status === "unreadable") halt ??= { code: "run_unreadable", detail: null, key };
    else if (f.permission) person ??= "permission";
    else if (f.status === "failed") failed("failed");
    else if (f.status === "stopped") failed("stopped");
    else if (f.status === "paused") {
      if (limited.some((x) => x.runId === id)) continue;
      if (WAIT_PAUSES.has(f.reason ?? "")) person ??= "person";
      else halt ??= f.reason === "limit_reached" ? { code: "limit_reached", detail: f.limit, key } : { code: "run_paused", detail: f.reason, key };
    } else if (f.status === "completed") {
      if (f.split === "proposed") { if (f.splitFailed) failed(f.splitFailed); else if (t.decomposedBy !== id) moving = true; }
      else if (f.split !== "whole") failed(f.split === "rejected" ? "rejected" : "failed");
    } else if (f.halted) halt ??= { code: "run_paused", detail: f.reason, key };
    else moving = true;
  }
  return { halt, person, moving };
}

// E3 (§7): the first parent of the place to split: marked, not split, not a subtask, never tried, its dependencies ready,
// and no decomposition of it at all (a retry is the person's). F2 (T-3): never an external task. F3 (T-13c): none at a
// remote base (remote_base_mode)
export function decomposeCandidate(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], statuses: ReadonlyMap<string, TaskStatus>, at: { workspaceId: string; project: string },
  opts: PlaceOpts = {}): BoardTask | null {
  if (opts.remoteBase) return null;
  return board.tasks.filter((t) => {
    const s = statuses.get(t.id);
    return t.workspaceId === at.workspaceId && t.project === at.project && t.decompose && !t.decomposedBy && !t.parentId && !t.archivedAt && !t.external
      && s?.column === "queue" && s.reason === null && s.attempts === 0 && s.depsWait === null && !heldDeps(t, board.tasks).some((d) => statuses.get(d)?.depsNote)
      && !facts.some((f) => f.decompositionOf === t.id && f.workspaceId === t.workspaceId);
  }).sort((a, b) => a.order - b.order)[0] ?? null;
}

export type AutopilotStep =
  | { kind: "wait"; why: string; limit?: AutopilotLimit; key?: string } // F2: why "external" — key: the external task it waits for
  | { kind: "resume"; runId: string; key: string; provider: string } // C4: continue its own run after the limit's reset
  | { kind: "take"; runId: string; key: string }
  | { kind: "start"; task: BoardTask; base: OrchestrationBaseRef | null }
  | { kind: "decompose"; task: BoardTask } // E3: split a parent marked «Split» (main starts the decomposition run)
  | { kind: "off"; code: AutopilotStopCode; detail: string | null; key: string | null; waiting?: AutopilotWaiting[] };

// B4 (§5.2): what the board's autopilot of a link does next, from the board and the facts of the runs alone (the
// settings, the readiness and the start itself are main's). last: the run it started last (null: none yet).
export function autopilotStep(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], at: { workspaceId: string; project: string; workMode: OrchestrationWorkMode },
  last: string | null, used: { runs: number; ms: number }, budget: AutopilotBudget, limited: readonly LimitedRun[] = [], now = Date.now(),
  splits: readonly string[] = []): AutopilotStep {
  // C4 (§2.1): a run of the place at a provider's limit comes before anything else — no new task meanwhile
  const limits = limitStep(limited, now);
  if (limits) return limits;
  // F3 (T-13a): no place options here — the project folder takes neither a remote base (remote_base_mode) nor a branch
  // template (work_mode_not_worktree): the profile refuses both
  const statuses = boardStatuses(board, facts);
  // E3 (§7): its own decomposition run first: one at a time, nothing else runs while it goes on
  const sp = ownSplits(board, facts, splits, limited);
  if (sp.halt) return { kind: "off", ...sp.halt };
  if (sp.person || sp.moving) return { kind: "wait", why: sp.person ?? "run" };
  const run = last ? facts.find((f) => f.runId === last) : undefined;
  const task = run?.taskId ? board.tasks.find((t) => t.id === run.taskId) : undefined;
  if (last && !run) return { kind: "wait", why: "run" }; // its journal is not there yet
  if (run && !task) return { kind: "off", code: "task_gone", detail: run.taskKey, key: run.taskKey };
  if (run && task) {
    const key = task.key;
    if (run.newer || run.status === "unreadable") return { kind: "off", code: "run_unreadable", detail: null, key };
    if (run.permission) return { kind: "wait", why: "permission" };
    if (run.status === "stopped") return { kind: "off", code: "run_stopped", detail: run.reason, key };
    if (run.status === "failed") return { kind: "off", code: "run_failed", detail: run.reason, key };
    if (run.status === "paused") {
      if (WAIT_PAUSES.has(run.reason ?? "")) return { kind: "wait", why: "person" };
      return run.reason === "limit_reached" ? { kind: "off", code: "limit_reached", detail: run.limit, key } : { kind: "off", code: "run_paused", detail: run.reason, key };
    }
    if (run.status !== "completed") return run.halted ? { kind: "off", code: "run_paused", detail: run.reason, key } : { kind: "wait", why: "run" };
    const s = statuses.get(task.id)!;
    if (s.current === run.runId && s.reason === "no_checks") return { kind: "wait", why: "accept" };
    if (s.current === run.runId && !s.done) return { kind: "off", code: "run_paused", detail: run.reason, key };
    if (autoTakeOnDone(s, run) === "branch") return { kind: "take", runId: run.runId, key };
  }
  const next = nextTask(board, statuses, at);
  // another run of this place goes on (the person's, another link's; E3: a split too): what it leaves may free the next task
  // (a run paused for another reason waits for nobody: the others wait, said as such)
  const busyHere = facts.some((f) => (ACTIVE.has(f.status) || f.permission || (f.status === "paused" && WAIT_PAUSES.has(f.reason ?? "")))
    && board.tasks.some((t) => t.id === (f.taskId ?? f.decompositionOf) && t.workspaceId === at.workspaceId && t.project === at.project));
  // E3 (§7): before a start of an ordinary task, a parent ready to split
  const split = decomposeCandidate(board, facts, statuses, at);
  if (split) {
    if (busyHere) return { kind: "wait", why: "run" };
    if (used.runs >= budget.runs) return { kind: "off", code: "budget_runs", detail: String(budget.runs), key: null };
    if (used.ms >= budget.minutes * 60_000) return { kind: "off", code: "budget_minutes", detail: String(budget.minutes), key: null };
    return { kind: "decompose", task: split };
  }
  if (!next && busyHere) return { kind: "wait", why: "run" };
  if (!next) {
    const idle = idleOf(board, statuses, at);
    if (idle.allDone) return { kind: "off", code: "all_done", detail: null, key: null };
    const external = externalWait(board, statuses, at);
    if (external) return { kind: "wait", why: "external", key: external };
    const detail = idle.waiting.map((w) => (w.waitsFor.length ? `${w.key} (${w.reason}: ${w.waitsFor.join(", ")})` : `${w.key} (${w.reason ?? "-"})`)).join("; ");
    return { kind: "off", code: "others_wait", detail, key: null, waiting: idle.waiting };
  }
  // the budget is asked before a start only: a last run that ends the board ends it «all done»
  if (used.runs >= budget.runs) return { kind: "off", code: "budget_runs", detail: String(budget.runs), key: null };
  if (used.ms >= budget.minutes * 60_000) return { kind: "off", code: "budget_minutes", detail: String(budget.minutes), key: null };
  const base = baseOf(next, board, statuses, facts);
  // a worktree starts from HEAD: from a ref is stage C (§5.2); a copy takes the branch (owner's decision 11)
  if (base && at.workMode !== "copy") return { kind: "off", code: "worktree_base", detail: base.key, key: next.key };
  return { kind: "start", task: next, base };
}

// C1 (stage-c-parallel.md §2, §4.5, §8): the board's autopilot of a link in a separate copy, with N slots and the board's
// merged head. One action per step, from the board, the facts of the runs and the head alone:
// - head: there is something to start or merge and no head yet — main starts it from the working folder;
// - take: a task «Done» by a run in a copy gets its result branch (decision 8), as in B;
// - merge: a task «Done», started from this head, not in it and never merged into it — one at a time, the oldest first;
// - start: a free slot and a task without a reason (its dependencies, if any, in the head), from the head.
// It waits while a run or a merge goes on or the person is asked; it is off, with a reason, when nothing goes on and
// nothing waits for the person. started: the runs it started (stops of those decide); slots count every run of the place.
// C3 (stage-c3-conflicts.md §6, §9): agent — a paused merge handed to an agent (a slot and the budget for it);
// merge_wait — no slot (it waits for one, not for the person) or no budget (then it is the person's)
export type AutopilotParallelStep = AutopilotStep | { kind: "head" } | { kind: "merge"; taskId: string; key: string; runId: string; commit: string }
  | { kind: "agent"; mergeRunId: string; key: string } | { kind: "merge_wait"; mergeRunId: string; why: "merge_waits_slot" | "merge_budget"; key: string };
// what a merge is handed to an agent from by the autopilot: once, never after an agent's try (§2.3)
const AGENT_FROM = new Set(["merge_conflict", "merge_checks_failed", "merge_waits_slot"]);
const MERGE_ACTIVE = new Set(["preparing", "running"]);
// C2: a worktree goes as a separate copy does — its own folder, from the head, merged into it
export const isCopy = (mode: OrchestrationWorkMode | null | undefined): boolean => mode === "copy" || mode === "worktree";
// refused (C3): merges the application would not hand to an agent (a lock file, not from the head, …): the person's
// opts (F3, T-13a): the place's options from its profile. remoteBase — no head (head is null), so no head, merge, agent
// or merge_wait step and no take; a task starts with base null (main puts the remote's branch in, T-13b); a direct
// dependency on an ordinary task holds it (waits_mr). issueRequired — a task without its issue is skipped
// (branch_template_field), with dependencies or without
export function autopilotParallelStep(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], at: { workspaceId: string; project: string },
  started: readonly string[], used: { runs: number; ms: number }, budget: AutopilotBudget, given: BoardHead | null, refused: ReadonlySet<string> = new Set(),
  limited: readonly LimitedRun[] = [], now = Date.now(), splits: readonly string[] = [], opts: PlaceOpts = {}): AutopilotParallelStep {
  const head = opts.remoteBase ? null : given;
  const statuses = boardStatuses(board, facts, head ? [head] : [], placeOpts(at, opts));
  const place = board.tasks.filter((t) => t.workspaceId === at.workspaceId && t.project === at.project);
  const mergeOf = (taskId: string) => mergeOfTask(head, taskId, statuses.get(taskId)?.current ?? null);
  const inHead = (taskId: string) => mergeOf(taskId)?.status === "completed";
  let halt: { code: AutopilotStopCode; detail: string | null; key: string | null } | null = null;
  let person: string | null = null; // what the person is asked: a permission, a decision in a run, «Accept the result», a merge
  // the runs it started: a stop or a failure takes no new task; a question of the person waits
  for (const id of started) {
    const run = facts.find((f) => f.runId === id);
    if (!run) return { kind: "wait", why: "run" }; // its journal is not there yet
    const task = board.tasks.find((t) => t.id === run.taskId);
    if (!task) { halt ??= { code: "task_gone", detail: run.taskKey, key: run.taskKey }; continue; }
    const s = statuses.get(task.id)!;
    if (s.current !== run.runId) continue; // a later run of the task (the person's) is the person's
    const key = task.key;
    if (run.newer || run.status === "unreadable") halt ??= { code: "run_unreadable", detail: null, key };
    else if (run.permission) person ??= "permission";
    else if (run.status === "stopped") halt ??= { code: "run_stopped", detail: run.reason, key };
    else if (run.status === "failed") halt ??= { code: "run_failed", detail: run.reason, key };
    else if (run.status === "paused") {
      if (limited.some((x) => x.runId === run.runId)) continue; // C4: the limits decide below
      if (WAIT_PAUSES.has(run.reason ?? "")) person ??= "person";
      else halt ??= run.reason === "limit_reached" ? { code: "limit_reached", detail: run.limit, key } : { code: "run_paused", detail: run.reason, key };
    } else if (run.status !== "completed") { if (run.halted) halt ??= { code: "run_paused", detail: run.reason, key }; }
    else if (s.reason === "no_checks") person ??= "accept";
    else if (!s.done) halt ??= { code: "run_paused", detail: run.reason, key };
    else if (autoTakeOnDone(s, run, opts) === "branch") return { kind: "take", runId: run.runId, key };
  }
  // E3 (stage-e-decomposition.md §7): its own decomposition runs, as the runs it started
  if (splits.some((id) => !facts.some((f) => f.runId === id))) return { kind: "wait", why: "run" }; // its journal is not there yet: no second split of the parent
  const sp = ownSplits(board, facts, splits, limited);
  halt ??= sp.halt;
  person ??= sp.person;
  // the merges: one at a time; a paused one waits for the person, the head moved by someone else ends it
  const merges = head?.merges ?? [];
  const merging = merges.some((m) => MERGE_ACTIVE.has(m.status));
  // C3: the paused merge the autopilot hands to an agent is not the person's (one at a time: one paused merge per head)
  const handoff = conflictsOf(budget) === "agent"
    ? merges.find((m) => m.status === "paused" && AGENT_FROM.has(m.reason ?? "") && !m.agent && !m.source && !refused.has(m.runId)) : undefined;
  if (merges.some((m) => m.status === "paused" && m !== handoff)) person ??= "merge";
  // the head moved by someone else: only while that is the latest merge (a later one went on from the new value)
  const moved = merges[0]?.status === "failed" && merges[0].reason === "head_moved" ? merges[0] : undefined;
  if (moved) halt ??= { code: "head_moved", detail: moved.task.key, key: moved.task.key };
  // a «Done» task whose merge failed or was interrupted is not in the result and nothing will merge it: the person
  // decides (§4.3); «Пропустить» is the person's decision already
  for (const t of place) {
    const m = statuses.get(t.id)?.done && !t.archivedAt ? mergeOf(t.id) : undefined;
    if (m && m !== moved && (m.status === "failed" || (m.status === "stopped" && m.reason !== "skipped"))) halt ??= { code: "merge_failed", detail: m.reason, key: t.key };
  }
  const retrying = merges.some((m) => m.retrying);
  // what is «Done», started from this head and not in it yet: the oldest first (reconciliation, §4.5)
  const pending = place.map((t) => ({ t, s: statuses.get(t.id)!, run: facts.find((f) => f.runId === statuses.get(t.id)?.current) }))
    .filter(({ t, s, run }) => s.done && run && head && run.board === head.ref && isCopy(run.workMode) && !mergeOf(t.id)
      && (run.taken?.commit || autoTakeOnDone(s, run, opts) === "branch"))
    .sort((a, b) => a.run!.createdAt - b.run!.createdAt);
  const take = pending.find(({ s, run }) => autoTakeOnDone(s, run, opts) === "branch");
  if (take) return { kind: "take", runId: take.run!.runId, key: take.t.key };
  const ready = pending.find(({ run }) => run!.taken?.commit);
  // a stop takes no new task, but what is «Done» still goes into the head; not onto a head moved by someone else
  if (ready && !merging && !merges.some((m) => m.status === "paused") && !moved) {
    return { kind: "merge", taskId: ready.t.id, key: ready.t.key, runId: ready.run!.runId, commit: ready.run!.taken!.commit! };
  }
  // C4 (§2.1): a provider's limit — after a take and a merge (no model turn in them), before an agent, a start or a stop
  const limits = limitStep(limited, now);
  if (limits) return limits;
  // the slots: every run of the place that is not over (a pause holds its copy and may go on)
  const SLOT = new Set(["created", "preparing", "running", "pausing", "stopping", "paused"]);
  // E3 (§7): every split of the place holds a slot too, the person's as well
  const busy = facts.filter((f) => place.some((t) => t.id === (f.taskId ?? f.decompositionOf)) && (SLOT.has(f.status) || f.permission
    || (f.status === "completed" && statuses.get(f.taskId!)?.reason === "no_checks" && statuses.get(f.taskId!)?.current === f.runId))).length
    // C3: a merge waiting for its resolution run holds a slot (the run is not on the board's facts)
    + merges.filter((m) => m.status === "running" && m.agent?.pending).length;
  if (handoff && !moved) {
    if (used.runs >= budget.runs) return { kind: "merge_wait", mergeRunId: handoff.runId, why: "merge_budget", key: handoff.task.key };
    if (busy < parallelOf(budget)) return { kind: "agent", mergeRunId: handoff.runId, key: handoff.task.key };
    if (handoff.reason !== "merge_waits_slot") return { kind: "merge_wait", mergeRunId: handoff.runId, why: "merge_waits_slot", key: handoff.task.key };
    return { kind: "wait", why: "run" };
  }
  // what goes on by itself: a run at work or waiting for the person's answer — a run paused for another reason (a bad
  // report, an external failure) holds its place but moves only by the person's «Продолжить»: no wait on it (§8)
  const moving = sp.moving || facts.some((f) => place.some((t) => t.id === (f.taskId ?? f.decompositionOf)) && (ACTIVE.has(f.status) || f.permission || (f.status === "paused" && WAIT_PAUSES.has(f.reason ?? ""))));
  const goingOn = moving || merging || (pending.length > 0 && !moved);
  if (halt) return goingOn || person ? { kind: "wait", why: "run" } : { kind: "off", ...halt };
  // a task without a reason, never tried; a dependency counts once it is in the head (owner's decision 9), or its result
  // is in the working folder (it worked there, or was applied) — the head starts from that folder. ponytail: a folder
  // result that came after the head started is not in it; «Начать новый итог доски» takes it in
  // E3 (§7): a parent ready to split goes before the ordinary start: a slot and the budget as for a start
  const split = decomposeCandidate(board, facts, statuses, at, opts);
  if (split && busy < parallelOf(budget) && !retrying) {
    if (used.runs >= budget.runs) return goingOn ? { kind: "wait", why: "run" } : { kind: "off", code: "budget_runs", detail: String(budget.runs), key: null };
    if (used.ms >= budget.minutes * 60_000) return goingOn ? { kind: "wait", why: "run" } : { kind: "off", code: "budget_minutes", detail: String(budget.minutes), key: null };
    return { kind: "decompose", task: split };
  }
  const resultIn = (d: string) => resultOf(facts.find((f) => f.runId === statuses.get(d)?.current)) === "folder";
  const next = place.filter((t) => {
    const s = statuses.get(t.id);
    const held = heldDeps(t, board.tasks); // E2 (§2.2): an archived subtask does not hold its parent
    if (!s || t.archivedAt || t.external || s.column !== "queue" || s.attempts !== 0 || held.some((d) => statuses.get(d)?.depsNote) || notYetSplit(t, s) || parentArchived(t, board.tasks)) return false;
    // F3 (T-6): the branch template cannot name it — with dependencies too, by the task itself (a held task's status may
    // carry another reason); T-13a: with a remote base the statuses say all
    if (opts.issueRequired && !t.issue) return false;
    if (!held.length || opts.remoteBase) return s.reason === null;
    return held.every((d) => !board.tasks.some((x) => x.id === d) || (statuses.get(d)?.done && (inHead(d) || resultIn(d))));
  }).sort((a, b) => a.order - b.order)[0] ?? null;
  // a merge's checks wait to be retried while the project is quiet: no new task meanwhile (§2.3)
  if (next && busy < parallelOf(budget) && !retrying) {
    if (used.runs >= budget.runs) return goingOn ? { kind: "wait", why: "run" } : { kind: "off", code: "budget_runs", detail: String(budget.runs), key: null };
    if (used.ms >= budget.minutes * 60_000) return goingOn ? { kind: "wait", why: "run" } : { kind: "off", code: "budget_minutes", detail: String(budget.minutes), key: null };
    if (opts.remoteBase) return { kind: "start", task: next, base: null };
    if (!head) return { kind: "head" };
    return { kind: "start", task: next, base: { branch: head.ref, commit: head.commit, key: "T-0" } };
  }
  if (goingOn || next || split || person) return { kind: "wait", why: person ?? "run" };
  const idle = idleOf(board, statuses, at);
  if (idle.allDone) return { kind: "off", code: "all_done", detail: null, key: null };
  const external = externalWait(board, statuses, at);
  if (external) return { kind: "wait", why: "external", key: external };
  const detail = idle.waiting.map((w) => (w.waitsFor.length ? `${w.key} (${w.reason}: ${w.waitsFor.join(", ")})` : `${w.key} (${w.reason ?? "-"})`)).join("; ");
  return { kind: "off", code: "others_wait", detail, key: null, waiting: idle.waiting };
}

// F2 (T-3): nothing goes on and nothing waits for the person, and every task of the place left waits — itself or along
// its dependencies — only for external tasks not marked yet: the autopilot waits for the mark (no run, no minutes)
// instead of turning off. The key: the first external task it waits for (its own dependencies «Done»: it can be marked)
export function externalWait(board: Pick<Board, "tasks">, statuses: ReadonlyMap<string, TaskStatus>, at: { workspaceId: string; project: string }): string | null {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const memo = new Map<string, string | null>();
  const waitsOn = (t: BoardTask): string | null => {
    if (memo.has(t.id)) return memo.get(t.id)!;
    memo.set(t.id, null); // a cycle waits for nobody's mark
    const s = statuses.get(t.id);
    const open = heldDeps(t, board.tasks).map((d) => byId.get(d)!).filter((d) => !statuses.get(d.id)?.done);
    let key: string | null = null;
    // an archived task is marked by nobody (task_archived): waiting for it would never end
    if (s && !s.done && !s.cycle && !t.archivedAt) {
      const along = open.map(waitsOn);
      const chain = along.length > 0 && along.every((k) => k !== null) ? along[0] : null;
      if (externalInForce(t, s)) key = open.length ? chain : t.key;
      else if (s.column === "queue" && s.attempts === 0 && (s.reason === "waits_external" || s.reason === "waits_task")) key = chain;
    }
    memo.set(t.id, key);
    return key;
  };
  const left = board.tasks.filter((t) => t.workspaceId === at.workspaceId && t.project === at.project && !t.archivedAt && !statuses.get(t.id)?.done)
    .sort((a, b) => a.order - b.order);
  const keys = left.map(waitsOn);
  return keys.length && keys.every((k) => k !== null) ? keys[0] : null;
}

// C2 (stage-c-parallel.md §4.7): the tasks of a place that may touch the same files — a warning on their cards, never a
// refusal. A task's files: what its current run changed (to its last checkpoint) and the paths its goal, its
// requirements and the lead's plan name. now — two tasks at work (or «Done» and not in the head yet); maybe — a task
// still to start and one at work. Two tasks that both wait to start are not marked: neither has changed anything.
export interface Overlap { key: string; files: string[]; kind: "now" | "maybe" }
// ponytail: a path is a word with a slash or an extension (src/auth.ts, README.md); «e.g.» and versions are not
const PATH_WORD = /(?:^|[\s`'"(<[])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7}|(?:[\w@.-]+\/)+[\w@.-]+)(?=$|[\s`'"),.:;!?>\]])/g;
export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_WORD)) {
    const p = m[1]!.replace(/^\.\//, "").replace(/\/+$/, "");
    const last = p.split("/").at(-1)!;
    // «e.g», «i.e»: a name of one letter before its extension is a word, not a file
    if (/^(?:https?:|www\.)/.test(p) || /^\d/.test(p) || last.length < 3 || (!p.includes("/") && /^[^.]?\./.test(last))) continue;
    out.add(p);
  }
  return [...out];
}
// the same file: equal, or one a path that ends with the other («auth.ts» named, «src/auth.ts» changed)
const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
export function overlapsOf(board: Pick<Board, "tasks">, facts: readonly RunTaskFacts[], statuses: ReadonlyMap<string, TaskStatus>,
  heads: readonly BoardHead[] = []): Map<string, Overlap[]> {
  const out = new Map<string, Overlap[]>();
  const OVER = new Set(["stopped", "failed", "unreadable"]);
  type Side = { t: BoardTask; files: string[]; going: boolean };
  const places = new Map<string, Side[]>();
  for (const t of board.tasks) {
    if (t.archivedAt) continue;
    const s = statuses.get(t.id);
    if (!s) continue;
    const named = namedPaths(`${t.text}\n${t.criteria.join("\n")}`);
    const run = s.current ? facts.find((f) => f.runId === s.current) : undefined;
    let side: Side | null = null;
    const head = heads.find((h) => h.workspaceId === t.workspaceId && h.project === t.project);
    // at work: a run not over; or «Done» in a copy from the head, still to be merged into it (its merge not completed
    // nor skipped). Any other «Done» — in the folder, applied, in an older head, without a head — is the others' base.
    const merge = run && mergeOfTask(head, t.id, run.runId);
    const going = !!run && !run.newer && !OVER.has(run.status) && (run.status !== "completed"
      || (!!head && isCopy(run.workMode) && run.board === head.ref && !run.taken?.applied && (!merge || ["preparing", "running", "paused"].includes(merge.status))));
    if (going) side = { t, files: [...(run!.files ?? []), ...(run!.named ?? []), ...named], going: true };
    else if (!run && s.column === "queue" && !t.external) side = { t, files: named, going: false }; // F2: an external task changes no file
    if (!side?.files.length) continue;
    const k = `${t.workspaceId}\0${t.project}`;
    places.set(k, [...(places.get(k) ?? []), side]);
  }
  const add = (id: string, o: Overlap) => out.set(id, [...(out.get(id) ?? []), o]);
  for (const sides of places.values()) {
    for (const [i, a] of sides.entries()) {
      for (const b of sides.slice(i + 1)) {
        if (!a.going && !b.going) continue;
        const files = [...new Set(a.files.filter((x) => b.files.some((y) => samePath(x, y))))].sort();
        if (!files.length) continue;
        if (a.going && b.going) { add(a.t.id, { key: b.t.key, files, kind: "now" }); add(b.t.id, { key: a.t.key, files, kind: "now" }); }
        else add((a.going ? b : a).t.id, { key: (a.going ? a : b).t.key, files, kind: "maybe" });
      }
    }
  }
  return out;
}
