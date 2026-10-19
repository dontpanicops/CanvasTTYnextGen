// C3, step 1 (stage-c3-conflicts.md §7.3, §10): before any code, do the released builds read the journals C3 will write?
// This build makes three merge runs that paused on a git conflict, one per project, and appends by hand what C3 will
// write after them: merge.agent and run.status «running» (P1), a pause merge_waits_slot (P2), a pause
// merge_agent_failed (P3); and a resolution run's journal v3 (kind «resolution», a plan by the application).
// A packaged older build opens the profile. Expected:
// - 1.5.17+: the board shows the three merges; P1 (running, no process) becomes paused(recovered); P2, P3 as written;
//   the resolution run is listed read only (a newer version's) and cannot be stopped; «Готово, проверить» on P3 after
//   the person fixed the copy merges it (the head moves);
// - 1.5.16: every journal listed read only.
// After: board.json, the resolution run's journal, P2's journal and every head but P3's are unchanged; this build reads
// the merges back. Fake shell, temporary profiles; no model call.
// Usage, from the repository root: node scripts/c3-rollback-fixtures.mjs "<path>/Raoden Loom.app" […] [--out file.json]
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NODE, launch, workspace } from "./orchestration-app-kit.mjs";
import { createBoardMerge } from "../src/main/services/orchestration/boardMerge.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { createProfileStore, suggestProfile } from "../src/main/services/orchestration/profile.ts";
import { buildRecord, canonical, sha256Hex } from "../src/main/services/orchestration/journal.ts";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const APPS = args.filter((a, i) => a !== "--out" && args[i - 1] !== "--out").map((a) => path.resolve(a));
const GIT = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };

