// E3 (docs/agent-orchestration/implementation/stage-e-decomposition.md §7, §2.2): the board's autopilot splits tasks.
// Pure steps (one test per row of the §7 table), the runner over stand-in calls (budget, minutes, limits, refusals), then
// the autopilot through the manager on fake CLIs (see the second half of this file).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardAutopilot } from "../src/main/services/orchestration/boardAutopilot.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { AUTOPILOT_BUDGET, LIMIT_MARGIN_MS, autopilotParallelStep, autopilotStep, boardStatuses, limitStep } from "../src/shared/taskBoard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 300_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-e3-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const WS = "common";
const run = (over = {}) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: ++n, workspaceId: WS, status: "running", reason: null, newer: false, halted: false, limit: null,
  completion: null, phase: "work", permission: false, workMode: "copy", taken: null, ...over });
const task = (over = {}) => ({ id: randomUUID(), key: `T-${++n}`, workspaceId: WS, project: "/p", title: "t", text: "x", criteria: ["c"],
  dependsOn: [], order: n, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", archivedAt: null, accepted: null, ...over });
const AT = { workspaceId: WS, project: "/p", workMode: "copy" };
const PAT = { workspaceId: WS, project: "/p" };
const NONE = { runs: 0, ms: 0 };
const B = AUTOPILOT_BUDGET;
const C = (hex) => hex.repeat(40).slice(0, 40);
const done = (t, over = {}) => run({ taskId: t.id, taskKey: t.key, status: "completed", completion: "confirmed", ...over });
const parentOf = (over = {}) => task({ decompose: true, ...over });
const splitOf = (p, over = {}) => run({ decompositionOf: p.id, status: "running", ...over });
const head = (merges = []) => ({ workspaceId: WS, project: "/p", ref: `refs/raoden/board/${WS}/1`, n: 1, commit: C("a"), merges });
const merged = (t, r) => ({ runId: randomUUID(), board: head().ref, base: C("a"), task: { id: t.id, key: t.key, runId: r.runId, commit: C("b") }, status: "completed", reason: null,
  detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, dir: null, createdAt: ++n });
const seq = (tasks, facts, splits = [], over = {}) => autopilotStep({ tasks }, facts, AT, null, over.used ?? NONE, over.budget ?? B, over.limited ?? [], over.now ?? Date.now(), splits);
const par = (tasks, facts, splits = [], over = {}) => autopilotParallelStep({ tasks }, facts, PAT, [], over.used ?? NONE, over.budget ?? B, "head" in over ? over.head : head(), new Set(),
  over.limited ?? [], over.now ?? Date.now(), splits);

// ---------------- the decompose step ----------------

test("decompose: a marked parent goes before an ordinary task of a lower order, in both modes; one at a time in the project folder", () => {
  const o = task(), p = parentOf();
  for (const step of [seq, par]) {
    const s = step([o, p], []);
    assert.deepEqual([s.kind, s.task?.id], ["decompose", p.id], step.name);
  }
  // parallel: no head needed (main takes the head commit or HEAD)
  assert.equal(par([o, p], [], [], { head: null }).kind, "decompose");
  // the project folder: another run of the place goes on — nothing meanwhile
  const busy = run({ taskId: o.id, taskKey: o.key });
  assert.deepEqual(seq([o, p], [busy]), { kind: "wait", why: "run" });
  // the person's split of another parent goes on: one at a time too
  const q = parentOf();
  assert.deepEqual(seq([o, p, q], [splitOf(q)]), { kind: "wait", why: "run" });
});

test("decompose: not for a parent with any split, a decomposedBy, dependencies not ready or not in the head, a run of its own, archived, a subtask, unmarked", () => {
  const o = task({ order: 99 });
  const dep = task({ order: 98 });
  const cases = {
    "any split of it (the person's retry)": [parentOf(), (p) => [splitOf(p, { status: "failed" })]],
    "a split made": [parentOf({ decomposedBy: randomUUID() }), () => []],
    "a split of a rejected answer": [parentOf(), (p) => [splitOf(p, { status: "completed", split: "rejected" })]],
    "a split that said whole": [parentOf(), (p) => [splitOf(p, { status: "completed", split: "whole" })]],
    "a run of its own": [parentOf(), (p) => [run({ taskId: p.id, taskKey: p.key, status: "stopped" })]],
    "archived": [parentOf({ archivedAt: "x" }), () => []],
    "a subtask": [parentOf({ parentId: randomUUID() }), () => []],
    "not marked": [task(), () => []]
  };
  for (const [what, [p, facts]] of Object.entries(cases)) {
    for (const step of [seq, par]) {
      const s = step([p, o], facts(p));
      assert.notEqual(s.kind, "decompose", `${what} (${step.name})`);
    }
  }
  // dependencies not ready: the dependency goes first
  const waits = parentOf({ dependsOn: [dep.id], order: 1 });
  for (const step of [seq, par]) assert.deepEqual([step([waits, dep], []).kind, step([waits, dep], []).task?.id], ["start", dep.id], step.name);
  // a dependency «Done» but not in the board's head (parallel): waits_head, not split yet
  const rd = done(dep, { taken: { branch: "raoden/x", commit: C("c"), applied: false }, board: head().ref });
  assert.notEqual(par([waits, dep], [rd]).kind, "decompose");
  // ... in the head: it is
  assert.equal(par([waits, dep], [rd], [], { head: head([merged(dep, rd)]) }).kind, "decompose");
  // a dependency «Done» on a shaky base (depsNote): the person's call
  const shaky = task(), mid = task({ dependsOn: [shaky.id] }), top = parentOf({ dependsOn: [mid.id] });
  assert.notEqual(seq([shaky, mid, top], [done(mid, { workMode: "project" })]).kind, "decompose");
});

test("decompose: the budget (runs, minutes) before it as before a start; the slots: parallel 1 holds the others while a split goes on", () => {
  const p = parentOf();
  for (const step of [seq, par]) {
    assert.deepEqual([step([p], [], [], { used: { runs: 5, ms: 0 } }).code], ["budget_runs"], step.name);
    assert.deepEqual([step([p], [], [], { used: { runs: 1, ms: 240 * 60_000 } }).code], ["budget_minutes"], step.name);
  }
  // slots: parallel 1 — a task run holds the only one; the parent waits for it
  const o = task(), q = parentOf();
  const one = { ...B, parallel: 1 };
  assert.deepEqual(par([o, q], [run({ taskId: o.id, taskKey: o.key })], [], { budget: one }), { kind: "wait", why: "run" });
  // a split of the place (the person's, here) holds a slot: no other start meanwhile; with parallel 2 one is free
  const mine = splitOf(q);
  const other = task(), third = parentOf();
  assert.deepEqual(par([q, other], [mine], [], { budget: one }), { kind: "wait", why: "run" }, "parallel 1: nothing starts beside the split");
  assert.equal(par([q, other], [mine], [], { budget: { ...B, parallel: 2 } }).task?.id, other.id, "parallel 2: another start");
  assert.deepEqual(par([q, third, other], [mine, run({ taskId: other.id, taskKey: other.key })], [], { budget: { ...B, parallel: 2 } }), { kind: "wait", why: "run" }, "the split and the task fill both");
  // a paused split holds its slot too (it may go on); a finished one does not
  assert.deepEqual(par([q, other], [{ ...mine, status: "paused", reason: "environment_error" }], [], { budget: one }), { kind: "wait", why: "run" });
  assert.equal(par([q, other], [{ ...mine, status: "failed" }], [], { budget: one }).task?.id, other.id);
  // a split of a task of another place holds nothing here
  assert.equal(par([other], [splitOf({ id: randomUUID() })], [], { budget: one }).task?.id, other.id);
});

// ---------------- the autopilot's own splits (the table of §7) ----------------

const ROWS = [
  // [what, over the split fact | null: no fact yet, sequential, parallel with nothing else going on]
  ["no journal yet", null, { kind: "wait", why: "run" }],
  ["running", {}, { kind: "wait", why: "run" }],
  ["preparing", { status: "preparing" }, { kind: "wait", why: "run" }],
  ["a permission request", { permission: true }, { kind: "wait", why: "permission" }],
  ["a question of the lead", { status: "paused", reason: "awaiting_answer" }, { kind: "wait", why: "person" }],
  ["paused for another reason", { status: "paused", reason: "environment_error" }, { kind: "off", code: "run_paused", detail: "environment_error" }],
  ["paused at its turn limit", { status: "paused", reason: "limit_reached", limit: "turns" }, { kind: "off", code: "limit_reached", detail: "turns" }],
  ["failed", { status: "failed" }, { kind: "off", code: "decomposition_failed", detail: "failed" }],
  ["stopped", { status: "stopped" }, { kind: "off", code: "decomposition_failed", detail: "stopped" }],
  ["rejected", { status: "completed", split: "rejected" }, { kind: "off", code: "decomposition_failed", detail: "rejected" }],
  ["a proposal the board refused", { status: "completed", split: "proposed", splitFailed: "requirements_changed" }, { kind: "off", code: "decomposition_failed", detail: "requirements_changed" }],
  ["a proposal main has not made yet", { status: "completed", split: "proposed" }, { kind: "wait", why: "run" }],
  ["a newer version's journal", { newer: true, status: "paused", reason: "x" }, { kind: "off", code: "run_unreadable", detail: null }],
  ["unreadable", { status: "unreadable" }, { kind: "off", code: "run_unreadable", detail: null }]
];

test("own split, one test per row of §7: the sequential step and the parallel step stop, wait and go on by the same rules", () => {
  for (const [what, over, want] of ROWS) {
    const p = parentOf();
    const f = over && splitOf(p, over);
    const splits = [f ? f.runId : randomUUID()];
    for (const step of [seq, par]) {
      const s = step([p], f ? [f] : [], splits);
      assert.deepEqual({ ...s, key: undefined }, { ...want, key: undefined }, `${what} (${step.name})`);
      if (want.kind === "off" && over) assert.equal(s.key, p.key, `${what}: the parent's key`);
    }
  }
});

test("own split: halted (running, stopped by a condition in main) — off in the project folder; in a copy it is a run going on, as a task's is", () => {
  const p = parentOf();
  const f = splitOf(p, { halted: true, reason: "x" });
  assert.deepEqual([seq([p], [f], [f.runId]).code, seq([p], [f], [f.runId]).detail], ["run_paused", "x"]);
  assert.deepEqual(par([p], [f], [f.runId]), { kind: "wait", why: "run" });
});

test("own split: its parent deleted from the board stops it (task_gone); a person's split in the same states never does", () => {
  const f = splitOf({ id: randomUUID() }, { status: "failed" });
  for (const step of [seq, par]) assert.deepEqual([step([task()], [f], [f.runId]).kind, step([task()], [f], [f.runId]).code], ["off", "task_gone"], step.name);
  // the person's «Разбить»: not in splits — the parent is out of the queue (decomposition_failed), the autopilot goes on with the others
  for (const over of [{ status: "failed" }, { status: "stopped" }, { status: "completed", split: "rejected" }, { status: "completed", split: "proposed", splitFailed: "parent_gone" },
    { status: "paused", reason: "environment_error" }, { status: "paused", reason: "limit_reached", limit: "turns" }]) {
    const p = parentOf({ order: 1 }), o = task({ order: 99 });
    const mine = splitOf(p, over);
    for (const step of [seq, par]) {
      const s = step([p, o], [mine]);
      assert.deepEqual([s.kind, s.task?.id], ["start", o.id], `${JSON.stringify(over)} (${step.name})`);
    }
  }
});

test("own split: parallel — a stop waits while something else goes on, then stops; a question and a permission are the person's", () => {
  const p = parentOf(), o = task();
  const failed = splitOf(p, { status: "failed" });
  const working = run({ taskId: o.id, taskKey: o.key });
  assert.deepEqual(par([p, o], [failed, working], [failed.runId]), { kind: "wait", why: "run" });
  assert.deepEqual([par([p, o], [failed], [failed.runId]).code], ["decomposition_failed"]);
  // a moving split keeps the board going: never all_done / others_wait meanwhile
  const moving = splitOf(p);
  assert.deepEqual(par([p], [moving], [moving.runId]), { kind: "wait", why: "run" });
  // a question: the person's, wait with that
  const ask = splitOf(p, { status: "paused", reason: "awaiting_answer" });
  assert.deepEqual(par([p, o], [ask, run({ taskId: o.id, taskKey: o.key, status: "stopped" })], [ask.runId]), { kind: "wait", why: "person" });
});

test("limits: an own split paused at a provider's limit — wait, then its continuation after the reset and the margin; the limit comes before a new split", () => {
  const p = parentOf(), q = parentOf();
  const f = splitOf(p, { status: "paused", reason: "environment_error", providerLimit: { provider: "codex", resetsAt: 10_000_000 } });
  const lim = (over = {}) => [{ runId: f.runId, key: p.key, provider: "codex", resetsAt: 10_000_000, own: true, resumes: 0, ...over }];
  for (const step of [seq, par]) {
    const w = step([p, q], [f], [f.runId], { limited: lim(), now: 10_000_000 });
    assert.deepEqual([w.kind, w.why, w.limit.key, w.limit.provider], ["wait", "provider_limit", p.key, "codex"], step.name);
    const r = step([p, q], [f], [f.runId], { limited: lim(), now: 10_000_000 + LIMIT_MARGIN_MS });
    assert.deepEqual([r.kind, r.runId, r.key], ["resume", f.runId, p.key], step.name);
  }
  // not own (the person's split): limitStep never continues it
  assert.equal(limitStep(lim({ own: false }), 99_000_000).kind, "wait");
  // three continuations in a row, then the person's
  assert.equal(limitStep(lim({ resumes: 3 }), 99_000_000).limit.repeated, true);
});

test("after «proposed» is made the subtasks are taken, the parent only after all its subtasks are in the head; a split that said whole is an ordinary task", () => {
  const rid = randomUUID();
  const s1 = task({ parentId: undefined }), s2 = task({ dependsOn: [s1.id] });
  const p = parentOf({ decomposedBy: rid, dependsOn: [s1.id, s2.id] });
  s1.parentId = p.id; s2.parentId = p.id;
  const fact = splitOf(p, { runId: rid, status: "completed", split: "proposed" });
  assert.deepEqual([par([p, s1, s2], [fact], [rid]).task?.id, par([p, s1, s2], [fact], [rid]).kind], [s1.id, "start"]);
  assert.equal(seq([p, s1, s2], [fact], [rid]).task.id, s1.id);
  // S1 in the head: S2 next; the parent still waits
  const r1 = done(s1, { taken: { branch: "raoden/s1", commit: C("b"), applied: false }, board: head().ref });
  const h1 = head([merged(s1, r1)]);
  assert.equal(par([p, s1, s2], [fact, r1], [rid], { head: h1 }).task.id, s2.id);
  // both in the head: the parent is an ordinary task now
  const r2 = done(s2, { taken: { branch: "raoden/s2", commit: C("c"), applied: false }, board: head().ref });
  const h2 = head([merged(s2, r2), merged(s1, r1)]);
  const all = par([p, s1, s2], [fact, r1, r2], [rid], { head: h2 });
  assert.deepEqual([all.kind, all.task?.id], ["start", p.id]);
  // an archived subtask holds nothing (§2.2): S2 archived, S1 in the head — the parent goes
  const s = par([p, s1, { ...s2, archivedAt: "x" }], [fact, r1], [rid], { head: h1 });
  assert.deepEqual([s.kind, s.task?.id], ["start", p.id]);
  // whole: the parent is taken as an ordinary task (not split again)
  const w = parentOf(), whole = splitOf(w, { status: "completed", split: "whole" });
  for (const step of [seq, par]) assert.deepEqual([step([w], [whole], [whole.runId]).kind, step([w], [whole], [whole.runId]).task?.id], ["start", w.id], step.name);
  // while the lead has not answered, or the proposal has not become subtasks, the parent is not run whole
  assert.notEqual(par([w], [splitOf(w, { status: "completed", split: "proposed" })]).kind, "start");
  // the person's split in the same place: the parent decomposed at last, the autopilot does not take it whole
  assert.notEqual(seq([w], [splitOf(w, { status: "failed" })]).kind, "start");
});

test("a parent in the archive: its subtasks are not taken (a missing parent: they are); the parent's own states keep it out of the queue", () => {
  const p = parentOf({ archivedAt: "x", decomposedBy: randomUUID() });
  const s1 = task({ parentId: p.id });
  for (const step of [seq, par]) {
    const s = step([p, s1], []);
    assert.equal(s.kind, "off", step.name);
    assert.equal(s.code, "others_wait", step.name);
  }
  const lone = task({ parentId: randomUUID() });
  for (const step of [seq, par]) assert.equal(step([lone], []).kind, "start", step.name);
  // decomposition_failed / decomposition_paused / subtasks_gone: out of the queue-with-no-reason, never started whole
  for (const [over, p2, why] of [
    [{ status: "failed" }, parentOf(), "decomposition_failed"],
    [{ status: "paused", reason: "environment_error" }, parentOf(), "decomposition_paused"],
    [{ status: "completed", split: "rejected" }, parentOf(), "decomposition_failed"]]) {
    const f = splitOf(p2, over);
    const st = boardStatuses({ tasks: [p2] }, [f]).get(p2.id);
    assert.equal(st.reason, why);
    for (const step of [seq, par]) assert.notEqual(step([p2], [f]).kind, "start", `${why} (${step.name})`);
  }
  const gone = parentOf({ decomposedBy: randomUUID() });
  assert.equal(boardStatuses({ tasks: [gone] }, []).get(gone.id).reason, "subtasks_gone");
  for (const step of [seq, par]) assert.notEqual(step([gone], []).kind, "start", step.name);
});

test("two parallel subtasks with a merge conflict: they are ordinary tasks to the C3 path — a paused merge goes to an agent (or the person's)", () => {
  const rid = randomUUID();
  const s1 = task(), s2 = task();
  const p = parentOf({ decomposedBy: rid, dependsOn: [s1.id, s2.id] });
  s1.parentId = p.id; s2.parentId = p.id;
  const fact = splitOf(p, { runId: rid, status: "completed", split: "proposed" });
  const r1 = done(s1, { taken: { branch: "raoden/s1", commit: C("b"), applied: false }, board: head().ref });
  const r2 = done(s2, { taken: { branch: "raoden/s2", commit: C("c"), applied: false }, board: head().ref });
  const m1 = merged(s1, r1);
  const m2 = { ...merged(s2, r2), status: "paused", reason: "merge_conflict", conflicts: ["s.txt"], dir: "/x" };
  const h = head([m2, m1]);
  const s = par([p, s1, s2], [fact, r1, r2], [rid], { head: h });
  assert.deepEqual([s.kind, s.mergeRunId, s.key], ["agent", m2.runId, s2.key]);
  // the person's way: the merge waits for them, the parent starts nothing
  const w = par([p, s1, s2], [fact, r1, r2], [rid], { head: h, budget: { ...B, conflicts: "person" } });
  assert.deepEqual(w, { kind: "wait", why: "merge" });
});

// ---------------- the runner over stand-in calls ----------------

const LINK = randomUUID();
function standIn({ tasks, journal = {}, limitTurns = {} }) {
  const facts = [];
  const calls = { start: [], decompose: [], resume: [], take: [], merge: [] };
  const state = { tasks, now: Date.now(), refuse: null, journal, limitTurns, head: head(),
    profile: { access: { claude: "workspace", codex: "workspace" }, workMode: "copy", checks: ["true"], finish: { commit: false, push: false, qa: false }, grants: [] } };
  const deps = {
    view: async () => ({ board: { v: 1, tasks: state.tasks, counters: {} }, facts: [...facts] }),
    link: async () => ({ workspaceId: WS, project: "/p" }),
    profile: async () => state.profile,
    optionalChecks: true,
    journal: async (runId) => state.journal[runId] ?? [],
    readiness: async () => ({ ok: true, value: { ready: true, items: [] } }),
    start: async ({ requestId, goal }) => {
      calls.start.push(goal.task.key);
      facts.push(run({ runId: requestId, taskId: goal.task.id, taskKey: goal.task.key, board: goal.base?.branch ?? null }));
      return { ok: true, value: { runId: requestId } };
    },
    take: async (runId) => { calls.take.push(runId); return { ok: true, value: { result: "created" } }; },
    head: async () => state.head,
    ensureHead: async () => {},
    merge: async () => ({ ok: true, value: { already: true } }),
    resume: async (runId) => { calls.resume.push(runId); return { ok: true, value: undefined }; },
    limitTurns: async (runId) => new Set(state.limitTurns[runId] ?? []),
    decompose: async (taskId) => {
      calls.decompose.push(taskId);
      if (state.refuse) return { ok: false, code: state.refuse, message: "x" };
      const f = splitOf({ id: taskId });
      facts.push(f);
      return { ok: true, value: { runId: f.runId } };
    },
    newId: () => randomUUID(),
    now: () => state.now
  };
  return { deps, facts, calls, state };
}
const stateOf = async (ap) => (await ap.state())[LINK];

test("runner: the decompose step starts a split once; runs and minutes of the budget count started + agents + splits; the budget ends before the next split", async () => {
  const p = parentOf(), q = parentOf();
  const t0 = Date.parse("2026-10-20T10:00:00Z");
  const s = standIn({ tasks: [p, q] });
  s.state.now = t0 + 30 * 60_000;
  const ap = createBoardAutopilot(s.deps, async () => ({ runs: 1, minutes: 240, parallel: 3 }), 3_600_000);
  await ap.set(LINK, true, "ru");
  await ap.tick(LINK);
  assert.deepEqual(s.calls.decompose, [p.id]);
  const f = s.facts[0];
  // its journal: 20 minutes of work, then it ended
  s.state.journal[f.runId] = [{ ts: new Date(t0 + 5 * 60_000).toISOString(), type: "run.status", data: { status: "running" } },
    { ts: new Date(t0 + 25 * 60_000).toISOString(), type: "run.status", data: { status: "completed", reason: null } }];
  Object.assign(f, { status: "completed", split: "proposed" });
  let st = await stateOf(ap);
  assert.deepEqual([st.used.runs, st.used.minutes], [1, 20]);
  // the proposal is made: the parent decomposedBy, subtasks on the board; the budget (1 run) is used: off before a start
  s.state.tasks = [{ ...p, decomposedBy: f.runId, dependsOn: [] }, q];
  await ap.tick(LINK);
  st = await stateOf(ap);
  assert.deepEqual([st.on, st.stop.code, st.stop.detail, s.calls.decompose.length, s.calls.start.length], [false, "budget_runs", "1", 1, 0]);
  ap.shutdown();
});

test("runner: a split's turn ended by a provider's limit is not work; the pause for the lead's question is not work either", async () => {
  const p = parentOf();
  const t0 = Date.parse("2026-10-20T10:00:00Z");
  const s = standIn({ tasks: [p] });
  s.state.now = t0 + 100 * 60_000;
  const ap = createBoardAutopilot(s.deps, async () => B, 3_600_000);
  await ap.set(LINK, true);
  await ap.tick(LINK);
  const id = s.facts[0].runId;
  const at = (m) => new Date(t0 + m * 60_000).toISOString();
  s.state.journal[id] = [{ ts: at(0), type: "run.status", data: { status: "running" } }, { ts: at(10), type: "turn.finished", data: { turnId: "t1", outcome: "failed" } },
    { ts: at(10), type: "run.status", data: { status: "paused", reason: "environment_error" } }, { ts: at(60), type: "run.status", data: { status: "running" } },
    { ts: at(70), type: "run.status", data: { status: "paused", reason: "awaiting_answer" } }, { ts: at(90), type: "run.status", data: { status: "running" } },
    { ts: at(95), type: "run.status", data: { status: "completed" } }];
  s.state.limitTurns[id] = ["t1"];
  assert.equal((await stateOf(ap)).used.minutes, 10 + 10 + 5, "10 before the limit, 10 after the reset, 5 after the answer");
  s.state.limitTurns[id] = [];
  assert.equal((await stateOf(ap)).used.minutes, 10 + 50 + 10 + 5, "without the feed's mark the pause counts");
  ap.shutdown();
});

test("runner: an own split at a provider's limit is waited for and continued after the reset; the counter of three resets by a completed turn; a person's split is not its to continue", async () => {
  const p = parentOf();
  const s = standIn({ tasks: [p] });
  const reset = Date.now() + 3_600_000;
  const ap = createBoardAutopilot(s.deps, async () => B, 3_600_000);
  await ap.set(LINK, true);
  await ap.tick(LINK);
  const f = s.facts[0];
  Object.assign(f, { status: "paused", reason: "environment_error", providerLimit: { provider: "codex", resetsAt: reset } });
  await ap.tick(LINK);
  let st = await stateOf(ap);
  assert.deepEqual([st.waits, st.limit.key, st.limit.provider, s.calls.resume.length], ["provider_limit", p.key, "codex", 0]);
  s.state.now = reset + LIMIT_MARGIN_MS;
  await ap.tick(LINK);
  st = await stateOf(ap);
  assert.deepEqual([s.calls.resume, st.resumed.runId, st.resumed.key], [[f.runId], f.runId, p.key]);
  // the same reset again (not yet changed): read as unknown, not continued twice; a new reset after a completed turn: afresh
  await ap.tick(LINK);
  assert.equal(s.calls.resume.length, 1);
  s.state.journal[f.runId] = [{ ts: "2026-10-20T10:00:00Z", type: "turn.finished", data: { turnId: "t2", outcome: "completed" } }];
  f.providerLimit = { provider: "codex", resetsAt: reset };
  await ap.tick(LINK);
  assert.equal(s.calls.resume.length, 2, "a completed turn since: it starts afresh");
  ap.shutdown();
  // the person's split at a limit: not in the limited runs — the autopilot goes on (this parent is out of the queue)
  const q = parentOf({ order: 1 }), o = task({ order: 99 });
  const t = standIn({ tasks: [q, o] });
  t.facts.push(splitOf(q, { status: "paused", reason: "environment_error", providerLimit: { provider: "codex", resetsAt: Date.now() + 9e6 } }));
  const bp = createBoardAutopilot(t.deps, async () => B, 3_600_000);
  await bp.set(LINK, true);
  await bp.tick(LINK);
  const st2 = await stateOf(bp);
  assert.deepEqual([st2.limit, t.calls.start, t.calls.resume], [null, [o.key], []]);
  bp.shutdown();
});

test("runner: a refusal that means «someone was first» is not a stop; any other is decomposition_failed with its code; no call at all — unavailable; the settings changed — off", async () => {
  for (const code of ["decomposition_active", "task_active_run", "deps_not_ready"]) {
    const p = parentOf();
    const s = standIn({ tasks: [p] });
    s.state.refuse = code;
    const ap = createBoardAutopilot(s.deps, async () => B, 3_600_000);
    await ap.set(LINK, true);
    await ap.tick(LINK);
    assert.deepEqual([(await stateOf(ap)).on, s.calls.decompose.length], [true, 1], code);
    ap.shutdown();
  }
  const p = parentOf();
  const s = standIn({ tasks: [p] });
  s.state.refuse = "journal_v1";
  const ap = createBoardAutopilot(s.deps, async () => B, 3_600_000);
  await ap.set(LINK, true);
  await ap.tick(LINK);
  let st = await stateOf(ap);
  assert.deepEqual([st.on, st.stop.code, st.stop.detail, st.stop.key], [false, "decomposition_failed", "journal_v1", p.key]);
  const none = standIn({ tasks: [p] });
  delete none.deps.decompose;
  const bp = createBoardAutopilot(none.deps, async () => B, 3_600_000);
  await bp.set(LINK, true);
  await bp.tick(LINK);
  st = await stateOf(bp);
  assert.deepEqual([st.stop.code, st.stop.detail], ["decomposition_failed", "unavailable"]);
  const cp = standIn({ tasks: [p] });
  const c = createBoardAutopilot(cp.deps, async () => B, 3_600_000);
  await c.set(LINK, true);
  cp.state.profile = { ...cp.state.profile, workMode: "project", checks: ["x"] };
  await c.tick(LINK);
  assert.deepEqual([(await stateOf(c)).stop.code, cp.calls.decompose.length], ["settings_changed", 0]);
  for (const x of [ap, bp, c]) x.shutdown();
});

test("runner: the stops of its own split — failed / stopped / rejected / refused by the board — turn it off with the parent's key and a detail; it is then not repeated", async () => {
  for (const [over, detail] of [[{ status: "failed" }, "failed"], [{ status: "stopped" }, "stopped"], [{ status: "completed", split: "rejected" }, "rejected"],
    [{ status: "completed", split: "proposed", splitFailed: "parent_gone" }, "parent_gone"]]) {
    const p = parentOf(), o = task({ order: 99 });
    const s = standIn({ tasks: [p, o] });
    const ap = createBoardAutopilot(s.deps, async () => B, 3_600_000);
    await ap.set(LINK, true);
    await ap.tick(LINK);
    Object.assign(s.facts[0], over);
    await ap.tick(LINK);
    const st = await stateOf(ap);
    assert.deepEqual([st.on, st.stop.code, st.stop.detail, st.stop.key], [false, "decomposition_failed", detail, p.key]);
    // turned on again: its own list is empty, the parent has a split — it is skipped, the other task goes (not repeated)
    await ap.set(LINK, true);
    await ap.tick(LINK);
    assert.deepEqual([s.calls.decompose.length, s.calls.start], [1, [o.key]], detail);
    ap.shutdown();
  }
});

// ---------------- through the manager, fake CLIs ----------------

function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
// one script per work folder (MOCK_SCRIPT_PER_CWD): the k-th folder that makes a call takes the k-th set. The split's copy
// calls first (1), then the subtasks' copies in the order they start, then the parent's
function scripts(...sets) {
  const dir = path.join(TMP, `script-${++n}`);
  sets.forEach((answers, k) => {
    const sub = path.join(dir, String(k + 1));
    fs.mkdirSync(sub, { recursive: true });
    answers.forEach((a, i) => {
      fs.writeFileSync(path.join(sub, `${i + 1}.json`), JSON.stringify(a.answer));
      if (a.writes) fs.writeFileSync(path.join(sub, `${i + 1}.writes.json`), JSON.stringify(a.writes));
    });
  });
  return dir;
}
const cond = (file, covers) => ({ keep: null, text: `${file} says done`, covers, evidence: { kind: "change", check: null } });
// one task's four turns: the plan, the executor writes <file>, the review, the final review. reqs: its requirements
const turns = (file, reqs = ["R1"]) => [
  { answer: { stages: [{ title: "fix", task: `write ${file}`, conditions: reqs.map((r) => cond(file, [r])) }], dropped: [], dropRequirements: [], question: null } },
  { answer: { summary: "done", done: true }, writes: [{ rel: file, base64: Buffer.from("done\n").toString("base64") }] },
  { answer: { conditions: reqs.map((_, i) => ({ id: `C${i + 1}`, status: "met", paths: [file], note: "written" })), findings: [], request: "none", question: null } },
  { answer: { conditions: [], findings: [], request: "none", question: null, requirements: reqs.map((r) => ({ id: r, status: "met", note: "written" })) } }
];
const part = (id, covers, dependsOn = []) => ({ id, title: `part ${id}`, text: `do ${id}`, criteria: [`${id} done`], dependsOn, covers });
const PROPOSAL = { tasks: [part("S1", ["R1"]), part("S2", ["R2"], ["S1"]), part("S3", ["R3"])], whole: null, question: null };
const WHOLE = { tasks: [], whole: "one change is enough", question: null };
const BAD = { tasks: [part("S1", ["R1"]), part("S2", ["R1"])], whole: null, question: null }; // R2 and R3 are not covered
const decide = (answer) => ({ answer });
const LIMIT = (resetsAt) => ({ answer: { __limit: { resetsAt } } });
function manager(script, extra = {}, root = path.join(TMP, `root-${++n}`)) {
  const file = path.join(TMP, `providers-${++n}.json`);
  fs.mkdirSync(path.join(TMP, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(TMP, ".codex", "config.toml"), "");
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, CODEX_HOME: path.join(TMP, ".codex"), MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script, MOCK_SCRIPT_PER_CWD: "1", ...extra } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.162.0", ...p }, claude: { executable: CLAUDE, version: "2.1.303 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  const m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true,
    workspaceOpen: () => true, workspaceKnown: (id) => id === "common" });
  m.root = root;
  return m;
}
function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
function personSide(dir) {
  const h = createHash("sha256");
  for (const f of fs.readdirSync(dir).filter((x) => x !== ".git").sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  h.update(fs.readFileSync(path.join(dir, ".git", "index"))).update(fs.readFileSync(path.join(dir, ".git", "HEAD")));
  // the result branches the autopilot takes (decision 8) are new names; the person's own are the ones compared
  return { files: h.digest("hex"), branches: g(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").split("\n").filter((x) => !x.startsWith("refs/heads/raoden/")) };
}
const until = async (fn, what, ms = 240_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
};
const bounds = { position: { x: 0, y: 0 }, size: { width: 280, height: 160 } };
async function linkOn(m, src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds })).value.agentId;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds })).value.agentId;
  return (await m.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
}
const parentInput = (src, over = {}) => ({ workspaceId: WS, project: src, title: "Parent", text: "Do the three things", criteria: ["first", "second", "third"], decompose: true, ...over });
const ended = (m, linkId, ms) => until(async () => { const s = (await m.board()).value.autopilot[linkId]; return s && !s.on ? s : null; }, "the autopilot to end", ms);
async function prepare(m, src, workMode = "copy", parallel = 2) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode, checks: ["true"] });
  const linkId = await linkOn(m, src);
  assert.ok((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel })).ok);
  return linkId;
}

