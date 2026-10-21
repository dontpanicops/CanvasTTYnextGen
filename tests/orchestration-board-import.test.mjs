// F1, T-1 and T-10 (docs/agent-orchestration/implementation/stage-f-external-projects.md §5.1–§5.4): a board-tasks/v1
// file into the board — every row checked on its own, the valid ones in one store write, the refusals by code, upsert
// by (workspaceId, ref), ifAbsent, the file as the source of truth, ref and origin kept by every write, the report
// board-tasks-report/v1, and «Import» that writes only what was shown. No CLI, no model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import { readTasksFile, sha256 } from "../src/main/services/orchestration/boardImport.ts";
import { createRunManager } from "../src/main/services/orchestration/manager.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-f1-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const repo = () => {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  execFileSync(GIT, ["init", "-q", dir], { env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: "1" } });
  return dir;
};
const P = repo();
const P2 = repo();
const WS = "ws-acme";
const WORKSPACES = { open: (id) => id === WS, named: (title) => (title === "acme" ? [WS] : []) };
const store = () => {
  const file = path.join(TMP, `board-${++n}.json`);
  return { file, s: createBoardStore(file), json: () => JSON.parse(fs.readFileSync(file, "utf8")) };
};
const row = (ref, over = {}) => ({ ref, project: P, title: `Задача ${ref}`, text: `Сделать ${ref}`, criteria: [`${ref} готово`], ...over });
const bytes = (tasks, over = {}) => Buffer.from(JSON.stringify({ format: "board-tasks/v1", workspace: "acme", tasks, ...over }));
// a file through the store: write (accept everything) or only check
async function imp(st, tasks, { started = new Set(), write = true, over = {} } = {}) {
  const r = await readTasksFile("tasks.json", bytes(tasks, over), WORKSPACES);
  assert.ok(r.job, JSON.stringify(r.report));
  const out = await st.s.importTasks(r.job, async () => started, write ? () => true : null);
  return out.rows;
}
const codes = (rows) => rows.refused.map((x) => [x.ref, x.code]);
const byRef = (st, ref) => st.json().tasks.find((t) => t.ref === ref);
const hand = (over = {}) => ({ id: randomUUID(), key: `T-${++n}`, workspaceId: WS, project: P, title: "h", text: "h", criteria: ["h"], dependsOn: [], order: n,
  createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z", archivedAt: null, accepted: null, ...over });
const handBoard = (tasks) => { const st = store(); fs.writeFileSync(st.file, JSON.stringify({ v: 1, tasks, counters: {} })); return st; };

test("five tasks, two invalid: three created in one write, two refused, the board kept whole (T-1, T-10)", async () => {
  const st = store();
  const before = await st.s.create({ workspaceId: WS, project: P, title: "Прежняя", text: "была до импорта", criteria: ["есть"] });
  const other = await st.s.create({ workspaceId: "ws-other", project: P, title: "Чужая", text: "другое пространство", criteria: ["есть"] });
  const rows = await imp(st, [row("T1"), row("T2", { criteria: [] }), row("T3", { dependsOn: ["T1"] }), row("T4", { dependsOn: ["NOPE"] }), row("T5", { dependsOn: ["T3", "T1"] })]);
  assert.deepEqual(rows.created.map((x) => [x.ref, x.key]), [["T1", "T-2"], ["T3", "T-3"], ["T5", "T-4"]]);
  assert.deepEqual(codes(rows), [["T2", "no_criteria"], ["T4", "unknown_dependency"]]);
  assert.deepEqual([rows.updated, rows.unchanged], [[], []]);
  assert.deepEqual(fs.readdirSync(path.dirname(st.file)).filter((f) => f.includes(".damaged-")), [], "board.json is not set aside");
  const again = (await createBoardStore(st.file).read()).board.tasks;
  assert.deepEqual(again.map((t) => t.key), ["T-1", "T-1", "T-2", "T-3", "T-4"]);
  assert.ok(again.some((t) => t.id === before.id) && again.some((t) => t.id === other.id), "the tasks of before are there");
  const t5 = again.find((t) => t.ref === "T5");
  assert.deepEqual(t5.dependsOn, [byRef(st, "T3").id, byRef(st, "T1").id]);
  assert.ok(t5.order > before.order);
  // T-10: a row without criteria at all
  assert.deepEqual(codes(await imp(st, [row("T6", { criteria: undefined })])), [["T6", "no_criteria"]]);
  // a dependency on an existing task of the workspace, by its ref
  assert.deepEqual((await imp(st, [row("T7", { dependsOn: ["T1"] })])).created.map((x) => x.ref), ["T7"]);
  assert.deepEqual(byRef(st, "T7").dependsOn, [byRef(st, "T1").id]);
});

test("the same file again: every row unchanged, nothing written", async () => {
  const st = store();
  const tasks = [row("T1"), row("T2", { dependsOn: ["T1"] })];
  await imp(st, tasks);
  const was = fs.readFileSync(st.file, "utf8");
  const rows = await imp(st, tasks);
  assert.deepEqual([rows.created, rows.updated, rows.unchanged, rows.refused], [[], [], ["T1", "T2"], []]);
  assert.equal(fs.readFileSync(st.file, "utf8"), was);
});

test("a cycle refuses every task on it; their dependents are refused; the rest imported", async () => {
  const st = store();
  const rows = await imp(st, [row("A", { dependsOn: ["B"] }), row("B", { dependsOn: ["A"] }), row("C"), row("D", { dependsOn: ["A"] }), row("S", { dependsOn: ["S"] })]);
  assert.deepEqual(rows.created.map((x) => x.ref), ["C"]);
  assert.deepEqual(codes(rows), [["A", "task_cycle"], ["B", "task_cycle"], ["D", "dependency_refused"], ["S", "task_cycle"]]);
  // a cycle through a task already on the board
  await imp(st, [row("X"), row("Y", { dependsOn: ["X"] })]);
  assert.deepEqual(codes(await imp(st, [row("X", { dependsOn: ["Y"] })])), [["X", "task_cycle"]]);
  assert.deepEqual(byRef(st, "X").dependsOn, []);
});

test("upsert: a task with runs and a changed text → task_started, the others imported; same content → unchanged", async () => {
  const st = store();
  await imp(st, [row("T1"), row("T2")]);
  const t1 = byRef(st, "T1");
  const rows = await imp(st, [row("T1", { text: "другой текст" }), row("T2", { title: "Новое имя" }), row("T3")], { started: new Set([t1.id]) });
  assert.deepEqual(codes(rows), [["T1", "task_started"]]);
  assert.deepEqual([rows.updated.map((x) => x.ref), rows.created.map((x) => x.ref)], [["T2"], ["T3"]]);
  assert.equal(byRef(st, "T1").text, "Сделать T1");
  assert.equal(byRef(st, "T2").title, "Новое имя");
  assert.deepEqual((await imp(st, [row("T1")], { started: new Set([t1.id]) })).unchanged, ["T1"], "the same content is no change");
});

test("ifAbsent with an existing ref and another text → unchanged, the task as it was; absent → created", async () => {
  const st = store();
  await imp(st, [row("T1")]);
  const was = byRef(st, "T1");
  const rows = await imp(st, [row("T1", { text: "иначе", ifAbsent: true }), row("T2", { ifAbsent: true })]);
  assert.deepEqual([rows.unchanged, rows.created.map((x) => x.ref)], [["T1"], ["T2"]]);
  assert.deepEqual(byRef(st, "T1"), was);
  assert.equal("ifAbsent" in byRef(st, "T2"), false, "ifAbsent is not stored");
  assert.deepEqual(codes(await imp(st, [row("T3", { ifAbsent: false })])), [["T3", "invalid_task"]]);
});

for (const [field, value] of [["external", true], ["models", { executor: "opus" }], ["issue", "ISSUE-1"], ["commitTitle", "feat: первая задача"], ["scope", ["docs/**"]]]) {
  test(`the F2–F4 field ${field} in F1 → field_not_supported for its row only`, async () => {
    const st = store();
    const rows = await imp(st, [row("T1", { [field]: value }), row("T2")]);
    assert.deepEqual(codes(rows), [["T1", "field_not_supported"]]);
    assert.deepEqual(rows.created.map((x) => x.ref), ["T2"]);
  });
}

test("an unknown field of a task → invalid_task for that row; unknown at the top → invalid_file", async () => {
  const st = store();
  const rows = await imp(st, [row("T1", { color: "red" }), row("T2")]);
  assert.deepEqual(codes(rows), [["T1", "invalid_task"]]);
  assert.match(rows.refused[0].detail, /color/);
  assert.deepEqual(rows.created.map((x) => x.ref), ["T2"]);
  const top = await readTasksFile("tasks.json", bytes([row("T1")], { extra: 1 }), WORKSPACES);
  assert.deepEqual([top.report.status, top.report.code], ["invalid_file", "invalid_file"]);
});

test("a task field named like an Object.prototype key (toString, constructor, __proto__) → invalid_task, never field_not_supported", async () => {
  // __proto__ only as JSON text: an object literal would set the prototype, not a key
  const text = (field) => `{"format":"board-tasks/v1","workspace":"acme","tasks":[${JSON.stringify(row("T1")).slice(0, -1)},"${field}":1}]}`;
  for (const field of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    const r = await readTasksFile("tasks.json", Buffer.from(text(field)), WORKSPACES);
    assert.ok(r.job, field);
    assert.deepEqual(r.job.rows.map((x) => [x.ref, x.refused?.code]), [["T1", "invalid_task"]], field);
    assert.match(r.job.rows[0].refused.detail, new RegExp(`unknown field ${field}`));
  }
});

test("project: the root of git — .git a folder with HEAD, or a file `gitdir: …`; a stray .git file or a .git link to an empty folder → project_not_found", async () => {
  const dir = (name, make) => { const d = path.join(TMP, `${name}-${++n}`); fs.mkdirSync(d); make(d); return d; };
  const stray = dir("stray", (d) => fs.writeFileSync(path.join(d, ".git"), "not a git file\n"));
  const empty = dir("empty", (d) => fs.mkdirSync(path.join(d, ".git")));
  const linked = dir("linked", (d) => { const e = path.join(TMP, `void-${n}`); fs.mkdirSync(e); fs.symlinkSync(e, path.join(d, ".git")); });
  const worktree = dir("worktree", (d) => fs.writeFileSync(path.join(d, ".git"), `gitdir: ${path.join(P, ".git")}\n`));
  const rows = await imp(store(), [row("S", { project: stray }), row("E", { project: empty }), row("L", { project: linked }), row("W", { project: worktree }), row("R")]);
  assert.deepEqual(codes(rows), [["S", "project_not_found"], ["E", "project_not_found"], ["L", "project_not_found"]]);
  assert.deepEqual(rows.created.map((x) => x.ref), ["W", "R"]);
});

test("rows refused by their own checks: invalid_ref, duplicate_ref, invalid_task (checkInput), project_not_found", async () => {
  const st = store();
  const sub = path.join(P, "sub");
  fs.mkdirSync(sub, { recursive: true });
  const rows = await imp(st, [row("-x"), row("D"), row("D"), row("E", { title: "   " }), row("F", { project: sub }), row("G", { project: "relative" }),
    row("H", { project: path.join(TMP, "none") }), row("OK")]);
  assert.deepEqual(codes(rows), [[null, "invalid_ref"], ["D", "duplicate_ref"], ["D", "duplicate_ref"], ["E", "invalid_task"], ["F", "project_not_found"],
    ["G", "project_not_found"], ["H", "project_not_found"]]);
  assert.deepEqual(rows.created.map((x) => x.ref), ["OK"]);
});

test("task_split: a marked task, a split parent, one with live subtasks — a change refused, the same content unchanged", async () => {
  const marked = hand({ ref: "M", title: "Задача M", text: "Сделать M", criteria: ["M готово"], decompose: true });
  const split = hand({ ref: "S", title: "Задача S", text: "Сделать S", criteria: ["S готово"], decomposedBy: randomUUID() });
  const parent = hand({ ref: "L", title: "Задача L", text: "Сделать L", criteria: ["L готово"] });
  const child = hand({ parentId: parent.id, covers: ["R1"] });
  const st = handBoard([marked, split, parent, child]);
  const rows = await imp(st, [row("M", { text: "иначе" }), row("S", { text: "иначе" }), row("L", { text: "иначе" })]);
  assert.deepEqual(codes(rows), [["M", "task_split"], ["S", "task_split"], ["L", "task_split"]]);
  assert.deepEqual((await imp(st, [row("M"), row("S"), row("L")])).unchanged, ["M", "S", "L"]);
});

test("project_changed and task_archived on an existing ref", async () => {
  const st = store();
  await imp(st, [row("T1"), row("T2")]);
  await st.s.archive(byRef(st, "T2").id, true);
  const rows = await imp(st, [row("T1", { project: P2 }), row("T2", { text: "иначе" }), row("T3", { dependsOn: ["T1"] })]);
  assert.deepEqual(codes(rows), [["T1", "project_changed"], ["T2", "task_archived"], ["T3", "dependency_refused"]]);
  assert.equal(byRef(st, "T1").project, P);
});

test("the file is the source of truth: a field of a later stage it lacks is taken off the task", async () => {
  const st = handBoard([hand({ ref: "T1", title: "Задача T1", text: "Сделать T1", criteria: ["T1 готово"], issue: "ISSUE-1", commitTitle: "feat: x", unknownLater: 1 })]);
  const rows = await imp(st, [row("T1")]);
  assert.deepEqual(rows.updated.map((x) => x.ref), ["T1"]);
  const t = byRef(st, "T1");
  assert.deepEqual([t.issue, t.commitTitle, t.unknownLater], [undefined, undefined, 1], "only the fields of the format; another unknown field is kept");
});

test("origin and ref: written at creation, kept by an edit, archive, move and split; a bad one in board.json is dropped, the board kept", async () => {
  const st = store();
  const file = bytes([row("T1", { criteria: ["один", "два"] }), row("T2")], { source: "plan.md@abc" });
  const r = await readTasksFile("tasks.json", file, WORKSPACES);
  await st.s.importTasks(r.job, async () => new Set(), () => true);
  const origin = { kind: "import", source: "plan.md@abc", file: "tasks.json", sha256: sha256(file) };
  const t1 = byRef(st, "T1");
  assert.deepEqual(t1.origin, origin);
  await st.s.update(t1.id, { text: "правка" });
  await st.s.update(t1.id, { order: 99 });
  await st.s.archive(t1.id, true);
  await st.s.archive(t1.id, false);
  await st.s.update(t1.id, { decompose: true });
  await st.s.split(t1.id, randomUUID(), { criteria: 2, language: "ru", tasks: [{ id: "S1", title: "часть", text: "часть", criteria: ["да"], dependsOn: [], covers: ["R1"] }] });
  const after = byRef(st, "T1");
  assert.deepEqual([after.ref, after.origin, after.text, after.order, typeof after.decomposedBy], ["T1", origin, "правка", 99, "string"]);
  // without a source the origin says null
  const plain = await readTasksFile("x.json", bytes([row("Z")]), WORKSPACES);
  assert.equal(plain.job.origin.source, null);
  // a bad origin and a bad ref in board.json: dropped, never the board
  const good = hand({ ref: "G", origin });
  const bad = [hand({ ref: "-bad", origin: { kind: "manual" } }), hand({ ref: 7, origin: { ...origin, sha256: "x" } }), hand({ origin: null })];
  const hb = handBoard([good, ...bad]);
  const read = await hb.s.read();
  assert.equal(read.readOnly, null);
  assert.deepEqual(read.board.tasks.map((t) => [t.id, t.ref, t.origin]), [[good.id, "G", origin], ...bad.map((t) => [t.id, undefined, undefined])]);
  assert.deepEqual(fs.readdirSync(path.dirname(hb.file)).filter((f) => f.includes(".damaged-")), []);
});

test("the file: over 1 MB, broken JSON, not an object, wrong format, both or neither workspace field → invalid_file", async () => {
  const big = Buffer.alloc(1024 * 1024 + 1, 0x20);
  const cases = [big, Buffer.from("{\"format\":"), Buffer.from("[]"), bytes([row("T1")], { format: "board-tasks/v2" }),
    bytes([row("T1")], { workspaceId: WS }), Buffer.from(JSON.stringify({ format: "board-tasks/v1", tasks: [row("T1")] })), bytes([])];
  for (const b of cases) {
    const r = await readTasksFile("tasks.json", b, WORKSPACES);
    assert.deepEqual([r.report.status, r.report.code, r.report.workspaceId, r.report.refused.map((x) => [x.ref, x.code])],
      ["invalid_file", "invalid_file", null, [[null, "invalid_file"]]], b.subarray(0, 40).toString());
  }
});

// ---------------- the manager: the workspace, the check and «Import» ----------------

function managerOf(workspaces) {
  const root = path.join(TMP, `root-${++n}`);
  return createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, agents: async () => null,
    workspaceOpen: (id) => workspaces.some((w) => w.id === id && w.open), workspaceKnown: (id) => workspaces.some((w) => w.id === id),
    workspaceNamed: (title) => workspaces.filter((w) => w.title === title && w.open).map((w) => w.id) });
}
const REPORT_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test("manager: the «minimal» example (§5.1) with project and workspace put in is checked, then imported; the report board-tasks-report/v1", async () => {
  const m = managerOf([{ id: WS, title: "acme", open: true }]);
  // §5.1 «minimal», project replaced by a temporary git repository
  const minimal = { format: "board-tasks/v1", workspace: "acme",
    tasks: [{ ref: "T1", project: "/path/to/project", title: "Первая задача", text: "…", criteria: ["…"] }] };
  minimal.tasks[0].project = P;
  const file = Buffer.from(JSON.stringify(minimal));
  const checked = (await m.boardImportCheck("tasks.json", file)).value;
  assert.deepEqual(Object.keys(checked).sort(), ["at", "code", "created", "file", "format", "refused", "sha256", "status", "unchanged", "updated", "workspaceId"]);
  assert.deepEqual([checked.format, checked.file, checked.status, checked.code, checked.workspaceId, checked.created, checked.refused],
    ["board-tasks-report/v1", "tasks.json", "checked", null, WS, [{ ref: "T1", key: "T-1" }], []]);
  assert.match(checked.sha256, /^[0-9a-f]{64}$/);
  assert.match(checked.at, REPORT_AT);
  assert.deepEqual((await m.board()).value.board.tasks, [], "a check writes nothing");
  const applied = (await m.boardImportApply("tasks.json", file, checked)).value;
  assert.deepEqual([applied.changed, applied.report.status, applied.report.created], [null, "imported", [{ ref: "T1", key: "T-1" }]]);
  const tasks = (await m.board()).value.board.tasks;
  assert.deepEqual(tasks.map((t) => [t.key, t.ref, t.workspaceId, t.project, t.accepted, t.archivedAt]), [["T-1", "T1", WS, P, null, null]]);
  await m.shutdown();
});

