// E2 (docs/agent-orchestration/implementation/stage-e-decomposition.md §2, §2.1, §2.2, §5, §5.1, §6): subtasks on the
// board — the store's one write that makes them, the marks and their refusals, the texts at their largest, the parent's
// status by the table, an archived subtask that does not hold its parent, and the autopilot's guard. No CLI, no model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import {
  AUTOPILOT_BUDGET, autopilotParallelStep, boardStatuses, goalFor, nextTask, subtaskText, taskText
} from "../src/shared/taskBoard.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-e2-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const WS = "common";
const PROJECT = "/tmp/e2-project";
let n = 0;
const store = (usedKeys) => {
  const file = path.join(TMP, `board-${++n}.json`);
  return { file, b: createBoardStore(file, usedKeys), read: () => JSON.parse(fs.readFileSync(file, "utf8")) };
};
const input = (over = {}) => ({ workspaceId: WS, project: PROJECT, title: "T", text: "do it", criteria: ["one", "two", "three"], ...over });
const stask = (id, covers, over = {}) => ({ id, title: `part ${id}`, text: `do ${id}`, criteria: [`${id} done`], dependsOn: [], covers, ...over });
const PLAN = { criteria: 3, language: "ru", tasks: [stask("S1", ["R1"]), stask("S2", ["R2"], { dependsOn: ["S1"] }), stask("S3", ["R3"])] };
const code = (p, c) => assert.rejects(p, { code: c });
// a board: a dependency D, a parent P (marked) that waits for it, a task N after it
async function seeded(s, over = {}) {
  const d = await s.b.create(input({ title: "D" }));
  const p = await s.b.create(input({ title: "P", dependsOn: [d.id], decompose: true, ...over }));
  const nx = await s.b.create(input({ title: "N" }));
  return { d, p, nx };
}

test("split: the subtasks, the parent's dependsOn and decomposedBy in one write; keys, order, inherited dependencies", async () => {
  const s = store();
  const { d, p, nx } = await seeded(s);
  assert.equal(s.read().tasks.find((t) => t.id === p.id).decompose, true);
  const run = randomUUID();
  const r = await s.b.split(p.id, run, PLAN);
  assert.deepEqual(r, { created: true, keys: ["T-4", "T-5", "T-6"] });
  const board = s.read();
  const [s1, s2, s3] = ["T-4", "T-5", "T-6"].map((k) => board.tasks.find((t) => t.key === k));
  const parent = board.tasks.find((t) => t.id === p.id);
  assert.equal(parent.decomposedBy, run);
  assert.deepEqual(parent.dependsOn, [d.id, s1.id, s2.id, s3.id]);
  // no dependency in the proposal: the parent's previous ones; otherwise its own, by the new ids
  assert.deepEqual([s1.dependsOn, s2.dependsOn, s3.dependsOn], [[d.id], [s1.id], [d.id]]);
  for (const t of [s1, s2, s3]) {
    assert.deepEqual([t.parentId, t.workspaceId, t.project, t.archivedAt, t.accepted], [p.id, WS, PROJECT, null, null]);
    assert.ok(t.order > parent.order && t.order < nx.order, `${t.key} between the parent and the next task`);
  }
  assert.ok(s1.order < s2.order && s2.order < s3.order, "in the proposal's order");
  assert.deepEqual([s1.covers, s2.covers, s3.covers], [["R1"], ["R2"], ["R3"]]);
  assert.deepEqual(s1.criteria, ["S1 done"]);
  assert.match(s1.text, /^do S1\n\nЧасть задачи T-2 «P»\. Закрывает её требования:\nR1 — one$/);
  assert.equal(board.counters[WS], 6);
  // nothing after the parent in the queue: the gap is 1
  const s2b = store();
  const only = await s2b.b.create(input({ decompose: true }));
  await s2b.b.split(only.id, randomUUID(), { ...PLAN, tasks: [stask("S1", ["R1", "R2", "R3"]), stask("S2", ["R1"])] });
  const orders = s2b.read().tasks.filter((t) => t.parentId).map((t) => t.order);
  assert.ok(orders.every((o) => o > only.order && o < only.order + 1));
});

