// F1, T-15 (docs/agent-orchestration/implementation/stage-f-external-projects.md §5.1, §8): the published formats.
// The examples of docs/agent-orchestration/board-formats.md pass docs/board-tasks-v1.schema.json and
// docs/board-review-v1.schema.json (full JSON Schema 2020-12 by Ajv, the owner's options), the negative cases do not, and
// every [П] field of board-review/v1 is built from a journal v2 that the current code wrote on fake CLIs (a helper builds
// the export here: the production export is F4's, which will run the same test through writeReviewExport). No model call.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { readRun, readText } from "../src/main/services/orchestration/store.ts";
import { readWorkspacePlace } from "../src/main/services/orchestration/workspace.ts";
import { closedByPerson } from "../src/shared/orchestration.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, "..", "docs");
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 180_000 };

// ---------------- schemas and the examples of the document ----------------

const AjvClass = Ajv2020.default ?? Ajv2020;
const ajv = new AjvClass({ strict: true, strictRequired: false, allErrors: true });
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const tasksSchema = readJson(path.join(DOCS, "board-tasks-v1.schema.json"));
const reviewSchema = readJson(path.join(DOCS, "board-review-v1.schema.json"));
const validTasks = ajv.compile(tasksSchema);
const validReview = ajv.compile(reviewSchema);
const errors = (v) => JSON.stringify(v.errors);

