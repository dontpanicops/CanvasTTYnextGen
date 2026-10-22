// The task board's file: <userData>/orchestration/board.json (stage-b-board.md §3). It holds only what the person
// set — tasks, their order and dependencies, and the person's decisions: an accepted result («Принять результат»,
// accepted) and an external task's mark «Выполнено» (F2, externalDone) — never a status. A decision is not a status: the
// status is worked out from it and the runs by boardStatuses (principle 8), and no edit of this file makes «Done —
// confirmed by checks». Written atomically (tmp + rename)
// through one queue; a damaged file is set aside and the board starts empty (runs keep their link to tasks in their
// goals); a file of a newer version is never written: the board is read only. Builds up to 1.5.13 neither read nor
// write this file, so a rollback keeps it as it is (canvas.json would not: 1.5.12 writes back only the keys it knows).
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { BOARD_VERSION, SPLIT_TEXT_MAX, subtaskText, type AutopilotBudget, type Board, type BoardExternalDone, type BoardPlace, type BoardTask, type BoardTaskInput, type BoardTaskOrigin, type BoardTaskPatch, type TaskModels } from "../../../shared/taskBoard.ts";
import { SAFE_MODEL } from "./providers.ts";

class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new Refusal(code, message); };

export const REF = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^T-(\d{1,6})$/;
const MAX_TASKS = 2000;
const empty = (): Board => ({ v: BOARD_VERSION, tasks: [], counters: {} });
const text = (v: unknown, max: number) => typeof v === "string" && v.trim() !== "" && v.length <= max && !v.includes("\0");
const coord = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isPlace = (p: unknown): p is BoardPlace => {
  const o = p as { position?: { x?: unknown; y?: unknown }; size?: { width?: unknown; height?: unknown } } | null;
  return !!o && coord(o.position?.x, -1e7, 1e7) && coord(o.position?.y, -1e7, 1e7) && coord(o.size?.width, 1, 1e5) && coord(o.size?.height, 1, 1e5);
};
const COVER = /^R([1-9]|[12]\d|3[0-2])$/;
const time = (v: unknown) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

// F1 (stage-f-external-projects.md §5.1): ref and origin are checked softly — a bad one is dropped, never the board
const isOrigin = (o: Partial<BoardTaskOrigin> | null): boolean => !!o && typeof o === "object" && o.kind === "import"
  && (o.source === null || (typeof o.source === "string" && o.source.length <= 300)) && typeof o.file === "string" && o.file.length >= 1 && o.file.length <= 255
  && typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256);
// F2 (T-3, T-4): external, externalDone and models — softly too
const ROLES = ["lead", "executor", "reviewer"];
export const isModels = (m: unknown): m is TaskModels => !!m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).length > 0
  && Object.entries(m).every(([k, v]) => ROLES.includes(k) && typeof v === "string" && SAFE_MODEL.test(v));
export const NOTE_MAX = 300;
const isMark = (d: Partial<BoardExternalDone> | null): boolean => !!d && typeof d === "object" && time(d.at) && d.by === "person"
  && (d.note === null || (typeof d.note === "string" && d.note.length <= NOTE_MAX));
const soft = (t: unknown): unknown => {
  if (!t || typeof t !== "object") return t;
  const { ref, origin, external, externalDone, models, ...rest } = t as Record<string, unknown>;
  return { ...rest, ...(typeof ref === "string" && REF.test(ref) ? { ref } : {}), ...(isOrigin(origin as BoardTaskOrigin) ? { origin } : {}),
    ...(external === true ? { external } : {}), ...(external === true && isMark(externalDone as BoardExternalDone) ? { externalDone } : {}), ...(isModels(models) ? { models } : {}) };
};

function isTask(t: unknown): t is BoardTask {
  const o = t as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  const acc = o.accepted as Record<string, unknown> | null;
  return typeof o.id === "string" && UUID.test(o.id) && typeof o.key === "string" && KEY.test(o.key)
    && typeof o.workspaceId === "string" && WORKSPACE_ID.test(o.workspaceId) && typeof o.project === "string" && isAbsolute(o.project)
    && text(o.title, 200) && text(o.text, 8000) && Array.isArray(o.criteria) && o.criteria.length >= 1 && o.criteria.length <= 32
    && o.criteria.every((c) => text(c, 500)) && Array.isArray(o.dependsOn) && o.dependsOn.every((d) => typeof d === "string" && UUID.test(d))
    && typeof o.order === "number" && Number.isFinite(o.order) && time(o.createdAt) && time(o.updatedAt)
    && (o.archivedAt === null || time(o.archivedAt))
    && (acc === null || (typeof acc === "object" && typeof acc.runId === "string" && UUID.test(acc.runId) && time(acc.at)))
    // E2 (stage-e-decomposition.md §2): absent, or well formed. A parentId with a decompose is not refused here: a hand
    // edit never sets the board aside (it is refused when a task is made or changed)
    && (o.decompose === undefined || o.decompose === true) && (o.decomposedBy === undefined || (typeof o.decomposedBy === "string" && UUID.test(o.decomposedBy)))
    && (o.parentId === undefined || (typeof o.parentId === "string" && UUID.test(o.parentId)))
    && (o.covers === undefined || (Array.isArray(o.covers) && o.covers.length >= 1 && o.covers.length <= 32 && o.covers.every((c) => typeof c === "string" && COVER.test(c))));
}

