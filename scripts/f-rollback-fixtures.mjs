// F0 (stage-f-external-projects.md §9): before any code, do the released builds keep and read what stage F will write,
// and what do they lose? Per build:
// 1. the build is the released one: its zip, Info.plist, app.asar and binary match the build's SHA256SUMS, and the
//    Info.plist version is the folder's;
// 2. this build makes the fixtures in a temporary profile: a board of four tasks with F's fields (ref, origin, external
//    with its one line and externalDone, models, issue, commitTitle, scope); a profile with branchTemplate, runBase,
//    runPush, reviewExport, runMcp; two task runs (worktree, commit and push to a bare remote, fake CLIs) whose goals get
//    goal.task.ref, goal.branch, goal.export, goal.finish.push.options and .protected, goal.base from the remote
//    (key "remote"), the journal's hash chain rebuilt. A: the push confirmed, its journal cut after the push's
//    finish.intent, as the application's end leaves it (no result; the remote branch removed: «push not done»). B: left
//    at the person's confirmation of the push (no push intent);
// 3. the packaged older build opens the profile with a window, a login shell that logs its lines, fake CLIs; through
//    window.canvasTTY.orchestration: the board read, the profile read through a link, A resumed (only ls-remote,
//    never git push), B's push confirmed (it pushes: without the options), a task renamed and another archived, the
//    profile saved; addGrant is not driven (no window call; it writes the profile as saveProfile does, profile.ts write);
// 4. after it quits: the tasks' new fields as before (sha256 of their canonical JSON), the profile's new keys dropped
//    (the known loss), this build reads the board and both journals back.
// No model call: the continued runs have only finish steps left. Usage, from the repository root:
//   node scripts/f-rollback-fixtures.mjs "release/<v>/.build.noindex/mac-arm64/Raoden Loom.app" […] [--out file.json]
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch, workspace } from "./orchestration-app-kit.mjs";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { createBoardStore } from "../src/main/services/orchestration/boardStore.ts";
import { buildRecord, canonical, sha256Hex } from "../src/main/services/orchestration/journal.ts";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const APPS = args.filter((a, i) => a !== "--out" && args[i - 1] !== "--out").map((a) => path.resolve(a));
const GIT = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };
const F_FIELDS = ["ref", "origin", "external", "externalDone", "models", "issue", "commitTitle", "scope"];
const fieldsOf = (tasks) => sha256Hex(canonical(tasks.map((t) => [t.key, ...F_FIELDS.map((k) => t[k] ?? null)])));
const F_PROFILE = ["branchTemplate", "runBase", "runPush", "reviewExport", "runMcp"];
const C1 = { keep: null, text: "done", covers: ["R1"], evidence: { kind: "change", check: null } };
const PLAN = { report: { stages: [{ title: "fix", task: "write note", conditions: [C1] }], dropped: [], dropRequirements: [], question: null } };
const exec = (file) => ({ report: { summary: "done", done: true }, writes: [[file, `${file}\n`]] });
const REVIEW = (file) => ({ report: { conditions: [{ id: "C1", status: "met", paths: [file], note: "ok" }], findings: [], request: "none", question: null } });
const FINAL = { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "ok" }] } };

