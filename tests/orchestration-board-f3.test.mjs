// F3 — T-13a, T-6, T-7, T-13b, T-13c (docs/agent-orchestration/implementation/stage-f-external-projects.md §4, §5.1, §5.5, §7):
// the remote base's statuses (no board's result, waits_mr, no take), the place options; the branch of a board task's
// worktree by the profile's template (its checks, the free name locally and on the remote, the take keeping it); the
// commit's title per task through the project's hooks; the base from the remote fetched for the start (its cache, its
// refusals, the race), the refusals in a place with a remote base. Neutral fixtures only (upstream/stable, T1, ISSUE-1), local
// repositories with a bare remote, fake CLIs: no model, no real Codex or Claude.
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
import { createBoardAutopilot, fingerprint, placeOptsOf } from "../src/main/services/orchestration/boardAutopilot.ts";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import { createBoardMerge } from "../src/main/services/orchestration/boardMerge.ts";
import { checkBase } from "../src/main/services/orchestration/orchestrationService.ts";
import { readTasksFile } from "../src/main/services/orchestration/boardImport.ts";
import { commitLine, commitMessage, fetchUrlsMatch, remoteUrlsMatch } from "../src/main/services/orchestration/finish.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, fillBranch, templateNeedsIssue, validateProfile } from "../src/main/services/orchestration/profile.ts";
import { assertMainRenderer } from "../src/main/ipc/mainRenderer.ts";
import { registerOrchestrationIpc } from "../src/main/ipc/orchestrationIpc.ts";
import { IPC } from "../src/shared/contracts.ts";
import {
  AUTOPILOT_BUDGET, EXTERNAL_CRITERION, autoTakeOnDone, decomposeCandidate, autopilotParallelStep, boardOptsOf, boardStatuses, nextTask, placeKey
} from "../src/shared/taskBoard.ts";
import { taskLine } from "../src/renderer/src/features/orchestration/boardModel.ts";
import { t as words } from "../src/renderer/src/lib/i18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 300_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-f3-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
const g = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: "utf8", env: GIT_ENV });
let n = 0;

const WS = "common";
const PLACE = { workspaceId: WS, project: "/p" };
const run = (over = {}) => ({ runId: randomUUID(), taskId: null, taskKey: null, createdAt: ++n, workspaceId: WS, status: "running", reason: null, newer: false, halted: false, limit: null,
  completion: null, phase: "work", permission: false, workMode: "worktree", taken: null, ...over });
