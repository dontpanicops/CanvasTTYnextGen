// F1 T-12 (stage-f-external-projects.md §4): the role line [Raoden Loom] role/task is the first line of every role's task, once;
// the goal's task ref is the board task's only (a ref in the goal is dropped, v2 only); parseGoal refuses task.ref from
// the window. Fake CLIs, temporary repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { parseJournal } from "../src/main/services/orchestration/journal.ts";
import { parseCreate } from "../src/main/ipc/orchestrationIpc.ts";
import { commitMessage } from "../src/main/services/orchestration/finish.ts";
import { goalFor, taskText } from "../src/shared/taskBoard.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-roleline-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const wrapper = (name, mock) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
};
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
fs.mkdirSync(path.join(TMP, ".codex"));
fs.writeFileSync(path.join(TMP, ".codex", "config.toml"), "");

// the n-th call of either CLI answers step n
function script(steps) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  steps.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(s.report));
    if (s.writes) fs.writeFileSync(path.join(dir, `${i + 1}.writes.json`), JSON.stringify(s.writes.map(([rel, text]) => ({ rel, base64: Buffer.from(text).toString("base64") }))));
  });
  return dir;
}
function manager(steps, journalV2 = true) {
  const root = path.join(TMP, `root-${++n}`);
  const file = path.join(TMP, `providers-${n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, CODEX_HOME: path.join(TMP, ".codex"), MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script(steps), MOCK_CHECKS: "none" } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  return { root, m: createRunManager({ platform: "darwin", arch: "arm64", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2 }) };
}
// a project whose side ref holds the conflict as a merge leaves it: markers in auth.txt
function conflictProject() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "auth.txt"), "base\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  fs.writeFileSync(path.join(dir, "auth.txt"), "<<<<<<< ours\none\n=======\ntwo\n>>>>>>> theirs\n");
  g(dir, "add", "-A");
  const tree = g(dir, "write-tree");
  const commit = g(dir, "commit-tree", tree, "-p", "HEAD", "-m", "the conflict");
  g(dir, "update-ref", "refs/canvastty/test/conflict-1", commit);
  g(dir, "checkout", "-q", "--", ".");
  g(dir, "reset", "-q");
  fs.writeFileSync(path.join(dir, "auth.txt"), "base\n");
  return { dir, commit };
}
const MARKERS = "! grep -sIE '^(<{7}|>{7}) ' -- 'auth.txt'";
const goal = (base) => ({ text: "Разрешите конфликт слияния в auth.txt", criteria: ["в auth.txt есть one и two", "В файлах auth.txt нет маркеров конфликта"],
  checks: [], commands: ["true", MARKERS], mode: "autopilot", workMode: "copy", limits: { turns: 8, roundsPerStage: 3, runMs: 40 * 60_000 },
  resolution: { mergeRunId: randomUUID(), taskId: randomUUID(), key: "T-2", base } });
const EXEC = (text) => ({ report: { summary: "resolved", done: true }, writes: [["auth.txt", text]] });
const REVIEW = { report: { conditions: [{ id: "C1", status: "met", paths: ["auth.txt"], note: "ok" }], findings: [], request: "none", question: null } };
const FINAL = { report: { conditions: [], findings: [], request: "none", question: null,
  requirements: [{ id: "R1", status: "met", note: "ok" }, { id: "R2", status: "met", note: "ok" }] } };
async function ended(m, runId) {
  const end = Date.now() + 90_000;
  for (;;) {
    const v = (await m.get(runId)).value.view;
    if (["completed", "paused", "failed", "stopped"].includes(v.status)) return v;
    if (Date.now() > end) throw new Error(`the run did not end: ${JSON.stringify(v).slice(0, 300)}`);
    await sleep(50);
  }
}
const journal = (root, runId) => {
  const buf = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"));
  return { lines: buf.toString().trim().split("\n").map((l) => JSON.parse(l)), parsed: parseJournal(buf, runId) };
};

const LINE = /^\[Raoden Loom\] role: (lead|executor|reviewer); task: ([A-Za-z0-9][A-Za-z0-9-]{0,31}|-)$/;
function turnsOf(root, runId) {
  const st = journal(root, runId).parsed.state;
  return Object.values(st.turns).map((t) => ({ role: t.role, text: fs.readFileSync(path.join(root, "runs", runId, "texts", t.task.sha256), "utf8") }));
}
function plainProject() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "app.txt"), "one\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return { dir, commit: g(dir, "rev-parse", "HEAD") };
}
const PLAN = { stages: [{ title: "s", task: "t", conditions: [{ keep: null, text: "done", covers: ["R1", "R2"], evidence: { kind: "change", check: null } }] }],
  dropped: [], dropRequirements: [], question: null };
const plainGoal = (task) => ({ text: "Add the parts", criteria: ["a works", "b works"], checks: [], commands: ["true"], mode: "autopilot", workMode: "copy",
  limits: { turns: 8, runMs: 40 * 60_000 }, ...(task ? { task } : {}) });
const splitGoal = (base) => ({ text: "Add the two parts", criteria: ["a works", "b works"], checks: [], commands: [], mode: "autopilot", workMode: "copy",
  limits: { turns: 6, runMs: 40 * 60_000, leadTurnMs: 10 * 60_000 }, decomposition: { taskId: randomUUID(), key: "T-3", base } });
const PROPOSAL = { tasks: [{ id: "S1", title: "p", text: "do", criteria: ["x"], dependsOn: [], covers: ["R1", "R2"] }], whole: null, question: null };

// line 1 is exactly the role line, once, and the old `Role: …` line is second
function assertFirst({ role, text }, wantRole, t) {
  const lines = text.split("\n");
  assert.equal(role, wantRole);
  assert.equal(lines[0], `[Raoden Loom] role: ${wantRole}; task: ${t}`);
  assert.match(lines[0], LINE);
  assert.match(lines[1], new RegExp(`^Role: ${wantRole}\\. Purpose: \\w+\\.$`));
  assert.equal(text.split("[Raoden Loom]").length - 1, 1, "the line is there once");
}
const boardTask = async (m, dir) => { const t = (await m.boardCreate({ workspaceId: "common", project: dir, title: "t", text: "write a file", criteria: ["the file says done"] })).value; return { id: t.id, key: t.key }; };
// a task with a ref comes only from an import (the button's path here): { id, key } of the task, as the window names it
async function importedTask(m, dir, ref) {
  const file = path.join(TMP, `tasks-${++n}.json`);
  fs.writeFileSync(file, JSON.stringify({ format: "board-tasks/v1", workspaceId: "common", tasks: [{ ref, project: dir, title: "t", text: "write a file", criteria: ["the file says done"] }] }));
  const r = await m.boardImportFile(async () => file);
  assert.equal(r.value?.status, "imported", JSON.stringify(r));
  const t = (await m.board()).value.board.tasks.find((x) => x.ref === ref);
  return { id: t.id, key: t.key };
}
const goalTask = (root, runId) => JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "texts", journal(root, runId).parsed.state.goal.sha256), "utf8")).task;
async function firstTurn(kind, ref) {
  const { dir } = plainProject();
  const { root, m } = manager([{ report: PLAN }]);
  const runId = randomUUID();
  const task = kind === "none" ? undefined : ref ? await importedTask(m, dir, ref) : await boardTask(m, dir);
  const r = await m.create({ requestId: runId, source: dir, goal: plainGoal(task) });
  assert.ok(r.ok, JSON.stringify(r));
  await ended(m, runId);
  const turns = turnsOf(root, runId);
  await m.shutdown();
  return { first: turns[0], key: task?.key };
}

test("lead: the board task's ref, else the key, else - without a task", OPTS, async () => {
  assertFirst((await firstTurn("task", "T1")).first, "lead", "T1");
  const k = await firstTurn("task");
  assertFirst(k.first, "lead", k.key);
  assert.match(k.key, /^T-\d+$/);
  assertFirst((await firstTurn("none")).first, "lead", "-");
});

test("decomposition: the lead's task names T-<n> from decomposition.key", OPTS, async () => {
  const { dir, commit } = plainProject();
  const { root, m } = manager([{ report: PROPOSAL }]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: splitGoal(commit) })).ok);
  await ended(m, runId);
  const turns = turnsOf(root, runId);
  assert.ok(turns.length >= 1);
  for (const t of turns) {
    assertFirst(t, "lead", "T-3");
    assert.equal(t.text.split("\n")[1], "Role: lead. Purpose: decompose.");
  }
  await m.shutdown();
});

test("resolution: executor and reviewer name T-<n> from resolution.key", OPTS, async () => {
  const { dir, commit } = conflictProject();
  const { root, m } = manager([EXEC("one\ntwo\n"), REVIEW, FINAL]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  assert.equal((await ended(m, runId)).status, "completed");
  const turns = turnsOf(root, runId);
  assert.deepEqual([...new Set(turns.map((t) => t.role))].sort(), ["executor", "reviewer"]);
  for (const t of turns) assertFirst(t, t.role, "T-2");
  await m.shutdown();
});

test("a task run: lead, executor and reviewer all carry the ref", OPTS, async () => {
  const { dir } = plainProject();
  const EXECUTED = { report: { summary: "done", done: true }, writes: [["app.txt", "two\n"]] };
  const { root, m } = manager([{ report: PLAN }, EXECUTED, REVIEW, FINAL]);
  const runId = randomUUID();
  const task = await importedTask(m, dir, "ABC-12"); // the goal names { id, key } only: the ref is the board's
  assert.ok((await m.create({ requestId: runId, source: dir, goal: plainGoal(task) })).ok);
  assert.deepEqual(goalTask(root, runId), { ...task, ref: "ABC-12" });
  await ended(m, runId);
  const turns = turnsOf(root, runId);
  assert.deepEqual([...new Set(turns.map((t) => t.role))].sort(), ["executor", "lead", "reviewer"]);
  for (const t of turns) assertFirst(t, t.role, "ABC-12");
  await m.shutdown();
});

test("goal.text, taskText and commitMessage do not carry the line", () => {
  const t = taskText({ id: randomUUID(), text: "do it" }, [], "en");
  assert.ok(!t.includes("[Raoden Loom]"));
  assert.ok(!commitMessage("do it", randomUUID()).includes("[Raoden Loom]"));
});

test("parseGoal refuses task.ref from the window", () => {
  const goal = { text: "x", criteria: ["a"], checks: [], commands: ["true"], workMode: "copy", task: { id: randomUUID(), key: "T-1", ref: "T1" } };
  assert.throws(() => parseCreate({ requestId: randomUUID(), source: "/p", goal }), /ref/);
  assert.ok(parseCreate({ requestId: randomUUID(), source: "/p", goal: { ...goal, task: { id: goal.task.id, key: "T-1" } } }));
});

test("the goal's task ref is the board's only: a ref in the goal is dropped, an imported task's ref is put in", OPTS, async () => {
  const { dir } = plainProject();
  const a = manager([]);
  // a task without a ref: any ref in the goal is dropped, the line names the key
  for (const ref of ["T1", "-x", "a b", "x".repeat(33), 1, null]) {
    const plain = await boardTask(a.m, dir); // a task has one active run
    const runId = randomUUID();
    const r = await a.m.create({ requestId: runId, source: dir, goal: plainGoal({ ...plain, ref }) });
    assert.ok(r.ok, `${ref}: ${JSON.stringify(r)}`);
    assert.deepEqual(goalTask(a.root, runId), plain, String(ref));
  }
  // an imported task: its ref, whatever the goal says
  for (const [own, ref] of [["T1", undefined], ["T2", "OTHER"]]) {
    const imported = await importedTask(a.m, dir, own);
    const runId = randomUUID();
    assert.ok((await a.m.create({ requestId: runId, source: dir, goal: plainGoal({ ...imported, ...(ref ? { ref } : {}) }) })).ok);
    assert.deepEqual(goalTask(a.root, runId), { ...imported, ref: own }, String(ref));
  }
  const extra = await a.m.create({ requestId: randomUUID(), source: dir, goal: plainGoal({ ...(await boardTask(a.m, dir)), extra: 1 }) });
  assert.equal(extra.code, "invalid_goal", "other keys of the task are still refused");
  await a.m.shutdown();
  const v1 = manager([], false);
  const r = await v1.m.create({ requestId: randomUUID(), source: dir, goal: plainGoal(await importedTask(v1.m, dir, "T1")) });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_goal", "v1 refuses a task");
  await v1.m.shutdown();
});

test("goalFor: the board task's ref goes to the goal; none without one", () => {
  const profile = { checks: [], workMode: "copy", finish: { commit: false }, models: null };
  const opts = { optionalChecks: false, language: "en", base: null };
  const id = randomUUID();
  assert.deepEqual(goalFor({ id, key: "T-1", ref: "ABC-1", text: "x", criteria: ["c"] }, profile, opts).task, { id, key: "T-1", ref: "ABC-1" });
  assert.deepEqual(goalFor({ id, key: "T-1", text: "x", criteria: ["c"] }, profile, opts).task, { id, key: "T-1" });
});
