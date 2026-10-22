// F2, T-3 and T-4 (docs/agent-orchestration/implementation/stage-f-external-projects.md §4, §5.1, §5.5, §5.6, §6): an
// external task — never started, «Done» only by the person's mark «Выполнено» (externalDone), apart from confirmed and
// accepted; its dependents wait for the mark (waits_external); the autopilot waits for it (wait / external) instead of
// turning off and spends no minutes meanwhile; a task with runs of its own goes by them (external_has_runs); never split.
// And a role's model per task over the profile's (goalFor), checked as the profile's. Fake CLIs and local repositories only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardAutopilot } from "../src/main/services/orchestration/boardAutopilot.ts";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import { readTasksFile } from "../src/main/services/orchestration/boardImport.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { assertMainRenderer } from "../src/main/ipc/mainRenderer.ts";
import { registerOrchestrationIpc } from "../src/main/ipc/orchestrationIpc.ts";
import { IPC } from "../src/shared/contracts.ts";
import {
  AUTOPILOT_BUDGET, EXTERNAL_CRITERION, activeMs, autopilotParallelStep, autopilotStep, boardStatuses, decomposeCandidate, externalWait, goalFor, idleOf, nextTask, own, resultOf, startBase
} from "../src/shared/taskBoard.ts";
import { taskLine, stopText } from "../src/renderer/src/features/orchestration/boardModel.ts";
import { t as words } from "../src/renderer/src/lib/i18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 180_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-f2-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
let n = 0;

const WS = "common";
const run = (over = {}) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: ++n, workspaceId: WS, status: "running", reason: null, newer: false, halted: false, limit: null,
  completion: null, phase: "work", permission: false, workMode: "project", taken: null, ...over });