test("a split → three subtasks (two at once, the third after the first) → the parent's closing run → all_done; the person's folder untouched", OPTS, async () => {
  const src = project();
  const before = personSide(src);
  // the split's copy 1; the subtasks' copies 2, 3 (the first two to start; any of S1 / S3), 4 (S2); the parent's closing run 5
  const m = manager(scripts([decide(PROPOSAL)], turns("s2.txt"), turns("s3.txt"), turns("s4.txt"), turns("p.txt", ["R1", "R2", "R3"])), { MOCK_TURN_DELAY_MS: "300" });
  const linkId = await prepare(m, src);
  const parent = (await m.boardCreate(parentInput(src))).value;
  assert.ok((await m.boardAutopilot(linkId, true, "en")).ok);
  const end = await ended(m, linkId, 280_000);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  const v = (await m.board()).value;
  const st = boardStatuses(v.board, v.facts, v.heads);
  const subs = v.board.tasks.filter((t) => t.parentId === parent.id);
  assert.equal(subs.length, 3);
  assert.deepEqual([parent, ...subs].map((t) => st.get(t.id).done), ["confirmed", "confirmed", "confirmed", "confirmed"]);
  // one split, started by the autopilot
  assert.equal(v.facts.filter((f) => f.decompositionOf === parent.id).length, 1);
  // all four in the board's head
  const [h] = v.heads;
  assert.deepEqual(h.merges.filter((x) => x.status === "completed").map((x) => x.task.key).sort(), [parent, ...subs].map((t) => t.key).sort());
  assert.deepEqual(personSide(src), before);
  await m.shutdown();
});