// an example is the ```json block that follows the comment «<!-- example: <name> -->»
const DOC = fs.readFileSync(path.join(DOCS, "agent-orchestration", "board-formats.md"), "utf8");
function example(name) {
  const m = DOC.match(new RegExp(`<!-- example: ${name} -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  assert.ok(m, `the document has no example «${name}»`);
  return JSON.parse(m[1]);
}
const clone = (x) => structuredClone(x);
const rejects = (validate, value, what) => assert.equal(validate(value), false, `${what}: must not pass`);

test("the schemas are $id first after $schema, draft 2020-12, and use no «format» keyword", () => {
  for (const s of [tasksSchema, reviewSchema]) {
    assert.deepEqual(Object.keys(s).slice(0, 2), ["$schema", "$id"]);
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.ok(!/"format"\s*:\s*"(?!board-)/.test(JSON.stringify(s)), "no `format` keyword");
  }
});

test("both examples of board-tasks/v1 pass the schema", () => {
  for (const name of ["tasks-minimal", "tasks-full"]) assert.ok(validTasks(example(name)), `${name}: ${errors(validTasks)}`);
});

test("board-tasks/v1: what the schema refuses", () => {
  const full = example("tasks-full");
  let f = clone(full); f.extra = 1; rejects(validTasks, f, "an unknown top-level field");
  f = clone(full); f.tasks[0].surprise = 1; rejects(validTasks, f, "an unknown field of a task");
  f = clone(full); f.workspaceId = "acme"; rejects(validTasks, f, "workspaceId and workspace together");
  f = clone(full); delete f.workspace; rejects(validTasks, f, "neither workspaceId nor workspace");
  f = clone(full); delete f.workspace; f.workspaceId = "acme_1-2"; assert.ok(validTasks(f), errors(validTasks));
  f = clone(full); delete f.workspace; f.workspaceId = "a b"; rejects(validTasks, f, "workspaceId with a space");
  f = clone(full); f.format = "board-tasks/v2"; rejects(validTasks, f, "another format");
  f = clone(full); f.tasks = []; rejects(validTasks, f, "no tasks");
  f = clone(full); f.tasks = Array.from({ length: 201 }, (_, i) => ({ ...full.tasks[0], ref: `R${i}` })); rejects(validTasks, f, "201 tasks");
  // criteria: required unless the task is external
  f = clone(full); delete f.tasks[0].criteria; rejects(validTasks, f, "a task that is not external without criteria");
  f = clone(full); f.tasks[0].criteria = []; rejects(validTasks, f, "empty criteria");
  f = clone(full); f.tasks[1].criteria = ["…"]; assert.ok(validTasks(f), errors(validTasks)); // an external task may have them
  assert.equal(full.tasks[1].criteria, undefined);
  assert.ok(validTasks(full), "an external task without criteria passes");
  f = clone(full); delete f.tasks[1].external; rejects(validTasks, f, "the same task without `external` needs criteria");
  f = clone(full); f.tasks[1].external = false; rejects(validTasks, f, "external is const true");
  f = clone(full); f.tasks[1].ifAbsent = false; rejects(validTasks, f, "ifAbsent is const true");
  // scope
  f = clone(full); f.tasks[2].scope = Array.from({ length: 64 }, (_, i) => `d${i}/**`); assert.ok(validTasks(f), errors(validTasks));
  f = clone(full); f.tasks[2].scope = Array.from({ length: 65 }, (_, i) => `d${i}/**`); rejects(validTasks, f, "scope of 65");
  f = clone(full); f.tasks[2].scope = ["x".repeat(301)]; rejects(validTasks, f, "a scope pattern of 301");
  f = clone(full); f.tasks[2].scope = []; rejects(validTasks, f, "empty scope");
  // dependsOn
  f = clone(full); f.tasks[2].dependsOn = ["T1", "T1"]; rejects(validTasks, f, "repeated dependsOn");
  f = clone(full); f.tasks[2].dependsOn = Array.from({ length: 65 }, (_, i) => `D${i}`); rejects(validTasks, f, "65 dependencies");
  f = clone(full); f.tasks[2].dependsOn = ["-bad"]; rejects(validTasks, f, "a dependency that is not a ref");
  // project, ref, models, issue, commitTitle
  f = clone(full); f.tasks[0].project = "relative/path"; rejects(validTasks, f, "a relative project");
  f = clone(full); f.tasks[0].project = `/${"p".repeat(4096)}`; rejects(validTasks, f, "a project over 4096");
  f = clone(full); f.tasks[0].ref = "-x"; rejects(validTasks, f, "a ref with a leading dash");
  f = clone(full); f.tasks[0].ref = "a".repeat(33); rejects(validTasks, f, "a ref of 33");
  f = clone(full); f.tasks[2].models = { executor: null }; rejects(validTasks, f, "a null model");
  f = clone(full); f.tasks[2].models = { executor: "bad model" }; rejects(validTasks, f, "a model with a space");
  f = clone(full); f.tasks[2].models = { writer: "opus" }; rejects(validTasks, f, "an unknown role");
  f = clone(full); f.tasks[2].models = { lead: "gpt-5.5:high", reviewer: "a/b[c]" }; assert.ok(validTasks(f), errors(validTasks));
  f = clone(full); f.tasks[0].issue = "bad issue"; rejects(validTasks, f, "an issue with a space");
  f = clone(full); f.tasks[0].commitTitle = "two\nlines"; rejects(validTasks, f, "a commit title with a line break");
  f = clone(full); f.tasks[0].commitTitle = "a b"; rejects(validTasks, f, "a commit title with U+2028");
  f = clone(full); f.tasks[0].commitTitle = "x".repeat(73); rejects(validTasks, f, "a commit title of 73");
  f = clone(full); f.tasks[0].commitTitle = ""; rejects(validTasks, f, "an empty commit title");
  f = clone(full); f.tasks[0].title = ""; rejects(validTasks, f, "an empty title");
  f = clone(full); f.tasks[0].text = "x".repeat(8001); rejects(validTasks, f, "a text of 8001");
});

test("«schema passed ≠ string accepted»: the schema counts characters, and does not trim", () => {
  const f = clone(example("tasks-minimal"));
  f.tasks[0].title = "   "; // the import refuses it (invalid_task); the schema has no trim
  assert.ok(validTasks(f), errors(validTasks));
  f.tasks[0].title = "😀".repeat(200); // 200 characters, 400 UTF-16 units: the schema counts code points
  assert.ok(validTasks(f), errors(validTasks));
  assert.equal(f.tasks[0].title.length, 400);
  f.tasks[0].title = "😀".repeat(201);
  rejects(validTasks, f, "201 characters");
});

// ---------------- board-review/v1 ----------------

test("the example review.json passes the schema", () => {
  assert.ok(validReview(example("review")), errors(validReview));
});

test("board-review/v1: what the schema refuses", () => {
  const ok = example("review");
  const mutate = (fn, what) => { const r = clone(ok); fn(r); rejects(validReview, r, what); };
  mutate((r) => { r.extra = 1; }, "an unknown field");
  mutate((r) => { delete r.tree; }, "a missing field");
  mutate((r) => { r.lead.cliVersionAtExport = "v2"; }, "a version that is not semver");
  mutate((r) => { r.lead.cliVersionAtExport = "2.1"; }, "a two-part version");
  mutate((r) => { r.lead.cliVersionAtExport = "codex-cli 0.155.0"; }, "a version with a prefix");
  mutate((r) => { r.lead.cliVersionRaw = "x".repeat(129); }, "a raw version of 129");
  mutate((r) => { delete r.lead.cliVersionRaw; }, "a role without cliVersionRaw");
  mutate((r) => { r.lead.cli = "gemini"; }, "a CLI that is not claude or codex");
  mutate((r) => { r.lead.model = "bad model"; }, "a model alias with a space");
  mutate((r) => { r.lead.modelActual = "bad model"; }, "a modelActual with a space");
  mutate((r) => { r.commit = "abc"; }, "a short sha");
  mutate((r) => { r.commit = "A".repeat(40); }, "an upper-case sha");
  mutate((r) => { r.run = "not-a-uuid"; }, "a run that is not a UUID");
  mutate((r) => { r.push.result = "unknown"; }, "push.result unknown");
  mutate((r) => { r.push.at = "2026-10-21T10:15:30Z"; }, "a push time without milliseconds");
  mutate((r) => { r.branch = "-x"; }, "a branch starting with a dash");
  mutate((r) => { r.base.branch = "x".repeat(201); }, "a base branch of 201");
  mutate((r) => { r.task.key = "T-"; }, "a task key without a number");
  mutate((r) => { r.scope = Array.from({ length: 65 }, () => "a"); }, "scope of 65");
  mutate((r) => { r.openBlocking = -1; }, "a negative openBlocking");
  mutate((r) => { r.findings[0].closedBy = null; }, "a closed finding without closedBy");
  mutate((r) => { r.findings[0].status = "open"; }, "an open finding with closedBy");
  mutate((r) => { r.findings[0].closedBy = "robot"; }, "closedBy that is neither reviewer nor person");
  mutate((r) => { r.findings[0].problem = ""; }, "an empty problem");
  mutate((r) => { r.conditions[0].evidence.check = null; }, "check evidence without a check");
  mutate((r) => { r.conditions[0].evidence.check = "cmd-123"; }, "a check id of three digits");
  mutate((r) => { r.conditions[0].evidence.kind = "change"; }, "change evidence with a check and a command");
  mutate((r) => { r.conditions[0].covers = Array.from({ length: 33 }, (_, i) => `R${i + 1}`); }, "33 covers");
  mutate((r) => { r.conditions[0].status = "maybe"; }, "an unknown condition status");
  // what it accepts: the null cases of §8
  const nulls = clone(ok);
  Object.assign(nulls, { push: null, lead: null, reviewer: null, scope: null, conditions: [], findings: [] });
  Object.assign(nulls.task, { ref: null, title: null, issue: null });
  Object.assign(nulls.executor, { model: null, cliVersionAtExport: null, cliVersionRaw: null });
  assert.ok(validReview(nulls), errors(validReview));
  const change = clone(ok);
  change.conditions[0].evidence = { kind: "person", check: null, command: null };
  assert.ok(validReview(change), errors(validReview));
  change.conditions[0].evidence = { kind: "check", check: "cmd-2", command: null };
  assert.ok(validReview(change), errors(validReview));
  const open = clone(ok);
  Object.assign(open.findings[0], { status: "open", closedBy: null, severity: "blocking" });
  assert.ok(validReview(open), errors(validReview));
});

// ---------------- the fixture: journal v2 written by the current code on fake CLIs ----------------

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-formats-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
let n = 0;
function project(files) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  for (const [f, text] of Object.entries({ ".gitignore": "node_modules/\n", ...files })) fs.writeFileSync(path.join(dir, f), text);
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
const VERSIONS = { codex: "codex-cli 0.155.1", claude: "2.1.281 (Claude Code)" };
function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] && { echo "${VERSIONS[name]}"; echo "second line"; exit 0; }\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const EXECUTABLE = { codex: CODEX, claude: CLAUDE };
function providersFile(env) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), ...env } };
  fs.writeFileSync(file, JSON.stringify({
    codex: { executable: CODEX, version: VERSIONS.codex, ...p }, claude: { executable: CLAUDE, version: VERSIONS.claude, ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP }
  }));
  return file;
}
function script(answers) {
  const dir = path.join(TMP, `script-${++n}`);
  fs.mkdirSync(dir);
  answers.forEach((a, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(a.answer));
    if (a.writes) fs.writeFileSync(path.join(dir, `${i + 1}.writes.json`), JSON.stringify(a.writes));
  });
  return dir;
}
function manager(env) {
  const root = path.join(TMP, `root-${++n}`);
  const m = createRunManager({
    platform: "darwin", arch: "arm64", root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providersFile(env), () => LAUNCH), journalV2: true
  });
  m.root = root;
  return m;
}
const view = async (m, runId) => (await m.get(runId)).value.view;
const settled = (m, runId) => until(async () => {
  const v = await view(m, runId);
  return ["completed", "paused", "failed", "stopped"].includes(v.status) && !v.permission ? v : null;
}, "the end");
const records = async (m, runId) => (await m.history(runId, 0, 500)).value.records;
const b64 = (s) => Buffer.from(s).toString("base64");
const writes = (files) => Object.entries(files).map(([rel, text]) => ({ rel, base64: b64(text) }));
const exec = (files) => ({ answer: { summary: "done", done: true }, writes: writes(files) });
const cond = (kind, text, covers, check = null) => ({ keep: null, text, covers, evidence: { kind, check } });
const plan = (conditions) => ({ answer: { stages: [{ title: "a", task: "a", conditions }], dropped: [], dropRequirements: [], question: null } });
const mark = (id) => ({ id, status: "met", paths: ["a.txt"], note: `${id} met` });
const finding = ({ id = null, severity = "blocking", problem = "a problem", paths = ["a.txt"], status = "open" } = {}) =>
  ({ id, severity, condition: null, problem, evidence: "seen in the file", closeWhen: "it is fixed", status, paths, relation: null });
const review = (findings, marks = [mark("C1")]) => ({ answer: { conditions: marks, findings, request: "none", question: null } });
const final = (findings = []) => ({ answer: { conditions: [], findings, request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "R1" }] } });
const sendAs = async (m, v, command) => {
  const r = await m.command(v.runId, { commandId: randomUUID(), expectedRevision: v.revision, command });
  assert.ok(r.ok && r.value.status === "accepted", JSON.stringify(r));
};

// The helper that builds board-review/v1 from the journal, a run's view and the board as §8 names the sources. Each
// field notes the source; the [П] ones are checked against the fixture in the tests below.
async function buildReview(m, runId) {
  const read = await readRun(m.root, runId);
  assert.equal(read.integrity.status, "ok");
  const st = read.state;
  const text = async (ref) => JSON.parse((await readText(m.root, runId, ref)).toString("utf8"));
  const goal = await text(st.goal);
  const recs = await records(m, runId);
  const progress = (await view(m, runId)).progress;
  const place = await readWorkspacePlace(m.root, runId);
  const board = (await m.board()).value.board;
  const boardTask = board.tasks.find((t) => t.id === goal.task.id) ?? null;
  const commit = st.orch.finish.filter((f) => f.step === "commit").at(-1); // currentCommit: the confirmed commit [Ф]
  assert.equal(commit.status, "done");
  const pushRec = st.orch.finish.filter((f) => f.step === "push").at(-1);
  let push = null;
  if (pushRec && pushRec.status === "done") {
    const params = await text(pushRec.params);
    const result = recs.find((r) => r.type === "finish.result" && r.data.intentId === pushRec.intentId);
    push = { remote: params.push?.remote ?? params.remote, at: result.ts, result: "confirmed" };
  }
  const role = (name) => {
    const intent = recs.filter((r) => r.type === "turn.intent" && r.data.role === name).at(-1);
    if (!intent) return null;
    const cli = intent.data.provider; // oneOf the two CLIs of providers.ts
    const first = execFileSync(EXECUTABLE[cli], ["--version"], { encoding: "utf8", timeout: 5000 }).split("\n")[0];
    const semver = first.split(/\s+/).find((w) => /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(w)) ?? null;
    return { provider: intent.data.provider, cli, model: goal.models?.[name] ?? null, modelActual: null,
      cliVersionAtExport: semver, cliVersionRaw: first.slice(0, 128) };
  };
  const items = progress.findings?.items ?? [];
  const checkNo = (c) => c.evidence.kind === "check";
  return {
    format: "board-review/v1",
    run: runId,
    task: { key: goal.task.key, ref: goal.task.ref ?? null, title: boardTask?.title ?? null, issue: boardTask?.issue ?? null },
    commit: commit.commit,
    tree: g(place.repo, "rev-parse", `${commit.commit}^{tree}`),
    checkedTree: commit.tree,
    base: { branch: goal.base.branch, commit: goal.base.commit },
    branch: place.branch,
    push,
    lead: role("lead"), executor: role("executor"), reviewer: role("reviewer"),
    conditions: (progress.conditions?.conditions ?? []).map((c) => ({ id: c.id, text: c.text, covers: c.covers, stage: c.stage, status: c.status,
      stale: c.stale === true, evidence: { kind: c.evidence.kind, check: checkNo(c) ? c.evidence.check : null, command: checkNo(c) ? c.evidence.command ?? null : null } })),
    findings: items.map((f) => ({ id: f.id, severity: f.severity, status: f.status,
      closedBy: f.status === "closed" ? (closedByPerson(f) ? "person" : "reviewer") : null, downgraded: f.downgraded,
      problem: f.problem, evidence: f.evidence, closeWhen: f.closeWhen, paths: f.paths })),
    openBlocking: items.filter((f) => f.severity === "blocking" && f.status === "open").length,
    scope: boardTask?.scope ?? null
  };
}

// The dependency run of the fixture: board tasks take a base only from a branch of what they depend on (manager.ts,
// «invalid_base»), so the exported run is the second one of a chain, started from the branch the first was taken into.
const DEP = [plan([cond("change", "d.txt exists", ["R1"])]), exec({ "d.txt": "1\n" }), review([], [{ ...mark("C1"), paths: ["d.txt"] }]), final()];
async function fixture(tail) {
  const src = project({ "a.txt": "1\n" });
  const m = manager({ MOCK_SCRIPT: script([...DEP, ...tail]) });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["true"] });
  const dep = await importTask(m, { ref: "D1", project: src, title: "Dependency", text: "dependency", criteria: ["d.txt exists"] });
  const first = await m.create({ requestId: randomUUID(), source: src, goal: { text: "d", criteria: ["d.txt exists"], checks: [], commands: ["true"], workMode: "copy", mode: "autopilot", task: { id: dep.id, key: dep.key } } });
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal((await settled(m, first.value.runId)).status, "completed");
  const info = (await m.take(first.value.runId)).value;
  assert.equal((await m.takeResult(first.value.runId, { action: "branch", name: info.suggested })).value.result, "created");
  const taken = (await m.board()).value.facts.find((f) => f.runId === first.value.runId).taken;
  return { m, src, dep, base: { branch: taken.branch, commit: taken.commit, key: dep.key } };
}
// a task with a ref comes only from an import: the button's path, the file named instead of the dialog
async function importTask(m, task) {
  const file = path.join(TMP, `tasks-${++n}.json`);
  fs.writeFileSync(file, JSON.stringify({ format: "board-tasks/v1", workspaceId: "common", tasks: [task] }));
  const r = await m.boardImportFile(async () => file);
  assert.equal(r.value?.status, "imported", JSON.stringify(r));
  return (await m.board()).value.board.tasks.find((t) => t.ref === task.ref);
}
async function startRun({ m, src, dep, base }, { title, goal = {}, profile = {} }) {
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "worktree", checks: ["false"], ...profile });
  const task = await importTask(m, { ref: "T2", project: src, title, text: title, criteria: ["a.txt says 2"], dependsOn: [dep.ref] });
  assert.deepEqual(task.dependsOn, [dep.id]);
  const runId = randomUUID();
  const r = await m.create({ requestId: runId, source: src, goal: { text: "a to 2", criteria: ["a.txt says 2"], checks: [], commands: ["grep -qx 2 a.txt"], workMode: "worktree", mode: "autopilot",
    task: { id: task.id, key: task.key }, base, ...goal } });
  assert.ok(r.ok, JSON.stringify(r));
  return { runId, task };
}
const PLAN = plan([cond("change", "a.txt says 2", ["R1"]), cond("check", "the check passes", ["R1"], "cmd-1")]);

test("[П] fields on a journal v2 of a pushed run: the export built from the journal passes the schema", OPTS, async () => {
  // F1 blocking is fixed and closed by the reviewer; the final review leaves a wish open
  const fx = await fixture([PLAN, exec({ "a.txt": "2\n" }), review([finding()]),
    exec({ "b.txt": "2\n", "a.txt": "2\n" }), review([finding({ id: "F1", status: "closed", paths: ["b.txt"] })]), final([finding({ severity: "wish", problem: "a wish", paths: ["b.txt"] })])]);
  const { m, src } = fx;
  const remote = path.join(TMP, `remote-${++n}.git`);
  g(TMP, "init", "-q", "--bare", remote);
  g(src, "remote", "add", "qa", remote);
  const { runId, task } = await startRun(fx, { title: "Second task", goal: { models: { executor: "opus" }, finish: { commit: true, push: true, qa: false } },
    profile: { finish: { commit: true, push: { remote: "qa", branch: "qa-branch", remoteUrl: remote }, qa: null } } });
  const v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify([v.reason, (await records(m, runId)).slice(-6).map((r) => [r.type, r.data.status ?? r.data.reason ?? ""])]));
  const r = await buildReview(m, runId);
  assert.ok(validReview(r), `${errors(validReview)}\n${JSON.stringify(r, null, 1)}`);
  // [Ф]/[П] fields against their sources
  const st = (await readRun(m.root, runId)).state;
  assert.equal(r.run, runId);
  assert.equal(r.task.key, task.key);
  assert.equal(r.task.title, "Second task", "task.title: the board task at export time");
  assert.equal(r.task.ref, task.ref, "task.ref: goal.task.ref of the journal, the board task's ref put in by main");
  assert.equal((await readText(m.root, runId, st.goal).then((b) => JSON.parse(b.toString("utf8")))).task.ref, "T2");
  // not confirmable on the current code: the board task has no issue/scope yet (F3/F4)
  assert.deepEqual([r.task.issue, r.scope], [null, null]);
  assert.equal(g(src, "rev-parse", `${r.commit}^{tree}`), r.tree, "tree: git rev-parse <commit>^{tree}");
  assert.equal(r.checkedTree, r.tree, "checkedTree is the tree of the commit result (nothing left out here)");
  assert.equal(g(remote, "rev-parse", "refs/heads/qa-branch"), r.commit, "the commit is what the confirmed push delivered");
  assert.deepEqual([r.push.remote, r.push.result], ["qa", "confirmed"]);
  assert.equal(new Date(r.push.at).toISOString(), r.push.at, "push.at is the time of the push result record");
  assert.match(r.branch, /^canvastty\/[0-9a-f]{8}$/, "branch: the run's worktree branch (goal.branch is T-6, not in the code yet)");
  assert.deepEqual(r.base, { branch: fx.base.branch, commit: fx.base.commit }, "base: goal.base");
  assert.equal(r.executor.model, "opus", "model: the alias of goal.models");
  assert.equal(r.lead.model, null);
  for (const role of [r.lead, r.executor, r.reviewer]) {
    assert.equal(role.cli, role.provider);
    assert.equal(role.cliVersionRaw, VERSIONS[role.cli], "cliVersionRaw: the first line of `<cli> --version`");
    assert.equal(role.cliVersionAtExport, VERSIONS[role.cli].split(/\s+/).find((w) => /^\d/.test(w)), "cliVersionAtExport: the semver word of that line");
  }
  assert.deepEqual(new Set([r.lead, r.executor, r.reviewer].map((x) => x.provider)), new Set(["claude", "codex"]), "both forms of the version line are covered");
  assert.ok([r.lead, r.executor, r.reviewer].every((x) => x.modelActual === null), "modelActual: always null");
  assert.deepEqual(r.conditions.map((c) => [c.id, c.status, c.evidence.kind, c.evidence.check, c.evidence.command]),
    [["C1", "met", "change", null, null], ["C2", "met", "check", "cmd-1", "grep -qx 2 a.txt"]], "evidence.command: from the decided goal");
  assert.deepEqual(r.findings.map((f) => [f.id, f.severity, f.status, f.closedBy, f.downgraded]),
    [["F1", "blocking", "closed", "reviewer", false], ["F2", "wish", "open", null, false]]);
  assert.equal(r.openBlocking, 0);
  assert.equal(r.openBlocking, v.progress.findings.openBlocking, "openBlocking: the number of open blocking among findings");
  assert.equal(st.orch.finish.filter((f) => f.step === "push").length, 1);
  await m.shutdown();
});

test("[П] fields on a journal v2 of a run without push: the person's decisions, push null", OPTS, async () => {
  const fx = await fixture([PLAN, exec({ "a.txt": "2\n" }), review([finding({ problem: "NOT-FIXED" }), finding({ problem: "OTHER", paths: ["b.txt"] })]), final()]);
  const { m } = fx;
  const { runId } = await startRun(fx, { title: "Person decides", goal: { limits: { roundsPerStage: 1 }, finish: { commit: true, push: false, qa: false } },
    profile: { finish: { commit: true, push: null, qa: null } } });
  let v = await settled(m, runId);
  assert.deepEqual([v.status, v.reason, v.progress.findings.openBlocking], ["paused", "limit_reached", 2]);
  await sendAs(m, v, { kind: "person.decide", subject: "finding", target: "F1", decision: "to_wish", finding: null, runKey: v.decisions.runKey });
  v = await view(m, runId);
  await sendAs(m, v, { kind: "person.decide", subject: "finding", target: "F2", decision: "close", finding: null, runKey: v.decisions.runKey });
  await sendAs(m, await view(m, runId), { kind: "raise_limit", limit: "roundsPerStage", value: 2 });
  await sendAs(m, await view(m, runId), { kind: "resume" });
  v = await settled(m, runId);
  assert.equal(v.status, "completed", JSON.stringify((await records(m, runId)).slice(-8).map((r) => [r.type, r.data.status ?? r.data.reason ?? ""])));
  const r = await buildReview(m, runId);
  assert.ok(validReview(r), `${errors(validReview)}\n${JSON.stringify(r, null, 1)}`);
  assert.equal(r.push, null, "push: not asked for");
  assert.equal(r.task.ref, "T2", "task.ref: goal.task.ref of the journal");
  assert.deepEqual(r.findings.map((f) => [f.id, f.severity, f.status, f.closedBy, f.downgraded]),
    [["F1", "wish", "open", null, true], ["F2", "blocking", "closed", "person", false]], "closedBy and downgraded come from the person's events");
  assert.equal(r.openBlocking, 0);
  await m.shutdown();
});
