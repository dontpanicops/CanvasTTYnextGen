// C4.2 (docs/agent-orchestration/implementation/stage-c4-limits.md §2, §3): the board's autopilot at a provider's limit —
// it takes no new task and hands nothing to an agent meanwhile, continues its own runs once the reset has come (not the
// person's), at most 3 times in a row, counts the wait in no budget; a resolution run (C3) at a limit keeps its try.
// Pure steps first, then through the manager on the fake CLIs (a reset already behind: continued on the next step).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createBoardAutopilot } from "../src/main/services/orchestration/boardAutopilot.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { AUTOPILOT_BUDGET, LIMIT_MARGIN_MS, activeMs, autopilotParallelStep, autopilotStep, limitStep } from "../src/shared/taskBoard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 200_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-c4-")));
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

// ---------- pure ----------
const NOW = Date.UTC(2026, 9, 19, 12);
const lim = (extra) => ({ runId: randomUUID(), key: "T-1", provider: "claude", resetsAt: NOW + 3600_000, own: true, resumes: 0, ...extra });

test("limitStep: its own run continued once the reset and the margin have passed, the earliest first; before that, unknown, the person's or 3 in a row — a wait", () => {
  assert.equal(limitStep([], NOW), null);
  const a = lim();
  assert.deepEqual(limitStep([a], NOW), { kind: "wait", why: "provider_limit", limit: { provider: "claude", resetsAt: a.resetsAt, key: "T-1", repeated: false, others: 0 } });
  assert.equal(limitStep([a], a.resetsAt + LIMIT_MARGIN_MS - 1).kind, "wait");
  assert.deepEqual(limitStep([a], a.resetsAt + LIMIT_MARGIN_MS), { kind: "resume", runId: a.runId, key: "T-1", provider: "claude" });
  // a reset behind already (the Mac slept): at once
  assert.equal(limitStep([lim({ resetsAt: NOW - 600_000 })], NOW).kind, "resume");
  // the person's run: only a reason to wait
  assert.equal(limitStep([lim({ resetsAt: NOW - 600_000, own: false })], NOW).kind, "wait");
  // unknown: wait for the person
  assert.deepEqual(limitStep([lim({ resetsAt: null })], NOW).limit.resetsAt, null);
  // 3 in a row: the person's, said as such
  const tired = limitStep([lim({ resetsAt: NOW - 600_000, resumes: 3 })], NOW);
  assert.deepEqual([tired.kind, tired.limit.repeated, tired.limit.resetsAt], ["wait", true, null]);
  // two providers: the earliest known reset is shown, the others counted
  const two = limitStep([lim({ provider: "codex", resetsAt: null, key: "T-2" }), lim({ resetsAt: NOW + 7200_000 }), lim({ provider: "codex", resetsAt: NOW + 600_000, key: "T-3", own: false })], NOW);
  assert.deepEqual([two.limit.provider, two.limit.key, two.limit.others], ["codex", "T-3", 2]);
  const due = [lim({ resetsAt: NOW - 1000_000, key: "T-9" }), lim({ resetsAt: NOW - 2000_000, key: "T-8" })];
  assert.equal(limitStep(due, NOW).key, "T-8", "the earliest first");
});

const fact = (task, extra) => ({ runId: randomUUID(), taskId: task.id, taskKey: task.key, createdAt: 1, workspaceId: WS, status: "paused", reason: "environment_error",
  newer: false, halted: false, limit: null, completion: null, phase: "work", permission: false, workMode: "copy", taken: null, board: "refs/raoden/board/common/1", ...extra });