const task = (over = {}) => ({ id: randomUUID(), key: `T-${++n}`, workspaceId: WS, project: "/p", title: "t", text: "x", criteria: ["c"],
  dependsOn: [], order: n, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z", archivedAt: null, accepted: null, ...over });
const done = (t, over = {}) => run({ taskId: t.id, taskKey: t.key, status: "completed", completion: "confirmed", ...over });
const MARK = { at: "2026-10-22T10:00:00.000Z", by: "person", note: null };
const NONE = { runs: 0, ms: 0 };
const C = (hex) => hex.repeat(40).slice(0, 40);
const REMOTE = { remoteBase: true };
const chain = (over = {}) => {
  const p1 = task({ ref: "P1", ...over });
  const mr = task({ ref: "P1-MR", external: true, criteria: [EXTERNAL_CRITERION], dependsOn: [p1.id], ...over });
  const p2 = task({ ref: "P2", dependsOn: [mr.id], ...over });
  return { p1, mr, p2, marked: () => ({ ...mr, externalDone: MARK }) };
};
const head = (merges = []) => ({ workspaceId: WS, project: "/p", ref: `refs/raoden/board/${WS}/1`, n: 1, commit: C("a"), merges });

// ---------------- T-13a: the statuses and the steps of a place with a remote base ----------------

test("autopilotParallelStep { remoteBase }: no board's result — start (base null), never head; head = null is taken; «Done» — no take, no merge", () => {
  const t1 = task();
  const t2 = task();
  const at = PLACE;
  // without a head: a start with no base (main puts the remote's branch in, T-13b) — the step without opts asks for a head
  assert.deepEqual(autopilotParallelStep({ tasks: [t1] }, [], at, [], NONE, AUTOPILOT_BUDGET, null, new Set(), [], Date.now(), [], REMOTE), { kind: "start", task: t1, base: null });
  assert.deepEqual(autopilotParallelStep({ tasks: [t1] }, [], at, [], NONE, AUTOPILOT_BUDGET, null), { kind: "head" });
  // a head given anyway is not read: the start has no base, nothing is merged into it
  assert.deepEqual(autopilotParallelStep({ tasks: [t1] }, [], at, [], NONE, AUTOPILOT_BUDGET, head(), new Set(), [], Date.now(), [], REMOTE).base, null);
  // T1 «Done» in its worktree, started by the autopilot: no take (its branch carries the commit), no merge; T2 starts
  const r1 = done(t1);
  const step = autopilotParallelStep({ tasks: [t1, t2] }, [r1], at, [r1.runId], { runs: 1, ms: 0 }, AUTOPILOT_BUDGET, head(), new Set(), [], Date.now(), [], REMOTE);
  assert.deepEqual([step.kind, step.task?.key, step.base], ["start", t2.key, null]);
  // the same «Done» without the option: take first, as before
  assert.equal(autopilotParallelStep({ tasks: [t1, t2] }, [r1], at, [r1.runId], { runs: 1, ms: 0 }, AUTOPILOT_BUDGET, head()).kind, "take");
  // all «Done»: off all_done, no merge step
  const r2 = done(t2);
  assert.deepEqual(autopilotParallelStep({ tasks: [t1, t2] }, [r1, r2], at, [r1.runId, r2.runId], { runs: 2, ms: 0 }, AUTOPILOT_BUDGET, null, new Set(), [], Date.now(), [], REMOTE).code, "all_done");
});

test("autoTakeOnDone: at a remote base — null; elsewhere as before", () => {
  const t1 = task();
  const r1 = done(t1);
  const s = boardStatuses({ tasks: [t1] }, [r1]).get(t1.id);
  assert.equal(autoTakeOnDone(s, r1), "branch");
  assert.equal(autoTakeOnDone(s, r1, {}), "branch");
  assert.equal(autoTakeOnDone(s, r1, REMOTE), null);
  assert.equal(autoTakeOnDone(s, { ...r1, taken: { branch: "b", commit: C("b"), applied: false } }), null);
});

test("waits_mr: at a remote base a direct dependency on an ordinary task holds the dependent (others_wait); heads are not read; without opts as before", () => {
  const t1 = task();
  const t2 = task({ dependsOn: [t1.id] });
  const r1 = done(t1, { taken: { branch: "b", commit: C("b"), applied: false } });
  const opts = { remoteBase: new Set([placeKey(PLACE)]) };
  let st = boardStatuses({ tasks: [t1, t2] }, [r1], [head([{ runId: randomUUID(), board: head().ref, base: C("a"), task: { id: t1.id, key: t1.key, runId: r1.runId, commit: C("b") },
    status: "completed", reason: null, detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: 1 }])], opts);
  assert.deepEqual([st.get(t2.id).reason, st.get(t2.id).waitsFor, st.get(t2.id).depsWait.reason], ["waits_mr", [t1.key], "waits_mr"], "in the head or not, it is not on the remote");
  // without the option: the dependency's result in its branch — B's rule (a separate base from that branch)
  st = boardStatuses({ tasks: [t1, t2] }, [r1]);
  assert.equal(st.get(t2.id).reason, null);
  // a dependency not «Done» yet: waits_task, as everywhere
  st = boardStatuses({ tasks: [t1, t2] }, [], [], opts);
  assert.equal(st.get(t2.id).reason, "waits_task");
  // the autopilot: nothing else to do — others_wait, the dependent with waits_mr in its waiting list
  const step = autopilotParallelStep({ tasks: [t1, t2] }, [r1], PLACE, [r1.runId], { runs: 1, ms: 0 }, AUTOPILOT_BUDGET, null, new Set(), [], Date.now(), [], REMOTE);
  assert.deepEqual([step.kind, step.code, step.waiting], ["off", "others_wait", [{ key: t2.key, reason: "waits_mr", waitsFor: [t1.key] }]]);
  // another place keeps its rule
  const other = { ...t2, id: randomUUID(), project: "/q" };
  assert.equal(boardStatuses({ tasks: [t1, other] }, [r1], [], opts).get(other.id).reason, null);
});

test("P1 → P1-MR → P2 at a remote base: P1 «Done» — wait external (never off); P1-MR gets no waits_mr and can be marked; after the mark P2 starts with base null", () => {
  const { p1, mr, p2, marked } = chain();
  const r1 = done(p1);
  const opts = { remoteBase: new Set([placeKey(PLACE)]) };
  const st = boardStatuses({ tasks: [p1, mr, p2] }, [r1], [], opts);
  // О4: the external task waits only for its own dependencies «Done» — no «in the folder» condition
  assert.deepEqual([st.get(mr.id).column, st.get(mr.id).reason, st.get(mr.id).depsWait], ["queue", null, null]);
  assert.equal(st.get(p2.id).reason, "waits_external");
  const wait = autopilotParallelStep({ tasks: [p1, mr, p2] }, [r1], PLACE, [r1.runId], { runs: 1, ms: 0 }, AUTOPILOT_BUDGET, null, new Set(), [], Date.now(), [], REMOTE);
  assert.deepEqual(wait, { kind: "wait", why: "external", key: mr.key });
  const go = autopilotParallelStep({ tasks: [p1, marked(), p2] }, [r1], PLACE, [r1.runId], { runs: 1, ms: 0 }, AUTOPILOT_BUDGET, null, new Set(), [], Date.now(), [], REMOTE);
  assert.deepEqual([go.kind, go.task?.key, go.base], ["start", p2.key, null]);
  assert.equal(boardStatuses({ tasks: [p1, marked(), p2] }, [r1], [], opts).get(p2.id).depsWait, null);
});

test("branch_template_field: a task without its issue where the template needs one — the reason in boardStatuses; nextTask and next take the next task (with dependencies too); the autopilot goes on", () => {
  const t0 = task({ issue: "ISSUE-1" });
  const bare = task(); // no issue
  const dep = task({ dependsOn: [t0.id] }); // no issue, its dependency «Done»
  const ok = task({ issue: "ISSUE-1", dependsOn: [t0.id] });
  const r0 = done(t0, { workMode: "project" }); // its result in the folder: the dependents see it
  const opts = { issueRequired: new Set([placeKey(PLACE)]) };
  const st = boardStatuses({ tasks: [t0, bare, dep, ok] }, [r0], [], opts);
  assert.deepEqual([bare, dep, ok].map((t) => st.get(t.id).reason), ["branch_template_field", "branch_template_field", null]);
  assert.equal(st.get(bare.id).depsWait, null, "not a dependency's wait: «Start» is offered, the start refuses it");
  assert.equal(nextTask({ tasks: [bare, ok] }, boardStatuses({ tasks: [bare, ok] }, [], [], opts), PLACE)?.key, ok.key);
  // the separate copy's step: from the head, the task with «Done» dependencies in it is skipped too (the branch of
  // dependencies did not look at the reason before F3)
  const r0in = { ...r0, workMode: "worktree", board: head().ref };
  const h = head([{ runId: randomUUID(), board: head().ref, base: C("a"), task: { id: t0.id, key: t0.key, runId: r0.runId, commit: C("b") }, status: "completed", reason: null,
    detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: 1 }]);
  const step = autopilotParallelStep({ tasks: [t0, dep, ok] }, [r0in], PLACE, [], NONE, AUTOPILOT_BUDGET, h, new Set(), [], Date.now(), [], { issueRequired: true });
  assert.deepEqual([step.kind, step.task?.key], ["start", ok.key]);
  // only it left: not started, off others_wait with the reason (not start_failed)
  const alone = autopilotParallelStep({ tasks: [t0, dep] }, [r0in], PLACE, [], NONE, AUTOPILOT_BUDGET, h, new Set(), [], Date.now(), [], { issueRequired: true });
  assert.deepEqual([alone.kind, alone.code, alone.waiting?.[0]?.reason], ["off", "others_wait", "branch_template_field"]);
  // an external task needs no branch
  const ext = task({ external: true, criteria: [EXTERNAL_CRITERION] });
  assert.equal(boardStatuses({ tasks: [ext] }, [], [], opts).get(ext.id).reason, null);
  // the card's words, in both languages
  for (const locale of ["ru", "en"]) {
    assert.match(taskLine(locale, st.get(bare.id), null, null), /issue/);
    assert.doesNotMatch(taskLine(locale, st.get(bare.id), null, null), /\{field\}/);
  }
});

test("branch_template_field by the task itself: a held task whose status carries another reason (waits_merge) is not started by the step without its issue", () => {
  const inFolder = task({ issue: "ISSUE-1" }), inHead = task({ issue: "ISSUE-1" });
  const rf = done(inFolder, { workMode: "project" });
  const rh = done(inHead, { workMode: "worktree", board: head().ref });
  const h = head([{ runId: randomUUID(), board: head().ref, base: C("a"), task: { id: inHead.id, key: inHead.key, runId: rh.runId, commit: C("b") }, status: "completed", reason: null,
    detail: null, completion: "confirmed", conflicts: [], outside: [], interference: false, retrying: false, dir: null, createdAt: 1 }]);
  const step = (dep) => autopilotParallelStep({ tasks: [inFolder, inHead, dep] }, [rf, rh], PLACE, [], NONE, AUTOPILOT_BUDGET, h, new Set(), [], Date.now(), [], { issueRequired: true });
  const bare = task({ dependsOn: [inFolder.id, inHead.id] });
  const st = boardStatuses({ tasks: [inFolder, inHead, bare] }, [rf, rh], [h], { issueRequired: new Set([placeKey(PLACE)]) });
  assert.equal(st.get(bare.id).reason, "waits_merge", "the status says another reason: no branch_template_field");
  assert.notEqual(step(bare).kind, "start", "the step does not start it");
  const withIssue = { ...bare, issue: "ISSUE-1" };
  assert.deepEqual([step(withIssue).kind, step(withIssue).task?.id], ["start", bare.id], "with its issue the step takes it (the status and the step disagree)");
  assert.equal(nextTask({ tasks: [bare] }, new Map([[bare.id, { ...st.get(inFolder.id), column: "queue", reason: null, attempts: 0, done: null, depsNote: null }]]), PLACE, { issueRequired: true }), null, "nextTask: by the task too");
});

test("the place options: placeOptsOf by the profile, boardOptsOf by the board's view; the fingerprint holds branchTemplate and runBase (absent: as before)", () => {
  assert.deepEqual(placeOptsOf({}), {});
  assert.deepEqual(placeOptsOf({ runBase: { remote: "upstream", branch: "stable", remoteUrl: "/r" }, branchTemplate: "{issue}-{ref}" }), { remoteBase: true, issueRequired: true });
  assert.deepEqual(placeOptsOf({ branchTemplate: "{ref}" }), {});
  assert.equal(templateNeedsIssue("{issue}-{ref}"), true);
  assert.deepEqual(boardOptsOf({}), {});
  assert.deepEqual([...boardOptsOf({ remoteBase: [placeKey(PLACE)] }).remoteBase], [`${WS}\0/p`]);
  const p = { access: { claude: "workspace", codex: "workspace" }, workMode: "worktree", checks: ["true"], prepare: { steps: [], auto: true }, env: { direnv: true },
    finish: { commit: true, push: null, qa: null }, grants: [] };
  // a profile without the new keys prints as before F3 (no new field in the string)
  assert.equal(fingerprint(p), JSON.stringify({ access: p.access, workMode: p.workMode, models: null, finish: p.finish, checks: p.checks, prepare: p.prepare, env: p.env, grants: [] }));
  assert.notEqual(fingerprint({ ...p, runBase: { remote: "upstream", branch: "stable", remoteUrl: "/r" } }), fingerprint(p));
  assert.notEqual(fingerprint({ ...p, branchTemplate: "{ref}" }), fingerprint(p));
});

test("controller: runBase (or branchTemplate) changed while on → settings_changed before the next start; with a remote base no board's head is read", async () => {
  const t1 = task({ issue: "ISSUE-1" });
  const t2 = task({ issue: "ISSUE-1" });
  const facts = [];
  const starts = [];
  let heads = 0;
  const base = { access: { claude: "workspace", codex: "workspace" }, workMode: "worktree", checks: ["true"], prepare: { steps: [], auto: true }, env: { direnv: true },
    finish: { commit: true, push: null, qa: null }, grants: [], runBase: { remote: "upstream", branch: "stable", remoteUrl: "/r" }, branchTemplate: "{issue}-{ref}" };
  let profile = base;
  const LINK = randomUUID();
  const ap = createBoardAutopilot({
    view: async () => ({ board: { v: 1, tasks: [t1, t2], counters: {} }, facts: [...facts] }),
    link: async () => PLACE, profile: async () => profile, optionalChecks: true, journal: async () => [],
    readiness: async () => ({ ok: true, value: { ready: true, items: [] } }),
    start: async ({ requestId, goal }) => { starts.push(goal); facts.push(done(goal.task.id === t1.id ? t1 : t2, { runId: requestId })); return { ok: true, value: { runId: requestId, created: true } }; },
    take: async () => { throw new Error("no take at a remote base"); }, head: async () => { heads++; return null; }, ensureHead: async () => { throw new Error("no head at a remote base"); },
    merge: async () => { throw new Error("no merge at a remote base"); }, newId: () => randomUUID(), now: () => Date.now(),
    remoteBase: async () => ({ ok: true, value: { branch: "upstream/stable", commit: C("b"), key: "remote" } })
  }, async () => ({ ...AUTOPILOT_BUDGET, parallel: 1 }), 3_600_000);
  await ap.set(LINK, true, "ru");
  await ap.tick(LINK);
  assert.deepEqual([starts.length, starts[0].base, heads], [1, { branch: "upstream/stable", commit: C("b"), key: "remote" }, 0], "started from the remote base, no head read");
  profile = { ...base, runBase: { ...base.runBase, branch: "other" } };
  await ap.tick(LINK);
  const st = (await ap.state())[LINK];
  assert.deepEqual([st.on, st.stop?.code, starts.length], [false, "settings_changed", 1]);
  ap.shutdown();
});

// ---------------- T-13a, T-6: the profile ----------------

const PROFILE = (over = {}) => ({ v: 1, workMode: "worktree", checks: ["true"], prepare: { steps: [], auto: true }, env: { direnv: true }, access: { claude: "workspace", codex: "workspace" },
  finish: { commit: true, push: null, qa: null }, grants: [], savedAt: null, ...over });
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

test("validateProfile: branchTemplate and runBase — the worktree only (work_mode_not_worktree, remote_base_mode), the template's own refusals", () => {
  assert.deepEqual(validateProfile(PROFILE({ branchTemplate: "{issue}-{ref}" })).branchTemplate, "{issue}-{ref}");
  assert.equal("branchTemplate" in validateProfile(PROFILE({ branchTemplate: "" })), false);
  assert.equal("runBase" in validateProfile(PROFILE({ runBase: null })), false);
  for (const workMode of ["copy", "project"]) {
    assert.equal(code(() => validateProfile(PROFILE({ workMode, branchTemplate: "{ref}" }))), "work_mode_not_worktree", workMode);
    assert.equal(code(() => validateProfile(PROFILE({ workMode, runBase: { remote: "upstream", branch: "stable", remoteUrl: null } }))), "remote_base_mode", workMode);
  }
  for (const t of ["feature", "{issue}", "a b-{ref}", "x..{ref}", "-{ref}", "{ref}{", "{ref}/", "x".repeat(201)]) {
    assert.equal(code(() => validateProfile(PROFILE({ branchTemplate: t }))), t === "{ref}/" ? null : "branch_template_invalid", t);
  }
  assert.equal(code(() => validateProfile(PROFILE({ branchTemplate: "{foo}-{ref}" }))), "branch_template_unknown");
  assert.equal(code(() => validateProfile(PROFILE({ runBase: { remote: "-x", branch: "stable" } }))), "invalid_profile");
  assert.equal(code(() => validateProfile(PROFILE({ runBase: { remote: "upstream", branch: "a..b" } }))), "invalid_profile");
  const rb = validateProfile(PROFILE({ runBase: { remote: "upstream", branch: "stable" } })).runBase;
  assert.deepEqual(rb, { remote: "upstream", branch: "stable", remoteUrl: null });
  assert.equal(fillBranch("{issue}-{ref}", { issue: "ISSUE-1", ref: "T1", run8: "x" }), "ISSUE-1-T1");
  // a profile saved before F3 reads as before
  assert.deepEqual(Object.keys(validateProfile(PROFILE())).sort(), ["access", "checks", "env", "finish", "grants", "prepare", "savedAt", "v", "workMode"]);
});

test("fetchUrlsMatch: the fetch addresses alone — a pushurl that differs does not matter (remoteUrlsMatch would refuse it)", () => {
  assert.equal(fetchUrlsMatch("/r\n", "/r"), true);
  assert.equal(remoteUrlsMatch("/r\n", "/push\n", "/r"), false);
  assert.equal(fetchUrlsMatch("/r\n/other\n", "/r"), false);
  assert.equal(fetchUrlsMatch("", "/r"), false);
  assert.equal(fetchUrlsMatch(null, "/r"), false);
});

// ---------------- the manager: fixtures ----------------

function wrapper(name, mock) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
}
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const CHECK_ENV = { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}` };
const turns = (file) => {
  const c1 = { keep: null, text: `${file} says done`, covers: ["R1"], evidence: { kind: "change", check: null } };
  return [
    { answer: { stages: [{ title: "fix", task: `write ${file}`, conditions: [c1] }], dropped: [], dropRequirements: [], question: null } },
    { answer: { summary: "done", done: true }, writes: [{ rel: file, base64: Buffer.from("done\n").toString("base64") }] },
    { answer: { conditions: [{ id: "C1", status: "met", paths: [file], note: "written" }], findings: [], request: "none", question: null } },
    { answer: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "written" }] } }
  ];
};
const PLAN_ONLY = turns("x.txt").slice(0, 1);
// one script per work folder (MOCK_SCRIPT_PER_CWD): each run its own answers
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
// a git that logs its calls and, on request, hangs on ls-remote or says no branch to the creation's local check
function fakeGit() {
  const dir = fs.mkdtempSync(path.join(TMP, "git-"));
  const file = path.join(dir, "git");
  fs.writeFileSync(file, `#!/bin/sh
echo "$*" >> "${dir}/log"
case "$1" in
  ls-remote) echo "ssh=$GIT_SSH_COMMAND" >> "${dir}/log"; [ -f "${dir}/hang" ] && sleep 5 ;;
  show-ref) [ -f "${dir}/lie" ] && exit 1 ;;
  remote) [ -f "${dir}/no-url" ] && [ "$2" = "get-url" ] && exit 2 ;;