test("a split at a provider's limit: the autopilot waits, then continues the run itself; the lead says «whole» — the parent is run as an ordinary task, all_done", OPTS, async () => {
  const src = fs.realpathSync(project());
  const resetsAt = Math.floor(Date.now() / 1000) - 600; // behind by 10 min: due at once
  const m = manager(scripts([LIMIT(resetsAt), decide(WHOLE)], turns("p.txt")));
  const linkId = await prepare(m, src);
  const parent = (await m.boardCreate(parentInput(src, { criteria: ["first"] }))).value;
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  let resumed = null;
  let waited = false;
  const end = await until(async () => {
    const s = (await m.board()).value.autopilot[linkId];
    if (s?.resumed) resumed = s.resumed;
    if (s?.waits === "provider_limit") waited = true;
    return s && !s.on ? s : null;
  });
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  assert.ok(resumed && resumed.key === parent.key, JSON.stringify(resumed));
  assert.ok(waited || resumed);
  const v = (await m.board()).value;
  const split = v.facts.filter((f) => f.decompositionOf === parent.id);
  assert.deepEqual([split.length, split[0].split, v.facts.filter((f) => f.taskId === parent.id).length], [1, "whole", 1]);
  await m.shutdown();
});

test("the budget ends between the subtasks: off budget_runs; the third subtask and the parent are untouched; the next «Запустить доску» goes on", OPTS, async () => {
  const src = fs.realpathSync(project());
  // the split and two subtasks use 3 runs; S2 waits for S1 and finds the budget used
  const m = manager(scripts([decide(PROPOSAL)], turns("s2.txt"), turns("s3.txt"), turns("s4.txt"), turns("p.txt", ["R1", "R2", "R3"])), { MOCK_TURN_DELAY_MS: "300" });
  const linkId = await prepare(m, src);
  assert.ok((await m.boardBudget(linkId, { runs: 3, minutes: 240, parallel: 2 })).ok);
  const parent = (await m.boardCreate(parentInput(src))).value;
  assert.ok((await m.boardAutopilot(linkId, true, "en")).ok);
  const end = await ended(m, linkId, 280_000);
  assert.deepEqual([end.stop.code, end.stop.detail], ["budget_runs", "3"], JSON.stringify(end));
  const v = (await m.board()).value;
  const subs = v.board.tasks.filter((t) => t.parentId === parent.id);
  const st = boardStatuses(v.board, v.facts, v.heads);
  assert.deepEqual(subs.map((t) => v.facts.filter((f) => f.taskId === t.id).length), [1, 0, 1], "S2 never started");
  assert.equal(v.facts.filter((f) => f.taskId === parent.id).length, 0, "the parent never started");
  assert.deepEqual([st.get(parent.id).column, st.get(parent.id).reason], ["queue", "waits_task"]);
  // the next start continues: the budget is the person's to raise
  assert.ok((await m.boardBudget(linkId, { runs: 5, minutes: 240, parallel: 2 })).ok);
  assert.ok((await m.boardAutopilot(linkId, true, "en")).ok);
  const end2 = await ended(m, linkId, 280_000);
  assert.equal(end2.stop.code, "all_done", JSON.stringify(end2));
  assert.equal((await m.board()).value.facts.filter((f) => f.decompositionOf === parent.id).length, 1, "not split again");
  await m.shutdown();
});