const isBudget = (p: unknown): p is AutopilotBudget => {
  const b = p as AutopilotBudget | null;
  return !!b && typeof b === "object" && Number.isInteger(b.runs) && b.runs >= 1 && b.runs <= 100 && Number.isInteger(b.minutes) && b.minutes >= 1 && b.minutes <= 1440
    && (b.parallel === undefined || (Number.isInteger(b.parallel) && b.parallel >= 1 && b.parallel <= 4))
    && (b.conflicts === undefined || b.conflicts === "agent" || b.conflicts === "person");
};

export type TaskInput = BoardTaskInput;
// F2: the keys of the direct dependents of t that have begun (a run, one being made, a split, a mark of their own)
export type Begun = (b: Board, t: BoardTask) => Promise<string[]>;

// E2 (stage-e-decomposition.md §5): what the creation of subtasks takes from the decomposition run: the proposal's tasks,
// the number of the requirements of the run's goal and its language
export interface SplitTask { id: string; title: string; text: string; criteria: string[]; dependsOn: string[]; covers: string[] }
export interface SplitPlan { criteria: number; language: "ru" | "en"; tasks: SplitTask[] }

// F1 (stage-f-external-projects.md §5.2): one board-tasks/v1 file, read and checked on its own (boardImport.ts). A row
// refused there carries its refusal: its dependents are refused with it
// fields (F2): external and models of the row, as they are to be stored (absent: taken off an existing task)
export interface ImportRow { ref: string | null; input: TaskInput | null; deps: string[]; ifAbsent: boolean; refused?: { code: string; detail: string }; fields?: ImportFields }
export interface ImportFields { external?: true; models?: TaskModels }
export interface ImportJob { workspaceId: string; origin: BoardTaskOrigin; rows: ImportRow[] }
export interface ImportRows {
  created: { ref: string; key: string }[]; updated: { ref: string; key: string }[]; unchanged: string[];
  refused: { ref: string | null; code: string; detail: string }[];
}
// the fields of F2–F4: a file without one takes it off an existing task (§5.2: the file is the source of truth)
const LATER_FIELDS: readonly string[] = ["external", "models", "issue", "commitTitle", "scope"];

export interface BoardRead { board: Board; readOnly: null | "newer_version" | "damaged_unmoved"; }