esac
exec "${GIT}" "$@"
`, { mode: 0o755 });
  return { path: file, log: () => (fs.existsSync(path.join(dir, "log")) ? fs.readFileSync(path.join(dir, "log"), "utf8").split("\n").filter(Boolean) : []),
    set: (what, on = true) => (on ? fs.writeFileSync(path.join(dir, what), "") : fs.rmSync(path.join(dir, what), { force: true })) };
}
function manager(script, { root = path.join(TMP, `root-${++n}`), git = GIT, remoteCheckMs, shell = SHELL, baseFetchMs, shellEnv = {} } = {}) {
  const file = path.join(TMP, `providers-${++n}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script, MOCK_SCRIPT_PER_CWD: "1" } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.155.1", ...p }, claude: { executable: CLAUDE, version: "2.1.281 (Claude Code)", ...p },
    shell, checkEnv: { ...CHECK_ENV, HOME: TMP, ...shellEnv } }));
  const m = createRunManager({ platform: "darwin", arch: "arm64", root, gitPath: () => git, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true,
    workspaceOpen: () => true, workspaceKnown: (id) => id === WS, ...(remoteCheckMs ? { remoteCheckMs } : {}), ...(baseFetchMs ? { baseFetchMs } : {}) });
  return Object.assign(m, { root });
}
// a project on main with a bare remote «upstream» whose «stable» is main; hook: a commit-msg hook of the fixture
const HOOK = `#!/bin/sh
# a neutral fixture hook: the task's issue in the message or in the branch
grep -q "ISSUE-1" "$1" && exit 0
git rev-parse --abbrev-ref HEAD | grep -q "ISSUE-1" && exit 0
echo "commit-msg: no ISSUE-1 in the message or the branch" >&2
exit 1
`;
function project({ hook = false } = {}) {
  const dir = path.join(TMP, `project-${++n}`);
  const bare = path.join(TMP, `remote-${n}.git`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  fs.writeFileSync(path.join(dir, "keep.txt"), "keep\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) g(dir, ...a);
  g(TMP, "init", "-q", "--bare", bare);
  g(dir, "remote", "add", "upstream", bare);
  g(dir, "push", "-q", "upstream", "main:stable");
  if (hook) fs.writeFileSync(path.join(dir, ".git", "hooks", "commit-msg"), HOOK, { mode: 0o755 });
  return { dir, bare };
}
const bounds = { position: { x: 0, y: 0 }, size: { width: 280, height: 160 } };
async function linkOn(m, src) {
  const lead = (await m.createAgent({ agentId: randomUUID(), provider: "codex", project: src, bounds })).value.agentId;
  const exec = (await m.createAgent({ agentId: randomUUID(), provider: "claude", project: src, bounds })).value.agentId;
  return (await m.createLink({ linkId: randomUUID(), fromAgentId: lead, toAgentId: exec })).value.linkId;
}
const goalOf = (root, runId) => {
  const first = JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").split("\n")[0]);
  return JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "texts", first.data.goal.sha256), "utf8"));
};
const until = async (fn, what, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
};
const boardFile = (root, tasks) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "board.json"), JSON.stringify({ v: 1, tasks, counters: { [WS]: 99 } })); };
const branches = (dir) => g(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").filter(Boolean).sort();
// the autopilot's own goal of a task (planOnly: the plan is shown first, the run stops there)
const autoGoal = (t, over = {}) => ({ text: t.text, criteria: t.criteria, checks: [], commands: ["test -f keep.txt"], mode: "autopilot", reviewPlan: false, workMode: "worktree",
  task: { id: t.id, key: t.key }, finish: { commit: true, push: false, qa: false }, ...over });
// T-13b: the autopilot's base at a remote base — the remote branch as the project has it now (a start without it is the dialog's: remote_base_dialog)
const remoteRef = (dir) => ({ base: { branch: "upstream/stable", commit: g(dir, "rev-parse", "refs/remotes/upstream/stable").trim(), key: "remote" } });
const ended = (m, runId) => until(async () => { const v = (await m.get(runId)).value?.view; return v && ["completed", "paused", "failed", "stopped"].includes(v.status) ? v : null; }, `run ${runId} to end`);
function ipc(m) {
  const wc = Object.assign(new EventEmitter(), { id: 1, mainFrame: { id: "frame" }, isDestroyed: () => false, send() {} });
  const handlers = new Map();
  registerOrchestrationIpc((channel, listener) => handlers.set(channel, (event, ...args) => {
    assertMainRenderer(event, () => ({ isDestroyed: () => false, webContents: wc }));
    return listener(event, ...args);
  }), m);
  return { invoke: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args)) };
}

test("saveProfile: runBase's address read by `git remote get-url --all` (insteadOf expanded); none or several — remote_url_unreadable; git's check of the template", OPTS, async () => {
  const { dir, bare } = project();
  const fake = fakeGit();
  const m = manager(scripts(), { git: fake.path });
  const linkId = await linkOn(m, dir);
  // the remote's url through a rewrite: the address saved is git's own (the real path)
  g(dir, "config", `url.${path.dirname(bare)}/.insteadOf`, "fixture:");
  g(dir, "remote", "set-url", "upstream", `fixture:${path.basename(bare)}`);
  const saved = await m.saveProfile(linkId, PROFILE({ runBase: { remote: "upstream", branch: "stable", remoteUrl: "anything" }, branchTemplate: "{issue}-{ref}" }));
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.deepEqual(saved.value.runBase, { remote: "upstream", branch: "stable", remoteUrl: bare });
  assert.equal((await createProfileStore(m.root).get(dir)).runBase.remoteUrl, bare);
  // a remote that is not there, one with two different addresses, a git that cannot read it
  assert.equal((await m.saveProfile(linkId, PROFILE({ runBase: { remote: "nope", branch: "stable" } }))).code, "remote_url_unreadable");
  g(dir, "remote", "set-url", "--add", "upstream", path.join(TMP, "elsewhere.git"));
  assert.equal((await m.saveProfile(linkId, PROFILE({ runBase: { remote: "upstream", branch: "stable" } }))).code, "remote_url_unreadable");
  g(dir, "remote", "set-url", "--delete", "upstream", "elsewhere");
  fake.set("no-url");
  const unread = await m.saveProfile(linkId, PROFILE({ runBase: { remote: "upstream", branch: "stable" } }));
  assert.deepEqual([unread.code, unread.message.split(": ").at(-1)], ["remote_url_unreadable", "upstream"]);
  fake.set("no-url", false);
  // the profile's own refusals come back with their codes; git's check of the name the template makes
  assert.equal((await m.saveProfile(linkId, PROFILE({ workMode: "copy", runBase: { remote: "upstream", branch: "stable" } }))).code, "remote_base_mode");
  assert.equal((await m.saveProfile(linkId, PROFILE({ workMode: "project", branchTemplate: "{ref}" }))).code, "work_mode_not_worktree");
  assert.equal((await m.saveProfile(linkId, PROFILE({ branchTemplate: "{ref}.lock" }))).code, "branch_template_invalid", "git does not take *.lock");
  const unknown = await m.saveProfile(linkId, PROFILE({ branchTemplate: "{foo}-{ref}" }));
  assert.deepEqual([unknown.code, unknown.message.split(": ").at(-1)], ["branch_template_unknown", "{foo}"]);
  await m.shutdown();
});