test("manager: the workspace by name (closed, ambiguous) and by id (closed, unknown)", async () => {
  const m = managerOf([{ id: WS, title: "acme", open: true }, { id: "ws-closed", title: "old", open: false }, { id: "ws-a", title: "twin", open: true }, { id: "ws-b", title: "twin", open: true }]);
  const report = async (over) => (await m.boardImportCheck("tasks.json", bytes([row("T1")], over))).value;
  const fileLevel = (r) => [r.status, r.code, r.workspaceId, r.refused.map((x) => [x.ref, x.code])];
  assert.deepEqual(fileLevel(await report({ workspace: "old" })), ["refused", "workspace_not_found", null, [[null, "workspace_not_found"]]]);
  assert.deepEqual(fileLevel(await report({ workspace: "nobody" })), ["refused", "workspace_not_found", null, [[null, "workspace_not_found"]]]);
  assert.deepEqual(fileLevel(await report({ workspace: "twin" })), ["refused", "workspace_ambiguous", null, [[null, "workspace_ambiguous"]]]);
  assert.deepEqual(fileLevel(await report({ workspace: undefined, workspaceId: "ws-closed" })), ["refused", "workspace_unavailable", "ws-closed", [[null, "workspace_unavailable"]]]);
  assert.deepEqual(fileLevel(await report({ workspace: undefined, workspaceId: "ws-unknown" })), ["refused", "workspace_unavailable", "ws-unknown", [[null, "workspace_unavailable"]]]);
  assert.deepEqual((await report({ workspace: undefined, workspaceId: WS })).created.map((x) => x.ref), ["T1"]);
  await m.shutdown();
});