test("split: the same run again changes nothing (byte for byte); deleted subtasks do not come back", async () => {
  const s = store();
  const { p } = await seeded(s);
  const run = randomUUID();
  await s.b.split(p.id, run, PLAN);
  const once = fs.readFileSync(s.file, "utf8");
  assert.deepEqual(await s.b.split(p.id, run, PLAN), { created: false });
  assert.equal(fs.readFileSync(s.file, "utf8"), once);
  // the person deletes the subtasks (they have no runs)
  const subs = JSON.parse(once).tasks.filter((x) => x.parentId).map((x) => x.id);
  for (const id of subs) await s.b.remove(id, async () => false, [p.id, ...subs]);
  const after = fs.readFileSync(s.file, "utf8");
  assert.ok(!JSON.parse(after).tasks.some((t) => t.parentId));
  assert.deepEqual(await s.b.split(p.id, run, PLAN), { created: false });
  assert.equal(fs.readFileSync(s.file, "utf8"), after, "nothing comes back");
  // a later split run is a new decision (the person's «Split again»)
  assert.equal((await s.b.split(p.id, randomUUID(), PLAN)).created, true);
});

test("split: every refusal of §5.1, with its code and no write", async () => {
  const s = store();
  const { p } = await seeded(s);
  const plain = await s.b.create(input({ title: "plain" }));
  const before = () => fs.readFileSync(s.file, "utf8");
  await code(s.b.split(randomUUID(), randomUUID(), PLAN), "parent_gone");
  await code(s.b.split(plain.id, randomUUID(), PLAN), "not_marked");
  await code(s.b.split(p.id, randomUUID(), { ...PLAN, criteria: 2 }), "requirements_changed");
  const archived = await s.b.create(input({ title: "arch", decompose: true }));
  await s.b.archive(archived.id, true);
  const was2 = before();
  await code(s.b.split(archived.id, randomUUID(), PLAN), "parent_gone");
  assert.equal(before(), was2, "unchanged by the refusals");
  const snapshot = before();
  await code(s.b.split(p.id, randomUUID(), { ...PLAN, criteria: 4 }), "requirements_changed");
  assert.equal(before(), snapshot);
  // subtasks that exist already (from another run)
  await s.b.split(p.id, randomUUID(), PLAN);
  await code(s.b.split(p.id, randomUUID(), PLAN), "has_subtasks");
  // an archived subtask is not live: the split can go again
  for (const t of s.read().tasks.filter((x) => x.parentId === p.id)) await s.b.archive(t.id, true);
  assert.equal((await s.b.split(p.id, randomUUID(), PLAN)).created, true);
  // the board is full: 2000 tasks at most
  const full = store();
  const hand = Array.from({ length: 1998 }, (_, i) => ({ id: randomUUID(), key: `T-${i + 1}`, workspaceId: WS, project: PROJECT, title: "x", text: "x", criteria: ["c"], dependsOn: [], order: i + 1,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt: null, accepted: null, ...(i === 0 ? { decompose: true } : {}) }));
  fs.writeFileSync(full.file, JSON.stringify({ v: 1, tasks: hand, counters: { [WS]: 1998 } }));
  const ONE = { ...PLAN, criteria: 1 };
  await code(full.b.split(hand[0].id, randomUUID(), ONE), "too_many_tasks"); // 1998 + 3 > 2000
  assert.equal((await full.b.split(hand[0].id, randomUUID(), { ...ONE, tasks: PLAN.tasks.slice(0, 2) })).created, true); // 2000
  // the numbers end at T-999999 (the runs' keys count too)
  const high = store(async () => 999_997);
  const hp = await high.b.create(input({ decompose: true }));
  assert.equal(hp.key, "T-999998"); // three more would end at T-1000001
  await code(high.b.split(hp.id, randomUUID(), PLAN), "too_many_tasks");
});