const task = (over = {}) => ({ id: randomUUID(), key: `T-${++n}`, workspaceId: WS, project: "/p", title: "t", text: "x", criteria: ["c"],
  dependsOn: [], order: n, createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z", archivedAt: null, accepted: null, ...over });
const done = (t, over = {}) => run({ taskId: t.id, taskKey: t.key, status: "completed", completion: "confirmed", ...over });
const MARK = { at: "2026-10-21T10:00:00.000Z", by: "person", note: null };
const AT = { workspaceId: WS, project: "/p", workMode: "project" };
const NONE = { runs: 0, ms: 0 };
const C = (hex) => hex.repeat(40).slice(0, 40);
// the chain of §6: an ordinary task, its external «MR merged», the next ordinary task
const chain = () => {
  const t1 = task({ ref: "T1" });
  const mr = task({ ref: "T1-MR", external: true, criteria: [EXTERNAL_CRITERION], dependsOn: [t1.id] });
  const t2 = task({ ref: "T2", dependsOn: [mr.id] });
  return { t1, mr, t2, marked: () => ({ ...mr, externalDone: MARK }) };
};

// ---------------- the statuses (boardStatuses, own, nextTask, idleOf, resultOf) ----------------

test("boardStatuses: an external task is never «Done» by itself; its mark is «Done» of its own kind; the dependent waits_external, then goes", () => {
  const { t1, mr, t2, marked } = chain();
  let st = boardStatuses({ tasks: [t1, mr, t2] }, []);
  assert.deepEqual([st.get(mr.id).column, st.get(mr.id).reason, st.get(mr.id).waitsFor, st.get(mr.id).done], ["queue", "waits_task", [t1.key], null], "it waits for its own dependency");
  assert.deepEqual([st.get(t2.id).reason, st.get(t2.id).waitsFor, st.get(t2.id).depsWait.reason], ["waits_external", [mr.key], "waits_external"]);
  // T1 «Done»: the external task waits for the person only (no reason, never taken)
  const r1 = done(t1);
  st = boardStatuses({ tasks: [t1, mr, t2] }, [r1]);
  assert.deepEqual([st.get(mr.id).column, st.get(mr.id).reason, st.get(mr.id).attempts], ["queue", null, 0]);
  assert.equal(nextTask({ tasks: [t1, mr, t2] }, st, AT), null, "nextTask never takes an external task");
  assert.equal(st.get(t2.id).reason, "waits_external");
  // marked: «Done» of the person's mark — never «confirmed», never «accepted»
  st = boardStatuses({ tasks: [t1, marked(), t2] }, [r1]);
  assert.deepEqual([st.get(mr.id).column, st.get(mr.id).done, st.get(mr.id).current, st.get(mr.id).completion], ["done", "external", null, null]);
  assert.deepEqual([st.get(t2.id).column, st.get(t2.id).reason, st.get(t2.id).depsWait], ["queue", null, null], "after the mark: in the queue without a reason");
  assert.equal(nextTask({ tasks: [t1, marked(), t2] }, st, AT)?.key, t2.key);
  // a dependency not «Done» that is an ordinary task: waits_task, as before
  const t0 = task();
  const both = { ...t2, dependsOn: [mr.id, t0.id] };
  assert.equal(boardStatuses({ tasks: [t1, mr, t0, both] }, [r1]).get(both.id).reason, "waits_task");
  // the line of the card and the stop's words
  assert.equal(taskLine("ru", st.get(mr.id), null, null), "Готово (отмечено вами: «Выполнено»)");
  assert.equal(taskLine("ru", boardStatuses({ tasks: [t1, mr, t2] }, [r1]).get(t2.id), null, null), `Ждёт отметки внешней задачи ${mr.key}`);
  assert.ok(stopText("ru", { code: "others_wait", detail: null, key: null, at: "x", waiting: [{ key: t2.key, reason: "waits_external", waitsFor: [mr.key] }] })
    .includes(`${t2.key} — Ждёт отметки внешней задачи ${mr.key}`));
});

test("a marked external task is no result anywhere: resultOf(undefined) is «folder», it holds no head, no merge, no start base", () => {
  assert.equal(resultOf(undefined), "folder", "a dependency without a run counts as in the folder");
  const { t1, mr, t2, marked } = chain();
  const head = { workspaceId: WS, project: "/p", ref: `refs/raoden/board/${WS}/1`, n: 1, commit: C("h"), merges: [] };
  const r1 = done(t1, { workMode: "copy", taken: { branch: "raoden/t1", commit: C("1"), applied: false } });
  head.merges = [{ runId: randomUUID(), board: head.ref, base: C("0"), task: { id: t1.id, key: t1.key, runId: r1.runId, commit: C("1") }, status: "completed", reason: null, detail: null,
    completion: "confirmed", conflicts: [], outside: [], interference: false, dir: null, createdAt: 1 }];
  // a task on both the merged T1 and the marked T1-MR: neither waits_merge nor waits_head
  const t3 = task({ dependsOn: [t1.id, mr.id] });
  const st = boardStatuses({ tasks: [t1, marked(), t2, t3] }, [r1], [head]);
  assert.deepEqual([st.get(t2.id).reason, st.get(t3.id).reason], [null, null]);
  // a person's start: from the board's head (the marked task says nothing of where to start from)
  assert.deepEqual(startBase(t2, { tasks: [t1, marked(), t2, t3] }, st, [r1], [head]), { branch: head.ref, commit: head.commit, key: "T-0" });
  // without a head: two results in branches would be a merge; the marked task is not one of them
  const t4 = task({ dependsOn: [t1.id, mr.id] });
  assert.equal(boardStatuses({ tasks: [t1, marked(), t4] }, [r1]).get(t4.id).reason, null);
});

test("own: an external task with runs of its own goes by them — external_has_runs where they leave no reason; its mark then means nothing", () => {
  const mr = task({ external: true, externalDone: MARK });
  assert.deepEqual([own(mr, []).done, own(mr, []).column], ["external", "done"]);
  const r = run({ taskId: mr.id, taskKey: mr.key });
  assert.deepEqual([own(mr, [r]).column, own(mr, [r]).reason, own(mr, [r]).done, own(mr, [r]).attempts], ["work", "external_has_runs", null, 1]);
  assert.equal(own(mr, [{ ...r, status: "stopped" }]).reason, "last_stopped", "its run's own reason first");
  assert.deepEqual([own(mr, [{ ...r, status: "completed", completion: "confirmed" }]).done, own(mr, [{ ...r, status: "completed", completion: "confirmed" }]).reason], ["confirmed", null]);
  // on the board: the same, and the dependents count it by its run
  const t2 = task({ dependsOn: [mr.id] });
  const st = boardStatuses({ tasks: [mr, t2] }, [r]);
  assert.deepEqual([st.get(mr.id).reason, st.get(t2.id).reason], ["external_has_runs", "waits_task"]);
  // an externalDone on a task that is not external: nothing
  const plain = task({ externalDone: MARK });
  assert.equal(own(plain, []).done, null);
});

test("idleOf.allDone counts the marks; nextTask and decomposeCandidate skip an external task (even marked «Разбить» by hand)", () => {
  const { t1, mr, t2, marked } = chain();
  const facts = [done(t1), done(t2)];
  assert.equal(idleOf({ tasks: [t1, mr, t2] }, boardStatuses({ tasks: [t1, mr, t2] }, facts), AT).allDone, false, "an unmarked external task is left");
  assert.equal(idleOf({ tasks: [t1, marked(), t2] }, boardStatuses({ tasks: [t1, marked(), t2] }, facts), AT).allDone, true);
  const split = task({ external: true, decompose: true });
  const st = boardStatuses({ tasks: [split] }, []);
  assert.equal(decomposeCandidate({ tasks: [split] }, [], st, AT), null);
  assert.equal(decomposeCandidate({ tasks: [{ ...split, external: undefined }] }, [], boardStatuses({ tasks: [{ ...split, external: undefined }] }, []), AT)?.id, split.id, "the same task not external is a candidate");
  assert.equal(nextTask({ tasks: [task({ external: true })] }, boardStatuses({ tasks: [task({ external: true })] }, []), AT), null);
});

// ---------------- the autopilot's steps ----------------

test("autopilotStep: «ordinary → external -MR → ordinary» — after the first it waits (external, its key), the minutes stay, the mark lets it take the second", () => {
  const { t1, mr, t2, marked } = chain();
  let s = autopilotStep({ tasks: [t1, mr, t2] }, [], AT, null, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.task?.key], ["start", t1.key]);
  const r1 = done(t1);
  s = autopilotStep({ tasks: [t1, mr, t2] }, [r1], AT, r1.runId, { runs: 1, ms: 60_000 }, AUTOPILOT_BUDGET);
  assert.deepEqual(s, { kind: "wait", why: "external", key: mr.key }, "not off: it waits for the person's mark");
  // the minutes are the runs' only: an hour of waiting adds none (the run is over)
  const t0 = Date.parse("2026-10-21T10:00:00Z");
  const records = [{ ts: "2026-10-21T10:00:00Z", type: "run.status", data: { status: "running" } }, { ts: "2026-10-21T10:05:00Z", type: "run.status", data: { status: "completed" } }];
  assert.equal(activeMs(records, t0 + 10 * 60_000), activeMs(records, t0 + 70 * 60_000));
  // the budget used up: still a wait, never «budget» while nothing is to start
  assert.equal(autopilotStep({ tasks: [t1, mr, t2] }, [r1], AT, r1.runId, { runs: 5, ms: 240 * 60_000 }, AUTOPILOT_BUDGET).why, "external");
  s = autopilotStep({ tasks: [t1, marked(), t2] }, [r1], AT, r1.runId, { runs: 1, ms: 60_000 }, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.task?.key, s.base], ["start", t2.key, null]);
  // something else of the place waits for another reason: off, as before
  const t3 = task();
  const stopped = run({ taskId: t3.id, taskKey: t3.key, status: "stopped" });
  const off = autopilotStep({ tasks: [t1, mr, t2, t3] }, [r1, stopped], AT, r1.runId, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([off.kind, off.code], ["off", "others_wait"]);
  // T1 failed: the external task waits for a task that waits for nobody — off
  const failed = run({ taskId: t1.id, taskKey: t1.key, status: "failed" });
  assert.equal(autopilotStep({ tasks: [t1, mr, t2] }, [failed], AT, null, NONE, AUTOPILOT_BUDGET).code, "others_wait");
});

test("autopilotParallelStep: the same chain from the board's head — after T1 is in the head it waits (external), after the mark T2 starts from the head", () => {
  const { t1, mr, t2, marked } = chain();
  const at = { workspaceId: WS, project: "/p" };
  const head = { workspaceId: WS, project: "/p", ref: `refs/raoden/board/${WS}/1`, n: 1, commit: C("h"), merges: [] };
  const r1 = done(t1, { workMode: "copy", board: head.ref, taken: { branch: "raoden/t1", commit: C("1"), applied: false } });
  const merged = { ...head, commit: C("2"), merges: [{ runId: randomUUID(), board: head.ref, base: C("h"), task: { id: t1.id, key: t1.key, runId: r1.runId, commit: C("1") }, status: "completed",
    reason: null, detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, dir: null, createdAt: 1 }] };
  let s = autopilotParallelStep({ tasks: [t1, mr, t2] }, [r1], at, [r1.runId], { runs: 1, ms: 60_000 }, AUTOPILOT_BUDGET, merged);
  assert.deepEqual(s, { kind: "wait", why: "external", key: mr.key });
  s = autopilotParallelStep({ tasks: [t1, marked(), t2] }, [r1], at, [r1.runId], { runs: 1, ms: 60_000 }, AUTOPILOT_BUDGET, merged);
  assert.deepEqual([s.kind, s.task?.key, s.base], ["start", t2.key, { branch: merged.ref, commit: merged.commit, key: "T-0" }]);
  // two external tasks one after another: it waits for the first that can be marked
  const mr2 = task({ external: true, dependsOn: [mr.id] });
  const t3 = task({ dependsOn: [mr2.id] });
  assert.deepEqual(externalWait({ tasks: [t1, mr, mr2, t3] }, boardStatuses({ tasks: [t1, mr, mr2, t3] }, [r1], [merged]), at), mr.key);
  // nothing but an unmarked external task on the board: wait
  const lone = task({ external: true });
  assert.deepEqual(autopilotParallelStep({ tasks: [lone] }, [], at, [], NONE, AUTOPILOT_BUDGET, null), { kind: "wait", why: "external", key: lone.key });
  assert.deepEqual(autopilotStep({ tasks: [lone] }, [], AT, null, NONE, AUTOPILOT_BUDGET), { kind: "wait", why: "external", key: lone.key });
});

// the controller over stand-in calls: the wait and its key in the state, no readiness and no start meanwhile
test("controller: waits for the mark with the key in its state (waitsKey), starts nothing, then takes the next task with the task's models", async () => {
  const { t1, mr, t2, marked } = chain();
  const t2m = { ...t2, models: { executor: "opus" } };
  const facts = [done(t1)];
  const calls = { readiness: [], start: [] };
  const state = { tasks: [t1, mr, t2m] };
  const profile = { access: { claude: "workspace", codex: "workspace" }, workMode: "project", checks: ["true"], finish: { commit: false, push: false, qa: false }, grants: [],
    models: { lead: "gpt-mock", executor: "sonnet", reviewer: null } };
  const LINK = randomUUID();
  const ap = createBoardAutopilot({
    view: async () => ({ board: { v: 1, tasks: state.tasks, counters: {} }, facts: [...facts] }),
    link: async () => ({ workspaceId: WS, project: "/p" }), profile: async () => profile, optionalChecks: true, journal: async () => [],
    readiness: async (input) => { calls.readiness.push(input); return { ok: true, value: { ready: true, items: [] } }; },
    start: async ({ requestId, goal }) => { calls.start.push(goal); facts.push(run({ runId: requestId, taskId: goal.task.id, taskKey: goal.task.key })); return { ok: true, value: { runId: requestId, created: true } }; },
    take: async () => ({ ok: true, value: { result: "created" } }), head: async () => null, ensureHead: async () => {}, merge: async () => ({ ok: false, code: "x", message: "" }),
    newId: () => randomUUID(), now: () => Date.now()
  }, async () => AUTOPILOT_BUDGET, 3_600_000);
  await ap.set(LINK, true, "ru");
  for (let i = 0; i < 3; i++) await ap.tick(LINK);
  let st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.waits, st.waitsKey, calls.readiness.length, calls.start.length], [true, "external", mr.key, 0, 0]);
  state.tasks = [t1, marked(), t2m];
  await ap.tick(LINK);
  st = (await ap.state())[LINK];
  assert.deepEqual([st.waits, st.waitsKey, calls.start.map((g) => g.task.key)], [null, null, [t2.key]]);
  // T-4: the task's executor over the profile's, the rest the profile's — in the readiness and in the goal
  assert.deepEqual(calls.readiness[0].models, { lead: "gpt-mock", executor: "opus", reviewer: null });
  assert.deepEqual(calls.start[0].models, { lead: "gpt-mock", executor: "opus", reviewer: null });
  ap.shutdown();
});