// usedKeys(workspaceId): the largest n of the T-<n> the runs of that workspace name in their goals. A new number is
// above it as well as above the file's counter, so a number is not given twice even after the file was lost.
export function createBoardStore(file: string, usedKeys: (workspaceId: string) => Promise<number> = async () => 0) {
  let cache: BoardRead | null = null;
  let first: Promise<BoardRead> | null = null; // the first read, shared: two loads at once would race the cache
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<BoardRead> {
    if (cache) return cache;
    first ??= readBoard().catch((e) => { first = null; throw e; }); // a read that failed is asked again next time
    const r = await first;
    cache ??= r; // a save after the first read has set it already
    return cache;
  }

  async function readBoard(): Promise<BoardRead> {
    // a write cut short leaves its tmp file next to the board: the board itself is the old or the new one, whole
    const dir = dirname(file);
    for (const n of await readdir(dir).catch(() => [] as string[])) {
      if (n.startsWith(`${basename(file)}.`) && n.endsWith(".tmp")) await rm(join(dir, n), { force: true }).catch(() => {});
    }
    const raw = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (raw === null) return { board: empty(), readOnly: null };
    let v: { v?: unknown; tasks?: unknown; counters?: unknown; places?: unknown; autopilot?: unknown } | null = null;
    try { v = JSON.parse(raw); } catch { v = null; }
    if (v && typeof v.v === "number" && v.v > BOARD_VERSION) {
      // a newer version's board: shown as far as its tasks read, never written
      const tasks = Array.isArray(v.tasks) ? v.tasks.map(soft).filter(isTask) : [];
      return { board: { v: BOARD_VERSION, tasks, counters: {} }, readOnly: "newer_version" };
    }
    const counters = v?.counters && typeof v.counters === "object" && !Array.isArray(v.counters)
      ? Object.fromEntries(Object.entries(v.counters as Record<string, unknown>).filter(([k, n]) => WORKSPACE_ID.test(k) && Number.isSafeInteger(n) && (n as number) >= 0)) as Record<string, number>
      : null;
    // a task written by hand without accepted or archivedAt has neither (never half a board: one bad task sets it aside)
    const tasks = Array.isArray(v?.tasks) ? v.tasks.map((t) => (t && typeof t === "object" ? soft({ accepted: null, archivedAt: null, ...t }) : t)) : null;
    if (v?.v === BOARD_VERSION && tasks?.every(isTask) && counters) {
      // a place that does not read is dropped (the card shows again where the person puts it); the tasks never are
      const places = v.places && typeof v.places === "object" && !Array.isArray(v.places)
        ? Object.fromEntries(Object.entries(v.places as Record<string, unknown>).filter(([k, p]) => WORKSPACE_ID.test(k) && isPlace(p))) as Record<string, BoardPlace>
        : {};
      // a budget that does not read is dropped (the default holds)
      const autopilot = v.autopilot && typeof v.autopilot === "object" && !Array.isArray(v.autopilot)
        ? Object.fromEntries(Object.entries(v.autopilot as Record<string, unknown>).filter(([k, p]) => UUID.test(k) && isBudget(p))) as Record<string, AutopilotBudget>
        : {};
      return { board: { v: BOARD_VERSION, tasks: tasks as BoardTask[], counters, ...(Object.keys(places).length ? { places } : {}), ...(Object.keys(autopilot).length ? { autopilot } : {}) }, readOnly: null };
    }
    // damaged: set aside whole (nothing is dropped from it), the board starts empty
    const aside = `${file}.damaged-${randomUUID()}`;
    const moved = await rename(file, aside).then(() => true, () => false);
    return { board: empty(), readOnly: moved ? null : "damaged_unmoved" };
  }

  // The cache follows the file: a failed write leaves both as they were and the caller gets store_failed.
  async function save(next: Board): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      refuse("store_failed", `the board could not be saved: ${(error as NodeJS.ErrnoException)?.code ?? "error"}`);
    }
    cache = { board: next, readOnly: null };
  }

  const writable = (r: BoardRead) => {
    if (r.readOnly === "newer_version") refuse("board_newer_version", "the board was written by a newer version of Raoden Loom: read only");
    if (r.readOnly) refuse("board_unavailable", "the damaged board could not be set aside: read only");
  };
  function change<T>(fn: (b: Board) => Promise<{ next: Board | null; value: T }>): Promise<T> {
    const run = queue.then(async () => {
      const r = await load();
      writable(r);
      const { next, value } = await fn(r.board);
      if (next) await save(next);
      return value;
    });
    queue = run.catch(() => {});
    return run;
  }

  const checkInput = (b: Board, input: TaskInput, self: string | null): Required<Omit<TaskInput, "decompose">> => {
    if (typeof input?.workspaceId !== "string" || !WORKSPACE_ID.test(input.workspaceId)) refuse("invalid_task", "workspaceId");
    if (typeof input.project !== "string" || !isAbsolute(input.project)) refuse("invalid_task", "project must be an absolute path");
    if (!text(input.title, 200)) refuse("invalid_task", "title: 1..200 characters");
    if (!text(input.text, 8000)) refuse("invalid_task", "text: 1..8000 characters");
    if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 32 || !input.criteria.every((c) => text(c, 500))) {
      refuse("invalid_task", "criteria: 1..32 lines of 1..500 characters");
    }
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    for (const d of dependsOn) {
      const dep = b.tasks.find((t) => t.id === d);
      if (!dep || dep.workspaceId !== input.workspaceId || d === self) refuse("invalid_task", `dependsOn: ${d} is not a task of this workspace`);
    }
    if (self && reaches(b, dependsOn, self)) refuse("task_cycle", "the dependencies would make a cycle");
    const { decompose: _mark, ...rest } = input; // E2: the mark is the caller's: stored as true or not at all
    return { ...rest, criteria: [...input.criteria], dependsOn };
  };
  const subtasksOf = (b: Board, id: string) => b.tasks.filter((x) => x.parentId === id && !x.archivedAt);
  // E2 (§6): a marked task leaves 400 characters for the closing run's paragraph
  const markOk = (text: string) => { if (text.length > SPLIT_TEXT_MAX) refuse("text_too_long", `to be split, the text is up to ${SPLIT_TEXT_MAX} characters`); };
  // F2: the keys of t's direct dependents (of its workspace) that have begun — the caller's facts (manager: a run, one
  // being made, a split, a mark); without them only what the board itself says (a mark) and the runs started names
  const begunByBoard = (started: ReadonlySet<string> = new Set()): Begun => async (b, t) =>
    b.tasks.filter((x) => x.dependsOn.includes(t.id) && x.workspaceId === t.workspaceId && (started.has(x.id) || !!x.externalDone)).map((x) => x.key);
  // F2 (§14 «F2», proposed by the implementer, for the owner to confirm): the mark «Выполнено» goes when a dependency is
  // added (a new id in the set) — refused while a direct dependent has begun; a narrower or the same set keeps it
  const added = (t: BoardTask, dependsOn: readonly string[]): boolean => dependsOn.some((d) => !t.dependsOn.includes(d));
  async function markGoes(b: Board, t: BoardTask, dependsOn: readonly string[], begun: Begun): Promise<boolean> {
    if (!t.externalDone || !added(t, dependsOn)) return false;
    const keys = await begun(b, t);
    if (keys.length) refuse("dependents_started", `${keys.join(", ")} began after ${t.key} was marked: a new dependency would take the mark off`);
    return true;
  }

  // F1 (§5.2): what one file would make of the board: every row created, updated, unchanged or refused
  async function planImport(b: Board, job: ImportJob, started: ReadonlySet<string>, begun: Begun = begunByBoard(started)): Promise<{ rows: ImportRows; next: Board | null }> {
    const ws = job.workspaceId;
    const mine = b.tasks.filter((t) => t.workspaceId === ws);
    const onBoard = new Map<string, BoardTask[]>();
    for (const t of mine) if (t.ref) onBoard.set(t.ref, [...(onBoard.get(t.ref) ?? []), t]);
    const refusal = new Map<number, { code: string; detail: string }>();
    const inFile = new Map<string, number>();
    job.rows.forEach((r, i) => {
      if (r.refused) refusal.set(i, r.refused);
      if (r.ref) inFile.set(r.ref, i);
    });
    // the id each row's task has (or will have): a dependency names it before it is made
    const ids = job.rows.map((r) => (r.ref && onBoard.get(r.ref)?.length === 1 ? onBoard.get(r.ref)![0].id : randomUUID()));
    const idOf = (ref: string) => (inFile.has(ref) ? ids[inFile.get(ref)!] : onBoard.get(ref)?.[0]?.id ?? null);
    const kind = new Map<number, "create" | "update" | "unchanged">();
    const classify = async (r: ImportRow, i: number): Promise<void> => {
      if (refusal.has(i)) return;
      const no = (code: string, detail: string) => { refusal.set(i, { code, detail }); };
      const input = r.input!;
      try { checkInput(b, { ...input, workspaceId: ws, dependsOn: [] }, null); } catch (e) { return no((e as Refusal).code ?? "invalid_task", String((e as Error).message)); }
      const missing = r.deps.find((d) => idOf(d) === null);
      if (missing) return no("unknown_dependency", `dependsOn: no task ${missing} in the file or the workspace`);
      const same = onBoard.get(r.ref!) ?? [];
      if (same.length > 1) return no("duplicate_ref", `${same.map((t) => t.key).join(", ")} have the ref ${r.ref}`);
      const t = same[0];
      if (!t) return void kind.set(i, "create");
      if (t.archivedAt) return no("task_archived", `${t.key} is archived`);
      if (r.ifAbsent) return void kind.set(i, "unchanged");
      if (t.project !== input.project) return no("project_changed", `${t.key} is of ${t.project}`);
      const deps = new Set(r.deps.map(idOf));
      // an external task without criteria in the file carries Loom's one line (readTasksFile): the same as on the board
      const later = r.fields ?? {};
      const equal = t.title === input.title && t.text === input.text && t.criteria.length === input.criteria.length && t.criteria.every((c, k) => c === input.criteria[k])
        && deps.size === new Set(t.dependsOn).size && t.dependsOn.every((d) => deps.has(d))
        && LATER_FIELDS.every((f) => JSON.stringify(sorted((t as unknown as Record<string, unknown>)[f])) === JSON.stringify(sorted((later as Record<string, unknown>)[f])));
      if (equal) return void kind.set(i, "unchanged");
      if (started.has(t.id)) return no("task_started", `${t.key} has runs`);
      if (t.decompose || t.decomposedBy || subtasksOf(b, t.id).length) return no("task_split", `${t.key} is marked or split into subtasks`);
      if (r.fields?.external) {
        try { await markGoes(b, t, [...deps] as string[], begun); } catch (e) { return no((e as Refusal).code ?? "dependents_started", String((e as Error).message)); }
      }
      kind.set(i, "update");
    };
    for (const [i, r] of job.rows.entries()) await classify(r, i);
    // a refusal takes its dependents with it; a cycle refuses every task on it — until nothing more is refused
    const at = new Date().toISOString();
    let tasks: BoardTask[] = b.tasks;
    const made = new Map<string, BoardTask>();
    for (;;) {
      let more = false;
      job.rows.forEach((r, i) => {
        const dep = kind.has(i) ? r.deps.find((d) => inFile.has(d) && refusal.has(inFile.get(d)!)) : undefined;
        if (dep) { kind.delete(i); refusal.set(i, { code: "dependency_refused", detail: `dependsOn: ${dep} is refused` }); more = true; }
      });
      if (more) continue;
      made.clear();
      let order = Math.max(0, ...mine.map((t) => t.order));
      job.rows.forEach((r, i) => {
        const k = kind.get(i);
        if (k !== "create" && k !== "update") return;
        const input = r.input!;
        const own = { title: input.title, text: input.text, criteria: [...input.criteria], dependsOn: r.deps.map((d) => idOf(d)!), origin: job.origin,
          ...(r.fields?.external ? { external: true as const } : {}), ...(r.fields?.models ? { models: { ...r.fields.models } } : {}) };
        if (k === "create") {
          made.set(ids[i], { id: ids[i], key: "", workspaceId: ws, project: input.project, ...own, order: ++order, createdAt: at, updatedAt: at, archivedAt: null, accepted: null, ref: r.ref! });
          return;
        }
        const t = onBoard.get(r.ref!)![0];
        // the person's mark goes with the external task: a file that makes it an ordinary one takes the mark off too,
        // and so does an added dependency (markGoes; a row with begun dependents was refused above)
        const kept = Object.fromEntries(Object.entries(t).filter(([f]) => !LATER_FIELDS.includes(f) && (f !== "externalDone" || (r.fields?.external && !added(t, own.dependsOn))))) as unknown as BoardTask;
        made.set(t.id, { ...kept, ...own, updatedAt: at });
      });
      tasks = [...b.tasks.map((t) => made.get(t.id) ?? t), ...[...made.values()].filter((t) => t.key === "")];
      const next = { ...b, tasks };
      for (const [i, k] of kind) {
        if (k !== "unchanged" && reaches(next, made.get(ids[i])!.dependsOn, ids[i])) { refusal.set(i, { code: "task_cycle", detail: "the dependencies make a cycle" }); kind.delete(i); more = true; }
      }
      if (!more) break;
    }
    // the numbers of the new tasks, in the file's order
    const fresh = job.rows.map((_, i) => i).filter((i) => kind.get(i) === "create");
    if (b.tasks.length + fresh.length > MAX_TASKS) refuse("too_many_tasks", `at most ${MAX_TASKS} tasks`);
    const counted = Math.max(b.counters[ws] ?? 0, ...mine.map((t) => Number(KEY.exec(t.key)![1])));
    const first = fresh.length ? Math.max(counted, await usedKeys(ws)) + 1 : counted + 1;
    if (first + fresh.length - 1 > 999_999) refuse("too_many_tasks", "task numbers end at T-999999 in this workspace");
    const keys = new Map(fresh.map((i, k) => [ids[i], `T-${first + k}`]));
    tasks = tasks.map((t) => (keys.has(t.id) ? { ...t, key: keys.get(t.id)! } : t));
    const rows: ImportRows = { created: [], updated: [], unchanged: [], refused: [] };
    job.rows.forEach((r, i) => {
      const k = kind.get(i);
      if (k === "create") rows.created.push({ ref: r.ref!, key: keys.get(ids[i])! });
      else if (k === "update") rows.updated.push({ ref: r.ref!, key: onBoard.get(r.ref!)![0].key });
      else if (k === "unchanged") rows.unchanged.push(r.ref!);
      else { const f = refusal.get(i)!; rows.refused.push({ ref: r.ref, code: f.code, detail: f.detail.slice(0, 400) }); }
    });
    if (!rows.created.length && !rows.updated.length) return { rows, next: null };
    return { rows, next: { ...b, tasks, counters: fresh.length ? { ...b.counters, [ws]: first + fresh.length - 1 } : b.counters } };
  }

  return {
    read: async (): Promise<BoardRead> => { await queue; return load(); },
    // The board as last saved, without waiting for the queue: for a check made inside another store's queue (a start
    // on a link holds the canvas queue; a change here may wait for the canvas — waiting both ways would never end).
    peek: (): Promise<BoardRead> => load(),

    create: (input: TaskInput) => change(async (b) => {
      if (b.tasks.length >= MAX_TASKS) refuse("too_many_tasks", `at most ${MAX_TASKS} tasks`);
      const ok = checkInput(b, input, null);
      const inFile = Math.max(b.counters[ok.workspaceId] ?? 0, ...b.tasks.filter((t) => t.workspaceId === ok.workspaceId).map((t) => Number(KEY.exec(t.key)![1])));
      const n = Math.max(inFile, await usedKeys(ok.workspaceId)) + 1;
      if (n > 999_999) refuse("too_many_tasks", "task numbers end at T-999999 in this workspace");
      const at = new Date().toISOString();
      const order = Math.max(0, ...b.tasks.filter((t) => t.workspaceId === ok.workspaceId).map((t) => t.order)) + 1;
      if (input.decompose === true) markOk(ok.text);
      const task: BoardTask = { id: randomUUID(), key: `T-${n}`, ...ok, order, createdAt: at, updatedAt: at, archivedAt: null, accepted: null, ...(input.decompose === true ? { decompose: true as const } : {}) };
      return { next: { ...b, tasks: [...b.tasks, task], counters: { ...b.counters, [ok.workspaceId]: n } }, value: task };
    }),

    // A task's text and requirements may change after runs (decision 4): the runs keep their own goal.
    // begun: t's begun direct dependents, asked inside the queue (manager: its facts; F2, markGoes)
    update: (id: string, patch: BoardTaskPatch, begun: Begun = begunByBoard()) => change(async (b) => {
      const t = b.tasks.find((x) => x.id === id) ?? refuse("task_not_found", `no task ${id}`);
      // a cycle is checked when the dependencies change: a task on a hand-made cycle can still be renamed (the form
      // sends its dependencies each time: the same set is no change)
      const same = patch.dependsOn === undefined || (new Set(patch.dependsOn).size === new Set(t.dependsOn).size && patch.dependsOn.every((d) => t.dependsOn.includes(d)));
      const ok = checkInput(b, { ...t, ...patch }, same ? null : id);
      if (patch.order !== undefined && !Number.isFinite(patch.order)) refuse("invalid_task", "order");
      // E2: «Split» on — a subtask has none, the text leaves room; off («Do it whole») — only without live subtasks
      let mark: Pick<BoardTask, "decompose" | "decomposedBy"> = { ...(t.decompose ? { decompose: true as const } : {}), ...(t.decomposedBy ? { decomposedBy: t.decomposedBy } : {}) };
      if (patch.decompose === true) {
        if (t.parentId) refuse("invalid_task", "a subtask is not split again");
        if (t.external) refuse("external_task", "an external task is not split: the person marks it «Done»");
        mark = { ...mark, decompose: true };
      } else if (patch.decompose === false) {
        if (subtasksOf(b, id).length) refuse("has_subtasks", "the task has subtasks");
        mark = {};
      }
      if (mark.decompose && (patch.text !== undefined || patch.decompose === true)) markOk(ok.text);
      const bare = <T extends object>(o: T): Omit<T, "decompose" | "decomposedBy"> => { const { decompose: _d, decomposedBy: _by, ...r } = o as T & Partial<Pick<BoardTask, "decompose" | "decomposedBy">>; return r; }; // ok carries t's own marks
      // F2: the mark «Выполнено» was given for the dependencies as they were — one added takes it off (markGoes)
      const own: Partial<BoardTask> = { ...bare(t), ...bare(ok) };
      if (await markGoes(b, t, ok.dependsOn, begun)) delete own.externalDone;
      const next: BoardTask = { ...(own as BoardTask), ...mark, ...(patch.order !== undefined ? { order: patch.order } : {}), updatedAt: new Date().toISOString() };
      return { next: { ...b, tasks: b.tasks.map((x) => (x.id === id ? next : x)) }, value: next };
    }),

    // starting(id): a run of the task is being created — it is not archived under that run (§3.3)
    archive: (id: string, archived: boolean, starting: () => boolean = () => false) => change(async (b) => {
      const t = b.tasks.find((x) => x.id === id) ?? refuse("task_not_found", `no task ${id}`);
      if (archived && starting()) refuse("task_starting", "a run of the task is being started");
      const next = { ...t, archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
      return { next: { ...b, tasks: b.tasks.map((x) => (x.id === id ? next : x)) }, value: next };
    }),

    // Only a task without runs is deleted (one with runs is archived); its dependents lose it openly (§4.2): dependents
    // are the ids the person saw in the confirmation, and a dependent they did not see refuses the deletion.
    // hasRuns is asked inside the queue: a run created after the question finds the task gone (manager taskOk)
    remove: (id: string, hasRuns: () => Promise<boolean>, dependents: readonly string[] = []) => change(async (b) => {
      if (!b.tasks.some((x) => x.id === id)) refuse("task_not_found", `no task ${id}`);
      if (await hasRuns()) refuse("task_has_runs", "a task with runs is archived, not deleted");
      // only the dependents of its workspace (the board shows those; another workspace's can only be a hand edit)
      const self = b.tasks.find((x) => x.id === id)!;
      const unseen = b.tasks.filter((x) => x.dependsOn.includes(id) && x.workspaceId === self.workspaceId && !dependents.includes(x.id));
      if (unseen.length) refuse("task_has_dependents", `${unseen.map((x) => x.key).join(", ")} depend on it: confirm to remove the link`);
      const tasks = b.tasks.filter((x) => x.id !== id).map((x) => (x.dependsOn.includes(id) ? { ...x, dependsOn: x.dependsOn.filter((d) => d !== id) } : x));
      return { next: { ...b, tasks }, value: null };
    }),

    // E2 (stage-e-decomposition.md §5, §5.1): the subtasks of a parent, made by the decomposition run `runId` in ONE write —
    // the subtasks, the parent's new dependsOn and its decomposedBy. The same run twice: nothing (what the person deleted
    // does not come back). A refusal's code is the detail of §5.1.
    split: (parentId: string, runId: string, plan: SplitPlan) => change(async (b): Promise<{ next: Board | null; value: { created: false } | { created: true; keys: string[] } }> => {
      const p = b.tasks.find((x) => x.id === parentId);
      if (!p) return refuse("parent_gone", "the task is gone");
      if (p.decomposedBy === runId) return { next: null, value: { created: false } };
      if (p.archivedAt) refuse("parent_gone", "the task is archived");
      if (subtasksOf(b, parentId).length) refuse("has_subtasks", "the task has subtasks");
      if (!p.decompose) refuse("not_marked", "«Split» was unmarked");
      if (p.criteria.length !== plan.criteria) refuse("requirements_changed", "the requirements changed during the split");
      if (b.tasks.length + plan.tasks.length > MAX_TASKS) refuse("too_many_tasks", `at most ${MAX_TASKS} tasks`);
      const inFile = Math.max(b.counters[p.workspaceId] ?? 0, ...b.tasks.filter((t) => t.workspaceId === p.workspaceId).map((t) => Number(KEY.exec(t.key)![1])));
      const first = Math.max(inFile, await usedKeys(p.workspaceId)) + 1;
      if (first + plan.tasks.length - 1 > 999_999) refuse("too_many_tasks", "task numbers end at T-999999 in this workspace");
      // the place in the queue: between the parent and the next task of its workspace, in the proposal's order
      const after = b.tasks.filter((t) => t.workspaceId === p.workspaceId && t.order > p.order).map((t) => t.order);
      const gap = (after.length ? Math.min(...after) : p.order + 1) - p.order;
      const at = new Date().toISOString();
      const ids = new Map(plan.tasks.map((t) => [t.id, randomUUID()]));
      const k = plan.tasks.length;
      const made: BoardTask[] = plan.tasks.map((t, i) => ({
        id: ids.get(t.id)!, key: `T-${first + i}`, workspaceId: p.workspaceId, project: p.project, title: t.title,
        text: subtaskText(t.text, p, t.covers, plan.language), criteria: [...t.criteria],
        // a subtask without dependencies in the proposal goes on from where the parent would have
        dependsOn: t.dependsOn.length ? t.dependsOn.map((d) => ids.get(d)!) : [...p.dependsOn],
        order: p.order + ((i + 1) / (k + 1)) * gap, createdAt: at, updatedAt: at, archivedAt: null, accepted: null, parentId: p.id, covers: [...t.covers]
      }));
      const parent: BoardTask = { ...p, dependsOn: [...p.dependsOn, ...made.map((t) => t.id)], decomposedBy: runId, updatedAt: at };
      return { next: { ...b, tasks: [...b.tasks.map((x) => (x.id === parentId ? parent : x)), ...made], counters: { ...b.counters, [p.workspaceId]: first + k - 1 } },
        value: { created: true, keys: made.map((t) => t.key) } };
    }),

    // F1 (§5.2, §5.4): the tasks of one file in ONE write. accept(rows) is asked inside the queue, against the board as
    // it is then: false — nothing is written (what the person was shown is not what would be written). Without accept
    // it is only the check. started(): the tasks with runs (or a run being created). accepted: the rows were written
    // (all unchanged: nothing to write)
    importTasks: async (job: ImportJob, started: () => Promise<ReadonlySet<string>>, accept: ((rows: ImportRows) => boolean) | null, begun?: Begun): Promise<{ rows: ImportRows; accepted: boolean }> => {
      if (!accept) {
        await queue;
        const r = await load();
        writable(r);
        return { rows: (await planImport(r.board, job, await started(), begun)).rows, accepted: false };
      }
      return change(async (b) => {
        const { rows, next } = await planImport(b, job, await started(), begun);
        const accepted = accept(rows);
        return { next: accepted ? next : null, value: { rows, accepted } };
      });
    },

    // B2: the board card's place on a workspace's canvas; null: off that canvas (the tasks stay)
    place: (workspaceId: string, bounds: BoardPlace | null) => change(async (b) => {
      if (!WORKSPACE_ID.test(workspaceId)) refuse("invalid_task", "workspaceId");
      if (bounds !== null && !isPlace(bounds)) refuse("invalid_task", "bounds");
      const { [workspaceId]: _, ...rest } = b.places ?? {};
      const places = bounds ? { ...rest, [workspaceId]: { position: { ...bounds.position }, size: { ...bounds.size } } } : rest;
      return { next: { ...b, places }, value: null };
    }),

    // B4: the budget of a link's autopilot (null: back to the default)
    budget: (linkId: string, budget: AutopilotBudget | null) => change(async (b) => {
      if (!UUID.test(linkId)) refuse("invalid_task", "linkId");
      if (budget !== null && !isBudget(budget)) refuse("invalid_task", "budget: runs 1..100, minutes 1..1440, parallel 1..4");
      const { [linkId]: _, ...rest } = b.autopilot ?? {};
      // C1 (§5.1): the parallelism goes with the budget; 1.5.15–1.5.16 write runs and minutes only (back to the default)
      // C3: «Конфликты» too (1.5.15–1.5.19 drop it the same way: back to «to an agent»)
      const autopilot = budget ? { ...rest, [linkId]: { runs: budget.runs, minutes: budget.minutes, ...(budget.parallel !== undefined ? { parallel: budget.parallel } : {}),
        ...(budget.conflicts !== undefined ? { conflicts: budget.conflicts } : {}) } } : rest;
      return { next: { ...b, autopilot }, value: null };
    }),

    // F2 (T-3, §5.6): «Выполнено» (done, with an optional note) and «Снять отметку» of an external task — the person's
    // decision. check(b): the caller's rules against the board as it is in the queue (its own dependencies «Done»,
    // the dependents not started), the runs read inside the queue too (as remove's hasRuns); it throws its refusal
    markExternal: (id: string, done: boolean, note: string | null, check: (b: Board, t: BoardTask) => Promise<void>) => change(async (b) => {
      const t = b.tasks.find((x) => x.id === id) ?? refuse("task_not_found", `no task ${id}`);
      if (t.archivedAt) refuse("task_archived", "the task is archived");
      if (!t.external) refuse("invalid_task", "the task is not external");
      if (note !== null && (typeof note !== "string" || note.length > NOTE_MAX || note.includes("\0"))) refuse("invalid_task", `note: up to ${NOTE_MAX} characters`);
      if (!done && !t.externalDone) return { next: null, value: t };
      await check(b, t);
      const at = new Date().toISOString();
      const { externalDone: _was, ...rest } = t;
      const next: BoardTask = { ...rest, ...(done ? { externalDone: { at, by: "person" as const, note: note?.trim() ? note : null } } : {}), updatedAt: at };
      return { next: { ...b, tasks: b.tasks.map((x) => (x.id === id ? next : x)) }, value: next };
    }),

    // «Accept the result»: the caller has checked that runId is the task's latest run, completed without checks.
    accept: (id: string, runId: string) => change(async (b) => {
      const t = b.tasks.find((x) => x.id === id) ?? refuse("task_not_found", `no task ${id}`);
      if (!UUID.test(runId)) refuse("invalid_task", "runId");
      if (t.accepted?.runId === runId) return { next: null, value: t };
      const next = { ...t, accepted: { runId, at: new Date().toISOString() }, updatedAt: new Date().toISOString() };
      return { next: { ...b, tasks: b.tasks.map((x) => (x.id === id ? next : x)) }, value: next };
    })
  };
}

// a value with its object keys in order, for the comparison of a field (models)
const sorted = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

// Would `self` be reached from `from` along the dependencies?
function reaches(b: Board, from: readonly string[], self: string): boolean {
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === self) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(b.tasks.find((t) => t.id === id)?.dependsOn ?? []));
  }
  return false;
}