test("«Split» mark: only true is stored; a subtask has none; the text leaves 400; «Do it whole» only without live subtasks", async () => {
  const s = store();
  const a = await s.b.create(input({ decompose: false }));
  assert.ok(!("decompose" in a), "false is never stored");
  await code(s.b.create(input({ decompose: true, text: "x".repeat(7601) })), "text_too_long");
  assert.equal((await s.b.create(input({ decompose: true, text: "x".repeat(7600) }))).decompose, true);
  const long = await s.b.create(input({ text: "x".repeat(8000) }));
  await code(s.b.update(long.id, { decompose: true }), "text_too_long");
  const marked = (await s.b.update(a.id, { decompose: true }));
  assert.equal(marked.decompose, true);
  await code(s.b.update(a.id, { text: "y".repeat(7601) }), "text_too_long");
  assert.equal((await s.b.update(a.id, { title: "renamed" })).decompose, true, "other fields keep the mark");
  assert.equal((await s.b.update(a.id, { decompose: true })).decompose, true);
  // a task with subtasks
  const run = randomUUID();
  await s.b.split(a.id, run, PLAN);
  const sub = s.read().tasks.find((t) => t.parentId === a.id);
  await code(s.b.update(sub.id, { decompose: true }), "invalid_task");
  const kept = await s.b.update(sub.id, { title: "renamed subtask" });
  assert.deepEqual([kept.parentId, kept.covers, "decompose" in kept], [a.id, ["R1"], false], "an update keeps the new fields");
  await code(s.b.update(a.id, { decompose: false }), "has_subtasks");
  for (const t of s.read().tasks.filter((x) => x.parentId === a.id)) await s.b.archive(t.id, true);
  const whole = await s.b.update(a.id, { decompose: false });
  assert.ok(!("decompose" in whole) && !("decomposedBy" in whole), "the mark and decomposedBy are dropped");
  // unmarking an unmarked task is no change
  assert.ok(!("decompose" in (await s.b.update(long.id, { decompose: false }))));
});

test("board.json by hand: the new fields read when well formed; bad ones set the board aside; a parentId with a decompose is not refused", async () => {
  const task = (over) => ({ id: randomUUID(), key: "T-1", workspaceId: WS, project: PROJECT, title: "x", text: "x", criteria: ["c"], dependsOn: [], order: 1,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt: null, accepted: null, ...over });
  const read = async (t) => {
    const s = store();
    fs.writeFileSync(s.file, JSON.stringify({ v: 1, tasks: [t], counters: {} }));
    return { r: await s.b.read(), s };
  };
  const both = await read(task({ decompose: true, parentId: randomUUID(), covers: ["R1", "R32"], decomposedBy: randomUUID() }));
  assert.equal(both.r.board.tasks.length, 1, "read whole");
  for (const bad of [{ decompose: false }, { decomposedBy: "x" }, { parentId: 3 }, { covers: [] }, { covers: ["R0"] }, { covers: ["R33"] }, { covers: ["r1"] }, { covers: "R1" },
    { covers: Array.from({ length: 33 }, () => "R1") }]) {
    const { r, s } = await read(task(bad));
    assert.equal(r.board.tasks.length, 0, JSON.stringify(bad));
    assert.ok(fs.readdirSync(TMP).some((f) => f.startsWith(path.basename(s.file) + ".damaged-")), "set aside whole");
  }
  // the update of such a task is refused, but its rename is not
  const s = store();
  const t = task({ decompose: true, parentId: randomUUID() });
  fs.writeFileSync(s.file, JSON.stringify({ v: 1, tasks: [t], counters: {} }));
  assert.equal((await s.b.update(t.id, { title: "renamed" })).title, "renamed");
  await code(s.b.update(t.id, { decompose: true }), "invalid_task");
});