// a record appended the way boardMerge.append does (journal v3, the chain of the file)
function append(file, runId, type, data, head = null) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  const last = lines.length ? JSON.parse(lines.at(-1)) : null;
  const { line } = buildRecord(last ? { seq: last.seq, hash: last.hash } : null, runId, new Date().toISOString(), type, data, 3, head);
  fs.appendFileSync(file, line);
}
function putText(dir, text) {
  const buf = Buffer.from(text, "utf8");
  const ref = { sha256: sha256Hex(buf), bytes: buf.length };
  fs.mkdirSync(path.join(dir, "texts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "texts", ref.sha256), buf);
  return ref;
}

async function check(APP) {
  const version = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(APP, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  const out = { app: APP, version, checks: {} };
  const { D, project } = workspace("c3rb.");
  const ROOT = D("profile", "orchestration");
  fs.mkdirSync(ROOT, { recursive: true });
  const SHELL = D("shell");
  fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: D(), GIT_CONFIG_GLOBAL: D("gitconfig"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const merges = createBoardMerge({ root: ROOT, gitPath: () => GIT, launch: () => ({ command: NODE, args: [path.resolve("src/orchestration/supervisor.mjs")], env: {} }),
    own: async () => {}, checks: async () => ["true"], shell: async () => ({ shell: SHELL, env: { PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: D() } }),
    quiet: async () => true, retryWaitMs: 100, retryPollMs: 50 });
  // the CLIs the older build resolves before checks: they only answer --version
  const BIN = D("bin");
  fs.mkdirSync(BIN);
  for (const [cli, v] of [["codex", "codex-cli 0.155.1"], ["claude", "2.1.281 (Claude Code)"]]) fs.writeFileSync(path.join(BIN, cli), `#!/bin/sh\necho "${v}"\n`, { mode: 0o755 });
  const providers = D("providers.json");
  fs.writeFileSync(providers, JSON.stringify({ codex: { executable: "/usr/bin/false", version: "codex-cli 0.155.1", path: "/usr/bin:/bin", env: { HOME: D() } },
    claude: { executable: "/usr/bin/false", version: "2.1.281 (Claude Code)", path: "/usr/bin:/bin", env: { HOME: D() } }, shell: SHELL, checkEnv: { PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: D() } }));
  const LAUNCH = { command: NODE, args: [path.resolve("src/orchestration/supervisor.mjs")], env: {} };
  let app;
  try {
    const m = createRunManager({ platform: "darwin", root: ROOT, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
      agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(providers, () => LAUNCH), leadSandbox: false, journalV2: true });
    // 1. three projects, each with a merge that paused on a conflict: T-1 is in the head, T-2 changed the same line
    const places = [];
    for (const name of ["p1", "p2", "p3"]) {
      const src = fs.realpathSync(project(`c3-${name}`));
      await createProfileStore(ROOT).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["true"] });
      if (!(await m.boardCreate({ workspaceId: "common", project: src, title: name, text: name, criteria: ["есть"], dependsOn: [] })).ok) throw new Error(`${name}: task refused`);
      const head = await merges.ensureHead("common", src);
      const tc = D(`tc-${name}`);
      const g = (...a) => execFileSync(GIT, a, { cwd: tc, encoding: "utf8", env }).trim();
      fs.mkdirSync(tc);
      g("init", "-q"); g("fetch", "-q", src, head.ref); g("checkout", "-q", "--detach", "FETCH_HEAD");
      const commitOf = (text) => { g("checkout", "-q", "--detach", head.commit); fs.writeFileSync(path.join(tc, "auth.txt"), text); g("add", "-A"); g("commit", "-q", "-m", text.trim());
        const c = g("rev-parse", "HEAD"); g("push", "-q", src, `HEAD:refs/heads/raoden/${name}-${c.slice(0, 8)}`); return c; };
      const one = commitOf("one\n"), two = commitOf("two\n");
      const m1 = await merges.merge({ workspaceId: "common", project: src, task: { id: randomUUID(), key: "T-1" }, taskRunId: randomUUID(), commit: one, language: "ru" });
      if (!await until(async () => (await merges.mergesInto(head.ref, src)).find((x) => x.runId === m1.runId && x.status === "completed"), 60_000)) throw new Error(`${name}: T-1 not merged`);
      const m2 = await merges.merge({ workspaceId: "common", project: src, task: { id: randomUUID(), key: "T-2" }, taskRunId: randomUUID(), commit: two, language: "ru" });
      const paused = await until(async () => (await merges.mergesInto(head.ref, src)).find((x) => x.runId === m2.runId && x.status === "paused"), 60_000);
      if (paused?.reason !== "merge_conflict") throw new Error(`${name}: no conflict pause (${paused?.reason})`);
      places.push({ name, src, ref: head.ref, runId: m2.runId, journal: path.join(ROOT, "runs", m2.runId, "journal.jsonl") });
    }
    // 2. what C3 writes after the conflict
    const resolution = randomUUID();
    const [P1, P2, P3] = places;
    const base = execFileSync(GIT, ["-C", P1.src, "rev-parse", P1.ref], { encoding: "utf8" }).trim();
    append(P1.journal, P1.runId, "merge.agent", { attempt: 1, reason: "conflict", resolutionRunId: resolution, base });
    append(P1.journal, P1.runId, "run.status", { status: "running", reason: null });
    append(P2.journal, P2.runId, "run.status", { status: "paused", reason: "merge_waits_slot" });
    append(P3.journal, P3.runId, "merge.agent", { attempt: 1, reason: "conflict", resolutionRunId: randomUUID(), base });
    append(P3.journal, P3.runId, "run.status", { status: "paused", reason: "merge_agent_failed", detail: "limit:turns" });
    // the resolution run: journal v3, kind «resolution», the application's plan (no turnId)
    const RD = path.join(ROOT, "runs", resolution);
    fs.mkdirSync(RD, { recursive: true });
    const goal = putText(RD, canonical({ v: 3, kind: "resolution", text: "Разрешите конфликт слияния в auth.txt", criteria: ["есть"], commands: ["true"], createdAt: Date.now(),
      resolution: { mergeRunId: P1.runId, taskId: randomUUID(), key: "T-2" } }));
    const RJ = path.join(RD, "journal.jsonl");
    append(RJ, resolution, "run.created", { goal, kind: "resolution" }, { minReaderVersion: 3 });
    append(RJ, resolution, "plan.recorded", { by: "app", version: 1, plan: putText(RD, "{}"), firstStage: 1, stageCount: 1, conditionsAssigned: 1 });
    append(RJ, resolution, "run.status", { status: "running", reason: null });
    // the person fixed P3's copy (for «Готово, проверить» in the older build)
    const copy3 = await merges.copyOf(P3.runId);
    fs.writeFileSync(path.join(copy3, "auth.txt"), "one and two\n");
    await m.shutdown();
    const BOARD = path.join(ROOT, "board.json");
    const refOf = (p) => execFileSync(GIT, ["-C", p.src, "rev-parse", p.ref], { encoding: "utf8" }).trim();
    const before = { board: sha(BOARD), rj: sha(RJ), p2: sha(P2.journal), p1: sha(P1.journal), heads: places.map(refOf) };
    const older = version === "1.5.16";
    // 3. the older build
    app = await launch({ userData: D("profile"), port: 9700 + Math.floor(Math.random() * 100), shots: D("shots"), executable: path.join(APP, "Contents/MacOS/Raoden Loom"), hermetic: false,
      env: { HOME: D(), SHELL: "/bin/bash", PATH: `${BIN}:${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(GIT)}` } });
    await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", "window", 60_000);
    const listed = await app.ev("window.canvasTTY.orchestration.list().then((r) => r.value.map((s) => [s.view.runId, s.view.status, s.view.reason]))");
    out.listed = listed;
    const res = listed.find((x) => x[0] === resolution);
    out.checks.resolutionReadOnly = res?.[2] === "newer_version";
    out.resolutionStop = await app.ev(`window.canvasTTY.orchestration.command({ runId: ${JSON.stringify(resolution)}, commandId: crypto.randomUUID(), expectedRevision: 0, command: { kind: "stop" } }).then((r) => r.ok ? "ok" : r.code)`);
    out.checks.resolutionStopRefused = out.resolutionStop === "run_newer_version";
    if (older) {
      out.checks.mergesReadOnly = places.every((p) => listed.find((x) => x[0] === p.runId)?.[2] === "newer_version");
    } else {
      const heads = await app.ev("window.canvasTTY.orchestration.board().then((r) => JSON.stringify((r.value.heads ?? []).map((h) => [h.project, h.merges])))");
      const mergeOf = (i, runId) => (JSON.parse(heads).find((h) => h[0] === places[i].src)?.[1] ?? []).find((x) => x.runId === runId) ?? null;
      const mm = places.map((p, i) => mergeOf(i, p.runId));
      out.merges = mm.map((x) => x && [x.status, x.reason, x.detail]);
      out.checks.p1Recovered = mm[0]?.status === "paused" && mm[0]?.reason === "recovered";
      out.checks.p2AsWritten = mm[1]?.status === "paused" && mm[1]?.reason === "merge_waits_slot";
      out.checks.p3AsWritten = mm[2]?.status === "paused" && mm[2]?.reason === "merge_agent_failed" && mm[2]?.detail === "limit:turns";
      out.p3resolve = await app.ev(`window.canvasTTY.orchestration.boardMergeResolve(${JSON.stringify(P3.runId)}, true).then((r) => JSON.stringify(r).slice(0, 300))`);
      out.checks.p3Merged = !!await until(async () => refOf(P3) !== before.heads[2], 60_000);
    }
    out.exit = await app.quit();
    app = null;
    // 4. what must not change, and this build reads it back
    out.checks.boardUnchanged = sha(BOARD) === before.board;
    out.checks.resolutionJournalUnchanged = sha(RJ) === before.rj;
    out.checks.p2JournalUnchanged = sha(P2.journal) === before.p2;
    out.checks.headsUnchanged = refOf(P1) === before.heads[0] && refOf(P2) === before.heads[1] && (older ? refOf(P3) === before.heads[2] : true);
    if (older) out.checks.p1JournalUnchanged = sha(P1.journal) === before.p1;
    const back = createBoardMerge({ root: ROOT, gitPath: () => GIT, launch: () => ({ command: NODE, args: [], env: {} }), own: async () => {}, checks: async () => ["true"],
      shell: async () => ({ shell: SHELL, env: {} }), quiet: async () => true });
    const read = await Promise.all(places.map(async (p) => (await back.mergesInto(p.ref, p.src)).find((x) => x.runId === p.runId)));
    out.back = read.map((x) => x && [x.status, x.reason, x.detail]);
    out.checks.readBack = read.every(Boolean);
    out.ok = Object.values(out.checks).every(Boolean);
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
