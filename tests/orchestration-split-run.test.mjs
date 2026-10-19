// E1 (docs/agent-orchestration/implementation/stage-e-decomposition.md §3.1, §3.3, §4): a decomposition run on fake CLIs —
// one lead (decompose) turn, the application's check of the proposal, a refusal with its reasons and a second chance,
// «whole», a question, the limits. The copy starts from `base`; the project's folder is never written. Temporary repositories.
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
import { splitViolations } from "../src/main/services/orchestration/orchestrationService.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-splitrun-")));
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

function script(steps) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  for (const [i, s] of steps.entries()) fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(s));
  return dir;
}
function manager(steps, env = {}) {
  const root = path.join(TMP, `root-${++n}`);
  const file = path.join(TMP, `providers-${n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, CODEX_HOME: path.join(TMP, ".codex"), MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script(steps), MOCK_CHECKS: "none", ...env } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  return { root, m: createRunManager({ platform: "darwin", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true }) };
}
function project() {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "app.txt"), "one\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return { dir, commit: g(dir, "rev-parse", "HEAD") };
}
const CRITERIA = ["the first part works", "the second part works"];
const goal = (base, over = {}) => ({ text: "Add the two parts", criteria: CRITERIA, checks: [], commands: [], mode: "autopilot", workMode: "copy",
  limits: { turns: 6, runMs: 40 * 60_000, leadTurnMs: 10 * 60_000 }, decomposition: { taskId: randomUUID(), key: "T-3", base }, ...over });
const task = (id, covers, dependsOn = []) => ({ id, title: `part ${id}`, text: `do ${id}`, criteria: [`${id} done`], dependsOn, covers });
const PROPOSAL = { tasks: [task("S1", ["R1"]), task("S2", ["R2"], ["S1"])], whole: null, question: null };
const MISSING_R2 = { tasks: [task("S1", ["R1"]), task("S2", ["R1"])], whole: null, question: null };
const WHOLE = { tasks: [], whole: "one small change, splitting adds nothing", question: null };
const QUESTION = { tasks: [], whole: null, question: "which part first?" };
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
const text = (root, runId, ref) => fs.readFileSync(path.join(root, "runs", runId, "texts", ref.sha256), "utf8");
const types = (lines) => lines.map((l) => l.type);
const command = async (m, runId, cmd) => m.command(runId, { commandId: randomUUID(), expectedRevision: (await m.get(runId)).value.view.revision, command: cmd });
const folder = (dir) => ({ head: g(dir, "rev-parse", "HEAD"), status: g(dir, "status", "--porcelain", "--ignored"), files: fs.readdirSync(dir).sort() });

test("checkDecomposition: refused without its form — base, commands, task, resolution, mode, workMode", OPTS, async () => {
  const { dir, commit } = project();
  const { m } = manager([]);
  const ok = { taskId: randomUUID(), key: "T-3", base: commit };
  const bads = [
    { decomposition: { ...ok, base: "main" } }, { decomposition: { ...ok, base: commit.slice(0, 12) } }, { decomposition: { ...ok, key: "3" } },
    { decomposition: { ...ok, taskId: "x" } }, { decomposition: { ...ok, extra: 1 } }, { decomposition: [] },
    { commands: ["true"] }, { workMode: "worktree" }, { workMode: "project" },
    { task: { id: randomUUID(), key: "T-3" } }, { reviewPlan: true }, { mode: "steps" },
    { resolution: { mergeRunId: randomUUID(), taskId: randomUUID(), key: "T-2", base: commit } },
    { finish: { commit: true, push: false, qa: false } }
  ];
  for (const bad of bads) {
    const r = await m.create({ requestId: randomUUID(), source: dir, goal: { ...goal(commit), ...bad } });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  await m.shutdown();
});

test("a proposed run: one decompose turn, decomposition.proposed, completed proposed; the copy is from base, the project's folder untouched", OPTS, async () => {
  const { dir, commit } = project();
  // the folder moves on after base: the copy must still start from it
  fs.writeFileSync(path.join(dir, "later.txt"), "later\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "later");
  const before = folder(dir);
  const { root, m } = manager([PROPOSAL]);
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: dir, goal: goal(commit) });
  assert.ok(r.ok, JSON.stringify(r));
  const v = await ended(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v).slice(0, 500));
  const { lines, parsed } = journal(root, runId);
  assert.equal(parsed.integrity.status, "ok", JSON.stringify(parsed.integrity));
  assert.ok(lines.every((l) => l.v === 3));
  assert.equal(lines[0].data.kind, "decomposition");
  const st = parsed.state;
  assert.equal(st.completion.kind, "proposed");
  assert.deepEqual(Object.values(st.orch.turns).map((t) => t.purpose), ["decompose"]);
  assert.deepEqual(Object.values(st.turns).map((t) => t.role), ["lead"]);
  assert.equal(st.orch.plan, null);
  assert.equal(types(lines).filter((t) => t.startsWith("decomposition.")).join(), "decomposition.proposed");
  assert.ok(!types(lines).some((t) => t === "checks.proposed" || t === "check.started"), "no checks");
  assert.equal(JSON.parse(text(root, runId, st.orch.split.proposed.ref)).tasks.length, 2);
  const basis = JSON.parse(text(root, runId, st.completion.basis));
  assert.deepEqual([basis.kind, basis.turnId], ["proposed", st.orch.split.proposed.turnId]);
  assert.equal(st.workspace.baseline.tree, g(dir, "rev-parse", `${commit}^{tree}`), "the copy started from base, not from the folder's head");
  assert.deepEqual(folder(dir), before, "nothing written to the project folder");
  // the turn's task: the goal, its requirements, no checks or conditions
  const t = text(root, runId, Object.values(st.turns)[0].task);
  assert.match(t, /Purpose: decompose/);
  assert.match(t, /R1: the first part works/);
  assert.match(t, /R2: the second part works/);
  assert.ok(!/Required checks|No check commands|Readiness conditions/.test(t));
  await m.shutdown();
});

test("two refusals (a requirement left uncovered): completed rejected; the second task carries the first reasons", OPTS, async () => {
  const { dir, commit } = project();
  const { root, m } = manager([MISSING_R2, MISSING_R2]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  const v = await ended(m, runId);
  assert.equal(v.status, "completed", JSON.stringify(v).slice(0, 500));
  const { lines, parsed } = journal(root, runId);
  assert.equal(parsed.integrity.status, "ok");
  const st = parsed.state;
  assert.equal(st.completion.kind, "rejected");
  assert.equal(types(lines).filter((t) => t === "decomposition.rejected").length, 2);
  assert.equal(st.orch.split.proposed, null);
  const reasons = JSON.parse(text(root, runId, st.orch.split.rejected[0].ref));
  assert.ok(reasons.some((x) => /R2/.test(x)), JSON.stringify(reasons));
  const tasks = Object.values(st.turns).map((x) => text(root, runId, x.task));
  assert.equal(tasks.length, 2);
  assert.ok(!/not accepted by the application/.test(tasks[0]));
  assert.match(tasks[1], /Your previous proposal was not accepted by the application/);
  assert.ok(tasks[1].includes(reasons[0]));
  await m.shutdown();
});

test("a refusal then a good proposal: completed proposed", OPTS, async () => {
  const { dir, commit } = project();
  const { root, m } = manager([MISSING_R2, PROPOSAL]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  assert.equal((await ended(m, runId)).status, "completed");
  const { parsed } = journal(root, runId);
  assert.equal(parsed.state.completion.kind, "proposed");
  assert.equal(parsed.state.orch.split.rejected.length, 1);
  await m.shutdown();
});

test("whole: completed whole", OPTS, async () => {
  const { dir, commit } = project();
  const { root, m } = manager([WHOLE]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  assert.equal((await ended(m, runId)).status, "completed");
  const { lines, parsed } = journal(root, runId);
  assert.equal(parsed.integrity.status, "ok");
  assert.equal(parsed.state.completion.kind, "whole");
  assert.equal(text(root, runId, parsed.state.orch.split.whole.ref), WHOLE.whole);
  assert.equal(types(lines).filter((t) => t.startsWith("decomposition.")).join(), "decomposition.whole");
  await m.shutdown();
});

test("a question: paused awaiting_answer; the answer goes to the next decompose turn, which proposes", OPTS, async () => {
  const { dir, commit } = project();
  const { root, m } = manager([QUESTION, PROPOSAL]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  const v = await ended(m, runId);
  assert.deepEqual([v.status, v.reason], ["paused", "awaiting_answer"], JSON.stringify(v).slice(0, 400));
  const q = journal(root, runId).parsed.state.orch.question;
  const a = await command(m, runId, { kind: "answer", questionId: q.questionId, text: "the first part first" });
  assert.ok(a.ok, JSON.stringify(a));
  const end = await ended(m, runId);
  assert.equal(end.status, "completed", JSON.stringify(end).slice(0, 400));
  const st = journal(root, runId).parsed.state;
  assert.equal(st.completion.kind, "proposed");
  const tasks = Object.values(st.turns).map((x) => text(root, runId, x.task));
  assert.equal(tasks.length, 2);
  assert.match(tasks[1], /Answer to your question: the first part first/);
  await m.shutdown();
});

test("an invalid report (none or two of tasks / whole / question, a wrong shape): paused invalid_report, nothing recorded", OPTS, async () => {
  for (const bad of [{ foo: 1 }, { tasks: [], whole: null, question: null }, { ...PROPOSAL, whole: "both" }, { tasks: [{ ...task("S11", ["R1"]) }], whole: null, question: null }]) {
    const { dir, commit } = project();
    const { root, m } = manager([bad]);
    const runId = randomUUID();
    assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
    const v = await ended(m, runId);
    assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"], JSON.stringify(bad));
    assert.ok(!types(journal(root, runId).lines).some((t) => t.startsWith("decomposition.")));
    await m.shutdown();
  }
});

test("stop during a turn: stopped", OPTS, async () => {
  const { dir, commit } = project();
  const { root, m } = manager([PROPOSAL], { MOCK_TURN_DELAY_MS: "3000" });
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  for (let i = 0; i < 100 && (await m.get(runId)).value.view.active?.kind !== "turn"; i++) await sleep(50);
  assert.equal((await m.get(runId)).value.view.active?.purpose, "decompose");
  assert.ok((await command(m, runId, { kind: "stop" })).ok);
  const v = await ended(m, runId);
  assert.equal(v.status, "stopped", JSON.stringify(v).slice(0, 300));
  assert.ok(!types(journal(root, runId).lines).some((t) => t.startsWith("decomposition.")));
  await m.shutdown();
});

test("the turns limit: six invalid turns, the seventh step pauses limit_reached turns", OPTS, async () => {
  const { dir, commit } = project();
  const { root, m } = manager(Array.from({ length: 7 }, () => ({ foo: 1 })));
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: dir, goal: goal(commit) })).ok);
  let v = await ended(m, runId);
  for (let i = 1; i < 6; i++) {
    assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"], `turn ${i}`);
    assert.ok((await command(m, runId, { kind: "step" })).ok);
    v = await ended(m, runId);
  }
  assert.deepEqual([v.status, v.reason], ["paused", "invalid_report"]);
  assert.ok((await command(m, runId, { kind: "step" })).ok);
  v = await ended(m, runId);
  assert.deepEqual([v.status, v.reason, v.progress?.budget?.reached], ["paused", "limit_reached", "turns"], JSON.stringify(v).slice(0, 300));
  assert.equal(Object.keys(journal(root, runId).parsed.state.turns).length, 6);
  await m.shutdown();
});

test("empty commands propose no checks in a decomposition run; an ordinary v2 run without commands still does", OPTS, async () => {
  const { dir, commit } = project();
  const a = manager([PROPOSAL]);
  const split = randomUUID();
  assert.ok((await a.m.create({ requestId: split, source: dir, goal: goal(commit) })).ok);
  assert.equal((await ended(a.m, split)).status, "completed");
  const lines = journal(a.root, split).lines;
  assert.ok(!types(lines).includes("checks.proposed"));
  await a.m.shutdown();
  // regression: the same empty commands in an ordinary run — the first plan turn proposes them
  const PLAN = { stages: [{ title: "s", task: "t", conditions: [{ keep: null, text: "done", covers: ["R1", "R2"], evidence: { kind: "change", check: null } }] }],
    dropped: [], dropRequirements: [], question: null };
  const b = manager([PLAN]);
  const plain = randomUUID();
  const { decomposition: _d, ...rest } = goal(commit);
  assert.ok((await b.m.create({ requestId: plain, source: dir, goal: { ...rest, workMode: "copy" } })).ok);
  await ended(b.m, plain);
  assert.ok(types(journal(b.root, plain).lines).includes("checks.proposed"), "an ordinary run proposes checks");
  await b.m.shutdown();
});

test("splitViolations: coverage, an extra R, a cycle, a self-dependency, an unknown dependency, duplicates, 1 and 11 subtasks", () => {
  const t = (id, covers, dependsOn = [], title = `t ${id}`) => ({ ...task(id, covers, dependsOn), title });
  assert.deepEqual(splitViolations([t("S1", ["R1"]), t("S2", ["R2"], ["S1"])], 2), []);
  assert.ok(splitViolations([t("S1", ["R1"]), t("S2", ["R1"])], 2).some((x) => /R2/.test(x)), "uncovered");
  assert.ok(splitViolations([t("S1", ["R1", "R3"]), t("S2", ["R2"])], 2).some((x) => /R3/.test(x)), "an R of no requirement");
  assert.ok(splitViolations([t("S1", ["R1"], ["S2"]), t("S2", ["R2"], ["S1"])], 2).some((x) => /cycle/.test(x)), "a cycle");
  assert.ok(splitViolations([t("S1", ["R1"], ["S1"]), t("S2", ["R2"])], 2).some((x) => /itself/.test(x)), "self");
  assert.ok(splitViolations([t("S1", ["R1"], ["S5"]), t("S2", ["R2"])], 2).some((x) => /S5/.test(x)), "unknown dependency");
  assert.ok(splitViolations([t("S1", ["R1"]), t("S1", ["R2"], [], "other")], 2).some((x) => /ids/.test(x)), "duplicate id");
  assert.ok(splitViolations([t("S1", ["R1"], [], "same"), t("S2", ["R2"], [], "same")], 2).some((x) => /titles/.test(x)), "duplicate title");
  assert.ok(splitViolations([t("S1", ["R1", "R2"])], 2).some((x) => /2\.\.10/.test(x)), "one subtask");
  const eleven = Array.from({ length: 11 }, (_, i) => t(`S${i + 1}`, i === 0 ? ["R1"] : []));
  assert.ok(splitViolations(eleven, 1).some((x) => /2\.\.10/.test(x)), "eleven subtasks");
  assert.ok(splitViolations([{ ...t("S1", ["R1"]), criteria: [] }, t("S2", ["R2"])], 2).some((x) => /criteria/.test(x)), "no criteria");
  // a three-step cycle and a chain that is not one
  assert.ok(splitViolations([t("S1", ["R1"], ["S3"]), t("S2", ["R2"], ["S1"]), t("S3", ["R3"], ["S2"])], 3).some((x) => /cycle/.test(x)));
  assert.deepEqual(splitViolations([t("S1", ["R1"]), t("S2", ["R2"], ["S1"]), t("S3", ["R3"], ["S1", "S2"])], 3), []);
});