test("texts: a subtask's text and the closing run's paragraph at their largest", () => {
  const criteria = Array.from({ length: 32 }, (_, i) => `${String.fromCharCode(97 + (i % 26))}`.repeat(500));
  const parent = { key: "T-999999", title: "t".repeat(200), criteria };
  const covers = Array.from({ length: 32 }, (_, i) => `R${i + 1}`);
  for (const language of ["ru", "en"]) {
    const t = subtaskText("L".repeat(4000), parent, covers, language);
    assert.ok(t.length <= 8000 && t.length > 7900, `${language}: ${t.length}`);
    assert.ok(t.startsWith("L".repeat(4000)));
    for (const r of covers) assert.ok(t.includes(`\n${r} — `), `${r} stays`);
    assert.ok(t.endsWith("…") || t.split("\n").at(-1).endsWith("…"), "the cut ones end with «…»");
    assert.ok(t.includes(`\nR1 — ${"a".repeat(500)}\n`), "verbatim while it fits");
  }
  // it all fits: verbatim, no cut
  const small = subtaskText("do it", { key: "T-2", title: "P", criteria: ["one", "two", "three"] }, ["R3", "R1"], "en");
  assert.equal(small, "do it\n\nPart of task T-2 «P». It covers these of its requirements:\nR3 — three\nR1 — one");
  assert.ok(!small.includes("…"));

  const mk = (key, order, over = {}) => ({ id: randomUUID(), key, order, parentId: "P", archivedAt: null, ...over });
  const P = { id: "P", text: "z".repeat(7600), decompose: true, decomposedBy: randomUUID() };
  const ten = Array.from({ length: 10 }, (_, i) => mk(`T-99999${i}`, i));
  for (const language of ["ru", "en"]) {
    const x = taskText(P, ten, language);
    assert.ok(x.length <= 8000, `${language}: ${x.length}`);
    assert.ok(x.startsWith("z".repeat(7600) + "\n\n"));
    assert.ok(x.slice(7602).length <= 400);
    assert.ok(x.includes("T-999990, T-999991") && x.includes("T-999999"));
  }
  assert.match(taskText(P, ten.slice(0, 3), "ru"), /Подзадачи T-999990, T-999991, T-999992 выполнены и влиты в итог доски\. Проверьте требования этой задачи на текущем коде и доделайте только недостающее\.$/);
  // far more keys than a split holds: «and N more», the paragraph still within 400
  const many = Array.from({ length: 200 }, (_, i) => mk(`T-${100000 + i}`, i));
  const cut = taskText({ ...P, text: "x" }, many, "en");
  assert.ok(cut.slice(3).length <= 400 && /and \d+ more are done|and \d+ more/.test(cut), cut);
  assert.match(taskText({ ...P, text: "x" }, many, "ru"), /и ещё \d+/);
  // archived subtasks are left out of the list; no subtasks, no mark or no decomposedBy: the text as it is
  assert.ok(!taskText(P, [...ten.slice(0, 2), mk("T-5", 9, { archivedAt: "x" })], "en").includes("T-5"));
  assert.equal(taskText(P, [], "en"), P.text);
  assert.equal(taskText({ ...P, decomposedBy: undefined }, ten, "en"), P.text);
  assert.equal(taskText({ id: "Q", text: "q" }, ten, "en"), "q");
  // the autopilot's goal carries it
  const g = goalFor({ ...P, key: "T-1", criteria: ["c"] }, { checks: [], workMode: "copy", finish: { commit: false }, models: null }, { optionalChecks: false, language: "en", base: null, tasks: ten.slice(0, 2) });
  assert.ok(g.text.includes("Subtasks T-999990, T-999991 are done"));
  assert.equal(goalFor({ id: "Q", key: "T-2", text: "q", criteria: ["c"] }, { checks: [], workMode: "copy", finish: { commit: false }, models: null }, { optionalChecks: false, language: "en", base: null }).text, "q");
});