test("saveProfile reads runBase's address in the login shell's environment, as the start does: an insteadOf only there is expanded, the start passes", OPTS, async () => {
  const { dir, bare } = project();
  const t1 = task({ project: dir, ref: "T1" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1]);
  // the rewrite lives only in the shell's global git config (not in the project's, not in this process's)
  const shellConfig = path.join(TMP, `gitconfig-shell-${++n}`);
  fs.writeFileSync(shellConfig, `[url "${path.dirname(bare)}/"]\n\tinsteadOf = shellonly:\n`);
  const m = manager(scripts(PLAN_ONLY), { root, shellEnv: { GIT_CONFIG_GLOBAL: shellConfig } });
  const linkId = await linkOn(m, dir);
  g(dir, "remote", "set-url", "upstream", `shellonly:${path.basename(bare)}`);
  const saved = await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], runBase: { remote: "upstream", branch: "stable" } }));
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.equal(saved.value.runBase.remoteUrl, bare, "expanded by the shell's config");
  g(dir, "remote", "set-url", "upstream", bare); // the fixture's own git fetches it
  g(dir, "fetch", "-q", "upstream");
  g(dir, "remote", "set-url", "upstream", `shellonly:${path.basename(bare)}`);
  const r = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { reviewPlan: true, ...remoteRef(dir) }) });
  assert.ok(r.ok, JSON.stringify(r));
  await ended(m, r.value.runId);
  await m.shutdown();
});

// ---------------- T-6: the branch of a board task's run ----------------

test("the template's branch: {issue}-{ref} → ISSUE-1-T1 in the worktree and in goal.branch; {ref} of a task without one is its key; a repeat keeps it; a run not of the board — canvastty/<run8>", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1" });
  const keyed = task({ project: dir, issue: "ISSUE-1" }); // no ref: the form's task
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, keyed]);
  const m = manager(scripts(PLAN_ONLY, PLAN_ONLY, PLAN_ONLY), { root });
  const store = createProfileStore(m.root);
  await store.save(dir, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}" }));
  const r1 = randomUUID();
  const c1 = await m.create({ requestId: r1, source: dir, goal: autoGoal(t1, { reviewPlan: true }) });
  assert.ok(c1.ok, JSON.stringify(c1));
  assert.equal(goalOf(m.root, r1).branch, "ISSUE-1-T1");
  assert.ok(branches(dir).includes("ISSUE-1-T1"), branches(dir).join(","));
  // the same request again: the run answers, no name is chosen again
  const again = await m.create({ requestId: r1, source: dir, goal: autoGoal(t1, { reviewPlan: true }) });
  assert.deepEqual([again.ok, again.value.created], [true, false]);
  assert.deepEqual(branches(dir).filter((b) => b.startsWith("ISSUE-1-T1")), ["ISSUE-1-T1"]);
  await ended(m, r1);
  // the template {ref}: a task without ref takes its key
  await store.save(dir, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "x/{ref}" }));
  const r2 = randomUUID();
  assert.ok((await m.create({ requestId: r2, source: dir, goal: autoGoal(keyed, { reviewPlan: true }) })).ok);
  assert.equal(goalOf(m.root, r2).branch, `x/${keyed.key}`);
  await ended(m, r2);
  // a run that is no board task's: canvastty/<run8>, no branch in its goal
  const r3 = randomUUID();
  const { task: _t, ...free } = autoGoal(t1, { reviewPlan: true });
  assert.ok((await m.create({ requestId: r3, source: dir, goal: free })).ok);
  assert.equal("branch" in goalOf(m.root, r3), false);
  assert.ok(branches(dir).includes(`canvastty/${r3.slice(0, 8)}`));
  await ended(m, r3);
  await m.shutdown();
});

test("the template's refusals at the start: no issue → branch_template_field, a protected name → protected_branch, a name git refuses → branch_invalid; nothing created", OPTS, async () => {
  const { dir } = project();
  const noIssue = task({ project: dir, ref: "T1" });
  const mainRef = task({ project: dir, ref: "main", issue: "ISSUE-1" });
  const stable = task({ project: dir, ref: "stable", issue: "ISSUE-1" });
  const dotted = task({ project: dir, ref: "T2", issue: "X.." }); // X..-T2: ".." is no branch name
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [noIssue, mainRef, stable, dotted]);
  const m = manager(scripts(), { root });
  const store = createProfileStore(m.root);
  await store.save(dir, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}" }));
  const before = branches(dir);
  const refused = async (t, over = {}) => (await m.create({ requestId: randomUUID(), source: dir, goal: autoGoal(t, over) })).code;
  assert.equal(await refused(noIssue), "branch_template_field");
  assert.equal(await refused(dotted), "branch_invalid");
  // the view: the reason on the card (issueRequired of the place)
  const v = (await m.board()).value;
  assert.deepEqual(v.issueRequired, [placeKey({ workspaceId: WS, project: dir })]);
  assert.equal(boardStatuses(v.board, v.facts, v.heads ?? [], boardOptsOf(v)).get(noIssue.id).reason, "branch_template_field");
  // {ref}: main and master are protected; with a remote base its branch too
  await store.save(dir, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{ref}", runBase: { remote: "upstream", branch: "stable", remoteUrl: g(dir, "remote", "get-url", "upstream").trim() } }));
  const prot = await m.create({ requestId: randomUUID(), source: dir, goal: autoGoal(mainRef, remoteRef(dir)) });
  assert.deepEqual([prot.code, prot.message.split(": ").at(-1)], ["protected_branch", "main"]);
  assert.equal(await refused(stable, remoteRef(dir)), "protected_branch");
  assert.deepEqual(branches(dir), before, "no branch made");
  assert.equal(fs.existsSync(path.join(m.root, "runs")) ? fs.readdirSync(path.join(m.root, "runs")).length : 0, 0, "no run created");
  // from the window: goal.branch is the application's — invalid_argument
  const { invoke } = ipc(m);
  const linkId = await linkOn(m, dir);
  const r = await invoke(IPC.orchestrationLinkStart, { linkId, requestId: randomUUID(), goal: { ...autoGoal(noIssue), branch: "mine" } });
  assert.equal(r.code, "invalid_argument");
  await m.shutdown();
});

test("the free name: a branch left by a stopped run → -2; one only on the remote → -2, ls-remote asked in startOn before the canvas lock (never inside it); all taken → branch_taken", OPTS, async () => {
  const { dir, bare } = project();
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1" });
  const t2 = task({ project: dir, ref: "T2", issue: "ISSUE-1" });
  const t3 = task({ project: dir, ref: "T3", issue: "ISSUE-1" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, t2, t3]);
  const fake = fakeGit();
  const m = manager(scripts(PLAN_ONLY, PLAN_ONLY, PLAN_ONLY), { root, git: fake.path });
  const linkId = await linkOn(m, dir);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}", runBase: { remote: "upstream", branch: "stable" } }))).ok);
  assert.ok((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel: 4 })).ok, "the paused runs hold their places: room for all");
  // a branch ISSUE-1-T1 left by a stopped run of the task
  g(dir, "branch", "ISSUE-1-T1");
  const r1 = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { reviewPlan: true, ...remoteRef(dir) }) });
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(goalOf(m.root, r1.value.runId).branch, "ISSUE-1-T1-2");
  assert.ok(branches(dir).includes("ISSUE-1-T1-2"));
  await ended(m, r1.value.runId);
  // ISSUE-1-T2 only on the remote
  g(dir, "push", "-q", "upstream", "main:refs/heads/ISSUE-1-T2");
  const logBefore = fake.log().length;
  const r2 = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t2, { reviewPlan: true, ...remoteRef(dir) }) });
  assert.ok(r2.ok, JSON.stringify(r2));
  assert.equal(goalOf(m.root, r2.value.runId).branch, "ISSUE-1-T2-2");
  const calls = fake.log().slice(logBefore);
  const lsRemote = calls.findIndex((l) => l.startsWith("ls-remote upstream refs/heads/ISSUE-1-T2 refs/heads/ISSUE-1-T2-2"));
  const add = calls.findIndex((l) => / worktree add /.test(` ${l} `));
  assert.ok(lsRemote >= 0 && add > lsRemote, calls.join("\n"));
  assert.equal(calls.filter((l) => l.startsWith("ls-remote")).length, 1, "one ls-remote, in startOn only");
  assert.ok(calls.some((l) => l.startsWith("remote get-url --all upstream")), "the fetch addresses checked first");
  await ended(m, r2.value.runId);
  // every name of T3 taken: locally and on the remote
  for (const k of [2, 3, 4, 5, 6, 7, 8]) g(dir, "branch", `ISSUE-1-T3-${k}`);
  g(dir, "branch", "ISSUE-1-T3");
  g(dir, "push", "-q", "upstream", "main:refs/heads/ISSUE-1-T3-9");
  const r3 = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t3, { reviewPlan: true, ...remoteRef(dir) }) });
  assert.equal(r3.code, "branch_taken");
  assert.ok(bare);
  await m.shutdown();
});

test("every start asks ls-remote (no cache: the retry of a busy link asks again); ls-remote's ssh asks nothing and gives up — unless the user's core.sshCommand is set", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1]);
  const fake = fakeGit();
  const m = manager(scripts(PLAN_ONLY), { root, git: fake.path });
  const linkId = await linkOn(m, dir);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}", runBase: { remote: "upstream", branch: "stable" } }))).ok);
  // a free run in the project folder holds the link (it waits for its plan)
  const { task: _t, ...free } = autoGoal(t1, { reviewPlan: true, workMode: "project" });
  const held = await m.startOnLink({ linkId, requestId: randomUUID(), goal: free });
  assert.ok(held.ok, JSON.stringify(held));
  await until(async () => (await m.get(held.value.runId)).value?.view.status === "paused" || null, "the free run to wait for its plan");
  const lsRemote = () => fake.log().filter((l) => l.startsWith("ls-remote"));
  const ssh = () => fake.log().filter((l) => l.startsWith("ssh="));
  const id = randomUUID();
  for (let i = 0; i < 2; i++) assert.equal((await m.startOnLink({ linkId, requestId: id, goal: autoGoal(t1, remoteRef(dir)) })).code, "link_busy");
  assert.equal(lsRemote().length, 2, "no cache: every start asks the remote");
  assert.equal(ssh().at(-1), "ssh=ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=2");
  // another request asks again; the user's own core.sshCommand is left as it is
  g(dir, "config", "core.sshCommand", "ssh -i /dev/null");
  assert.equal((await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, remoteRef(dir)) })).code, "link_busy");
  assert.deepEqual([lsRemote().length, ssh().at(-1)], [3, "ssh="]);
  await ended(m, held.value.runId).catch(() => {});
  await m.shutdown();
});

