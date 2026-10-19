// C3 (docs/agent-orchestration/implementation/stage-c3-conflicts.md §2, §4, §5, §6): a merge into the board's result
// handed to an agent — the conflict as a commit published in the project, the merge waiting for its resolution run, the
// resolution's tree moved into the merge copy, the mechanical condition, the merge's own checks, commit and head; every
// way it does not get there. The resolution run itself is replaced by its outcome (tests/orchestration-resolution-run).
// The person's working folder, index, HEAD and branches: byte for byte.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardMerge, isLockFile, markersLines, mergeRequirements } from "../src/main/services/orchestration/boardMerge.ts";
import { isResolutionJournal } from "../src/main/services/orchestration/journal.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { AUTOPILOT_BUDGET, autopilotParallelStep } from "../src/shared/taskBoard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-c3-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WS = "common";
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const CHECK_ENV = { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}` };
let n = 0;

function project(files = { "a.txt": "base\n", "keep.txt": "keep\n" }) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  fs.writeFileSync(path.join(dir, "draft.txt"), "the person's own unsaved work\n");
  return dir;
}
function personSide(dir) {
  const h = createHash("sha256");
  for (const f of fs.readdirSync(dir).filter((f) => f !== ".git").sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  h.update(fs.readFileSync(path.join(dir, ".git", "index"))).update(fs.readFileSync(path.join(dir, ".git", "HEAD")));
  return { files: h.digest("hex"), head: g(dir, "rev-parse", "HEAD"), branches: g(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").split("\n").filter((l) => !/refs\/heads\/raoden\//.test(l)) };
}
// a commit on top of `base` with these files, in the project (as a task's result branch or a resolution's checkpoint)
function commitOn(dir, base, files, name) {
  const clone = path.join(TMP, `clone-${++n}`);
  g(TMP, "clone", "-q", "--no-checkout", dir, clone);
  g(clone, "fetch", "-q", "origin", base);
  g(clone, "checkout", "-q", "--detach", base);
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(clone, rel)); else fs.writeFileSync(path.join(clone, rel), text);
  }
  g(clone, "add", "-A");
  g(clone, "commit", "-q", "-m", name);
  const commit = g(clone, "rev-parse", "HEAD");
  g(clone, "push", "-q", "origin", `HEAD:refs/heads/raoden/${name}`);
  return commit;
}
function merges(checks = ["true"], extra = {}) {
  const root = path.join(TMP, `root-${++n}`);
  return createBoardMerge({ root, gitPath: () => GIT, launch: () => LAUNCH, own: async () => {}, checks: async () => checks,
    shell: async () => ({ shell: SHELL, env: CHECK_ENV }), quiet: async () => true, retryWaitMs: 50, retryPollMs: 10, ...extra });
}
const until = async (fn, ms = 60_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await sleep(50); } };
const mergeOf = async (m, h, dir, runId) => (await m.mergesInto(h.ref, dir)).find((x) => x.runId === runId);
// T-1 in the head changed a.txt one way, T-2 another: the merge of T-2 pauses on the conflict
async function conflicted(m, files1 = { "a.txt": "one\n" }, files2 = { "a.txt": "two\n" }, dirFiles) {
  const dir = project(dirFiles);
  const side = personSide(dir);
  const h0 = await m.ensureHead(WS, dir);
  const one = commitOn(dir, h0.commit, files1, `t1-${n}`);
  const two = commitOn(dir, h0.commit, files2, `t2-${n}`);
  const r1 = await m.merge({ workspaceId: WS, project: dir, task: { id: randomUUID(), key: "T-1" }, taskRunId: randomUUID(), commit: one, language: "ru" });
  await until(async () => (await mergeOf(m, h0, dir, r1.runId))?.status === "completed");
  const r2 = await m.merge({ workspaceId: WS, project: dir, task: { id: randomUUID(), key: "T-2" }, taskRunId: randomUUID(), commit: two, language: "ru" });
  const p = await until(async () => { const x = await mergeOf(m, h0, dir, r2.runId); return x?.status === "paused" ? x : null; });
  assert.equal(p.reason, "merge_conflict");
  return { dir, side, h: h0, runId: r2.runId, headBefore: g(dir, "rev-parse", h0.ref) };
}
const ref = (dir, r) => { try { return g(dir, "rev-parse", "--verify", "--quiet", r); } catch { return null; } };

test("handed to an agent: the conflict published as a commit on the head, the merge waits; the resolution's tree merges it, checked, the head moves", OPTS, async () => {
  const m = merges();
  const { dir, side, h, runId, headBefore } = await conflicted(m);
  const resolution = randomUUID();
  const t = await m.toAgent(runId, resolution);
  assert.deepEqual([t.attempt, t.reason, t.conflicts], [1, "conflict", ["a.txt"]]);
  assert.equal(ref(dir, `refs/canvastty/${runId}/conflict-1`), t.base, "published in the project");
  assert.equal(g(dir, "rev-parse", `${t.base}^`), headBefore, "on the expected head");
  assert.match(g(dir, "show", `${t.base}:a.txt`), /^<<<<<<< /m, "with the markers");
  assert.equal(t.first, t.base);
  let s = await mergeOf(m, h, dir, runId);
  assert.equal(s.status, "running");
  assert.deepEqual(s.agent, { attempt: 1, reason: "conflict", resolutionRunId: resolution, pending: true });
  assert.deepEqual(await m.awaiting(), [{ runId, resolutionRunId: resolution }]);
  // another run's end is not this merge's
  assert.equal(await m.resolutionEnded(runId, randomUUID(), { kind: "failed", detail: "x" }), "ignored");
  const resolved = commitOn(dir, t.base, { "a.txt": "one\ntwo\n" }, `res-${n}`);
  assert.equal(await m.resolutionEnded(runId, resolution, { kind: "completed", tree: g(dir, "rev-parse", `${resolved}^{tree}`) }), "applied");
  s = await until(async () => { const x = await mergeOf(m, h, dir, runId); return x?.status === "completed" ? x : null; });
  assert.equal(s.completion, "confirmed");
  assert.deepEqual(s.outside, []);
  assert.equal(s.agent.pending, false);
  const head = g(dir, "rev-parse", h.ref);
  assert.notEqual(head, headBefore);
  assert.equal(g(dir, "show", `${head}:a.txt`), "one\ntwo");
  assert.deepEqual(personSide(dir), side, "the person's folder untouched");
  assert.deepEqual(await m.awaiting(), []);
});

test("the resolution changed a file out of the conflict: listed in outside, still merged (the reviewer saw it)", OPTS, async () => {
  const m = merges();
  const { dir, h, runId } = await conflicted(m);
  const resolution = randomUUID();
  const t = await m.toAgent(runId, resolution);
  const resolved = commitOn(dir, t.base, { "a.txt": "one\ntwo\n", "keep.txt": null }, `res-${n}`);
  await m.resolutionEnded(runId, resolution, { kind: "completed", tree: g(dir, "rev-parse", `${resolved}^{tree}`) });
  const s = await until(async () => { const x = await mergeOf(m, h, dir, runId); return x?.status === "completed" ? x : null; });
  assert.deepEqual(s.outside, ["keep.txt"]);
});

test("the agent did not get there: each way pauses the merge for the person with why; the head and the copy stay", OPTS, async () => {
  const m = merges();
  const { dir, h, runId, headBefore } = await conflicted(m);
  // failed by the run
  const r1 = randomUUID();
  await m.toAgent(runId, r1);
  assert.equal(await m.resolutionEnded(runId, r1, { kind: "failed", detail: "limit:turns" }), "failed");
  let s = await mergeOf(m, h, dir, runId);
  assert.deepEqual([s.status, s.reason, s.detail, s.agent.pending], ["paused", "merge_agent_failed", "limit:turns", false]);
  // markers left in the tree it brings
  const r2 = randomUUID();
  const t2 = await m.toAgent(runId, r2);
  assert.equal(t2.attempt, 2);
  const left = commitOn(dir, t2.base, { "a.txt": "<<<<<<< x\none\n=======\ntwo\n>>>>>>> y\n" }, `left-${n}`);
  assert.equal(await m.resolutionEnded(runId, r2, { kind: "completed", tree: g(dir, "rev-parse", `${left}^{tree}`) }), "failed");
  s = await mergeOf(m, h, dir, runId);
  assert.deepEqual([s.reason, s.detail], ["merge_agent_failed", "markers"]);
  // the copy changed while the agent worked: the move is refused
  const r3 = randomUUID();
  const t3 = await m.toAgent(runId, r3);
  assert.equal(t3.first, ref(dir, `refs/canvastty/${runId}/conflict-1`), "the reviewer's diff is always against the first try");
  fs.writeFileSync(path.join(await m.copyOf(runId), "a.txt"), "the person typed here\n");
  const ok = commitOn(dir, t3.base, { "a.txt": "one\ntwo\n" }, `ok-${n}`);
  assert.equal(await m.resolutionEnded(runId, r3, { kind: "completed", tree: g(dir, "rev-parse", `${ok}^{tree}`) }), "failed");
  s = await mergeOf(m, h, dir, runId);
  assert.deepEqual([s.reason, s.detail], ["merge_agent_failed", "copy_changed"]);
  assert.equal(g(dir, "rev-parse", h.ref), headBefore, "the head did not move");
  // the person finishes it by hand, as in 1.5.19
  fs.writeFileSync(path.join(await m.copyOf(runId), "a.txt"), "one\ntwo\n");
  assert.equal((await m.resolve(runId, true)).result, "checking");
  s = await until(async () => { const x = await mergeOf(m, h, dir, runId); return x?.status === "completed" ? x : null; });
  assert.equal(s.completion, "confirmed");
});

test("the merge's own checks fail after the agent's resolution: checks_after, not handed to an agent again by itself", OPTS, async () => {
  const m = merges(["false"]);
  const dir = project();
  const h = await m.ensureHead(WS, dir);
  const one = commitOn(dir, h.commit, { "a.txt": "one\n" }, `t1-${n}`);
  const r = await m.merge({ workspaceId: WS, project: dir, task: { id: randomUUID(), key: "T-1" }, taskRunId: randomUUID(), commit: one, language: "ru" });
  let s = await until(async () => { const x = await mergeOf(m, h, dir, r.runId); return x?.status === "paused" ? x : null; });
  assert.equal(s.reason, "merge_checks_failed");
  const res = randomUUID();
  const t = await m.toAgent(r.runId, res);
  assert.deepEqual([t.reason, t.conflicts], ["checks", []]);
  const fixed = commitOn(dir, t.base, { "a.txt": "one fixed\n" }, `fix-${n}`);
  await m.resolutionEnded(r.runId, res, { kind: "completed", tree: g(dir, "rev-parse", `${fixed}^{tree}`) });
  s = await until(async () => { const x = await mergeOf(m, h, dir, r.runId); return x?.status === "paused" ? x : null; });
  assert.deepEqual([s.reason, s.detail, s.interference], ["merge_agent_failed", "checks_after", true]);
});

test("never to an agent: a conflict in a lock file, an update from HEAD, a merge that does not wait", OPTS, async () => {
  assert.ok(isLockFile("package-lock.json") && isLockFile("web/composer.lock") && !isLockFile("lock.txt"));
  const m = merges();
  const lock = await conflicted(m, { "package-lock.json": "{\"a\":1}\n" }, { "package-lock.json": "{\"a\":2}\n" }, { "package-lock.json": "{}\n" });
  await assert.rejects(m.toAgent(lock.runId, randomUUID()), (e) => e.code === "merge_agent_unavailable" && /package-lock\.json/.test(e.message));
  // waits for an agent already: not again
  const c = await conflicted(m);
  await m.toAgent(c.runId, randomUUID());
  await assert.rejects(m.toAgent(c.runId, randomUUID()), (e) => e.code === "merge_not_paused");
  // an update from HEAD that conflicts
  const m2 = merges();
  const dir = project();
  const h = await m2.ensureHead(WS, dir);
  const one = commitOn(dir, h.commit, { "a.txt": "one\n" }, `t1-${n}`);
  const r1 = await m2.merge({ workspaceId: WS, project: dir, task: { id: randomUUID(), key: "T-1" }, taskRunId: randomUUID(), commit: one, language: "ru" });
  await until(async () => (await mergeOf(m2, h, dir, r1.runId))?.status === "completed");
  fs.writeFileSync(path.join(dir, "a.txt"), "the person's\n");
  g(dir, "commit", "-q", "-am", "the person's commit");
  const hr = await m2.fromHead({ workspaceId: WS, project: dir, language: "ru" });
  const p = await until(async () => { const x = await mergeOf(m2, h, dir, hr.runId); return x?.status === "paused" ? x : null; });
  assert.equal(p.reason, "merge_conflict");
  await assert.rejects(m2.toAgent(hr.runId, randomUUID()), (e) => e.code === "merge_agent_unavailable");
});

test("waiting for a slot or the budget: a pause, then handed to an agent from it", OPTS, async () => {
  const m = merges();
  const { dir, h, runId } = await conflicted(m);
  await m.waitFor(runId, "merge_waits_slot");
  assert.equal((await mergeOf(m, h, dir, runId)).reason, "merge_waits_slot");
  const t = await m.toAgent(runId, randomUUID());
  assert.equal(t.attempt, 1);
});

test("a restart while the merge waits for its resolution run: it waits on (not «recovered»)", OPTS, async () => {
  const root = path.join(TMP, `root-${++n}`);
  const mk = () => createBoardMerge({ root, gitPath: () => GIT, launch: () => LAUNCH, own: async () => {}, checks: async () => ["true"],
    shell: async () => ({ shell: SHELL, env: CHECK_ENV }), quiet: async () => true, retryWaitMs: 50, retryPollMs: 10 });
  const m = mk();
  const { dir, h, runId } = await conflicted(m);
  const res = randomUUID();
  await m.toAgent(runId, res);
  const again = mk(); // a new process: its recovery runs first
  await again.recovered();
  const s = await mergeOf(again, h, dir, runId);
  assert.deepEqual([s.status, s.agent.pending], ["running", true]);
  assert.deepEqual(await again.awaiting(), [{ runId, resolutionRunId: res }]);
});

test("the requirements a resolution keeps: the application's, the merged task's, then the touching tasks' — once each, 32 at most; the markers' check lines", () => {
  const r = mergeRequirements({ key: "T-2", criteria: ["x", "y"] }, [{ key: "T-1", criteria: ["y", "z"], paths: ["a.txt"] }, { key: "T-3", criteria: ["q"], paths: ["b.txt"] }], ["a.txt"], true);
  assert.deepEqual(r, { criteria: ["В файлах нет маркеров конфликта: a.txt", "x", "y", "z"], left: [] });
  // semantic: no markers' requirement
  assert.deepEqual(mergeRequirements({ key: "T-2", criteria: ["x"] }, [], ["a.txt"], false).criteria, ["x"]);
  // over 32: the application's and the merged task's first; a task none of whose fit is named
  const many = Array.from({ length: 31 }, (_, i) => `t2-${i}`);
  const big = mergeRequirements({ key: "T-2", criteria: many }, [{ key: "T-1", criteria: ["other"], paths: ["a.txt"] }], ["a.txt"], true);
  assert.equal(big.criteria.length, 32);
  assert.deepEqual(big.left, ["T-1"]);
  // a long list of paths: the requirement stays within 500 characters
  const paths = Array.from({ length: 60 }, (_, i) => `src/some/long/path/file-${i}.ts`);
  const long = mergeRequirements({ key: "T-2", criteria: ["x"] }, [], paths, true).criteria[0];
  assert.ok(long.length <= 500 && /и ещё \d+/.test(long), long);
  // the markers' check: quoted paths, a file that is gone passes, a marker fails
  const [line] = markersLines(["a.txt", "it's b.txt"], 1);
  assert.equal(line, "! grep -sIE '^(<{7}|>{7}) ' -- 'a.txt' 'it'\\''s b.txt'");
  const d = fs.mkdtempSync(path.join(TMP, "mk-"));
  const run = (files) => { for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t); try { execFileSync("/bin/sh", ["-c", line], { cwd: d }); return 0; } catch (e) { return e.status; } };
  assert.equal(run({ "a.txt": "one\ntwo\n" }), 0, "no markers, the other file gone");
  assert.equal(run({ "it's b.txt": ">>>>>>> theirs\n" }), 1, "a marker");
  assert.equal(markersLines(Array.from({ length: 200 }, (_, i) => `p/${"x".repeat(40)}-${i}`), 1), null, "does not fit one line");
  assert.equal(markersLines(Array.from({ length: 200 }, (_, i) => `p/${"x".repeat(40)}-${i}`), 16).length > 1, true);
});

// ---------------- through the manager, fake CLIs ----------------
const wrapper = (name, mock) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
};
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const b64 = (t) => Buffer.from(t).toString("base64");
const taskTurns = (text) => [
  { answer: { stages: [{ title: "fix", task: "write c.txt", conditions: [{ keep: null, text: "c.txt written", covers: ["R1"], evidence: { kind: "change", check: null } }] }], dropped: [], dropRequirements: [], question: null } },
  { answer: { summary: "done", done: true }, writes: [{ rel: "c.txt", base64: b64(text) }] },
  { answer: { conditions: [{ id: "C1", status: "met", paths: ["c.txt"], note: "written" }], findings: [], request: "none", question: null } },
  { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "written" }] } }
];
const resolutionTurns = [
  { answer: { summary: "resolved", done: true }, writes: [{ rel: "c.txt", base64: b64("one\ntwo\n") }] },
  { answer: { conditions: [{ id: "C1", status: "met", paths: ["c.txt"], note: "both kept" }], findings: [], request: "none", question: null } },
  { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "ok" }, { id: "R2", status: "met", note: "ok" }] } }
];
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
function manager(script, extra = {}) {
  const root = path.join(TMP, `root-${++n}`);
  const file = path.join(TMP, `providers-${++n}.json`);
  fs.mkdirSync(path.join(TMP, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(TMP, ".codex", "config.toml"), "");
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, CODEX_HOME: path.join(TMP, ".codex"), MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script, MOCK_SCRIPT_PER_CWD: "1", ...extra } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...CHECK_ENV, HOME: TMP } }));
  const m = createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true,
    workspaceOpen: () => true, workspaceKnown: (id) => id === "common" });
  m.root = root;
  return m;
}
const bounds = { position: { x: 0, y: 0 }, size: { width: 280, height: 160 } };
async function linkOn(m, src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds })).value.agentId;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds })).value.agentId;
  return (await m.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
}

test("through the manager: two tasks change one line, the second's merge conflicts, «Поручить агенту» — a resolution run off the canvas, then the merge completes with both", OPTS, async () => {
  const src = fs.realpathSync(project());
  const m = manager(scripts(taskTurns("one\n"), taskTurns("two\n"), resolutionTurns), { MOCK_TURN_DELAY_MS: "300" });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] });
  const input = (title) => ({ workspaceId: WS, project: src, title, text: "write c.txt", criteria: ["c.txt is written"], dependsOn: [] });
  const t1 = (await m.boardCreate(input("A"))).value;
  const t2 = (await m.boardCreate(input("B"))).value;
  const side = personSide(src);
  const linkId = await linkOn(m, src);
  assert.equal((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel: 2 })).ok, true);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  const paused = await until(async () => (await m.board()).value.heads?.[0]?.merges.find((x) => x.status === "paused" && x.reason === "merge_conflict"), 120_000);
  assert.equal(paused.task.id, [t1, t2].find((t) => t.id === paused.task.id).id);
  assert.deepEqual(paused.conflicts, ["c.txt"]);
  const r = await m.boardMergeAgent(paused.runId, "ru");
  assert.ok(r.ok, JSON.stringify(r));
  const resolution = r.value.runId;
  // the resolution run stands on no link and is not listed with the runs
  assert.ok(isResolutionJournal(fs.readFileSync(path.join(m.root, "runs", resolution, "journal.jsonl"))));
  assert.ok(!(await m.list()).value.some((x) => x.view.runId === resolution));
  assert.ok(!(await m.canvas()).value.links.some((l) => (l.runIds ?? []).includes(resolution)));
  const done = await until(async () => (await m.board()).value.heads[0].merges.find((x) => x.runId === paused.runId && x.status === "completed"), 120_000);
  assert.deepEqual([done.completion, done.agent.resolutionRunId, done.agent.pending], ["confirmed", resolution, false]);
  const h = (await m.board()).value.heads[0];
  assert.equal(g(src, "show", `${h.commit}:c.txt`), "one\ntwo");
  // the resolution's goal: both sides' requirements, the project's check and the markers'
  const first = JSON.parse(fs.readFileSync(path.join(m.root, "runs", resolution, "journal.jsonl"), "utf8").split("\n")[0]);
  const goal = JSON.parse(fs.readFileSync(path.join(m.root, "runs", resolution, "texts", first.data.goal.sha256), "utf8"));
  assert.deepEqual(goal.criteria, ["В файлах нет маркеров конфликта: c.txt", "c.txt is written"]);
  assert.deepEqual(goal.commands, ["test -f keep.txt", "! grep -sIE '^(<{7}|>{7}) ' -- 'c.txt'"]);
  assert.equal(goal.task, undefined);
  assert.equal(goal.resolution.mergeRunId, paused.runId);
  await m.boardAutopilot(linkId, false, "ru");
  assert.deepEqual(personSide(src), side, "the person's folder untouched");
  await m.shutdown();
});

test("the autopilot's step (§9): a paused conflict to an agent with a slot and budget; no slot — it waits for one, not the person; no budget, «Решать мне», a second try, a refusal — the person's", () => {
  const at = { workspaceId: WS, project: "/p" };
  const merge = (extra) => ({ runId: randomUUID(), board: "refs/raoden/board/common/1", base: "b".repeat(40), task: { id: randomUUID(), key: "T-2", runId: randomUUID(), commit: "c".repeat(40) },
    status: "paused", reason: "merge_conflict", detail: null, completion: null, conflicts: ["a.txt"], outside: [], interference: false, retrying: false, dir: null, createdAt: 1, ...extra });
  const head = (merges) => ({ workspaceId: WS, project: "/p", ref: "refs/raoden/board/common/1", n: 1, commit: "b".repeat(40), behind: null, branch: null, merges });
  const step = (merges, budget = { runs: 5, minutes: 240 }, used = { runs: 0, ms: 0 }, refused) => autopilotParallelStep({ tasks: [] }, [], at, [], used, budget, head(merges), refused);
  const m = merge();
  assert.deepEqual(step([m]), { kind: "agent", mergeRunId: m.runId, key: "T-2" });
  assert.deepEqual(step([merge({ reason: "merge_checks_failed", conflicts: [] })]).kind, "agent");
  // no slot: parallel 1 held by another merge's resolution run
  const busy = merge({ status: "running", reason: null, agent: { attempt: 1, reason: "conflict", resolutionRunId: randomUUID(), pending: true } });
  assert.deepEqual(step([m, busy], { runs: 5, minutes: 240, parallel: 1 }), { kind: "merge_wait", mergeRunId: m.runId, why: "merge_waits_slot", key: "T-2" });
  assert.deepEqual(step([merge({ reason: "merge_waits_slot" }), busy], { runs: 5, minutes: 240, parallel: 1 }), { kind: "wait", why: "run" }, "a wait for a slot is not the person's");
  // no budget
  assert.equal(step([m], { runs: 2, minutes: 240 }, { runs: 2, ms: 0 }).why, "merge_budget");
  // the person's
  assert.deepEqual(step([m], { runs: 5, minutes: 240, conflicts: "person" }), { kind: "wait", why: "merge" });
  assert.deepEqual(step([merge({ reason: "merge_agent_failed", agent: { attempt: 1, reason: "conflict", resolutionRunId: randomUUID(), pending: false } })]), { kind: "wait", why: "merge" });
  assert.deepEqual(step([merge({ agent: { attempt: 1, reason: "conflict", resolutionRunId: randomUUID(), pending: false } })]), { kind: "wait", why: "merge" }, "never a second try by itself");
  assert.deepEqual(step([m], undefined, undefined, new Set([m.runId])), { kind: "wait", why: "merge" });
  assert.deepEqual(step([merge({ source: "head" })]), { kind: "wait", why: "merge" });
  assert.deepEqual(step([merge({ reason: "merge_budget" })]), { kind: "wait", why: "merge" });
});

test("through the manager with the autopilot: the conflict handed to an agent by itself, the merge completes, the autopilot ends «all done»; its budget counts the resolution run", OPTS, async () => {
  const src = fs.realpathSync(project());
  const m = manager(scripts(taskTurns("one\n"), taskTurns("two\n"), resolutionTurns), { MOCK_TURN_DELAY_MS: "300" });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] });
  const input = (title) => ({ workspaceId: WS, project: src, title, text: "write c.txt", criteria: ["c.txt is written"], dependsOn: [] });
  await m.boardCreate(input("A"));
  await m.boardCreate(input("B"));
  const side = personSide(src);
  const linkId = await linkOn(m, src);
  assert.equal((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel: 2 })).ok, true);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  let most = 0;
  const end = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; if (s?.on) most = Math.max(most, s.used.runs); return s && !s.on ? s : null; }, 200_000);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  assert.equal(most, 3, "two tasks and the resolution run");
  const h = (await m.board()).value.heads[0];
  const agentMerge = h.merges.find((x) => x.agent);
  assert.deepEqual([agentMerge.status, agentMerge.completion, agentMerge.agent.attempt], ["completed", "confirmed", 1]);
  assert.equal(g(src, "show", `${h.commit}:c.txt`), "one\ntwo");
  assert.deepEqual(personSide(src), side);
  await m.shutdown();
});

test("«Решать мне»: the conflict waits for the person, nothing is handed to an agent; the setting survives a budget change", OPTS, async () => {
  const src = fs.realpathSync(project());
  const m = manager(scripts(taskTurns("one\n"), taskTurns("two\n")), { MOCK_TURN_DELAY_MS: "300" });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] });
  const input = (title) => ({ workspaceId: WS, project: src, title, text: "write c.txt", criteria: ["c.txt is written"], dependsOn: [] });
  await m.boardCreate(input("A"));
  await m.boardCreate(input("B"));
  const linkId = await linkOn(m, src);
  assert.equal((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel: 2, conflicts: "person" })).ok, true);
  assert.equal((await m.board()).value.board.autopilot[linkId].conflicts, "person");
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  const paused = await until(async () => (await m.board()).value.heads?.[0]?.merges.find((x) => x.status === "paused"), 120_000);
  await sleep(3500); // a few beats of the autopilot
  const again = (await m.board()).value;
  assert.deepEqual([again.heads[0].merges.find((x) => x.runId === paused.runId).reason, again.autopilot[linkId].waits], ["merge_conflict", "merge"]);
  assert.ok(!again.heads[0].merges.some((x) => x.agent));
  await m.boardAutopilot(linkId, false, "ru");
  await m.shutdown();
});