// ---- statuses ----
const task = (key, over = {}) => ({ id: randomUUID(), key, workspaceId: WS, project: PROJECT, title: key, text: key, criteria: ["c1", "c2"], dependsOn: [], order: Number(key.slice(2)),
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt: null, accepted: null, ...over });
let at = 0;
const fact = (over = {}) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: ++at, workspaceId: WS, status: "completed", reason: null, newer: false, halted: false, limit: null,
  completion: "confirmed", phase: "work", permission: false, workMode: "copy", taken: null, ...over });
const splitRun = (parent, over = {}) => fact({ decompositionOf: parent.id, completion: null, split: null, ...over });
const view = (parent, facts, tasks = [parent]) => { const s = boardStatuses({ tasks }, facts).get(parent.id); return [s.column, s.reason, s.split?.detail ?? null]; };

test("the parent's status by the table of §2.1, row by row", () => {
  const P = task("T-1", { decompose: true });
  const row = (over) => view(P, [splitRun(P, over)]);
  assert.deepEqual(view(P, []), ["queue", null, null], "no split yet");
  for (const status of ["preparing", "running", "pausing", "stopping", "created"]) assert.deepEqual(row({ status }), ["work", "decomposing", null], status);
  assert.deepEqual(row({ status: "running", permission: true }), ["work", "waits_permission", null]);
  assert.deepEqual(row({ status: "paused", reason: "awaiting_answer" }), ["work", "waits_answer", null]);
  for (const reason of ["environment_error", "limit_reached", "recovered", "report_failed"]) assert.deepEqual(row({ status: "paused", reason }), ["work", "decomposition_paused", reason], reason);
  assert.deepEqual(row({ status: "paused", reason: "environment_error", providerLimit: { provider: "codex", resetsAt: 5 } }), ["work", "decomposition_paused", "environment_error"]);
  assert.deepEqual(row({ split: "proposed" }), ["work", "decomposing", null], "proposed, the subtasks not made yet");
  assert.deepEqual(row({ split: "proposed", splitFailed: "parent_gone" }), ["review", "decomposition_failed", "parent_gone"]);
  assert.deepEqual(row({ split: "whole" }), ["queue", null, "whole"], "whole: as an ordinary task");
  assert.deepEqual(row({ split: "rejected" }), ["review", "decomposition_failed", "rejected"]);
  assert.deepEqual(row({ status: "failed" }), ["review", "decomposition_failed", "failed"]);
  assert.deepEqual(row({ status: "stopped" }), ["review", "decomposition_failed", "stopped"]);
  assert.deepEqual(row({ newer: true, status: "paused" }), ["queue", "run_newer", null]);
  assert.deepEqual(row({ status: "unreadable" }), ["queue", "run_unreadable", null]);
  // the latest run decides (the person's «Split again»)
  const old = splitRun(P, { status: "stopped" });
  const newer = splitRun(P, { status: "running" });
  assert.deepEqual(view(P, [newer, old]), ["work", "decomposing", null]);
  assert.equal(boardStatuses({ tasks: [P] }, [old, newer]).get(P.id).split.runId, newer.runId);
  // another workspace's run, and a task without the mark, ignore it
  assert.deepEqual(view(P, [splitRun(P, { status: "running", workspaceId: "other" })]), ["queue", null, null]);
  const plain = task("T-9");
  assert.deepEqual(view(plain, [splitRun(plain, { status: "running" })]), ["queue", null, null]);
  // a split run is no run of the task: its attempts and current stay its own
  const s = boardStatuses({ tasks: [P] }, [splitRun(P, { status: "running" })]).get(P.id);
  assert.deepEqual([s.attempts, s.current, s.completion], [0, null, null]);
  // a parent that waits for its dependencies is not split
  const D = task("T-2");
  const W = task("T-3", { decompose: true, dependsOn: [D.id] });
  assert.equal(boardStatuses({ tasks: [D, W] }, []).get(W.id).depsWait.reason, "waits_task");
});