test("protected names: every candidate, without case — the run base's branch as -2 is skipped (-3), MAIN as the name is refused", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1" });
  const t2 = task({ project: dir, ref: "MAIN" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, t2]);
  const m = manager(scripts(PLAN_ONLY), { root });
  g(dir, "push", "-q", "upstream", "main:refs/heads/issue-1-t1-2");
  g(dir, "fetch", "-q", "upstream");
  const store = createProfileStore(m.root);
  const rb = { remote: "upstream", branch: "issue-1-t1-2", remoteUrl: g(dir, "remote", "get-url", "upstream").trim() };
  await store.save(dir, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}", runBase: rb }));
  g(dir, "branch", "ISSUE-1-T1"); // the first candidate taken locally
  const base = { base: { branch: "upstream/issue-1-t1-2", commit: g(dir, "rev-parse", "refs/remotes/upstream/issue-1-t1-2").trim(), key: "remote" } };
  const r1 = randomUUID();
  const c1 = await m.create({ requestId: r1, source: dir, goal: autoGoal(t1, { reviewPlan: true, ...base }) });
  assert.ok(c1.ok, JSON.stringify(c1));
  assert.equal(goalOf(m.root, r1).branch, "ISSUE-1-T1-3", "ISSUE-1-T1-2 is the run base's branch (case aside)");
  await ended(m, r1);
  await store.save(dir, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{ref}", runBase: rb }));
  assert.equal((await m.create({ requestId: randomUUID(), source: dir, goal: autoGoal(t2, base) })).code, "protected_branch");
  await m.shutdown();
});

test("ls-remote without an answer → remote_check_failed; a fetch address not the allowed one → base_remote_mismatch; a branch appearing between the check and the creation → ref_conflict, the run failed", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1]);
  const fake = fakeGit();
  const m = manager(scripts(PLAN_ONLY), { root, git: fake.path, remoteCheckMs: 1000 });
  const linkId = await linkOn(m, dir);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}", runBase: { remote: "upstream", branch: "stable" } }))).ok);
  fake.set("hang");
  const hung = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, remoteRef(dir)) });
  assert.deepEqual([hung.code, hung.message.split(": ").at(-1)], ["remote_check_failed", "upstream"]);
  fake.set("hang", false);
  // the remote's address changed after the profile was saved
  const url = g(dir, "remote", "get-url", "upstream").trim();
  g(dir, "remote", "set-url", "upstream", path.join(TMP, "moved.git"));
  assert.equal((await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, remoteRef(dir)) })).code, "base_remote_mismatch");
  g(dir, "remote", "set-url", "upstream", url);
  // the local check says free (a lying git), the branch is there when the worktree is added
  g(dir, "branch", "ISSUE-1-T1");
  fake.set("lie");
  const id = randomUUID();
  const raced = await m.startOnLink({ linkId, requestId: id, goal: autoGoal(t1, remoteRef(dir)) });
  assert.equal(raced.code, "ref_conflict");
  assert.equal((await m.get(id)).value.view.status, "failed");
  assert.equal(fs.existsSync(path.join(m.root, "runs")) ? fs.readdirSync(path.join(m.root, "runs")).length : 0, 1, "nothing else created");
  await m.shutdown();
});

test("a remote base without a template: a board task's run gets goal.branch canvastty/<run8> (its worktree's own name); a run not of the board — no branch key", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1]);
  const m = manager(scripts(PLAN_ONLY, PLAN_ONLY), { root });
  const linkId = await linkOn(m, dir);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], runBase: { remote: "upstream", branch: "stable" } }))).ok);
  const r1 = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { reviewPlan: true, ...remoteRef(dir) }) });
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(goalOf(m.root, r1.value.runId).branch, `canvastty/${r1.value.runId.slice(0, 8)}`);
  await ended(m, r1.value.runId);
  const { task: _t, ...free } = autoGoal(t1, { reviewPlan: true });
  const r2 = await m.startOnLink({ linkId, requestId: randomUUID(), goal: free });
  assert.ok(r2.ok, JSON.stringify(r2));
  assert.equal("branch" in goalOf(m.root, r2.value.runId), false);
  await ended(m, r2.value.runId);
  // the board's view names the place; every reading of the statuses sees the same (principle 8)
  const v = (await m.board()).value;
  assert.deepEqual(v.remoteBase, [placeKey({ workspaceId: WS, project: dir })]);
  await m.shutdown();
});

test("principle 8 at a remote base: the view's options make waits_mr in the window's statuses, main's start refuses it task_not_ready, «Accept» and mergeAll read the same", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1" });
  const t2 = task({ project: dir, ref: "T2", dependsOn: [t1.id] });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, t2]);
  const m = manager(scripts(turns("x.txt"), PLAN_ONLY), { root });
  const linkId = await linkOn(m, dir);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], finish: { commit: false, push: null, qa: null }, runBase: { remote: "upstream", branch: "stable" } }))).ok);
  // T1 completes, its checks passed
  const r1 = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { finish: { commit: false, push: false, qa: false }, ...remoteRef(dir) }) });
  assert.ok(r1.ok, JSON.stringify(r1));
  const v1 = await ended(m, r1.value.runId);
  assert.equal(v1.status, "completed", JSON.stringify([v1.status, v1.reason]));
  assert.equal((await m.boardAccept(t1.id)).code, "accept_unavailable", "acceptTask reads the statuses with the options: confirmed, nothing to accept");
  const v = (await m.board()).value;
  const st = boardStatuses(v.board, v.facts, v.heads ?? [], boardOptsOf(v)); // as useBoard
  assert.deepEqual([st.get(t1.id).done, st.get(t2.id).reason, st.get(t2.id).waitsFor], ["confirmed", "waits_mr", [t1.key]]);
  // without the options the window would say otherwise: the same function, the same inputs as main
  assert.notEqual(boardStatuses(v.board, v.facts, v.heads ?? []).get(t2.id).reason, "waits_mr");
  assert.equal((await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t2, remoteRef(dir)) })).code, "task_not_ready");
  assert.equal((await m.boardMergeAll(WS, dir, "ru")).code, "remote_base_mode", "no board's result at a remote base (T-13c)");
  // no take after «Done» was made by anyone: no raoden/ branch
  assert.equal(branches(dir).some((b) => b.startsWith("raoden/")), false);
  for (const locale of ["ru", "en"]) assert.match(taskLine(locale, st.get(t2.id), null, null), new RegExp(t1.key));
  await m.shutdown();
});

test("the take after «Done» keeps the template's name and adds no commit — also when the preparation's files were left out of the commit; without a template the take is as before", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1" });
  const t2 = task({ project: dir, ref: "T2" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, t2]);
  const m = manager(scripts(turns("x.txt"), turns("y.txt")), { root });
  const store = createProfileStore(m.root);
  // the preparation makes a file the commit leaves out (leftOut): the checked snapshot holds it, the commit does not
  await store.save(dir, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}", prepare: { steps: [{ command: "echo made > made.txt", unless: "made.txt" }], auto: true } }));
  const r1 = randomUUID();
  assert.ok((await m.create({ requestId: r1, source: dir, goal: autoGoal(t1) })).ok);
  const v1 = await ended(m, r1);
  assert.equal(v1.status, "completed", JSON.stringify([v1.status, v1.reason]));
  const tip = g(dir, "rev-parse", "ISSUE-1-T1").trim();
  const committed = g(dir, "ls-tree", "--name-only", tip).trim().split("\n");
  const take = (await m.take(r1)).value;
  assert.equal(take.suggested, "ISSUE-1-T1");
  const made = await m.takeResult(r1, { action: "branch", name: take.suggested });
  assert.equal(made.value?.result, "created", JSON.stringify(made));
  assert.equal(g(dir, "rev-parse", "ISSUE-1-T1").trim(), tip, "no commit added");
  assert.equal(branches(dir).some((b) => b.startsWith("raoden/")), false);
  // the preparation's file stayed out of the commit (leftOut ≠ ∅: the checked snapshot holds it), and out of the branch
  assert.match(JSON.stringify((await m.activity(r1, 0, 500)).value), /left out \(made by the environment preparation\): made\.txt/);
  assert.equal(committed.includes("made.txt"), false);
  // no template, no remote base: canvastty/<run8> and the take's raoden/<slug>-<id>, as before
  await store.save(dir, PROFILE({ checks: ["test -f keep.txt"] }));
  const r2 = randomUUID();
  assert.ok((await m.create({ requestId: r2, source: dir, goal: autoGoal(t2) })).ok);
  assert.equal((await ended(m, r2)).status, "completed");
  assert.equal("branch" in goalOf(m.root, r2), false);
  assert.match((await m.take(r2)).value.suggested, new RegExp(`^raoden/.+-${r2.slice(0, 8)}$`));
  await m.shutdown();
});

// ---------------- T-7: the commit's title per task ----------------

test("commitMessage: the task's commitTitle is the first line, the trailer stays; none — the text's first line, as before; no --no-verify in the commit's line", () => {
  const id = randomUUID();
  assert.equal(commitMessage("Сделать\nвторое", id, "feat: первая задача"), `feat: первая задача\n\nCanvasTTY-Run: ${id}\n`);
  assert.equal(commitMessage("Сделать\nвторое", id), `Сделать\n\nCanvasTTY-Run: ${id}\n`);
  assert.equal(commitMessage("Сделать", id, "  "), `Сделать\n\nCanvasTTY-Run: ${id}\n`);
  for (const paths of [null, ["a.txt"]]) assert.doesNotMatch(commitLine({ message: "m", paths, runId: id }, "/out"), /--no-verify/);
});

