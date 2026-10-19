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
import { createBoardMerge, isLockFile } from "../src/main/services/orchestration/boardMerge.ts";

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