test("the parent with subtasks is an ordinary waiting task; subtasks_gone; a later split run decides again", () => {
  const D = task("T-2");
  const P = task("T-1", { decompose: true, decomposedBy: randomUUID() });
  const S1 = task("T-3", { parentId: P.id });
  const S2 = task("T-4", { parentId: P.id });
  P.dependsOn = [S1.id, S2.id];
  const run = (t, over) => fact({ taskId: t.id, taskKey: t.key, ...over });
  const st = (tasks, facts) => boardStatuses({ tasks }, facts).get(P.id);
  const waiting = st([P, S1, S2], []);
  assert.deepEqual([waiting.column, waiting.reason, waiting.waitsFor], ["queue", "waits_task", ["T-3", "T-4"]]);
  assert.equal(st([P, S1, S2], [run(S1, {})]).reason, "waits_task");
  // gone: deleted, or archived
  assert.deepEqual([st([P], []).column, st([P], []).reason], ["review", "subtasks_gone"]);
  assert.deepEqual([st([P, { ...S1, archivedAt: "x" }, { ...S2, archivedAt: "x" }], []).column, st([P, { ...S1, archivedAt: "x" }, { ...S2, archivedAt: "x" }], []).reason], ["review", "subtasks_gone"]);
  // the original run alone is not a new split; a later one shows its own state, and a failed one its failure
  const original = splitRun(P, { runId: P.decomposedBy, split: "proposed" });
  assert.equal(st([P], [original]).reason, "subtasks_gone");
  assert.equal(st([P], [original, splitRun(P, { status: "running" })]).reason, "decomposing");
  assert.deepEqual([st([P], [original, splitRun(P, { split: "rejected" })]).reason, st([P], [original, splitRun(P, { split: "rejected" })]).split.detail], ["decomposition_failed", "rejected"]);
  // the parent has run itself (an older build did): its own status
  assert.equal(st([P], [run(P, { status: "running" })]).reason, null);
  assert.ok(D);
});

// ---- §2.2 and the autopilot ----
const HEAD_REF = "refs/raoden/board/common/1";
const head = (merged) => ({ workspaceId: WS, project: PROJECT, ref: HEAD_REF, n: 1, commit: "a".repeat(40),
  merges: merged.map((x) => ({ runId: randomUUID(), board: HEAD_REF, base: "a".repeat(40), task: { id: x.task.id, key: x.task.key, runId: x.runId, commit: "b".repeat(40) },
    status: x.status ?? "completed", reason: x.reason ?? null, detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: 1 })) });
const done = (t) => fact({ taskId: t.id, taskKey: t.key, board: HEAD_REF, taken: { branch: "b", commit: "b".repeat(40), applied: false } });
const step = (tasks, facts, h) => autopilotParallelStep({ tasks }, facts, { workspaceId: WS, project: PROJECT }, [], { runs: 0, ms: 0 }, AUTOPILOT_BUDGET, h);