test("the project's commit-msg hook: with the branch ISSUE-1-T1 the commit of the task's title passes; refused → finish_unconfirmed, the commit failed and the hook's output in the feed, not «Done»", OPTS, async () => {
  const { dir } = project({ hook: true });
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1", commitTitle: "feat: первая задача" });
  const t2 = task({ project: dir, ref: "T2", issue: "OTHER-2", commitTitle: "feat: вторая задача" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, t2]);
  const m = manager(scripts(turns("x.txt"), turns("y.txt")), { root });
  await createProfileStore(m.root).save(dir, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}" }));
  const r1 = randomUUID();
  assert.ok((await m.create({ requestId: r1, source: dir, goal: autoGoal(t1) })).ok);
  const v1 = await ended(m, r1);
  assert.equal(v1.status, "completed", JSON.stringify([v1.status, v1.reason, v1.progress?.finish]));
  assert.equal(g(dir, "log", "-1", "--format=%B", "ISSUE-1-T1"), `feat: первая задача\n\nCanvasTTY-Run: ${r1}\n\n`);
  // the hook refuses: neither the message nor the branch (OTHER-2-T2) has ISSUE-1
  const r2 = randomUUID();
  assert.ok((await m.create({ requestId: r2, source: dir, goal: autoGoal(t2) })).ok);
  const v2 = await ended(m, r2);
  assert.deepEqual([v2.status, v2.reason], ["paused", "finish_unconfirmed"]);
  assert.equal(v2.progress.finish.find((f) => f.step === "commit").status, "failed");
  const st = boardStatuses((await m.board()).value.board, (await m.board()).value.facts).get(t2.id);
  assert.deepEqual([st.done, st.reason], [null, "waits_decision"]);
  const feed = JSON.stringify((await m.activity(r2, 0, 500)).value ?? "");
  assert.match(feed, /commit-msg: no ISSUE-1/);
  assert.doesNotMatch(feed, /--no-verify/);
  assert.equal(g(dir, "rev-parse", "OTHER-2-T2").trim(), g(dir, "rev-parse", "main").trim(), "nothing committed");
  await m.shutdown();
});

test("i18n: every F3 text in both languages", () => {
  for (const key of ["boardReason_waits_mr", "boardReason_branch_template_field", "projBranchTemplate", "projRunBase",
    "orchError_branch_template_invalid", "orchError_branch_template_unknown", "orchError_branch_template_field", "orchError_branch_invalid", "orchError_branch_taken",
    "orchError_remote_check_failed", "orchError_protected_branch", "orchError_remote_url_unreadable", "orchError_remote_base_mode", "orchError_work_mode_not_worktree",
    "orchError_base_remote_mismatch", "orchError_ref_conflict"]) {
    for (const locale of ["ru", "en"]) assert.ok(words(locale, key), `${locale} ${key}`);
  }
});

// ---------------- T-6, T-7: import ----------------

const P = (() => {
  const dir = path.join(TMP, "repo");
  fs.mkdirSync(dir);
  execFileSync(GIT, ["init", "-q", dir], { env: GIT_ENV });
  return dir;
})();
const WORKSPACES = { open: (id) => id === WS, named: (title) => (title === "acme" ? [WS] : []) };
const row = (ref, over = {}) => ({ ref, project: P, title: `Задача ${ref}`, text: `Сделать ${ref}`, criteria: [`${ref} готово`], ...over });
async function imp(st, tasks) {
  const r = await readTasksFile("tasks.json", Buffer.from(JSON.stringify({ format: "board-tasks/v1", workspace: "acme", tasks })), WORKSPACES);
  assert.ok(r.job, JSON.stringify(r.report));
  return (await st.importTasks(r.job, async () => new Set(), () => true)).rows;
}

test("import (F3): issue and commitTitle accepted and kept; bad ones → invalid_task; a file without them takes them off; the same again — unchanged; scope still field_not_supported", async () => {
  const file = path.join(TMP, `board-${++n}.json`);
  const st = createBoardStore(file);
  const json = () => JSON.parse(fs.readFileSync(file, "utf8")).tasks;
  const byRef = (ref) => json().find((t) => t.ref === ref);
  let rows = await imp(st, [row("T1", { issue: "ISSUE-1", commitTitle: "feat: первая задача" }), row("T2", { issue: "-x" }), row("T3", { commitTitle: "a\nb" }),
    row("T4", { commitTitle: "x".repeat(73) }), row("T5", { commitTitle: " " }), row("T6", { scope: ["docs/**"] })]);
  assert.deepEqual(rows.refused.map((x) => [x.ref, x.code]), [["T2", "invalid_task"], ["T3", "invalid_task"], ["T4", "invalid_task"], ["T5", "invalid_task"], ["T6", "field_not_supported"]]);
  assert.deepEqual([byRef("T1").issue, byRef("T1").commitTitle], ["ISSUE-1", "feat: первая задача"]);
  rows = await imp(st, [row("T1", { issue: "ISSUE-1", commitTitle: "feat: первая задача" })]);
  assert.deepEqual(rows.unchanged, ["T1"]);
  rows = await imp(st, [row("T1", { issue: "ISSUE-2" })]);
  assert.deepEqual([rows.updated.map((x) => x.ref), byRef("T1").issue, "commitTitle" in byRef("T1")], [["T1"], "ISSUE-2", false]);
  rows = await imp(st, [row("T1")]);
  assert.deepEqual([rows.updated.map((x) => x.ref), "issue" in byRef("T1")], [["T1"], false]);
  // board.json by hand: a bad issue or title is dropped, the board kept
  const t = json()[0];
  fs.writeFileSync(file, JSON.stringify({ v: 1, tasks: [{ ...t, issue: "bad issue", commitTitle: "two\nlines" }], counters: { [WS]: 9 } }));
  const read = (await createBoardStore(file).read()).board.tasks[0];
  assert.deepEqual([read.id, "issue" in read, "commitTitle" in read], [t.id, false, false]);
});

// ---------------- T-13a, T-6: the autopilot through a chain at a remote base ----------------

test("the autopilot at a remote base with a template: T1 → T1-MR → T2 — branches ISSUE-1-T1 and ISSUE-1-T2, commits of the tasks' titles through the hook; no board's result, no merge, no take; waits for the mark, then all done", OPTS, async () => {
  const { dir } = project({ hook: true });
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1", commitTitle: "feat: первая задача", text: "write x", criteria: ["x.txt says done"] });
  const mr = task({ project: dir, ref: "T1-MR", external: true, criteria: [EXTERNAL_CRITERION], dependsOn: [t1.id] });
  const t2 = task({ project: dir, ref: "T2", issue: "ISSUE-1", commitTitle: "feat: вторая задача", dependsOn: [mr.id], text: "write y", criteria: ["y.txt says done"] });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, mr, t2]);
  const m = manager(scripts(turns("x.txt"), turns("y.txt")), { root });
  const linkId = await linkOn(m, dir);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}", runBase: { remote: "upstream", branch: "stable" } }))).ok);
  assert.equal((await m.boardBudget(linkId, { ...AUTOPILOT_BUDGET, parallel: 1 })).ok, true);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  const waiting = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; return s?.waits === "external" ? s : s && !s.on ? s : null; }, "the wait for the mark");
  assert.deepEqual([waiting.on, waiting.waits, waiting.waitsKey], [true, "external", mr.key], JSON.stringify(waiting));
  assert.ok((await m.boardExternalMark(mr.id, true, "MR merged")).ok);
  const end = await until(async () => { const s = (await m.board()).value.autopilot[linkId]; return s && !s.on ? s : null; }, "the autopilot to end", 240_000);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  const v = (await m.board()).value;
  assert.equal(v.heads, undefined, "no board's result");
  assert.equal(g(dir, "for-each-ref", "refs/raoden/").trim(), "", "no ref of a board's result");
  assert.deepEqual(branches(dir).filter((b) => !b.startsWith("canvastty/")), ["ISSUE-1-T1", "ISSUE-1-T2", "main"]);
  assert.equal(g(dir, "log", "-1", "--format=%s", "ISSUE-1-T1").trim(), "feat: первая задача");
  assert.equal(g(dir, "log", "-1", "--format=%s", "ISSUE-1-T2").trim(), "feat: вторая задача");
  const st = boardStatuses(v.board, v.facts, [], boardOptsOf(v));
  assert.deepEqual([t1, mr, t2].map((t) => st.get(t.id).done), ["confirmed", "external", "confirmed"]);
  // no take: nothing was taken (taken.json), the names are the runs' own
  assert.deepEqual(v.facts.map((f) => f.taken?.branch ?? null), [null, null]);
  await m.shutdown();
});

// ---------------- T-13b: the base from the remote ----------------

test("checkBase: the key remote is taken (journal v2, a worktree), another key that is not T-<n> is not", () => {
  const bad = (m) => { throw Object.assign(new Error(m), { code: "invalid_goal" }); };
  const b = { branch: "upstream/stable", commit: C("b"), key: "remote" };
  assert.deepEqual(checkBase(b, true, "worktree", bad), b);
  assert.deepEqual(checkBase({ ...b, key: "T-3" }, true, "copy", bad), { ...b, key: "T-3" });
  for (const key of ["remotes", "origin", "T-x", "", "REMOTE"]) assert.equal(code(() => checkBase({ ...b, key }, true, "worktree", bad)), "invalid_goal", key);
  assert.equal(code(() => checkBase(b, false, "worktree", bad)), "invalid_goal", "journal v2 only");
});