const task = (key, extra) => ({ id: randomUUID(), key, workspaceId: WS, project: "/p", title: key, text: key, criteria: ["c"], dependsOn: [], order: Number(key.slice(2)),
  createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", archivedAt: null, accepted: null, ...extra });

test("the parallel step: the limit before a stop, a start and an agent; a merge (no model turn) still goes; the sequential step likewise", () => {
  const at = { workspaceId: WS, project: "/p" };
  const t1 = task("T-1"), t2 = task("T-2");
  const f1 = fact(t1, { providerLimit: { provider: "claude", resetsAt: NOW + 3600_000 } });
  const limited = [lim({ runId: f1.runId })];
  const head = (merges) => ({ workspaceId: WS, project: "/p", ref: "refs/raoden/board/common/1", n: 1, commit: "b".repeat(40), behind: null, branch: null, merges });
  const step = (merges = [], l = limited, started = [f1.runId]) => autopilotParallelStep({ tasks: [t1, t2] }, [f1], at, started, { runs: 1, ms: 0 }, AUTOPILOT_BUDGET, head(merges), new Set(), l, NOW);
  // without C4 the paused run would stop it (run_paused); with the limit known: a wait, T-2 not started
  assert.deepEqual(step().kind, "wait");
  assert.equal(step().why, "provider_limit");
  assert.equal(step([], []).kind, "off", "without a known limit: as before");
  // a paused conflict is not handed to an agent meanwhile
  const conflict = { runId: randomUUID(), board: "refs/raoden/board/common/1", base: "b".repeat(40), task: { id: randomUUID(), key: "T-5", runId: randomUUID(), commit: "c".repeat(40) },
    status: "paused", reason: "merge_conflict", detail: null, completion: null, conflicts: ["a.txt"], outside: [], interference: false, retrying: false, dir: null, createdAt: 1 };
  assert.equal(step([conflict]).why, "provider_limit");
  // a «Done» task ready to merge still merges
  const t3 = task("T-3"), f3 = fact(t3, { status: "completed", reason: null, completion: "confirmed", taken: { branch: "raoden/t3", commit: "d".repeat(40), applied: false } });
  const merged = autopilotParallelStep({ tasks: [t1, t3] }, [f1, f3], at, [f1.runId, f3.runId], { runs: 2, ms: 0 }, AUTOPILOT_BUDGET, head([]), new Set(), limited, NOW);
  assert.equal(merged.kind, "merge");
  // sequential (project folder): its last run at the limit — a wait, then a resume
  const seq = (now) => autopilotStep({ tasks: [t1, t2] }, [f1], { ...at, workMode: "project" }, f1.runId, { runs: 1, ms: 0 }, AUTOPILOT_BUDGET, limited, now);
  assert.equal(seq(NOW).why, "provider_limit");
  assert.equal(seq(NOW + 2 * 3600_000).kind, "resume");
});

test("activeMs: a pause after a turn the limit ended is a wait, not work; any other environment_error is work as before", () => {
  const rec = (ts, type, data) => ({ ts: new Date(NOW + ts).toISOString(), type, data });
  const records = [rec(0, "run.created", {}), rec(0, "run.status", { status: "running" }), rec(60_000, "turn.finished", { turnId: "t1", outcome: "failed" }),
    rec(60_000, "run.status", { status: "paused", reason: "environment_error" }), rec(3 * 3600_000, "run.status", { status: "running" })];
  const end = NOW + 3 * 3600_000 + 60_000;
  assert.equal(activeMs(records, end), end - NOW, "unknown: the pause counts");
  assert.equal(activeMs(records, end, undefined, new Set(["t1"])), 2 * 60_000, "a limit: only the work");
});

test("boardAutopilot: a refusal of «Продолжить» because the person was first is no stop; another refusal stops it; a continuation is recorded only when accepted", async () => {
  const t1 = task("T-1");
  let now = NOW;
  let answer = { ok: false, code: "stale_revision", message: "" };
  const f1 = fact(t1, { providerLimit: { provider: "claude", resetsAt: NOW - 600_000 }, workMode: "project" });
  const resumed = [];
  let startedIt = false; // before its start, the board has no run: the first step starts T-1 (its own from then on)
  const ap = createBoardAutopilot({
    view: async () => ({ board: { v: 1, tasks: [t1], counters: {} }, facts: startedIt ? [f1] : [] }),
    link: async () => ({ workspaceId: WS, project: "/p" }),
    profile: async () => ({ access: {}, workMode: "project", finish: {}, checks: [], prepare: null, env: {}, grants: [] }),
    optionalChecks: false, journal: async () => [], readiness: async () => ({ ok: true, value: { items: [] } }),
    start: async () => { startedIt = true; return { ok: true, value: { runId: f1.runId } }; }, take: async () => ({ ok: false, code: "x", message: "" }),
    head: async () => null, ensureHead: async () => {}, merge: async () => ({ ok: false, code: "x", message: "" }),
    resume: async (runId) => { resumed.push(runId); return answer; },
    limitTurns: async () => new Set(), newId: () => randomUUID(), now: () => now
  }, async () => AUTOPILOT_BUDGET, 3_600_000);
  await ap.set("L", true, "ru");
  await ap.tick("L");
  let s = (await ap.state()).L;
  assert.deepEqual([s.on, startedIt], [true, true], "the first step started T-1");
  await ap.tick("L");
  s = (await ap.state()).L;
  assert.deepEqual([s.on, s.resumed ?? null, resumed.length], [true, null, 1], "stale_revision: no stop, nothing recorded");
  answer = { ok: false, code: "test_database_unsafe", message: "" };
  await ap.tick("L");
  s = (await ap.state()).L;
  assert.deepEqual([s.on, s.stop.code, s.stop.detail], [false, "resume_failed", "test_database_unsafe"]);
  // accepted: recorded (a new autopilot: it starts nothing new while the limit holds, and the run is not its own)
  answer = { ok: true, value: undefined };
  await ap.set("L", true, "ru");
  await ap.tick("L");
  s = (await ap.state()).L;
  assert.deepEqual([s.waits, s.resumed ?? null], ["provider_limit", null], "after a restart of the autopilot the run is the person's");
  ap.shutdown();
  startedIt = false;
  await ap.set("L", true, "ru");
  await ap.tick("L");
  await ap.tick("L");
  s = (await ap.state()).L;
  assert.equal(s.resumed?.key, "T-1");
  assert.equal(s.resumed?.provider, "claude");
  now += 1;
  ap.shutdown();
});

// ---------- through the manager on the fake CLIs ----------
function project(files = { "a.txt": "base\n", "keep.txt": "keep\n" }) {
  const dir = path.join(TMP, `project-${++n}`);
  fs.mkdirSync(dir);
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  return dir;
}
const wrapper = (name, mock) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
};
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const b64 = (t) => Buffer.from(t).toString("base64");
const PLAN = { answer: { stages: [{ title: "fix", task: "write c.txt", conditions: [{ keep: null, text: "c.txt written", covers: ["R1"], evidence: { kind: "change", check: null } }] }], dropped: [], dropRequirements: [], question: null } };
const EXEC = (text) => ({ answer: { summary: "done", done: true }, writes: [{ rel: "c.txt", base64: b64(text) }] });
const REVIEW = { answer: { conditions: [{ id: "C1", status: "met", paths: ["c.txt"], note: "written" }], findings: [], request: "none", question: null } };
const FINAL = { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "written" }] } };
const LIMIT = (resetsAt) => ({ answer: { __limit: { resetsAt } } });
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
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.162.0", ...p }, claude: { executable: CLAUDE, version: "2.1.303 (Claude Code)", ...p },
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
const until = async (fn, ms = 150_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await sleep(50); } };