test("§2.2: an archived subtask does not hold its parent; an archived ordinary dependency does", () => {
  const P = task("T-1", { decompose: true, decomposedBy: randomUUID() });
  const S1 = task("T-2", { parentId: P.id });
  const S2 = task("T-3", { parentId: P.id });
  P.dependsOn = [S1.id, S2.id];
  const r1 = done(S1);
  const h = head([{ task: S1, runId: r1.runId }]);
  // S2 never ran and is archived: the parent waits for S1 only, and S1 is in the head
  const tasks = [P, S1, { ...S2, archivedAt: "2026-10-02T00:00:00Z" }];
  const s = boardStatuses({ tasks }, [r1], [h]).get(P.id);
  assert.deepEqual([s.column, s.reason, s.depsWait], ["queue", null, null]);
  const a = step(tasks, [r1], h);
  assert.deepEqual([a.kind, a.task?.key], ["start", "T-1"], "the autopilot starts the parent");
  // not archived: the parent waits for it
  const live = boardStatuses({ tasks: [P, S1, S2] }, [r1], [h]).get(P.id);
  assert.deepEqual([live.reason, live.waitsFor], ["waits_task", ["T-3"]]);
  assert.notEqual(step([P, S1, S2], [r1], h).task?.key, "T-1");
  // an ordinary dependency, archived and not done, still holds
  const A = task("T-5", { archivedAt: "2026-10-02T00:00:00Z" });
  const B = task("T-6", { dependsOn: [A.id] });
  const sb = boardStatuses({ tasks: [A, B] }, []).get(B.id);
  assert.deepEqual([sb.reason, sb.waitsFor], ["waits_task", ["T-5"]]);
  assert.notEqual(step([A, B], [], h).task?.key, "T-6");
  // a subtask of ANOTHER parent, archived, still holds this task
  const other = task("T-7", { parentId: randomUUID(), archivedAt: "2026-10-02T00:00:00Z" });
  const C = task("T-8", { dependsOn: [other.id] });
  assert.equal(boardStatuses({ tasks: [other, C] }, []).get(C.id).reason, "waits_task");
});

test("the parent starts only when every live subtask is in the board's result; «Пропустить» of one keeps the parent waiting", () => {
  const P = task("T-1", { decompose: true, decomposedBy: randomUUID() });
  const S1 = task("T-2", { parentId: P.id });
  const S2 = task("T-3", { parentId: P.id });
  P.dependsOn = [S1.id, S2.id];
  const tasks = [P, S1, S2];
  const r1 = done(S1);
  const r2 = done(S2);
  const only1 = step(tasks, [r1, r2], head([{ task: S1, runId: r1.runId }]));
  assert.notEqual(only1.task?.key, "T-1", "S2 done but not merged: the autopilot merges it first, the parent waits");
  assert.equal(only1.kind, "merge");
  const both = step(tasks, [r1, r2], head([{ task: S1, runId: r1.runId }, { task: S2, runId: r2.runId }]));
  assert.deepEqual([both.kind, both.task.key], ["start", "T-1"]);
  // «Пропустить»: the merge stopped, reason skipped — the subtask is «Done» and not in the head
  const skipped = head([{ task: S1, runId: r1.runId }, { task: S2, runId: r2.runId, status: "stopped", reason: "skipped" }]);
  const s = boardStatuses({ tasks }, [r1, r2], [skipped]).get(P.id);
  // the code's reason with a head is waits_head (§2.2 says waits_merge: that is the no-head rule for results in different places)
  assert.deepEqual([s.column, s.reason, s.waitsFor], ["queue", "waits_head", ["T-3"]]);
  assert.notEqual(step(tasks, [r1, r2], skipped).task?.key, "T-1");
});

test("a marked parent that is not split is not taken as a task (the autopilot splits it first, E3), unless the lead said «whole»", () => {
  const P = task("T-1", { decompose: true });
  const Q = task("T-2");
  const statuses = (facts) => boardStatuses({ tasks: [P, Q] }, facts);
  const at = { workspaceId: WS, project: PROJECT };
  assert.equal(nextTask({ tasks: [P, Q] }, statuses([]), at).key, "T-2", "the next ordinary task");
  assert.equal(nextTask({ tasks: [P] }, statuses([]), at), null);
  const whole = [splitRun(P, { split: "whole" })];
  assert.equal(nextTask({ tasks: [P, Q] }, statuses(whole), at).key, "T-1");
  assert.deepEqual([step([P, Q], [], head([])).kind, step([P, Q], [], head([])).task.key], ["decompose", "T-1"], "E3: split first, not started whole");
  assert.equal(step([P, Q], [splitRun(P, { status: "failed" })], head([])).task.key, "T-2", "the person's split that failed: the parent is skipped");
  assert.equal(step([P], [splitRun(P, { status: "failed" })], head([])).kind, "off");
  assert.equal(step([P, Q], whole, head([])).task.key, "T-1");
});
