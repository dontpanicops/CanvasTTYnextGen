// E0 (stage-e-decomposition.md §9, §12): before any code, do the released builds keep and read what stage E will write?
// This build makes a board and appends by hand what E will write: T-1 marked «split» without subtasks; T-2 split by a
// run (decomposedBy) into T-3, T-4 (depends on T-3), T-5 (archived), each with parentId, covers and the note in its text;
// T-2 depends on all three. And two split runs' journals v3 (kind «decomposition»): proposed, rejected.
// A packaged older build opens the profile. Expected (1.5.16–1.5.20):
// - the board reads (not damaged, not newer_version), the tasks as ordinary ones: T-1 and T-3 in the queue without a
//   reason, T-4 and T-2 waiting for their dependencies;
// - both split runs listed read only (a newer version's), their stop refused;
// - a rename of T-4 and the archive of T-3 by the older build keep every new field (the fields' hash before and after);
// - after: the split journals unchanged, this build reads the board back with the new fields.
// Fake shell, temporary profiles; no model call.
// Usage, from the repository root: node scripts/e-rollback-fixtures.mjs "<path>/Raoden Loom.app" […] [--out file.json]
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NODE, launch, workspace } from "./orchestration-app-kit.mjs";
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
const E_FIELDS = ["decompose", "decomposedBy", "parentId", "covers"];
const fieldsOf = (tasks) => canonical(tasks.map((t) => [t.key, ...E_FIELDS.map((k) => t[k] ?? null)]));

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
// a split run's journal as E1 will write it (§3.2)
function splitJournal(ROOT, parent, base, outcome) {
  const runId = randomUUID();
  const RD = path.join(ROOT, "runs", runId);
  fs.mkdirSync(RD, { recursive: true });
  const goal = putText(RD, canonical({ v: 3, kind: "decomposition", text: parent.text, criteria: parent.criteria, commands: [], createdAt: Date.now(),
    decomposition: { taskId: parent.id, key: parent.key, base } }));
  const RJ = path.join(RD, "journal.jsonl");
  append(RJ, runId, "run.created", { goal, kind: "decomposition" }, { minReaderVersion: 3 });
  append(RJ, runId, "run.status", { status: "running", reason: null });
  const turnId = randomUUID();
  if (outcome === "proposed") append(RJ, runId, "decomposition.proposed", { turnId, proposal: putText(RD, canonical({ tasks: [{ id: "S1" }, { id: "S2" }, { id: "S3" }] })) });
  else for (let i = 0; i < 2; i++) append(RJ, runId, "decomposition.rejected", { turnId: randomUUID(), reasons: putText(RD, `R2 is not covered (${i + 1})`) });
  append(RJ, runId, "run.status", { status: "completed", reason: null, completion: { kind: outcome } });
  return { runId, journal: RJ };
}