// ---------------- T-4: goalFor ----------------

test("goalFor: the task's model of a role over the profile's; no key — the profile's; only with journal v2 (optionalChecks)", () => {
  const profile = { checks: ["true"], workMode: "project", finish: { commit: false, push: false, qa: false }, models: { lead: "gpt-a", executor: "sonnet", reviewer: null } };
  const t = task({ models: { executor: "opus", reviewer: "gpt-b" } });
  const opts = { optionalChecks: true, language: "en", base: null };
  assert.deepEqual(goalFor(t, profile, opts).models, { lead: "gpt-a", executor: "opus", reviewer: "gpt-b" });
  assert.deepEqual(goalFor(task(), profile, opts).models, { lead: "gpt-a", executor: "sonnet", reviewer: null }, "no models: the profile's");
  assert.deepEqual(goalFor(t, { ...profile, models: undefined }, opts).models, { lead: null, executor: "opus", reviewer: "gpt-b" }, "no profile models: as in the CLI, the task's over it");
  assert.equal("models" in goalFor(t, profile, { ...opts, optionalChecks: false }), false, "journal v1: no models at all, as before");
});

// ---------------- the store: soft checks, import ----------------

const P = (() => {
  const dir = path.join(TMP, "repo");
  fs.mkdirSync(dir);
  execFileSync(GIT, ["init", "-q", dir], { env: GIT_ENV });
  return dir;
})();
const WORKSPACES = { open: (id) => id === WS, named: (title) => (title === "acme" ? [WS] : []) };
const row = (ref, over = {}) => ({ ref, project: P, title: `Задача ${ref}`, text: `Сделать ${ref}`, criteria: [`${ref} готово`], ...over });
const store = () => {
  const file = path.join(TMP, `board-${++n}.json`);
  return { file, s: createBoardStore(file), json: () => JSON.parse(fs.readFileSync(file, "utf8")) };
};
async function imp(st, tasks) {
  const r = await readTasksFile("tasks.json", Buffer.from(JSON.stringify({ format: "board-tasks/v1", workspace: "acme", tasks })), WORKSPACES);
  assert.ok(r.job, JSON.stringify(r.report));
  return (await st.s.importTasks(r.job, async () => new Set(), () => true)).rows;
}
const codes = (rows) => rows.refused.map((x) => [x.ref, x.code]);
const byRef = (st, ref) => st.json().tasks.find((t) => t.ref === ref);