// the autopilot of one place at a remote base with fake deps: every fetch counted, the starts answered by `answer`
function remoteAutopilot(tasks, answer, { fetch } = {}) {
  const LINK = randomUUID();
  const s = { tasks, facts: [], fetches: 0, starts: [],
    profile: { access: { claude: "workspace", codex: "workspace" }, workMode: "worktree", checks: ["true"], prepare: { steps: [], auto: true }, env: { direnv: true },
      finish: { commit: true, push: null, qa: null }, grants: [], runBase: { remote: "upstream", branch: "stable", remoteUrl: "/r" } } };
  const ap = createBoardAutopilot({
    view: async () => ({ board: { v: 1, tasks: s.tasks, counters: {} }, facts: [...s.facts] }),
    link: async () => PLACE, profile: async () => s.profile, optionalChecks: true, journal: async () => [],
    readiness: async () => ({ ok: true, value: { ready: true, items: [] } }),
    start: async (input) => {
      s.starts.push(input.goal);
      const r = answer(input, s);
      if (r.ok) s.facts.push(done(s.tasks.find((t) => t.id === input.goal.task.id), { runId: input.requestId }));
      return r;
    },
    take: async () => { throw new Error("no take"); }, head: async () => { throw new Error("no head read"); }, ensureHead: async () => { throw new Error("no head"); },
    merge: async () => { throw new Error("no merge"); }, newId: () => randomUUID(), now: () => Date.now(),
    remoteBase: async () => { s.fetches++; return fetch ? fetch(s) : { ok: true, value: { branch: "upstream/stable", commit: C(String(s.fetches % 10)), key: "remote" } }; }
  }, async () => ({ ...AUTOPILOT_BUDGET, parallel: 1 }), 3_600_000);
  return { ap, LINK, s, st: async () => (await ap.state())[LINK] };
}
const OK = (input) => ({ ok: true, value: { runId: input.requestId, created: true } });
const NO = (code) => ({ ok: false, code, message: code });

test("the base's cache (О3): kept while the start waits link_busy (no second fetch); after the run is created the next start fetches; a mark given or taken off fetches again", async () => {
  const t1 = task(), t2 = task();
  let busy = 1;
  const a = remoteAutopilot([t1, t2], (input) => (busy-- > 0 ? NO("link_busy") : OK(input)));
  await a.ap.set(a.LINK, true, "ru");
  await a.ap.tick(a.LINK);
  assert.deepEqual([a.s.fetches, a.s.starts.length, (await a.st()).on], [1, 1, true], "the start waits the link");
  await a.ap.tick(a.LINK);
  assert.deepEqual([a.s.fetches, a.s.starts.length], [1, 2], "the second step: no fetch, the same base");
  assert.deepEqual(a.s.starts.map((g) => g.base), [{ branch: "upstream/stable", commit: C("1"), key: "remote" }, { branch: "upstream/stable", commit: C("1"), key: "remote" }]);
  await a.ap.tick(a.LINK);
  assert.deepEqual([a.s.fetches, a.s.starts.length, a.s.starts[2].task.id, a.s.starts[2].base.commit], [2, 3, t2.id, C("2")], "after the run was created: a fresh fetch");
  a.ap.shutdown();
  // a mark of an external task of the place while the start waits
  const e = task({ external: true, criteria: [EXTERNAL_CRITERION] }), t3 = task();
  const b = remoteAutopilot([e, t3], () => NO("link_busy"));
  await b.ap.set(b.LINK, true, "ru");
  await b.ap.tick(b.LINK);
  await b.ap.tick(b.LINK);
  assert.deepEqual([b.s.fetches, b.s.starts.length], [1, 2]);
  b.s.tasks = [{ ...e, externalDone: MARK }, t3]; // «Выполнено»
  await b.ap.tick(b.LINK);
  assert.deepEqual([b.s.fetches, b.s.starts.length], [2, 3], "the mark: fetched again");
  b.s.tasks = [e, t3]; // «Снять отметку»
  await b.ap.tick(b.LINK);
  assert.equal(b.s.fetches, 3, "the mark taken off: fetched again");
  b.ap.shutdown();
});

test("the base's cache (О3) lives only while one start waits: start (link_busy) → a step that waits → the same task's start fetches again", async () => {
  const t1 = task(), t2 = task();
  let busy = 1;
  const a = remoteAutopilot([t1, t2], (input) => (busy-- > 0 ? NO("link_busy") : OK(input)));
  await a.ap.set(a.LINK, true, "ru");
  await a.ap.tick(a.LINK);
  assert.deepEqual([a.s.fetches, a.s.starts.length], [1, 1], "the start waits the link");
  // another run of the place takes the only slot: the step waits, no start
  const other = run({ taskId: t2.id, taskKey: t2.key });
  a.s.facts.push(other);
  await a.ap.tick(a.LINK);
  assert.deepEqual([a.s.fetches, a.s.starts.length, (await a.st()).on], [1, 1, true], "a wait: neither fetch nor start");
  a.s.facts = a.s.facts.filter((f) => f !== other);
  await a.ap.tick(a.LINK);
  assert.deepEqual([a.s.fetches, a.s.starts.length, a.s.starts[1].task.id, a.s.starts[1].base.commit], [2, 2, t1.id, C("2")], "the same task again: fetched anew");
  a.ap.shutdown();
});

test("the race by the goal's base: invalid_base of a remote base — pending dropped, the cache too, the autopilot stays on and starts on the next step; two in a row — a fetch each; another refusal stops it as before", async () => {
  const t1 = task();
  let refusals = 2;
  const a = remoteAutopilot([t1], (input) => (refusals-- > 0 ? NO("invalid_base") : OK(input)));
  await a.ap.set(a.LINK, true, "ru");
  for (let i = 0; i < 3; i++) await a.ap.tick(a.LINK);
  assert.deepEqual([a.s.fetches, a.s.starts.length, (await a.st()).on], [3, 3, true], "two invalid_base in a row: fetched again each time, then started");
  assert.deepEqual(a.s.starts.map((g) => g.base.commit), [C("1"), C("2"), C("3")]);
  assert.equal(a.s.facts.length, 1);
  a.ap.shutdown();
  // the step's own base is null at a remote base (autopilotParallelStep): the race is read from the goal's base; any
  // other refusal of the start stops it as before
  const b = remoteAutopilot([task()], () => NO("invalid_goal"));
  await b.ap.set(b.LINK, true, "ru");
  await b.ap.tick(b.LINK);
  const st = await b.st();
  assert.deepEqual([st.on, st.stop?.code, st.stop?.detail, b.s.fetches], [false, "start_failed", "invalid_goal", 1]);
  b.ap.shutdown();
});

test("runBase changed: settings_changed; on again — a fresh fetch. The fetch's refusals: base_fetch_failed, base_remote_mismatch — the autopilot off with the code; remote_url_unreadable — start_failed; no start", async () => {
  const t1 = task();
  const a = remoteAutopilot([t1], () => NO("link_busy"));
  await a.ap.set(a.LINK, true, "ru");
  await a.ap.tick(a.LINK);
  a.s.profile = { ...a.s.profile, runBase: { ...a.s.profile.runBase, branch: "other" } };
  await a.ap.tick(a.LINK);
  assert.deepEqual([(await a.st()).stop?.code, a.s.fetches], ["settings_changed", 1]);
  await a.ap.set(a.LINK, true, "ru");
  await a.ap.tick(a.LINK);
  assert.equal(a.s.fetches, 2, "on again with the new runBase: fetched");
  a.ap.shutdown();
  for (const [codeOf, stop, detail] of [["base_fetch_failed", "base_fetch_failed", "base_fetch_failed"], ["base_remote_mismatch", "base_remote_mismatch", "base_remote_mismatch"], ["remote_url_unreadable", "start_failed", "remote_url_unreadable"]]) {
    const b = remoteAutopilot([t1], OK, { fetch: () => NO(codeOf) });
    await b.ap.set(b.LINK, true, "ru");
    await b.ap.tick(b.LINK);
    const st = await b.st();
    assert.deepEqual([st.on, st.stop?.code, st.stop?.detail, st.stop?.key, b.s.starts.length], [false, stop, detail, t1.key, 0], codeOf);
    b.ap.shutdown();
  }
});

// the user's login shell of the fixture: logs each fetch line; on request the fetch fails or hangs
function fakeShell() {
  const dir = fs.mkdtempSync(path.join(TMP, "shell-"));
  const file = path.join(dir, "sh");
  fs.writeFileSync(file, `#!/bin/sh
case "$1" in -ilc|-c) shift ;; esac
case "$1" in *"git fetch"*)
  printf '%s\\n' "$1" >> "${dir}/fetch.log"
  [ -f "${dir}/fail" ] && { echo "fatal: the fixture's remote is down" >&2; exit 128; }
  [ -f "${dir}/hang" ] && exec sleep 30 ;;
esac
exec /bin/sh -c "$1"
`, { mode: 0o755 });
  return { path: file, log: () => (fs.existsSync(path.join(dir, "fetch.log")) ? fs.readFileSync(path.join(dir, "fetch.log"), "utf8").split("\n").filter(Boolean) : []),
    set: (what, on = true) => (on ? fs.writeFileSync(path.join(dir, what), "") : fs.rmSync(path.join(dir, what), { force: true })) };
}
// the remote's branch moved by someone else: a commit pushed to its stable from another clone
function moveRemote(bare, file) {
  const c = path.join(TMP, `clone-${++n}`);
  g(TMP, "clone", "-q", "-b", "stable", bare, c);
  fs.writeFileSync(path.join(c, file), "moved\n");
  g(c, "add", "-A");
  g(c, "commit", "-q", "-m", `move ${file}`);
  g(c, "push", "-q", "origin", "stable");
  return g(c, "rev-parse", "HEAD").trim();
}
const apState = async (m, linkId) => (await m.board()).value.autopilot[linkId];

test("the autopilot's base from the fresh remote: the fetch line in the login shell (GIT_TERMINAL_PROMPT=0, the explicit refspec); pushurl ≠ url passes by the url; the worktree from the moved remote's commit; no board's ref", OPTS, async () => {
  const { dir, bare } = project();
  const t1 = task({ project: dir, ref: "T1", issue: "ISSUE-1", text: "write x", criteria: ["x.txt says done"] });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1]);
  const sh = fakeShell();
  const m = manager(scripts(turns("x.txt")), { root, shell: sh.path });
  const linkId = await linkOn(m, dir);
  g(dir, "remote", "set-url", "--push", "upstream", path.join(TMP, "push-only.git")); // remoteUrlsMatch would refuse it
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], branchTemplate: "{issue}-{ref}", runBase: { remote: "upstream", branch: "stable" } }))).ok);
  const before = g(dir, "rev-parse", "refs/remotes/upstream/stable").trim();
  const moved = moveRemote(bare, "moved.txt");
  assert.notEqual(moved, before);
  assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
  const end = await until(async () => { const s = await apState(m, linkId); return s && !s.on ? s : null; }, "the autopilot to end", 240_000);
  assert.equal(end.stop.code, "all_done", JSON.stringify(end));
  const runId = (await m.board()).value.facts[0].runId;
  assert.deepEqual(goalOf(m.root, runId).base, { branch: "upstream/stable", commit: moved, key: "remote" });
  assert.equal(g(dir, "rev-parse", "ISSUE-1-T1^").trim(), moved, "the run's commit is on the moved remote's commit");
  assert.equal(g(dir, "rev-parse", "refs/remotes/upstream/stable").trim(), moved);
  assert.deepEqual(sh.log(), ["GIT_TERMINAL_PROMPT=0 git fetch --no-tags 'upstream' '+refs/heads/stable:refs/remotes/upstream/stable'"]);
  assert.equal(g(dir, "for-each-ref", "refs/raoden/").trim(), "", "no ref of a board's result");
  await m.shutdown();
});