test("manager: «Import» after the board changed gives a new report, not a write; the second «Import» writes; another file → file_changed", async () => {
  const m = managerOf([{ id: WS, title: "acme", open: true }]);
  const file = bytes([row("T1"), row("T2")]);
  const shown = (await m.boardImportCheck("tasks.json", file)).value;
  assert.deepEqual(shown.created.map((x) => x.ref), ["T1", "T2"]);
  // meanwhile another file puts T1 on the board with another text
  const other = bytes([row("T1", { text: "из другого файла" })]);
  await m.boardImportApply("other.json", other, (await m.boardImportCheck("other.json", other)).value);
  const before = JSON.stringify((await m.board()).value.board.tasks);
  const first = (await m.boardImportApply("tasks.json", file, shown)).value;
  assert.deepEqual([first.changed, first.report.status, first.report.updated.map((x) => x.ref), first.report.created.map((x) => x.ref)], ["report_changed", "checked", ["T1"], ["T2"]]);
  assert.equal(JSON.stringify((await m.board()).value.board.tasks), before, "nothing written");
  const second = (await m.boardImportApply("tasks.json", file, first.report)).value;
  assert.deepEqual([second.changed, second.report.status], [null, "imported"]);
  assert.deepEqual((await m.board()).value.board.tasks.map((t) => [t.ref, t.text]), [["T1", "Сделать T1"], ["T2", "Сделать T2"]]);
  // the file changed after its check
  const changed = (await m.boardImportApply("tasks.json", bytes([row("T1"), row("T3")]), second.report)).value;
  assert.deepEqual([changed.changed, changed.report.status, changed.report.created.map((x) => x.ref)], ["file_changed", "checked", ["T3"]]);
  assert.equal((await m.board()).value.board.tasks.length, 2);
  await m.shutdown();
});