test("the project folder: a split, then the subtasks and the parent one at a time", OPTS, async () => {
  const src = fs.realpathSync(project());
  // the split's copy is script 1; every run in the project folder shares script 2, in order
  const m = manager(scripts([decide(PROPOSAL)], [...turns("s1.txt"), ...turns("s2.txt"), ...turns("s3.txt"), ...turns("p.txt", ["R1", "R2", "R3"])]), { MOCK_TURN_DELAY_MS: "100" });
  const linkId = await prepare(m, src, "project");
  const parent = (await m.boardCreate(parentInput(src))).value;
  assert.ok((await m.boardAutopilot(linkId, true, "en")).ok);
  let most = 0;
  const end = await until(async () => {
    const v = (await m.board()).value;
    most = Math.max(most, v.facts.filter((f) => ["created", "preparing", "running", "pausing", "stopping"].includes(f.status) && (f.taskId || f.decompositionOf)).length);
    const s = v.autopilot[linkId];
    return s && !s.on ? s : null;
  }, "the autopilot to end", 280_000);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  assert.equal(most, 1, "one run at a time");
  const v = (await m.board()).value;
  const st = boardStatuses(v.board, v.facts);
  assert.deepEqual(v.board.tasks.map((t) => st.get(t.id).done), ["confirmed", "confirmed", "confirmed", "confirmed"]);
  const order = v.facts.filter((f) => f.taskId).sort((a, b) => a.createdAt - b.createdAt).map((f) => f.taskKey);
  assert.equal(order.at(-1), parent.key, "the parent last");
  await m.shutdown();
});

