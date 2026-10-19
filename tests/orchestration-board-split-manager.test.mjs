// E2 (docs/agent-orchestration/implementation/stage-e-decomposition.md §3.4, §5, §5.1): the decomposition run started from
// a task of the board, through the manager on fake CLIs — the subtasks made once from `completed proposed` (also after
// a restart), the refusals of a start, the run that stands on no link, and the person's side untouched. Temporary repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { boardStatuses } from "../src/shared/taskBoard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 180_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-e2m-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WS = "common";
let n = 0;
const wrapper = (name, mock) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
};
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
function script(steps) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  for (const [i, s] of steps.entries()) fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(s));
  return dir;
}
function manager(steps, root = path.join(TMP, `root-${++n}`)) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script(steps), MOCK_CHECKS: "none" } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  const m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true });
  m.root = root;
  return m;
}
function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  fs.writeFileSync(path.join(dir, "draft.txt"), "the person's own unsaved work\n");
  return dir;
}
function personSide(dir) {
  const h = createHash("sha256");
  for (const f of fs.readdirSync(dir).filter((x) => x !== ".git").sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  h.update(fs.readFileSync(path.join(dir, ".git", "index"))).update(fs.readFileSync(path.join(dir, ".git", "HEAD")));
  return { files: h.digest("hex"), branches: g(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads") };
}
const until = async (fn, what, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
};
const part = (id, covers, dependsOn = []) => ({ id, title: `part ${id}`, text: `do ${id}`, criteria: [`${id} done`], dependsOn, covers });
const PROPOSAL = { tasks: [part("S1", ["R1"]), part("S2", ["R2"], ["S1"]), part("S3", ["R3"])], whole: null, question: null };
const WHOLE = { tasks: [], whole: "one change is enough", question: null };
const BAD = { tasks: [part("S1", ["R1"]), part("S2", ["R1"])], whole: null, question: null }; // R2 and R3 are not covered
const QUESTION = { tasks: [], whole: null, question: "which part first?" };
const PLAN = { stages: [{ title: "fix", task: "make a.txt say 2", conditions: [{ keep: null, text: "a.txt says 2", covers: ["R1"], evidence: { kind: "change", check: null } }] }], dropped: [], dropRequirements: [], question: null };
const input = (project, over = {}) => ({ workspaceId: WS, project, title: "Parent", text: "Do the three things", criteria: ["first", "second", "third"], decompose: true, ...over });
const view = async (m) => (await m.board()).value;
const parentStatus = async (m, id) => { const v = await view(m); return boardStatuses(v.board, v.facts, v.heads ?? []).get(id); };
const stop = async (m, runId) => m.command(runId, { commandId: randomUUID(), expectedRevision: (await m.get(runId)).value.view.revision, command: { kind: "stop" } });

test("a split from the board: the subtasks made once, never on a link, the person's folder untouched; refusals after", OPTS, async () => {
  const src = project();
  const before = personSide(src);
  const m = manager([PROPOSAL]);
  const nextTask = (await m.boardCreate(input(src, { title: "After", decompose: false }))).value; // T-1, ahead of the parent in the queue
  const parent = (await m.boardCreate(input(src))).value; // T-2
  const r = await m.boardDecompose(parent.id, "ru");
  assert.ok(r.ok, JSON.stringify(r));
  const runId = r.value.runId;
  const made = await until(async () => { const v = await view(m); return v.board.tasks.length === 5 ? v : null; }, "the subtasks");
  const p = made.board.tasks.find((t) => t.id === parent.id);
  const subs = made.board.tasks.filter((t) => t.parentId === parent.id);
  assert.deepEqual(subs.map((t) => t.key), ["T-3", "T-4", "T-5"]);
  assert.equal(p.decomposedBy, runId);
  assert.deepEqual(p.dependsOn, subs.map((t) => t.id));
  assert.deepEqual(subs.map((t) => t.dependsOn), [[], [subs[0].id], []]);
  assert.match(subs[1].text, /^do S2\n\nЧасть задачи T-2 «Parent»\. Закрывает её требования:\nR2 — second$/);
  assert.deepEqual(subs.map((t) => t.covers), [["R1"], ["R2"], ["R3"]]);
  // the queue order: the parent, then its subtasks in the proposal's order (the task made before it stays ahead)
  assert.deepEqual(made.board.tasks.slice().sort((a, b) => a.order - b.order).map((t) => t.key), ["T-1", "T-2", "T-3", "T-4", "T-5"]);
  assert.ok(nextTask.order < p.order);
  // a run of its own kind: on no link, not in the list, with its parent in the facts, owned by the task's workspace
  assert.deepEqual((await m.list()).value, []);
  assert.deepEqual((await m.canvas()).value.links, []);
  const fact = made.facts.find((f) => f.runId === runId);
  assert.deepEqual([fact.decompositionOf, fact.taskId, fact.split, fact.status, fact.workspaceId], [parent.id, null, "proposed", "completed", WS]);
  const first = fs.readFileSync(path.join(m.root, "runs", runId, "journal.jsonl"), "utf8").split("\n")[0];
  assert.equal(JSON.parse(first).data.kind, "decomposition");
  const st = boardStatuses(made.board, made.facts).get(parent.id);
  assert.deepEqual([st.column, st.reason, st.waitsFor], ["queue", "waits_task", ["T-3", "T-4", "T-5"]]);
  // the timer goes on a little: repeated syncs change nothing
  const file = fs.readFileSync(path.join(m.root, "board.json"), "utf8");
  await sleep(4000);
  await view(m);
  assert.equal(fs.readFileSync(path.join(m.root, "board.json"), "utf8"), file, "made once");
  // refusals: it has subtasks now
  assert.equal((await m.boardDecompose(parent.id, "ru")).code, "has_subtasks");
  assert.deepEqual(personSide(src), before, "the person's folder, index, HEAD and branches as they were");
  await m.shutdown();
});

test("a restart between «completed proposed» and the board write: the subtasks are made once", OPTS, async () => {
  const src = project();
  const head = g(src, "rev-parse", "HEAD");
  const m1 = manager([PROPOSAL]);
  const parent = (await m1.boardCreate(input(src))).value;
  // the run is made as the person's start makes it, without the manager's timer (nothing writes the board meanwhile)
  const runId = randomUUID();
  const created = await m1.create({ requestId: runId, source: src, goal: { text: parent.text, criteria: parent.criteria, checks: [], commands: [], mode: "autopilot", workMode: "copy", reviewPlan: false,
    language: "en", limits: { turns: 6, leadTurnMs: 600_000 }, decomposition: { taskId: parent.id, key: parent.key, base: head } } });
  assert.ok(created.ok, JSON.stringify(created));
  await until(async () => (await m1.get(runId)).value.view.status === "completed", "the run");
  assert.equal((await m1.board()).value.board.tasks.length, 1, "nothing made yet");
  await m1.shutdown();
  // the board is read after the restart: main follows the proposal
  const m2 = manager([], m1.root);
  assert.equal((await view(m2)).board.tasks.length, 1);
  const v = await until(async () => { const x = await view(m2); return x.board.tasks.length === 4 ? x : null; }, "the subtasks after the restart");
  assert.equal(v.board.tasks.find((t) => t.id === parent.id).decomposedBy, runId);
  assert.match(v.board.tasks.find((t) => t.parentId).text, /Part of task T-1 «Parent»\. It covers these of its requirements:/, "the run's language");
  await m2.shutdown();
  // and once more: the same run is not made again, nor are subtasks the person deleted
  const file = fs.readFileSync(path.join(m1.root, "board.json"), "utf8");
  const m3 = manager([], m1.root);
  await view(m3);
  await sleep(3500);
  assert.equal(fs.readFileSync(path.join(m1.root, "board.json"), "utf8"), file);
  await m3.shutdown();
});

test("refusals of a start: unmarked, archived, subtasks, dependencies, a task run, two at once, a manual start and «Do it whole» during the split", OPTS, async () => {
  const src = project();
  const m = manager([PLAN, QUESTION]);
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["false"] });
  const plain = (await m.boardCreate(input(src, { title: "plain", decompose: false }))).value;
  const gone = (await m.boardCreate(input(src, { title: "gone" }))).value;
  await m.boardArchive(gone.id, true);
  const dep = (await m.boardCreate(input(src, { title: "dep", decompose: false }))).value;
  const waits = (await m.boardCreate(input(src, { title: "waits", dependsOn: [dep.id] }))).value;
  assert.equal((await m.boardDecompose(randomUUID(), "en")).code, "task_not_found");
  assert.equal((await m.boardDecompose("nope", "en")).code, "invalid_argument");
  assert.equal((await m.boardDecompose(plain.id, "en")).code, "invalid_task");
  assert.equal((await m.boardDecompose(gone.id, "en")).code, "task_archived");
  assert.equal((await m.boardDecompose(waits.id, "en")).code, "deps_not_ready");
  // the task has a run of its own going: the plan waits for the person's review
  const own = (await m.boardCreate(input(src, { title: "own" }))).value;
  const runId = randomUUID();
  const goal = { text: "a to 2", criteria: ["a.txt says 2"], checks: [], commands: [], mode: "autopilot", reviewPlan: true, task: { id: own.id, key: own.key } };
  assert.ok((await m.create({ requestId: runId, source: src, goal })).ok);
  await until(async () => (await m.get(runId)).value.view.reason === "plan_review", "the plan review");
  assert.equal((await m.boardDecompose(own.id, "en")).code, "task_active_run");
  await stop(m, runId);
  await until(async () => (await m.get(runId)).value.view.status === "stopped", "stopped");
  // a stopped run of its own does not stand in the way; the lead asks a question, the split waits for the answer
  const [a, b] = await Promise.all([m.boardDecompose(own.id, "en"), m.boardDecompose(own.id, "en")]);
  assert.deepEqual([a, b].map((x) => x.ok ? "ok" : x.code).sort(), ["decomposition_active", "ok"]);
  const split = [a, b].find((x) => x.ok).value.runId;
  await until(async () => (await m.get(split)).value.view.reason === "awaiting_answer", "the question");
  assert.equal((await m.boardDecompose(own.id, "en")).code, "decomposition_active");
  const manual = await m.create({ requestId: randomUUID(), source: src, goal });
  assert.equal(manual.code, "decomposition_active", "a manual start of the parent during its split");
  assert.equal((await m.boardUpdate(own.id, { decompose: false })).code, "decomposition_active");
  assert.equal((await m.boardUpdate(own.id, { title: "renamed" })).ok, true);
  const st = await parentStatus(m, own.id);
  assert.deepEqual([st.column, st.reason], ["queue", "last_stopped"], "its own stopped run is its status");
  // a parent without runs of its own: the split shows
  const fresh = (await m.boardCreate(input(src, { title: "fresh" }))).value;
  assert.equal((await parentStatus(m, fresh.id)).column, "queue");
  await stop(m, split);
  await until(async () => (await m.get(split)).value.view.status === "stopped", "the split stopped");
  assert.equal((await m.boardUpdate(own.id, { decompose: false })).ok, true, "«Do it whole» once the split is over");
  await m.shutdown();
});

test("the split of a parent: a question shows waits_answer; a stopped split is decomposition_failed; whole and rejected twice", OPTS, async () => {
  const src = project();
  const m = manager([QUESTION, WHOLE, BAD, BAD]);
  const t1 = (await m.boardCreate(input(src, { title: "q" }))).value;
  const r1 = (await m.boardDecompose(t1.id, "en")).value.runId;
  await until(async () => (await m.get(r1)).value.view.reason === "awaiting_answer", "the question");
  let st = await parentStatus(m, t1.id);
  assert.deepEqual([st.column, st.reason, st.split.runId], ["work", "waits_answer", r1]);
  await stop(m, r1);
  await until(async () => (await m.get(r1)).value.view.status === "stopped", "stopped");
  st = await parentStatus(m, t1.id);
  assert.deepEqual([st.column, st.reason, st.split.detail], ["review", "decomposition_failed", "stopped"]);
  // «Split again», the lead answers whole: the parent is an ordinary task, "whole" said
  const r2 = (await m.boardDecompose(t1.id, "en")).value.runId;
  await until(async () => (await m.get(r2)).value.view.status === "completed", "whole");
  st = await parentStatus(m, t1.id);
  assert.deepEqual([st.column, st.reason, st.split.detail], ["queue", null, "whole"]);
  assert.equal((await view(m)).board.tasks.length, 1, "nothing made");
  // the proposal fails the check twice: rejected
  const r3 = (await m.boardDecompose(t1.id, "en")).value.runId;
  await until(async () => (await m.get(r3)).value.view.status === "completed", "rejected");
  st = await parentStatus(m, t1.id);
  assert.deepEqual([st.column, st.reason, st.split.detail], ["review", "decomposition_failed", "rejected"]);
  assert.equal((await view(m)).board.tasks.length, 1);
  await m.shutdown();
});

test("a proposal that cannot be made into subtasks: the §5.1 code on the parent, nothing written", OPTS, async () => {
  const src = project();
  const m = manager([PROPOSAL, PROPOSAL, PROPOSAL, PROPOSAL]);
  const done = async (id) => until(async () => (await m.get(id)).value.view.status === "completed", "the split");
  const failed = async (taskId) => until(async () => { const s = await parentStatus(m, taskId); return s.reason === "decomposition_failed" ? s.split.detail : null; }, "the failure");
  // «Do it whole» during the split is refused, so the mark cannot go (not_marked is the store's, tested there): the split is made
  const a = (await m.boardCreate(input(src, { title: "unmarked" }))).value;
  const ra = (await m.boardDecompose(a.id, "en")).value.runId;
  assert.equal((await m.boardUpdate(a.id, { decompose: false })).code, "decomposition_active");
  await done(ra);
  await until(async () => (await view(m)).board.tasks.some((t) => t.parentId === a.id), "its subtasks");
  // requirements changed during the split
  const b = (await m.boardCreate(input(src, { title: "changed" }))).value;
  const rb = (await m.boardDecompose(b.id, "en")).value.runId;
  await m.boardUpdate(b.id, { criteria: ["first", "second"] });
  await done(rb);
  assert.equal(await failed(b.id), "requirements_changed");
  assert.ok(!(await view(m)).board.tasks.some((t) => t.parentId === b.id));
  // archived while the lead worked
  const c = (await m.boardCreate(input(src, { title: "archived" }))).value;
  const rc = (await m.boardDecompose(c.id, "en")).value.runId;
  await m.boardArchive(c.id, true);
  await done(rc);
  await until(async () => (await view(m)).facts.find((f) => f.runId === rc)?.splitFailed === "parent_gone", "parent_gone");
  // deleted
  const d = (await m.boardCreate(input(src, { title: "deleted" }))).value;
  const rd = (await m.boardDecompose(d.id, "en")).value.runId;
  await m.boardRemove(d.id, []);
  await done(rd);
  await sleep(3500); // a task that is not on the board has nobody to say it to: main follows tasks of the board only
  assert.equal((await view(m)).facts.find((f) => f.runId === rd).splitFailed, undefined);
  assert.ok(!(await view(m)).board.tasks.some((t) => t.parentId && t.parentId !== a.id), "no subtask of a failed split anywhere");
  await m.shutdown();
});

test("a parent that had a run of its own: the split is made, the subtasks are not (parent_started)", OPTS, async () => {
  const src = project();
  const m = manager([PLAN, PROPOSAL]);
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "project", checks: ["false"] });
  const t = (await m.boardCreate(input(src))).value;
  const runId = randomUUID();
  const goal = { text: "a to 2", criteria: ["a.txt says 2"], checks: [], commands: [], mode: "autopilot", reviewPlan: true, task: { id: t.id, key: t.key } };
  assert.ok((await m.create({ requestId: runId, source: src, goal })).ok);
  await until(async () => (await m.get(runId)).value.view.reason === "plan_review", "the plan review");
  await stop(m, runId);
  await until(async () => (await m.get(runId)).value.view.status === "stopped", "stopped");
  const split = (await m.boardDecompose(t.id, "en")).value.runId;
  const v = await until(async () => { const x = await view(m); return x.facts.find((f) => f.runId === split)?.splitFailed ? x : null; }, "the failure");
  assert.equal(v.facts.find((f) => f.runId === split).splitFailed, "parent_started");
  assert.equal(v.board.tasks.length, 1);
  assert.equal(v.board.tasks[0].decomposedBy, undefined);
  await m.shutdown();
});