test("isTask: bad external, externalDone and models in board.json are dropped, the board kept; a hand edit never makes «Done — confirmed by checks»", async () => {
  const st = store();
  const good = task({ project: P, external: true, externalDone: MARK, models: { executor: "opus" } });
  const bad = [
    task({ project: P, external: "yes", externalDone: { at: "x", by: "person", note: null }, models: { executor: null } }),
    task({ project: P, external: true, externalDone: { at: MARK.at, by: "agent", note: null }, models: { writer: "opus" } }),
    task({ project: P, externalDone: { ...MARK, note: "x".repeat(301) }, models: {} })
  ];
  fs.writeFileSync(st.file, JSON.stringify({ v: 1, tasks: [good, ...bad], counters: {} }));
  const r = await st.s.read();
  assert.equal(r.readOnly, null);
  assert.equal(fs.readdirSync(path.dirname(st.file)).some((f) => f.startsWith(`${path.basename(st.file)}.damaged-`)), false, "not set aside");
  const [g, b1, b2, b3] = r.board.tasks;
  assert.deepEqual([g.external, g.externalDone, g.models], [true, MARK, { executor: "opus" }]);
  for (const t of [b1, b2, b3]) assert.deepEqual([t.models], [undefined]);
  assert.deepEqual([b1.external, b1.externalDone, b2.external, b2.externalDone, b3.externalDone], [undefined, undefined, true, undefined, undefined]);
  // statuses: the good mark is the person's «Done», never «confirmed»; the rest are not «Done»
  const s = boardStatuses(r.board, []);
  assert.deepEqual(r.board.tasks.map((t) => s.get(t.id).done), ["external", null, null, null]);
  // every write keeps the fields: an edit, an archive
  await st.s.update(g.id, { title: "renamed" });
  await st.s.archive(g.id, true);
  const after = st.json().tasks.find((t) => t.id === g.id);
  assert.deepEqual([after.external, after.externalDone, after.models, after.title], [true, MARK, { executor: "opus" }, "renamed"]);
});

test("the store: «Разбить» on an external task → external_task; the mark only on an external task, its note up to 300", async () => {
  const st = store();
  fs.writeFileSync(st.file, JSON.stringify({ v: 1, tasks: [task({ project: P, external: true }), task({ project: P })], counters: {} }));
  const [ext, plain] = (await st.s.read()).board.tasks;
  await assert.rejects(st.s.update(ext.id, { decompose: true }), { code: "external_task" });
  await assert.rejects(st.s.markExternal(plain.id, true, null, () => {}), { code: "invalid_task" });
  await assert.rejects(st.s.markExternal(ext.id, true, "x".repeat(301), () => {}), { code: "invalid_task" });
  const marked = await st.s.markExternal(ext.id, true, "MR !12 merged", () => {});
  assert.deepEqual([marked.externalDone.by, marked.externalDone.note, typeof marked.externalDone.at], ["person", "MR !12 merged", "string"]);
  const off = await st.s.markExternal(ext.id, false, null, () => {});
  assert.equal("externalDone" in off, false);
  assert.equal("externalDone" in st.json().tasks[0], false);
});

test("import (F2): external accepted — without criteria Loom's one line, the same file again unchanged; a file without external takes it off", async () => {
  const st = store();
  let rows = await imp(st, [row("T1"), row("T1-MR", { criteria: undefined, external: true, dependsOn: ["T1"] })]);
  assert.deepEqual([rows.created.map((x) => x.ref), rows.refused], [["T1", "T1-MR"], []]);
  const mr = byRef(st, "T1-MR");
  assert.deepEqual([mr.external, mr.criteria], [true, [EXTERNAL_CRITERION]]);
  rows = await imp(st, [row("T1"), row("T1-MR", { criteria: undefined, external: true, dependsOn: ["T1"] })]);
  assert.deepEqual(rows.unchanged, ["T1", "T1-MR"], "Loom's line counts as «no criteria»");
  // an external task with criteria of its own keeps them
  rows = await imp(st, [row("E2", { external: true })]);
  assert.deepEqual(byRef(st, "E2").criteria, ["E2 готово"]);
  // marked, then the same row again: unchanged, the mark stays; a changed title keeps the mark
  await st.s.markExternal(mr.id, true, null, () => {});
  assert.deepEqual((await imp(st, [row("T1-MR", { criteria: undefined, external: true, dependsOn: ["T1"] })])).unchanged, ["T1-MR"]);
  assert.deepEqual((await imp(st, [row("T1-MR", { title: "MR T1 влит", criteria: undefined, external: true, dependsOn: ["T1"] })])).updated.map((x) => x.ref), ["T1-MR"]);
  assert.equal(byRef(st, "T1-MR").externalDone.by, "person");
  // the file without external (with criteria now): the mark and the field are taken off; without criteria → no_criteria
  assert.deepEqual(codes(await imp(st, [row("T1-MR", { criteria: undefined, dependsOn: ["T1"] })])), [["T1-MR", "no_criteria"]]);
  rows = await imp(st, [row("T1-MR", { dependsOn: ["T1"] })]);
  assert.deepEqual(rows.updated.map((x) => x.ref), ["T1-MR"]);
  assert.deepEqual([byRef(st, "T1-MR").external, byRef(st, "T1-MR").externalDone], [undefined, undefined]);
  // external must be true
  assert.deepEqual(codes(await imp(st, [row("E3", { external: false })])), [["E3", "invalid_task"]]);
  // the inbox list says which rows are external
  const { inboxTasks } = await import("../src/main/services/orchestration/boardImport.ts");
  assert.deepEqual(inboxTasks(Buffer.from(JSON.stringify({ tasks: [row("A"), row("B", { external: true })] }))).map((x) => x.external), [false, true]);
});

test("import (F2): models accepted and over the profile; null or an unknown role → invalid_task; a file without models takes them off; scope still field_not_supported (issue and commitTitle: F3)", async () => {
  const st = store();
  let rows = await imp(st, [row("T1", { models: { executor: "opus", lead: "gpt-5.5:high" } }), row("T2", { models: { executor: null } }), row("T3", { models: { writer: "x" } }),
    row("T4", { models: { executor: "bad model" } }), row("T5", { models: {} })]);
  assert.deepEqual(codes(rows), [["T2", "invalid_task"], ["T3", "invalid_task"], ["T4", "invalid_task"]]);
  assert.deepEqual(byRef(st, "T1").models, { executor: "opus", lead: "gpt-5.5:high" });
  assert.equal("models" in byRef(st, "T5"), false, "an empty object: the profile's models");
  // the same models in another key order: unchanged; other models: updated; none: taken off
  assert.deepEqual((await imp(st, [row("T1", { models: { lead: "gpt-5.5:high", executor: "opus" } })])).unchanged, ["T1"]);
  assert.deepEqual((await imp(st, [row("T1", { models: { executor: "sonnet" } })])).updated.map((x) => x.ref), ["T1"]);
  assert.deepEqual(byRef(st, "T1").models, { executor: "sonnet" });
  rows = await imp(st, [row("T1")]);
  assert.deepEqual([rows.updated.map((x) => x.ref), "models" in byRef(st, "T1")], [["T1"], false]);
  for (const [field, value] of [["scope", ["docs/**"]]]) {
    assert.deepEqual(codes(await imp(st, [row("X", { [field]: value })])), [["X", "field_not_supported"]], field);
  }
});