test("the fetch's refusals in main: it fails → base_fetch_failed; it hangs longer than its wait (here 1 s, 120 s in the code) → base_fetch_failed; another fetch address → base_remote_mismatch; none read → start_failed remote_url_unreadable; no run created", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1]);
  const sh = fakeShell();
  const fake = fakeGit();
  const m = manager(scripts(), { root, shell: sh.path, git: fake.path, baseFetchMs: 1000 });
  const linkId = await linkOn(m, dir);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], runBase: { remote: "upstream", branch: "stable" } }))).ok);
  const stopOf = async () => {
    assert.ok((await m.boardAutopilot(linkId, true, "ru")).ok);
    return (await until(async () => { const s = await apState(m, linkId); return s && !s.on ? s : null; }, "the autopilot to stop", 60_000)).stop;
  };
  sh.set("fail");
  const failed = await stopOf();
  assert.deepEqual([failed.code, failed.key], ["base_fetch_failed", t1.key]);
  assert.match(failed.detail, /the fixture's remote is down/);
  sh.set("fail", false);
  sh.set("hang");
  const t0 = Date.now();
  const hung = await stopOf();
  assert.deepEqual([hung.code, /did not answer/.test(hung.detail)], ["base_fetch_failed", true], JSON.stringify(hung));
  assert.ok(Date.now() - t0 < 30_000, "stopped by its own wait");
  sh.set("hang", false);
  const url = g(dir, "remote", "get-url", "upstream").trim();
  g(dir, "remote", "set-url", "upstream", path.join(TMP, "moved.git"));
  assert.equal((await stopOf()).code, "base_remote_mismatch");
  g(dir, "remote", "set-url", "upstream", url);
  fake.set("no-url");
  assert.deepEqual(await stopOf().then((s) => [s.code, s.detail]), ["start_failed", "remote_url_unreadable"]);
  assert.equal(fs.existsSync(path.join(m.root, "runs")) ? fs.readdirSync(path.join(m.root, "runs")).length : 0, 0, "no run created");
  assert.ok(sh.log().every((l) => l.startsWith("GIT_TERMINAL_PROMPT=0 git fetch ")), sh.log().join("\n"));
  await m.shutdown();
});

test("taskOk at a remote base: the base remote taken when its commit is the project's remote branch now (no new fetch), another commit → invalid_base; an existing board's result is not read (no task_not_ready); remote in a place without runBase → invalid_base", OPTS, async () => {
  const { dir, bare } = project();
  const t1 = task({ project: dir, ref: "T1" });
  const t2 = task({ project: dir, ref: "T2" });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, t2]);
  const fake = fakeGit();
  const m = manager(scripts(PLAN_ONLY, PLAN_ONLY), { root, git: fake.path });
  const linkId = await linkOn(m, dir);
  // a remote base in a place without runBase
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"] }))).ok);
  assert.equal((await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, remoteRef(dir)) })).code, "invalid_base");
  // a board's result made before the remote base
  assert.ok((await m.boardHeadNew(WS, dir)).ok);
  const boardRef = g(dir, "for-each-ref", "--format=%(refname)", "refs/raoden/").trim();
  assert.match(boardRef, /^refs\/raoden\/board\//);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], runBase: { remote: "upstream", branch: "stable" } }))).ok);
  const stale = remoteRef(dir);
  moveRemote(bare, "later.txt"); // the remote moved, the project not fetched: its remote branch is what taskOk reads
  assert.equal((await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { base: { ...stale.base, commit: C("1") } }) })).code, "invalid_base");
  assert.equal((await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { base: { ...stale.base, branch: "upstream/main" } }) })).code, "invalid_base");
  const fetchesBefore = fake.log().filter((l) => l.startsWith("fetch")).length;
  const r1 = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { reviewPlan: true, ...stale }) });
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(fake.log().filter((l) => l.startsWith("fetch")).length, fetchesBefore, "taskOk fetches nothing");
  assert.equal(g(dir, "rev-parse", `canvastty/${r1.value.runId.slice(0, 8)}`).trim(), stale.base.commit, "the worktree from the base's commit");
  await ended(m, r1.value.runId);
  assert.ok((await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t2, { reviewPlan: true, ...stale }) })).ok, "the board's result is not read");
  assert.equal(g(dir, "for-each-ref", "--format=%(refname)", "refs/raoden/").trim(), boardRef, "no new ref of a board's result");
  await until(async () => (await m.board()).value.facts.every((f) => ["completed", "paused", "failed", "stopped"].includes(f.status)), "the runs to end");
  await m.shutdown();
});

// ---------------- T-13c: the refusals in a place with a remote base ----------------

test("T-13c: at a remote base mergeTask, mergeAll, a new head → remote_base_mode; «Split» (the form, a new task, the start of a split) → remote_base_mode, decomposeCandidate skips; the dialog's start of a board task → remote_base_dialog; a free run is created; without runBase nothing changed", OPTS, async () => {
  const { dir } = project();
  const t1 = task({ project: dir, ref: "T1" });
  const parent = task({ project: dir, ref: "P", decompose: true });
  const root = path.join(TMP, `root-${++n}`);
  boardFile(root, [t1, parent]);
  const m = manager(scripts(PLAN_ONLY, PLAN_ONLY), { root });
  const linkId = await linkOn(m, dir);
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"], runBase: { remote: "upstream", branch: "stable" } }))).ok);
  assert.equal((await m.boardMerge(t1.id, "ru")).code, "remote_base_mode");
  assert.equal((await m.boardMergeAll(WS, dir, "ru")).code, "remote_base_mode");
  assert.equal((await m.boardHeadNew(WS, dir)).code, "remote_base_mode");
  assert.equal((await m.boardUpdate(t1.id, { decompose: true })).code, "remote_base_mode");
  assert.equal((await m.boardCreate({ workspaceId: WS, project: dir, title: "n", text: "n", criteria: ["c"], dependsOn: [], decompose: true })).code, "remote_base_mode");
  assert.equal((await m.boardDecompose(parent.id, "ru")).code, "remote_base_mode");
  const v = (await m.board()).value;
  const statuses = boardStatuses(v.board, v.facts, [], boardOptsOf(v));
  const at = { workspaceId: WS, project: dir };
  assert.equal(decomposeCandidate(v.board, v.facts, statuses, at, { remoteBase: true }), null);
  assert.equal(decomposeCandidate(v.board, v.facts, statuses, at)?.id, parent.id, "without the option: as before");
  // the dialog: no base, or the board's result — refused; the autopilot's (base remote) passes: tests above
  const dialog = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1) });
  assert.deepEqual([dialog.code], ["remote_base_dialog"]);
  assert.equal((await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { base: { branch: `refs/raoden/board/${WS}/1`, commit: C("a"), key: "T-0" } }) })).code, "remote_base_dialog");
  assert.equal(fs.existsSync(path.join(m.root, "runs")) ? fs.readdirSync(path.join(m.root, "runs")).length : 0, 0, "no run created");
  const { task: _t, ...free } = autoGoal(t1, { reviewPlan: true });
  const r = await m.startOnLink({ linkId, requestId: randomUUID(), goal: free });
  assert.ok(r.ok, JSON.stringify(r));
  await ended(m, r.value.runId);
  assert.equal(g(dir, "for-each-ref", "refs/raoden/").trim(), "", "no ref of a board's result");
  // ensureHead itself (boardMerge.ts)
  const merges = createBoardMerge({ root: m.root, gitPath: () => GIT, launch: () => LAUNCH, own: async () => {}, checks: async () => [], shell: async () => ({ shell: SHELL, env: {} }),
    quiet: async () => true, remoteBase: async () => true });
  await assert.rejects(merges.ensureHead(WS, dir), (e) => e.code === "remote_base_mode");
  // a merge asked for at a remote base (the autopilot's step of before runBase): refused before any head is read
  await assert.rejects(merges.merge({ workspaceId: WS, project: dir, task: { id: t1.id, key: t1.key }, taskRunId: randomUUID(), commit: C("b"), language: "ru" }),
    (e) => e.code === "remote_base_mode");
  // the same place without runBase: as before
  assert.ok((await m.saveProfile(linkId, PROFILE({ checks: ["test -f keep.txt"] }))).ok);
  assert.ok((await m.boardUpdate(t1.id, { decompose: true })).ok);
  assert.ok((await m.boardUpdate(t1.id, { decompose: false })).ok);
  assert.notEqual((await m.boardMerge(t1.id, "ru")).code, "remote_base_mode");
  const plain = await m.startOnLink({ linkId, requestId: randomUUID(), goal: autoGoal(t1, { reviewPlan: true }) });
  assert.ok(plain.ok, JSON.stringify(plain));
  await ended(m, plain.value.runId);
  await m.shutdown();
});

test("i18n (F3 part 2): the stops of the fetch and the dialog's refusal in both languages", () => {
  for (const key of ["boardApStop_base_fetch_failed", "boardApStop_base_remote_mismatch", "orchError_remote_base_dialog", "orchError_remote_base_mode"]) {
    for (const locale of ["ru", "en"]) assert.notEqual(words(locale, key), key, `${locale}: ${key}`);
  }
  assert.equal(words("ru", "orchError_remote_base_dialog"), "В этом проекте задачи доски запускает автопилот");
  assert.equal(words("en", "boardApStop_base_fetch_failed"), "{key}: the remote branch could not be fetched — check the network and access");
});
