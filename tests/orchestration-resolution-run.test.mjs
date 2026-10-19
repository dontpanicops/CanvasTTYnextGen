// C3 (docs/agent-orchestration/implementation/stage-c3-conflicts.md §2.2, §3, §4, §5): a resolution run on fake CLIs —
// its copy starts from the conflict's commit, its plan is the application's (no lead turn), the markers' check sends the
// executor back, the reviewer's replan request pauses it (no lead to plan again). Every repository is a temporary one.
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
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-resrun-")));
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
function manager(steps) {
  const root = path.join(TMP, `root-${++n}`);
  const file = path.join(TMP, `providers-${n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, CODEX_HOME: path.join(TMP, ".codex"), MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script(steps), MOCK_CHECKS: "none" } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  return { root, m: createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true }) };
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
const roles = (st) => Object.values(st.turns).map((t) => t.role);

test("a resolution run: from the conflict's commit, the application's plan, executor then reviewer — completed and confirmed, no lead turn", OPTS, async () => {
  const { dir, commit } = conflictProject();
  const { root, m } = manager([EXEC("one\ntwo\n"), REVIEW, FINAL]);
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: dir, goal: goal(commit) });
  assert.ok(r.ok, JSON.stringify(r));
  const v = await ended(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v).slice(0, 500));
  const { lines, parsed } = journal(root, runId);
  assert.ok(lines.every((l) => l.v === 3));
  assert.equal(parsed.integrity.status, "ok");
  const st = parsed.state;
  assert.equal(st.completion.kind, "confirmed");
  assert.equal(st.orch.plan.turnId, null);
  assert.deepEqual(roles(st), ["executor", "reviewer", "reviewer"]);
  assert.equal(st.workspace.baseline.tree, g(dir, "rev-parse", `${commit}^{tree}`), "the copy started from the conflict");
  // the run is never a task's: no goal.task
  const goalText = JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "texts", lines[0].data.goal.sha256), "utf8"));
  assert.equal(goalText.task, undefined);
  assert.equal(goalText.resolution.base, commit);
  await m.shutdown();
});

test("markers left by the executor: the markers' check fails, the executor goes again", OPTS, async () => {
  const { dir, commit } = conflictProject();
  const left = "<<<<<<< ours\none\n=======\ntwo\n>>>>>>> theirs\n";
  const NOT_YET = { report: { conditions: [{ id: "C1", status: "not_met", paths: ["auth.txt"], note: "markers left" }], findings: [], request: "none", question: null } };
  const { root, m } = manager([EXEC(left), NOT_YET, EXEC("one\ntwo\n"), REVIEW, FINAL]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  const v = await ended(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v).slice(0, 500));
  const st = journal(root, runId).parsed.state;
  assert.deepEqual(roles(st), ["executor", "reviewer", "executor", "reviewer", "reviewer"]);
  const failed = Object.values(st.checks).filter((c) => c.status === "failed");
  assert.equal(failed.length, 1, "the markers' check failed once");
  await m.shutdown();
});

test("the reviewer asks for a new plan: no lead to make it — paused at the limit of replans", OPTS, async () => {
  const { dir, commit } = conflictProject();
  const REPLAN = { report: { conditions: [{ id: "C1", status: "not_met", paths: [], note: "wrong" }], findings: [], request: "replan", question: null } };
  const { root, m } = manager([EXEC("one\n"), REPLAN]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  const v = await ended(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "limit_reached"], JSON.stringify(v).slice(0, 500));
  assert.ok(!roles(journal(root, runId).parsed.state).includes("lead"));
  await m.shutdown();
});

test("a resolution goal is refused without its form: worktree, a task beside it, no commands", OPTS, async () => {
  const { dir, commit } = conflictProject();
  const { m } = manager([]);
  for (const bad of [{ workMode: "worktree" }, { task: { id: randomUUID(), key: "T-2" } }, { commands: [] }, { reviewPlan: true }]) {
    const r = await m.create({ requestId: randomUUID(), source: dir, goal: { ...goal(commit), ...bad } });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  await m.shutdown();
});