async function check(APP) {
  const version = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(APP, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  const out = { app: APP, version, checks: {} };
  const { D, project } = workspace("erb.");
  const ROOT = D("profile", "orchestration");
  fs.mkdirSync(ROOT, { recursive: true });
  const SHELL = D("shell");
  fs.writeFileSync(SHELL, `#!/bin/sh\ncase "$1" in -ilc|-c) shift ;; esac\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
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
    // 1. five ordinary tasks of one project, then what E writes into them
    const src = fs.realpathSync(project("e-app"));
    await createProfileStore(ROOT).save(src, { ...(await suggestProfile(src)), workMode: "copy", checks: ["true"] });
    const titles = ["Большая A", "Большая B", "Часть 1", "Часть 2", "Часть 3"];
    for (const title of titles) {
      const r = await m.boardCreate({ workspaceId: "common", project: src, title, text: `${title}: сделать`, criteria: ["первое", "второе"], dependsOn: [] });
      if (!r.ok) throw new Error(`task refused: ${JSON.stringify(r)}`);
    }
    if (!(await m.boardPlace("common", { position: { x: 0, y: 0 }, size: { width: 1100, height: 640 } })).ok) throw new Error("board not placed");
    await m.shutdown();
    const BOARD = path.join(ROOT, "board.json");
    const b = JSON.parse(fs.readFileSync(BOARD, "utf8"));
    const [T1, T2, T3, T4, T5] = b.tasks;
    const base = execFileSync(GIT, ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const proposed = splitJournal(ROOT, T2, base, "proposed");
    const rejected = splitJournal(ROOT, T1, base, "rejected");
    const note = (t, ids) => `${t.text}\n\nЧасть задачи ${T2.key} «${T2.title}». Закрывает её требования:\n${ids.map((r) => `${r} — ${T2.criteria[Number(r.slice(1)) - 1]}`).join("\n")}`;
    Object.assign(T1, { decompose: true });
    Object.assign(T2, { decompose: true, decomposedBy: proposed.runId, dependsOn: [T3.id, T4.id, T5.id] });
    Object.assign(T3, { parentId: T2.id, covers: ["R1"], text: note(T3, ["R1"]) });
    Object.assign(T4, { parentId: T2.id, covers: ["R2"], text: note(T4, ["R2"]), dependsOn: [T3.id] });
    Object.assign(T5, { parentId: T2.id, covers: ["R1", "R2"], text: note(T5, ["R1", "R2"]), archivedAt: new Date().toISOString() });
    fs.writeFileSync(BOARD, JSON.stringify(b, null, 2));
    const before = { fields: fieldsOf(b.tasks), proposed: sha(proposed.journal), rejected: sha(rejected.journal) };
    // 2. the older build
    app = await launch({ userData: D("profile"), port: 9700 + Math.floor(Math.random() * 100), shots: D("shots"), executable: path.join(APP, "Contents/MacOS/Raoden Loom"), hermetic: false,
      env: { HOME: D(), SHELL: "/bin/bash", PATH: `${BIN}:${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(GIT)}` } });
    await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", "window", 60_000);
    const view = await app.ev("window.canvasTTY.orchestration.board().then((r) => JSON.stringify({ ok: r.ok, readOnly: r.value?.readOnly ?? null, n: r.value?.board?.tasks?.length }))");
    out.view = JSON.parse(view);
    out.checks.boardReads = out.view.ok && out.view.readOnly === null && out.view.n === 5;
    const cards = await until(() => app.ev(`(() => { const c = [...document.querySelectorAll("[data-board-task]")].map((e) => [e.dataset.boardTask, e.dataset.boardTaskColumn, e.dataset.boardReason ?? null]); return c.length >= 4 ? JSON.stringify(c) : null; })()`), 30_000);
    out.cards = cards && JSON.parse(cards);
    const card = (k) => out.cards?.find((c) => c[0] === k);
    out.checks.parentUnsplitQueued = card(T1.key)?.[1] === "queue" && card(T1.key)?.[2] === null;
    out.checks.firstSubtaskQueued = card(T3.key)?.[1] === "queue" && card(T3.key)?.[2] === null;
    out.checks.subtaskWaits = card(T4.key)?.[2] === "waits_task";
    out.checks.parentWaits = card(T2.key)?.[2] === "waits_task";
    const listed = await app.ev("window.canvasTTY.orchestration.list().then((r) => r.value.map((s) => [s.view.runId, s.view.status, s.view.reason]))");
    out.listed = listed;
    out.checks.splitsReadOnly = [proposed, rejected].every((s) => listed.find((x) => x[0] === s.runId)?.[2] === "newer_version");
    out.stop = await app.ev(`window.canvasTTY.orchestration.command({ runId: ${JSON.stringify(proposed.runId)}, commandId: crypto.randomUUID(), expectedRevision: 0, command: { kind: "stop" } }).then((r) => r.ok ? "ok" : r.code)`);
    out.checks.splitStopRefused = out.stop === "run_newer_version";
    // the older build edits a subtask and archives another
    out.rename = await app.ev(`window.canvasTTY.orchestration.boardUpdate(${JSON.stringify(T4.id)}, { title: "Часть 2 (правка)" }).then((r) => r.ok ? "ok" : r.code)`);
    out.archive = await app.ev(`window.canvasTTY.orchestration.boardArchive(${JSON.stringify(T3.id)}, true).then((r) => r.ok ? "ok" : r.code)`);
    out.checks.editsAccepted = out.rename === "ok" && out.archive === "ok";
    out.exit = await app.quit();
    app = null;
    // 3. what must not change, and this build reads it back
    const after = JSON.parse(fs.readFileSync(BOARD, "utf8"));
    out.checks.fieldsKept = fieldsOf(after.tasks) === before.fields;
    out.checks.editsWritten = after.tasks.find((t) => t.id === T4.id)?.title === "Часть 2 (правка)" && !!after.tasks.find((t) => t.id === T3.id)?.archivedAt;
    out.checks.splitJournalsUnchanged = sha(proposed.journal) === before.proposed && sha(rejected.journal) === before.rejected;
    const back = await createBoardStore(BOARD).read();
    out.checks.readBack = back.readOnly === null && fieldsOf(back.board.tasks) === before.fields;
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