test("through the manager: the executor's turn ends at Claude's limit, the reset is behind — the autopilot continues the run itself, the task «Done», «all done»", OPTS, async () => {
  const src = fs.realpathSync(project());
  const resetsAt = Math.floor(Date.now() / 1000) - 600; // behind by 10 min: kept (§1.2), due at once (§2.3)
  const m = manager(scripts([PLAN, LIMIT(resetsAt), EXEC("one\n"), REVIEW, FINAL]));
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] });
  await m.boardCreate({ workspaceId: WS, project: src, title: "A", text: "write c.txt", criteria: ["c.txt is written"], dependsOn: [] });
  const linkId = await linkOn(m, src);
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
  assert.equal(resumed?.provider, "claude", "continued by itself");
  assert.equal(resumed?.key, "T-1");
  const facts = (await m.board()).value.facts;
  assert.equal(facts[0].status, "completed");
  assert.ok(waited || resumed, "the limit was seen");
  await m.shutdown();
});

test("through the manager: the reset unknown — the autopilot waits for the person; the person's «Продолжить» goes on, the autopilot ends «all done»", OPTS, async () => {
  const src = fs.realpathSync(project());
  const m = manager(scripts([PLAN, LIMIT(null), EXEC("one\n"), REVIEW, FINAL]));
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] });
  await m.boardCreate({ workspaceId: WS, project: src, title: "A", text: "write c.txt", criteria: ["c.txt is written"], dependsOn: [] });
  const linkId = await linkOn(m, src);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  const waiting = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; return s?.waits === "provider_limit" ? s : null; });
  assert.deepEqual([waiting.limit.provider, waiting.limit.resetsAt, waiting.on], ["claude", null, true]);
  const fact = (await m.board()).value.facts[0];
  assert.deepEqual(fact.providerLimit, { provider: "claude", resetsAt: null });
  const view = (await m.get(fact.runId)).value.view;
  const r = await m.command(fact.runId, { commandId: randomUUID(), expectedRevision: view.revision, command: { kind: "resume" } });
  assert.ok(r.ok && r.value.status !== "rejected", JSON.stringify(r));
  const end = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; return s && !s.on ? s : null; });
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  assert.equal(end.resumed ?? null, null, "the person continued it, not the autopilot");
  await m.shutdown();
});