// 1. the zip, Info.plist, app.asar and binary against the build's own SHA256SUMS
function released(APP) {
  const dir = path.resolve(APP, "../../..");
  const ver = path.basename(dir);
  const sums = new Map(fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").split("\n").filter(Boolean).map((l) => { const [h, ...f] = l.split(/\s+/); return [f.join(" "), h]; }));
  const zip = `Raoden-Loom-${ver}-mac-arm64.zip`;
  const inApp = ["Contents/Info.plist", "Contents/Resources/app.asar", "Contents/MacOS/Raoden Loom"];
  const version = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(APP, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  const zipSha = sha(path.join(dir, zip));
  return { version, zipSha, ok: version === ver && sums.get(zip) === zipSha
    && inApp.every((f) => sums.get(`.build.noindex/mac-arm64/Raoden Loom.app/${f}`) === sha(path.join(APP, f))) };
}

// The journal with F's goal fields: a new goal text, every record rebuilt on the chain (same type, time and data)
function withGoal(ROOT, runId, edit) {
  const RD = path.join(ROOT, "runs", runId), J = path.join(RD, "journal.jsonl");
  const recs = fs.readFileSync(J, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const goal = edit(JSON.parse(fs.readFileSync(path.join(RD, "texts", recs[0].data.goal.sha256), "utf8")));
  const buf = Buffer.from(canonical(goal), "utf8");
  const ref = { sha256: sha256Hex(buf), bytes: buf.length };
  fs.writeFileSync(path.join(RD, "texts", ref.sha256), buf);
  let prev = null, out = "";
  for (const r of recs) {
    const { v, seq, ts, runId: id, type, prevHash, data, hash, ...head } = r;
    const { record, line } = buildRecord(prev, id, ts, type, seq === 0 ? { ...data, goal: ref } : data, v, seq === 0 ? head : null);
    prev = { seq: record.seq, hash: record.hash };
    out += line.toString("utf8");
  }
  fs.writeFileSync(J, out);
  return { J, recs: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}
const turns = (J) => fs.readFileSync(J, "utf8").split("\n").filter((l) => /"type":"(orch\.turn|turn\.)/.test(l)).length;
// The person's confirmation of the push the run asked for (the view's tree and commit)
const confirm = (v) => ({ kind: "finish.confirm", tree: v.confirm.tree, commit: v.confirm.commit, push: "confirm", qa: null });
// As the application left it when it ended: the records up to `keep` (exclusive), the chain unchanged
function cut(J, recs, keep) {
  fs.writeFileSync(J, recs.slice(0, keep).map((r) => canonical(r) + "\n").join(""));
}

async function check(APP) {
  const out = { app: APP, checks: {}, losses: {} };
  const rel = released(APP);
  Object.assign(out, { version: rel.version, zipSha: rel.zipSha });
  out.checks.released = rel.ok;
  if (!rel.ok) { out.ok = false; return out; } // not checked without the sums
  const { D, git, project, script } = workspace("frb.");
  const src = fs.realpathSync(project("f-app"));
  const ROOT = D("profile", "orchestration");
  // the remote: a bare repository that logs the push options it gets
  const REMOTE = D("remote.git");
  execFileSync(GIT, ["init", "-q", "--bare", REMOTE]);
  execFileSync(GIT, ["-C", REMOTE, "config", "receive.advertisePushOptions", "true"]);
  const OPTS = D("push-options.log");
  fs.writeFileSync(path.join(REMOTE, "hooks", "pre-receive"), `#!/bin/sh\necho "count=\${GIT_PUSH_OPTION_COUNT:-0}" >> "${OPTS}"\ncat > /dev/null\n`, { mode: 0o755 });
  git(src, "remote", "add", "origin", REMOTE);
  git(src, "push", "-q", "origin", "main");
  const base = git(src, "rev-parse", "HEAD").trim();
  const SCRIPT = script("f", [PLAN, exec("a.txt"), REVIEW("a.txt"), FINAL, PLAN, exec("b.txt"), REVIEW("b.txt"), FINAL]);
  fs.mkdirSync(D("state"));
  const BIN = D("bin");
  fs.mkdirSync(BIN);
  const VERSION = { codex: "codex-cli 0.155.1", claude: "2.1.281 (Claude Code)" };
  for (const p of ["codex", "claude"]) {
    fs.writeFileSync(path.join(BIN, p), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "${VERSION[p]}"; exit 0; }\nMOCK_SCRIPT="${SCRIPT}" MOCK_CHECKS=none MOCK_STATE="${D("state")}" exec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  }
  fs.mkdirSync(D(".codex"));
  fs.writeFileSync(D(".codex", "config.toml"), "");
  // the login shell: every line it runs is logged (the older build's push and ls-remote are read from here)
  const LOG = D("shell.log");
  const SHELL = D("shell");
  fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nprintf '%s\\n' "$1" >> "${LOG}"\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  const lines = (re) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => re.test(l)) : []);
  const gitEnv = { PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: D(), GIT_CONFIG_GLOBAL: D("gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@localhost", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@localhost" };
  const providers = D("providers.json");
  const p = { path: `${BIN}:/usr/bin:/bin`, env: { HOME: D(), MOCK_STATE: D("state"), MOCK_SCRIPT: SCRIPT, MOCK_CHECKS: "none" } };
  fs.writeFileSync(providers, JSON.stringify({ codex: { executable: path.join(BIN, "codex"), version: VERSION.codex, ...p },
    claude: { executable: path.join(BIN, "claude"), version: VERSION.claude, ...p }, shell: SHELL, checkEnv: gitEnv }));
  const LAUNCH = { command: NODE, args: [path.resolve("src/orchestration/supervisor.mjs")], env: {} };
  const manager = () => createRunManager({ platform: "darwin", root: ROOT, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providers, () => LAUNCH), leadSandbox: false, journalV2: true });
  const remoteHead = (branch) => { try { return execFileSync(GIT, ["-C", REMOTE, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).trim(); } catch { return null; } };
  let app;
  try {
    // 2. this build: four tasks, two task runs to their push
    const m = manager();
    const profiles = createProfileStore(ROOT);
    const saveWith = async (branch) => profiles.save(src, { ...(await suggestProfile(src)), workMode: "worktree", checks: ["true"],
      finish: { commit: true, push: { remote: "origin", branch, remoteUrl: REMOTE }, qa: null } });
    const task = async (title) => (await m.boardCreate({ workspaceId: "common", project: src, title, text: title, criteria: ["есть"], dependsOn: [] })).value;
    const T = [await task("Внешняя"), await task("Задача A"), await task("Задача B"), await task("Архивная")];
    if (T.some((t) => !t)) throw new Error("a task refused");
    if (!(await m.boardPlace("common", { position: { x: 0, y: 0 }, size: { width: 1100, height: 640 } })).ok) throw new Error("board not placed");
    const runs = {};
    for (const [name, t, branch] of [["A", T[1], "f0-a"], ["B", T[2], "f0-b"]]) {
      await saveWith(branch);
      const runId = randomUUID();
      const r = await m.create({ requestId: runId, source: src, goal: { text: t.text, criteria: ["есть"], checks: [], commands: [], mode: "autopilot",
        task: { id: t.id, key: t.key }, finish: { commit: true, push: true, qa: false } } });
      if (!r.ok) throw new Error(`run ${name} refused: ${JSON.stringify(r)}`);
      const settle = () => until(async () => { const v = (await m.get(runId)).value.view; return ["completed", "failed", "stopped", "paused"].includes(v.status) ? v : null; }, 90_000);
      const asked = await settle();
      if (asked?.reason !== "awaiting_finish_confirmation") throw new Error(`run ${name} did not ask to push: ${JSON.stringify(asked)?.slice(0, 600)}`);
      runs[name] = { runId, branch, task: t };
      if (name === "B") continue; // B stays at the person's confirmation: no push intent yet
      await m.command(runId, { commandId: randomUUID(), expectedRevision: asked.revision, command: confirm(asked) });
      const end = await settle();
      if (end?.status !== "completed" || !remoteHead(branch)) throw new Error(`run ${name} did not push: ${JSON.stringify(end)?.slice(0, 600)}`);
    }
    await m.shutdown();
    // what F writes into the tasks
    const BOARD = path.join(ROOT, "board.json");
    const b = JSON.parse(fs.readFileSync(BOARD, "utf8"));
    const origin = { kind: "import", source: "plan.md@0123abc", file: "tasks.json", sha256: "a".repeat(64) };
    const at = new Date().toISOString();
    const fields = [
      { ref: "T1-MR", external: true, externalDone: { at, by: "person", note: "MR влит" }, criteria: ["Отметка человека «Выполнено»"] },
      { ref: "T1", models: { executor: "sonnet", reviewer: "gpt-5" }, issue: "ISSUE-1", commitTitle: "feat: задача A", scope: ["src/a/**"] },
      { ref: "T2", issue: "ISSUE-2", commitTitle: "feat: задача B", scope: ["src/b/**", "tests/b/**"] },
      { ref: "T3", models: { lead: "opus" }, issue: "ISSUE-3", commitTitle: "chore: архивная" }
    ];
    T.forEach((t, i) => { Object.assign(b.tasks.find((x) => x.id === t.id), { origin }, fields[i]); });
    fs.writeFileSync(BOARD, JSON.stringify(b, null, 2));
    // what F writes into the profile
    const PROFILE = path.join(ROOT, "profiles", `${createHash("sha256").update(src).digest("hex")}.json`);
    const pf = JSON.parse(fs.readFileSync(PROFILE, "utf8"));
    Object.assign(pf.profile, { branchTemplate: "{issue}-{ref}", runBase: { remote: "origin", branch: "main", remoteUrl: REMOTE },
      runPush: { enabled: true, remote: "origin", remoteUrl: REMOTE, options: ["merge_request.create", "merge_request.target={base}"], protected: ["release"], confirmedAt: at },
      reviewExport: true, runMcp: false });
    fs.writeFileSync(PROFILE, JSON.stringify(pf));
    // what F writes into the goals; A cut after the push's intent (the remote branch gone: «push not done»), B before it
    const J = {};
    for (const [name, r] of Object.entries(runs)) {
      const { J: file, recs } = withGoal(ROOT, r.runId, (g) => ({ ...g, task: { ...g.task, ref: b.tasks.find((t) => t.id === r.task.id).ref },
        branch: r.branch, export: true, base: { branch: "origin/main", commit: base, key: "remote" },
        finish: { ...g.finish, push: { ...g.finish.push, options: ["merge_request.create"], protected: ["main", "master", "release"] } } }));
      J[name] = file;
      if (name === "B") {
        const c = recs.filter((x) => x.type === "finish.result" && x.data.commit).at(-1).data;
        r.committed = { tree: c.tree, commit: c.commit };
        continue;
      }
      const pushIntent = recs.findIndex((x) => x.type === "finish.intent" && x.data.step === "push");
      if (pushIntent < 0) throw new Error(`run ${name}: no push intent`);
      cut(file, recs, pushIntent + 1);
      execFileSync(GIT, ["-C", REMOTE, "update-ref", "-d", `refs/heads/${r.branch}`]);
    }
    // the hook counts options: a control push with one
    git(src, "push", "-q", "-o", "control", "origin", "HEAD:refs/heads/f0-control");
    if (!fs.readFileSync(OPTS, "utf8").includes("count=1")) throw new Error("the pre-receive hook does not see push options");
    execFileSync(GIT, ["-C", REMOTE, "update-ref", "-d", "refs/heads/f0-control"]);
    fs.rmSync(OPTS, { force: true });
    fs.rmSync(LOG, { force: true }); // from here: only the older build's lines
    // this build reads the fixtures
    const m1 = manager();
    for (const [name, r] of Object.entries(runs)) {
      const g = (await m1.get(r.runId)).value;
      if (g?.integrity !== "ok") throw new Error(`run ${name}: this build does not read the fixture: ${JSON.stringify(g)?.slice(0, 400)}`);
    }
    await m1.shutdown();
    const before = { fields: fieldsOf(b.tasks), profile: sha(PROFILE), turns: turns(J.A) + turns(J.B) };

    // 3. the older build
    app = await launch({ userData: D("profile"), port: 9700 + Math.floor(Math.random() * 100), shots: D("shots"), executable: path.join(APP, "Contents/MacOS/Raoden Loom"), hermetic: false,
      env: { HOME: D(), SHELL, PATH: `${BIN}:${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(GIT)}`, CODEX_HOME: D(".codex"),
        GIT_CONFIG_GLOBAL: D("gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } });
    await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", "window", 60_000);
    const O = "window.canvasTTY.orchestration";
    out.view = JSON.parse(await app.ev(`${O}.board().then((r) => JSON.stringify({ ok: r.ok, readOnly: r.value?.readOnly ?? null, n: r.value?.board?.tasks?.length }))`));
    out.checks.boardReads = out.view.ok && out.view.readOnly === null && out.view.n === 4;
    // the profile through a link of two agents on the project
    const agent = (provider, x) => app.ev(`(async () => { const agentId = crypto.randomUUID(); const r = await ${O}.createAgent({ agentId, provider: "${provider}", project: ${JSON.stringify(src)},
      bounds: { position: { x: ${x}, y: 0 }, size: { width: 300, height: 200 } }, workspaceId: "common" }); return r.ok ? agentId : "refused " + JSON.stringify(r); })()`);
    const lead = await agent("codex", 1200), executor = await agent("claude", 1600);
    const linkId = randomUUID();
    out.link = await app.ev(`${O}.createLink(${JSON.stringify({ linkId, fromAgentId: lead, toAgentId: executor })}).then((r) => r.ok ? "ok" : JSON.stringify(r))`);
    out.profile = await app.ev(`${O}.profile(${JSON.stringify(linkId)}).then((r) => r.ok ? { profile: r.value.profile !== null, suggested: r.value.suggested ?? null } : JSON.stringify(r))`);
    out.checks.profileReads = out.link === "ok" && out.profile?.profile === true;
    // the runs: both listed, read by the older build
    const listed = await app.ev(`${O}.list().then((r) => r.value.map((s) => [s.view.runId, s.view.status, s.view.reason]))`);
    out.listed = listed;
    const row = (name) => listed.find((x) => x[0] === runs[name].runId);
    out.checks.journalsRead = ["A", "B"].every((n) => row(n) && !["newer_version", "damaged"].includes(row(n)[2]));
    const get = (name) => app.ev(`${O}.get(${JSON.stringify(runs[name].runId)}).then((r) => r.ok ? r.value.view : null)`);
    const resume = (name) => app.ev(`${O}.get(${JSON.stringify(runs[name].runId)}).then((r) => ${O}.command({ runId: ${JSON.stringify(runs[name].runId)},
      commandId: crypto.randomUUID(), expectedRevision: r.value.view.revision, command: { kind: "resume" } })).then((r) => JSON.stringify(r).slice(0, 300))`);
    const settled = (name, ms = 120_000) => until(async () => { const v = await get(name); return v && !["running", "preparing"].includes(v.status) && !v.permission
      && !(v.progress?.finish ?? []).some((f) => f.status === "establishing" || f.status === "started") ? v : null; }, ms);
    // A: the intent without a result — after the resume only ls-remote, never a push
    out.A = { opened: (await get("A"))?.status + "/" + (await get("A"))?.reason, resume: await resume("A") };
    await until(() => lines(/git ls-remote .*refs\/heads\/f0-a/).length > 0, 60_000);
    const a = await settled("A");
    out.A.end = a && { status: a.status, reason: a.reason, push: a.progress?.finish?.find((f) => f.step === "push") ?? null };
    out.A.lsRemote = lines(/git ls-remote .*refs\/heads\/f0-a/).length;
    out.A.push = lines(/git push .*f0-a/).length;
    out.checks.intentNotPushed = out.A.opened === "paused/recovered" && out.A.end?.reason === "finish_unconfirmed"
      && out.A.end?.push?.status === "not_done" && out.A.end?.push?.established === true && out.A.lsRemote >= 1 && out.A.push === 0 && remoteHead("f0-a") === null;
    // B: paused before the push — the older build continues it and pushes, without the options
    // a listed (not open) run's view has no confirmation: the tree and commit the person confirms are the commit step's
    const vb = await get("B");
    out.B = { opened: `${vb?.status}/${vb?.reason}` };
    out.B.confirm = await app.ev(`${O}.command({ runId: ${JSON.stringify(runs.B.runId)}, commandId: crypto.randomUUID(),
      expectedRevision: ${vb?.revision ?? -1}, command: ${JSON.stringify(confirm({ confirm: runs.B.committed }))} }).then((r) => JSON.stringify(r).slice(0, 300))`);
    const bb = await until(async () => { const v = await get("B"); return v && (["completed", "failed", "stopped"].includes(v.status) || (v.status === "paused" && v.reason !== "awaiting_finish_confirmation")) ? v : null; }, 120_000);
    out.B.end = bb && { status: bb.status, reason: bb.reason };
    out.B.pushed = remoteHead("f0-b");
    out.B.options = fs.existsSync(OPTS) ? fs.readFileSync(OPTS, "utf8").trim() : null;
    out.checks.pausedContinued = out.B.opened === "paused/awaiting_finish_confirmation" && bb?.status === "completed" && !!out.B.pushed;
    out.losses.pushWithoutOptions = out.checks.pausedContinued && out.B.options === "count=0";
    // the profile is not rewritten by reading it and running; then saved by the older build
    out.checks.profileUntouched = sha(PROFILE) === before.profile;
    out.saved = await app.ev(`${O}.profile(${JSON.stringify(linkId)}).then((r) => ${O}.saveProfile(${JSON.stringify(linkId)}, r.value.profile)).then((r) => r.ok ? "ok" : JSON.stringify(r))`);
    // the older build edits a task and archives another
    out.rename = await app.ev(`${O}.boardUpdate(${JSON.stringify(T[0].id)}, { title: "Внешняя (правка)" }).then((r) => r.ok ? "ok" : r.code)`);
    out.archive = await app.ev(`${O}.boardArchive(${JSON.stringify(T[3].id)}, true).then((r) => r.ok ? "ok" : r.code)`);
    out.checks.editsAccepted = out.rename === "ok" && out.archive === "ok";
    out.exit = await app.quit();
    app = null;

    // 4. what must stay, what is lost, this build reads it back
    const after = JSON.parse(fs.readFileSync(BOARD, "utf8"));
    out.checks.fieldsKept = fieldsOf(after.tasks) === before.fields;
    out.checks.editsWritten = after.tasks.find((t) => t.id === T[0].id)?.title === "Внешняя (правка)" && !!after.tasks.find((t) => t.id === T[3].id)?.archivedAt;
    const back = await createBoardStore(BOARD).read();
    out.checks.boardReadBack = back.readOnly === null && fieldsOf(back.board.tasks) === before.fields;
    const saved = JSON.parse(fs.readFileSync(PROFILE, "utf8")).profile;
    out.losses.profileKeysDropped = out.saved === "ok" && F_PROFILE.every((k) => !(k in saved));
    out.checks.profileReadBack = out.saved === "ok" && (await createProfileStore(ROOT).get(src)) !== null;
    const m2 = manager();
    out.readBack = {};
    for (const [name, r] of Object.entries(runs)) out.readBack[name] = (await m2.get(r.runId)).value?.integrity ?? null;
    await m2.shutdown();
    out.checks.noNewTurns = before.turns > 0 && turns(J.A) + turns(J.B) === before.turns; // no model call by the older build
    out.checks.journalsReadBack = Object.values(out.readBack).every((x) => x === "ok");
    // the known losses are expected outcomes too: one that did not happen means §9's table is wrong
    out.ok = Object.values(out.checks).every(Boolean) && out.losses.pushWithoutOptions === true && out.losses.profileKeysDropped === true;
  } catch (error) {
    out.ok = false;
    out.error = String(error?.stack ?? error).slice(0, 2000);
  } finally {
    if (app) out.exit = await app.quit?.();
  }
  return out;
}

const results = [];
for (const app of APPS) results.push(await check(app));
console.log(JSON.stringify(results, null, 1));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
process.exitCode = results.length && results.every((r) => r.ok) ? 0 : 1;