// ---------------- the manager: «Выполнено», «Снять отметку», external_task ----------------

function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
function script(answers) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  answers.forEach((a, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer));
    if (a.writes) fs.writeFileSync(path.join(dir, `${i + 1}.writes.json`), JSON.stringify(a.writes));
  });
  return dir;
}
const C1 = { keep: null, text: "a.txt says 2", covers: ["R1"], evidence: { kind: "change", check: null } };
const PLAN = { answer: { stages: [{ title: "fix", task: "make a.txt say 2", conditions: [C1] }], dropped: [], dropRequirements: [], question: null } };
const REVIEW = { answer: { conditions: [{ id: "C1", status: "met", paths: ["a.txt"], note: "a.txt says 2" }], findings: [], request: "none", question: null } };
const FINAL = { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "a.txt says 2" }] } };
const EXEC = { answer: { summary: "done", done: true }, writes: [{ rel: "a.txt", base64: Buffer.from("2\n").toString("base64") }] };
function manager({ platform = "darwin", arch = "arm64", env = {}, root = path.join(TMP, `root-${++n}`), board } = {}) {
  const state = fs.mkdtempSync(path.join(TMP, "state-"));
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: state, MOCK_SCRIPT: script([PLAN, EXEC, REVIEW, FINAL, PLAN]), MOCK_CHECKS: "none", ...env } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  const m = createRunManager({ platform, arch, root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true, ...(board ? { board } : {}) });
  return Object.assign(m, { root, state });
}
function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync(GIT, a, { cwd: dir, env: GIT_ENV });
  return dir;
}
const until = async (fn, what, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
};
const boardFile = (root, tasks) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "board.json"), JSON.stringify({ v: 1, tasks, counters: { [WS]: 9 } })); };
const goalOf = (t, over = {}) => ({ text: "a to 2", criteria: ["a.txt says 2"], checks: [], commands: [], mode: "autopilot", task: { id: t.id, key: t.key }, ...over });
// Fake Electron: the main window's top frame; handleMain as registerIpc wraps it
function ipc(m) {
  const wc = Object.assign(new EventEmitter(), { id: 1, mainFrame: { id: "frame" }, isDestroyed: () => false, send() {} });
  const handlers = new Map();
  registerOrchestrationIpc((channel, listener) => handlers.set(channel, (event, ...args) => {
    assertMainRenderer(event, () => ({ isDestroyed: () => false, webContents: wc }));
    return listener(event, ...args);
  }), m);
  return { invoke: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args)),
    other: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: wc, senderFrame: { id: "iframe" } }, ...args)) };
}

test("«Выполнено» / «Снять отметку»: deps_not_done, then the mark with its note; undone while no dependent began, dependents_started after; external_task for a start and a split", OPTS, async () => {
  const src = project();
  const t1 = task({ project: src, ref: "T1" });
  const mr = task({ project: src, ref: "T1-MR", external: true, criteria: [EXTERNAL_CRITERION], dependsOn: [t1.id] });
  const t2 = task({ project: src, ref: "T2", dependsOn: [mr.id] });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, mr, t2]);
  const m = manager({ root });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["false"] });
  const { invoke, other } = ipc(m);
  // its own dependency is not «Done»
  const early = await invoke(IPC.orchestrationBoardExternalMark, mr.id, true);
  assert.deepEqual([early.code, early.message], ["deps_not_done", `${mr.key} waits for ${t1.key}`]);
  // never started, never split: by the person's start, by the autopilot's start, by «Разбить»
  assert.equal((await m.create({ requestId: randomUUID(), source: src, goal: goalOf(mr) })).code, "external_task");
  assert.equal((await m.boardUpdate(mr.id, { decompose: true })).code, "external_task");
  assert.equal((await m.boardDecompose(mr.id, "ru")).code, "external_task");
  // T1 runs (no checks) and the person accepts it
  const r1 = randomUUID();
  assert.ok((await m.create({ requestId: r1, source: src, goal: goalOf(t1) })).ok);
  await until(async () => (await m.get(r1)).value.view.status === "completed", "T1 completed");
  assert.ok((await m.boardAccept(t1.id)).ok);
  // IPC: the note up to 300, a boolean, a note only with «Done»; the main window's top frame only
  assert.equal((await invoke(IPC.orchestrationBoardExternalMark, mr.id, true, "x".repeat(301))).code, "invalid_argument");
  assert.equal((await invoke(IPC.orchestrationBoardExternalMark, mr.id, "yes")).code, "invalid_argument");
  assert.equal((await invoke(IPC.orchestrationBoardExternalMark, mr.id, false, "note")).code, "invalid_argument");
  await assert.rejects(other(IPC.orchestrationBoardExternalMark, mr.id, true));
  const runsBefore = fs.readdirSync(path.join(m.root, "runs")).length;
  const marked = await invoke(IPC.orchestrationBoardExternalMark, mr.id, true, "MR !1 влит");
  assert.ok(marked.ok, JSON.stringify(marked));
  assert.deepEqual([marked.value.externalDone.by, marked.value.externalDone.note], ["person", "MR !1 влит"]);
  let v = (await m.board()).value;
  const st = boardStatuses(v.board, v.facts, v.heads ?? []);
  assert.deepEqual([st.get(mr.id).done, st.get(t1.id).done, st.get(t2.id).column, st.get(t2.id).reason], ["external", "accepted", "queue", null]);
  assert.equal(fs.readdirSync(path.join(m.root, "runs")).length, runsBefore, "the mark starts nothing");
  assert.equal(v.board.tasks.length, 3, "deletes nothing");
  // undone while T2 has not begun; marked again
  assert.ok((await invoke(IPC.orchestrationBoardExternalMark, mr.id, false)).ok);
  v = (await m.board()).value;
  assert.equal(boardStatuses(v.board, v.facts).get(t2.id).reason, "waits_external");
  assert.equal((await m.create({ requestId: randomUUID(), source: src, goal: goalOf(t2, { reviewPlan: true }) })).code, "task_not_ready", "the dependent waits for the mark");
  assert.ok((await invoke(IPC.orchestrationBoardExternalMark, mr.id, true)).ok);
  // T2 starts (and waits for the plan's review): the mark can no longer be taken off
  const r2 = randomUUID();
  assert.ok((await m.create({ requestId: r2, source: src, goal: goalOf(t2, { reviewPlan: true }) })).ok);
  await until(async () => (await m.get(r2)).value.view.reason === "plan_review", "the plan review");
  const late = await invoke(IPC.orchestrationBoardExternalMark, mr.id, false);
  assert.deepEqual([late.code, late.message], ["dependents_started", `${t2.key} began after it`]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.root, "board.json"), "utf8")).tasks.find((t) => t.id === mr.id).externalDone.by, "person");
  // a mark on a task that is not external
  assert.equal((await m.boardExternalMark(t1.id, true)).code, "invalid_task");
  await m.shutdown();
});