test("through the manager: the resolution run (C3) ends at Claude's limit — the try is kept, the autopilot continues it itself, the merge completes with both", OPTS, async () => {
  const src = fs.realpathSync(project());
  const resetsAt = Math.floor(Date.now() / 1000) - 600;
  const task = (text) => [PLAN, EXEC(text), REVIEW, FINAL];
  const resolution = [LIMIT(resetsAt), { answer: { summary: "resolved", done: true }, writes: [{ rel: "c.txt", base64: b64("one\ntwo\n") }] },
    { answer: { conditions: [{ id: "C1", status: "met", paths: ["c.txt"], note: "both kept" }], findings: [], request: "none", question: null } },
    { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "ok" }, { id: "R2", status: "met", note: "ok" }] } }];
  const m = manager(scripts(task("one\n"), task("two\n"), resolution), { MOCK_TURN_DELAY_MS: "300" });
  await createProfileStore(m.root).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["test -f keep.txt"] });
  for (const title of ["A", "B"]) await m.boardCreate({ workspaceId: WS, project: src, title, text: "write c.txt", criteria: ["c.txt is written"], dependsOn: [] });
  const linkId = await linkOn(m, src);
  assert.equal((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel: 2 })).ok, true);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  let resumed = null;
  const end = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; if (s?.resumed) resumed = s.resumed; return s && !s.on ? s : null; }, 200_000);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  assert.deepEqual([resumed?.provider, resumed?.key], ["claude", "T-2"]);
  const h = (await m.board()).value.heads[0];
  const agentMerge = h.merges.find((x) => x.agent);
  assert.deepEqual([agentMerge.status, agentMerge.completion, agentMerge.agent.attempt], ["completed", "confirmed", 1], "the try was kept, not failed");
  assert.equal(g(src, "show", `${h.commit}:c.txt`), "one\ntwo");
  await m.shutdown();
});