test("a split refused twice (rejected): off decomposition_failed; turned on again it is not repeated — the parent is skipped, the other task goes", OPTS, async () => {
  const src = fs.realpathSync(project());
  const m = manager(scripts([decide(BAD), decide(BAD)], turns("o.txt")));
  const linkId = await prepare(m, src);
  const parent = (await m.boardCreate(parentInput(src))).value;
  const other = (await m.boardCreate(parentInput(src, { title: "Other", decompose: false, criteria: ["first"] }))).value;
  assert.ok((await m.boardAutopilot(linkId, true, "en")).ok);
  const end = await ended(m, linkId, 200_000);
  assert.deepEqual([end.stop.code, end.stop.detail, end.stop.key], ["decomposition_failed", "rejected", parent.key], JSON.stringify(end));
  assert.deepEqual((await m.board()).value.facts.filter((f) => f.taskId === other.id), [], "nothing else started after the stop");
  assert.ok((await m.boardAutopilot(linkId, true, "en")).ok);
  const end2 = await ended(m, linkId, 200_000);
  assert.equal(end2.stop.code, "others_wait", JSON.stringify(end2));
  const v = (await m.board()).value;
  assert.equal(v.facts.filter((f) => f.decompositionOf === parent.id).length, 1, "not split again");
  assert.equal(boardStatuses(v.board, v.facts, v.heads).get(other.id).done, "confirmed");
  assert.equal(v.facts.filter((f) => f.taskId === parent.id).length, 0, "the parent is not run whole");
  await m.shutdown();
});