test("external_has_runs: an external task with runs of its own goes by them — started like any task, no mark offered", OPTS, async () => {
  const src = project();
  const ext = task({ project: src, external: true });
  const root = path.join(TMP, `root-${++n}`);
  // a run of it from a build that did not know external (a rollback, §9): written as the journal of a real run
  boardFile(root, [{ ...ext, external: undefined }]);
  const m = manager({ root });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["false"] });
  const r = randomUUID();
  assert.ok((await m.create({ requestId: r, source: src, goal: goalOf(ext, { reviewPlan: true }) })).ok);
  await until(async () => (await m.get(r)).value.view.reason === "plan_review", "the plan review");
  await m.shutdown();
  boardFile(root, [ext]);
  const again = manager({ root });
  const v = (await again.board()).value;
  // by its run: waits for the plan's review (its run's own reason; external_has_runs where the run leaves none — own above)
  const st = boardStatuses(v.board, v.facts).get(ext.id);
  assert.deepEqual([st.column, st.reason, st.attempts, st.done], ["work", "waits_decision", 1, null]);
  assert.equal((await again.boardExternalMark(ext.id, true)).code, "external_has_runs");
  assert.equal((await again.create({ requestId: randomUUID(), source: src, goal: goalOf(ext) })).code, "task_active_run", "a start goes by its runs (one at a time), never external_task");
  await again.shutdown();
});

for (const [platform, arch] of [["linux", "arm64"], ["darwin", "x64"]]) {
  test(`${platform}/${arch}: «Выполнено» and «Снять отметку» → unsupported_platform, the mark not written`, async () => {
    const ext = task({ project: P, external: true });
    const root = path.join(TMP, `root-${++n}`);
    const marked = { ...task({ project: P, external: true }), externalDone: MARK };
    boardFile(root, [ext, marked]);
    const before = fs.readFileSync(path.join(root, "board.json"), "utf8");
    const m = manager({ platform, arch, root });
    assert.equal((await m.boardExternalMark(ext.id, true)).code, "unsupported_platform");
    assert.equal((await m.boardExternalMark(marked.id, false)).code, "unsupported_platform");
    assert.equal(fs.readFileSync(path.join(root, "board.json"), "utf8"), before);
    assert.deepEqual(JSON.parse(before).tasks.find((x) => x.id === marked.id).externalDone, MARK);
    await m.shutdown();
  });
}

// ---------------- T-4: the task's model in the run, and an unknown Codex model ----------------

const lines = (m, file) => {
  const f = path.join(m.state, file);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
async function linkOf(m, src) {
  const at = (x) => ({ position: { x, y: 0 }, size: { width: 300, height: 200 } });
  const [lead, exec, linkId] = [randomUUID(), randomUUID(), randomUUID()];
  assert.ok((await m.createAgent({ agentId: lead, provider: "codex", project: src, bounds: at(0) })).ok);
  assert.ok((await m.createAgent({ agentId: exec, provider: "claude", project: src, bounds: at(400) })).ok);
  assert.ok((await m.createLink({ linkId, fromAgentId: lead, toAgentId: exec })).ok);
  return linkId;
}

test("T-4: the goal of a task's start carries its models over the profile's — the fake CLIs get them; an unknown Codex model is a readiness blocker and a refused start", OPTS, async () => {
  const src = project();
  const profileModels = { lead: "gpt-mock", executor: "sonnet", reviewer: null };
  const withModel = task({ project: src, models: { executor: "opus", reviewer: "gpt-mock-mini" } });
  const without = task({ project: src });
  const unknown = task({ project: src, models: { lead: "gpt-nope" } });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [withModel, without, unknown]);
  const m = manager({ root });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["grep -qx 2 a.txt"], models: profileModels });
  const profile = (await createProfileStore(m.root).get(src));
  const linkId = await linkOf(m, src);
  const goal = (t) => goalFor(t, profile, { optionalChecks: true, language: "en", base: null });
  // the task's model: in the run's goal and with the CLI (claude --model, the reviewer's Codex thread)
  const r = await m.startOnLink({ linkId, requestId: randomUUID(), goal: goal(withModel) });
  assert.ok(r.ok, JSON.stringify(r));
  const v = await until(async () => { const x = (await m.get(r.value.runId)).value.view; return ["completed", "paused", "failed"].includes(x.status) ? x : null; }, "the run's end");
  assert.equal(v.status, "completed", JSON.stringify([v.status, v.reason]));
  assert.deepEqual(v.progress.models, { lead: "gpt-mock", executor: "opus", reviewer: "gpt-mock-mini" });
  const argv = lines(m, "claude-argv.jsonl").at(-1);
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "opus"]);
  assert.deepEqual(lines(m, "codex-thread.jsonl").map((x) => x.model), ["gpt-mock", "gpt-mock-mini", "gpt-mock-mini"]);
  // no models of its own: the profile's (in the readiness the autopilot asks)
  const ready = await m.readiness({ linkId, commands: ["true"], workMode: "project", models: goal(without).models });
  const facts = ready.value.items.find((i) => i.id === "model").facts;
  assert.deepEqual([facts.lead, facts.executor, facts.reviewer], ["gpt-mock", "sonnet", "cli"]);
  // an unknown Codex model of the task: the readiness blocker model_unavailable and the same code for the start, no thread
  const threads = lines(m, "codex-thread.jsonl").length;
  const blocked = await m.readiness({ linkId, commands: ["true"], workMode: "project", models: goal(unknown).models });
  const item = blocked.value.items.find((i) => i.id === "model");
  assert.deepEqual([blocked.value.ready, item.level, item.facts.code, item.facts.model, item.facts.source], [false, "blocker", "model_unavailable", "gpt-nope", "chosen"]);
  const refused = await m.startOnLink({ linkId, requestId: randomUUID(), goal: goal(unknown) });
  assert.equal(refused.code, "model_unavailable");
  assert.equal(lines(m, "codex-thread.jsonl").length, threads, "no thread was started");
  await m.shutdown();
});

// ---------------- the review of F2 ----------------

test("«Запустить всё равно»: a text for every reason of depsWait in both languages (waits_external too)", () => {
  for (const locale of ["ru", "en"]) {
    for (const reason of ["waits_task", "waits_result", "waits_merge", "waits_head", "waits_external"]) {
      const text = words(locale, `boardStartAnywayWhy_${reason}`);
      assert.ok(typeof text === "string" && text.includes("{keys}"), `${locale} ${reason}: ${text}`);
    }
  }
});

test("an archived external task not marked: nobody can mark it (task_archived) — no wait for it, off / others_wait as before F2", () => {
  const t1 = task();
  const ext = task({ external: true, dependsOn: [t1.id], archivedAt: "2026-10-21T00:00:00.000Z" });
  const t2 = task({ dependsOn: [ext.id] });
  const r1 = done(t1);
  const board = { tasks: [t1, ext, t2] };
  assert.equal(externalWait(board, boardStatuses(board, [r1]), AT), null);
  const s = autopilotStep(board, [r1], AT, null, NONE, AUTOPILOT_BUDGET);
  assert.deepEqual([s.kind, s.code], ["off", "others_wait"]);
  const lone = { tasks: [task({ external: true, archivedAt: "2026-10-21T00:00:00.000Z" }), task()] };
  assert.notEqual(autopilotStep(lone, [], AT, null, NONE, AUTOPILOT_BUDGET).why, "external");
});

test("a marked external task loses its mark only by an added dependency — by the form (update) and by an import; narrower or the same set (any order) keeps it", async () => {
  const st = store();
  const [a, b, c] = [task({ project: P }), task({ project: P }), task({ project: P })];
  const ext = task({ project: P, external: true, dependsOn: [a.id, b.id], externalDone: MARK });
  fs.writeFileSync(st.file, JSON.stringify({ v: 1, tasks: [a, b, c, ext], counters: {} }));
  const markOf = () => st.json().tasks.find((t) => t.id === ext.id).externalDone;
  // the same set in another order, with a new title: kept
  assert.deepEqual((await st.s.update(ext.id, { title: "renamed", dependsOn: [b.id, a.id] })).externalDone, MARK);
  // narrower: kept
  assert.deepEqual((await st.s.update(ext.id, { dependsOn: [a.id] })).externalDone, MARK);
  assert.deepEqual(markOf(), MARK);
  // added, a direct dependent begun (the caller's facts): refused, the mark and the dependencies as they were
  const begun = async (_b, t) => (t.id === ext.id ? ["T-77"] : []);
  await assert.rejects(st.s.update(ext.id, { dependsOn: [a.id, c.id] }, begun), { code: "dependents_started" });
  assert.deepEqual([markOf(), st.json().tasks.find((t) => t.id === ext.id).dependsOn], [MARK, [a.id]]);
  // added, nobody begun: taken off
  const changed = await st.s.update(ext.id, { dependsOn: [a.id, c.id] }, async () => []);
  assert.equal("externalDone" in changed, false);
  assert.equal(markOf(), undefined);
  // without the caller's facts the board's own: a dependent with a mark of its own has begun
  const st2 = store();
  const ext2 = task({ project: P, external: true, dependsOn: [a.id], externalDone: MARK });
  const dep2 = task({ project: P, external: true, dependsOn: [ext2.id], externalDone: MARK });
  fs.writeFileSync(st2.file, JSON.stringify({ v: 1, tasks: [a, b, ext2, dep2], counters: {} }));
  await assert.rejects(st2.s.update(ext2.id, { dependsOn: [a.id, b.id] }), { code: "dependents_started" });

  // the import, the same rules: a row adding a dependency with a begun dependent is refused dependents_started
  const im = store();
  const extRow = (deps, over = {}) => row("T1-MR", { criteria: undefined, external: true, dependsOn: deps, ...over });
  await imp(im, [row("T0"), row("T1"), row("T9"), extRow(["T1", "T0"]), row("T2", { dependsOn: ["T1-MR"] })]);
  await im.s.markExternal(byRef(im, "T1-MR").id, true, null, async () => {});
  // the same set in another order (a new title): kept
  assert.deepEqual((await imp(im, [extRow(["T0", "T1"], { title: "MR влит" })])).updated.map((x) => x.ref), ["T1-MR"]);
  assert.equal(byRef(im, "T1-MR").externalDone.by, "person");
  // narrower: kept
  assert.deepEqual((await imp(im, [extRow(["T1"])])).updated.map((x) => x.ref), ["T1-MR"]);
  assert.equal(byRef(im, "T1-MR").externalDone.by, "person");
  // added while T2 (a direct dependent) has runs (started): refused, nothing changed
  const job = await readTasksFile("tasks.json", Buffer.from(JSON.stringify({ format: "board-tasks/v1", workspace: "acme", tasks: [extRow(["T1", "T9"])] })), WORKSPACES);
  const out = await im.s.importTasks(job.job, async () => new Set([byRef(im, "T2").id]), () => true);
  assert.deepEqual(codes(out.rows), [["T1-MR", "dependents_started"]]);
  assert.deepEqual([byRef(im, "T1-MR").externalDone.by, byRef(im, "T1-MR").dependsOn], ["person", [byRef(im, "T1").id]]);
  // added, nobody begun: taken off
  assert.deepEqual((await imp(im, [extRow(["T1", "T9"])])).updated.map((x) => x.ref), ["T1-MR"]);
  assert.equal(byRef(im, "T1-MR").externalDone, undefined);
});

test("externalDone only with external: true — on an ordinary task in board.json it is dropped, and an import making it external does not make it «Done»", async () => {
  const st = store();
  const x = task({ project: P, ref: "X", externalDone: MARK });
  fs.writeFileSync(st.file, JSON.stringify({ v: 1, tasks: [x], counters: {} }));
  const r = await st.s.read();
  assert.equal("externalDone" in r.board.tasks[0], false);
  assert.equal(boardStatuses(r.board, []).get(x.id).done, null);
  assert.deepEqual((await imp(st, [row("X", { external: true })])).updated.map((u) => u.ref), ["X"]);
  const after = byRef(st, "X");
  assert.deepEqual([after.external, after.externalDone], [true, undefined]);
  assert.equal(boardStatuses(st.json(), []).get(x.id).done, null);
});

// refuses: how many starts in a row are refused task_not_ready before one goes
const refusingPilot = (refuses) => {
  const { t1, mr, t2, marked } = chain();
  const facts = [done(t1)];
  let left = refuses;
  const starts = [];
  const profile = { access: { claude: "workspace", codex: "workspace" }, workMode: "project", checks: ["true"], finish: { commit: false, push: false, qa: false }, grants: [] };
  const LINK = randomUUID();
  const ap = createBoardAutopilot({
    view: async () => ({ board: { v: 1, tasks: [t1, marked(), t2], counters: {} }, facts: [...facts] }),
    link: async () => ({ workspaceId: WS, project: "/p" }), profile: async () => profile, optionalChecks: true, journal: async () => [],
    readiness: async () => ({ ok: true, value: { ready: true, items: [] } }),
    start: async ({ requestId, goal }) => {
      starts.push(goal.task.key);
      if (left > 0) { left--; return { ok: false, code: "task_not_ready", message: `${goal.task.key} waits for ${mr.key}: start anyway?` }; }
      facts.push(run({ runId: requestId, taskId: goal.task.id, taskKey: goal.task.key }));
      return { ok: true, value: { runId: requestId, created: true } };
    },
    take: async () => ({ ok: true, value: { result: "created" } }), head: async () => null, ensureHead: async () => {}, merge: async () => ({ ok: false, code: "x", message: "" }),
    newId: () => randomUUID(), now: () => Date.now()
  }, async () => AUTOPILOT_BUDGET, 3_600_000);
  return { ap, LINK, t2, starts };
};
test("controller: a start refused task_not_ready (a mark taken off while the start was checked) — the step is decided again, never start_failed", async () => {
  const { ap, LINK, t2, starts } = refusingPilot(1);
  await ap.set(LINK, true, "ru");
  await ap.tick(LINK);
  let st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.stop, starts], [true, null, [t2.key]]);
  await ap.tick(LINK);
  st = (await ap.state())[LINK];
  assert.deepEqual([st.on, starts], [true, [t2.key, t2.key]]);
  ap.shutdown();
});

test("controller: task_not_ready twice in a row for the same task — decided again once, then off with start_failed (no endless «waits for a start»)", async () => {
  const { ap, LINK, t2, starts } = refusingPilot(5);
  await ap.set(LINK, true, "ru");
  await ap.tick(LINK);
  assert.deepEqual([(await ap.state())[LINK].on, starts], [true, [t2.key]]);
  await ap.tick(LINK);
  const st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.stop?.code, st.stop?.detail, starts], [false, "start_failed", "task_not_ready", [t2.key, t2.key]]);
  await ap.tick(LINK);
  assert.equal(starts.length, 2, "no start once off");
  ap.shutdown();
});

// the runs appear between the call and the check: the facts are read inside the board's queue (review of F2) — the
// queue held by a gate, so the order is fixed: the call, the run in place, then the check
test("«Выполнено» / «Снять отметку» read the runs inside the board's queue: a run finished after the call is seen — no deps_not_done, dependents_started", OPTS, async () => {
  const src = project();
  const t1 = task({ project: src, ref: "T1" });
  const mr = task({ project: src, ref: "T1-MR", external: true, criteria: [EXTERNAL_CRITERION], dependsOn: [t1.id] });
  const t2 = task({ project: src, ref: "T2", dependsOn: [mr.id] });
  const root = path.join(TMP, `root-${++n}`);
  // the runs made beforehand (T2 not depending on anything then), then put aside
  boardFile(root, [t1, mr, { ...t2, dependsOn: [] }]);
  const first = manager({ root });
  await createProfileStore(first.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["false"] });
  const [r1, r2] = [randomUUID(), randomUUID()];
  assert.ok((await first.create({ requestId: r1, source: src, goal: goalOf(t1) })).ok);
  await until(async () => (await first.get(r1)).value.view.status === "completed", "T1 completed");
  assert.ok((await first.create({ requestId: r2, source: src, goal: goalOf(t2, { reviewPlan: true }) })).ok);
  await until(async () => (await first.get(r2)).value.view.reason === "plan_review", "the plan review");
  await first.shutdown();
  const runs = path.join(root, "runs");
  const aside = path.join(root, "aside");
  fs.mkdirSync(aside);
  for (const id of [r1, r2]) fs.renameSync(path.join(runs, id), path.join(aside, id));
  const t0 = task({ project: src, ref: "T0" });
  boardFile(root, [{ ...t1, accepted: { runId: r1, at: "2026-10-21T10:00:00.000Z" } }, mr, t2, t0]);
  const store = createBoardStore(path.join(root, "board.json"));
  // reached: the call has got to the store's markExternal (whatever main read before it is read by then)
  let reached;
  const m = manager({ root, board: { ...store, markExternal: (...a) => { reached(); return store.markExternal(...a); } } });
  // the board's queue held by a gate: an import (no rows) whose started() waits inside the queue
  const held = () => {
    let open;
    const gate = new Promise((r) => { open = r; });
    const done = store.importTasks({ workspaceId: WS, rows: [], origin: null }, () => gate.then(() => new Set()), () => true);
    const at = new Promise((r) => { reached = r; });
    return { open, done, at };
  };
  // «Выполнено»: T1's accepted run is there only after the call, before the queue gets to it
  let g = held();
  const mark = m.boardExternalMark(mr.id, true);
  await g.at;
  fs.renameSync(path.join(aside, r1), path.join(runs, r1));
  g.open();
  await g.done;
  const marked = await mark;
  assert.ok(marked.ok, JSON.stringify(marked));
  // «Снять отметку»: T2's run is there only after the call
  g = held();
  const off = m.boardExternalMark(mr.id, false);
  await g.at;
  fs.renameSync(path.join(aside, r2), path.join(runs, r2));
  g.open();
  await g.done;
  assert.deepEqual([(await off).code], ["dependents_started"]);
  const mrNow = () => JSON.parse(fs.readFileSync(path.join(root, "board.json"), "utf8")).tasks.find((t) => t.id === mr.id);
  assert.equal(mrNow().externalDone.by, "person");
  // a dependency added to the marked task while T2 has a run: the form and the import are refused, the mark kept
  assert.equal((await m.boardUpdate(mr.id, { dependsOn: [t1.id, t0.id] })).code, "dependents_started");
  const file = Buffer.from(JSON.stringify({ format: "board-tasks/v1", workspaceId: WS, tasks: [{ ref: "T1-MR", project: src, title: mr.title, text: mr.text, external: true, dependsOn: ["T1", "T0"] }] }));
  const checked = (await m.boardImportCheck("tasks.json", file)).value;
  assert.deepEqual(checked.refused.map((x) => [x.ref, x.code]), [["T1-MR", "dependents_started"]]);
  assert.deepEqual([mrNow().externalDone.by, mrNow().dependsOn], ["person", [t1.id]]);
  // narrower: the form passes, the mark kept
  assert.ok((await m.boardUpdate(mr.id, { dependsOn: [] })).ok);
  assert.equal(mrNow().externalDone.by, "person");
  await m.shutdown();
});
