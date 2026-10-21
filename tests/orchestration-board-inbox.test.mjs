// F1, T-2 (docs/agent-orchestration/implementation/stage-f-external-projects.md §5.4–§5.6): the new inputs — the
// platform gate newInputsAvailable (macOS arm64 only), «Import tasks» (main's dialog and read, never a path from the
// window), the smoke's dialog hook, and inbox/ with its life cycle on temporary folders: a file only checked, tasks
// written only by «Import», «Reject», invalid_file / refused to done/ at once, symlinks, *.tmp and folders, the reports,
// a taken name in done/, a restart, file_changed and the board moved on. No CLI, no model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { IPC } from "../src/shared/contracts.ts";
import { newInputsAvailable, orchestrationAvailable } from "../src/shared/orchestration.ts";
import { assertMainRenderer } from "../src/main/ipc/mainRenderer.ts";
import { importFilePicker, registerOrchestrationIpc } from "../src/main/ipc/orchestrationIpc.ts";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager } from "../src/main/services/orchestration/manager.ts";
import { fileRefusal, importReport, sha256 } from "../src/main/services/orchestration/boardImport.ts";
import { createInbox } from "../src/main/services/orchestration/boardInbox.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raoden-f1-inbox-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const P = path.join(TMP, "project");
fs.mkdirSync(P);
execFileSync(GIT, ["init", "-q", P], { env: { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_NOSYSTEM: "1" } });
const WS = "ws-acme";
const row = (ref, over = {}) => ({ ref, project: P, title: `Задача ${ref}`, text: `Сделать ${ref}`, criteria: [`${ref} готово`], ...over });
const tasksFile = (tasks, over = {}) => JSON.stringify({ format: "board-tasks/v1", workspace: "acme", tasks, ...over });

function manager(root, { platform = "darwin", arch = "arm64", open = [WS] } = {}) {
  return createRunManager({ platform, arch, root, gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000, agents: async () => null,
    workspaceOpen: (id) => open.includes(id), workspaceKnown: (id) => id === WS, workspaceNamed: (title) => (title === "acme" && open.includes(WS) ? [WS] : []) });
}
// a manager with a started inbox/ and its folders
async function started(over = {}) {
  const root = path.join(TMP, `root-${++n}`);
  const m = manager(root, over);
  const events = [];
  m.onBoardChange((e) => events.push(e));
  assert.deepEqual(await m.inboxStart(), { ok: true, value: null });
  const inbox = path.join(root, "inbox");
  const put = (name, text) => { fs.writeFileSync(path.join(inbox, `${name}.tmp`), text); fs.renameSync(path.join(inbox, `${name}.tmp`), path.join(inbox, name)); };
  const view = async () => (await m.board()).value;
  const ls = (...p) => fs.readdirSync(path.join(inbox, ...p)).sort();
  const json = (...p) => JSON.parse(fs.readFileSync(path.join(inbox, ...p), "utf8"));
  return { m, root, inbox, put, view, ls, json, events };
}
const rowOf = async (f, file) => (await f.view()).inbox?.find((r) => r.file === file);

test("newInputsAvailable: macOS on Apple silicon only; orchestrationAvailable is as it was", () => {
  assert.equal(newInputsAvailable("darwin", "arm64"), true);
  assert.equal(newInputsAvailable("darwin", "x64"), false);
  assert.equal(newInputsAvailable("linux", "arm64"), false);
  assert.equal(newInputsAvailable("win32", "x64"), false);
  assert.equal(orchestrationAvailable("darwin"), true, "stages A–E: any macOS");
});

for (const [platform, arch] of [["linux", "arm64"], ["darwin", "x64"]]) {
  test(`${platform}/${arch}: the button, inbox/ and its decisions are refused unsupported_platform; no inbox/ folder`, async () => {
    const root = path.join(TMP, `root-${++n}`);
    const m = manager(root, { platform, arch });
    let picked = 0;
    assert.equal((await m.inboxStart()).code, "unsupported_platform");
    assert.equal((await m.boardImportFile(async () => { picked++; return "/x.json"; })).code, "unsupported_platform");
    assert.equal(picked, 0, "no dialog");
    assert.equal((await m.boardInboxImport("a.json", "0".repeat(64))).code, "unsupported_platform");
    assert.equal((await m.boardInboxReject("a.json")).code, "unsupported_platform");
    assert.equal(fs.existsSync(path.join(root, "inbox")), false);
    await m.shutdown();
  });
}

test("a file in inbox/: checked, its report in reports/, a row and an event, the board untouched; «Import» writes it; both to done/", async () => {
  const f = await started();
  assert.deepEqual(f.ls(), [".work", "done", "reports"]);
  for (const d of ["", "reports", "done", ".work"]) assert.equal(fs.statSync(path.join(f.inbox, d)).mode & 0o777, 0o700);
  const text = tasksFile([row("T1"), row("T2", { dependsOn: ["T1"] })]);
  f.put("plan.json", text);
  await f.m.inboxScan();
  const r = await rowOf(f, "plan.json");
  assert.equal(r.report.status, "checked");
  assert.equal(r.sha256, sha256(Buffer.from(text)));
  assert.equal(r.workspaceId, WS);
  assert.deepEqual(r.tasks.map((x) => [x.ref, x.title, x.project, x.dependsOn]), [["T1", "Задача T1", P, []], ["T2", "Задача T2", P, ["T1"]]]);
  assert.deepEqual(f.json("reports", "plan.report.json").status, "checked");
  assert.deepEqual((await f.view()).board.tasks, [], "only checked");
  assert.deepEqual(f.events, [{ kind: "inbox" }]);
  await f.m.inboxScan();
  assert.equal(f.events.length, 1, "the same file again: no event");

  const imported = await f.m.boardInboxImport("plan.json", r.sha256);
  assert.equal(imported.value.status, "imported");
  assert.deepEqual((await f.view()).board.tasks.map((t) => t.ref), ["T1", "T2"]);
  assert.deepEqual(f.ls(), [".work", "done", "reports"]);
  assert.deepEqual(f.ls("done"), ["plan.json", "plan.report.json"]);
  assert.equal(f.json("done", "plan.report.json").status, "imported");
  assert.deepEqual(f.ls("reports"), []);
  assert.equal((await f.view()).inbox, undefined, "the row is gone");
  assert.equal(f.events.length, 2);
  await f.m.shutdown();
});

test("«Reject»: rejected, to done/; nothing on the board", async () => {
  const f = await started();
  f.put("a.json", tasksFile([row("T1")]));
  await f.m.inboxScan();
  assert.deepEqual(await f.m.boardInboxReject("a.json"), { ok: true, value: null });
  assert.equal(f.json("done", "a.report.json").status, "rejected");
  assert.deepEqual(f.ls("done"), ["a.json", "a.report.json"]);
  assert.deepEqual((await f.view()).board.tasks, []);
  assert.equal((await f.m.boardInboxReject("a.json")).code, "file_changed", "no such row any more");
  assert.equal((await f.m.boardInboxImport("../x.json", "0".repeat(64))).code, "invalid_argument", "a name, never a path");
  await f.m.shutdown();
});

test("invalid_file (broken JSON, over 1 MB, a symlink) and refused (workspace_not_found, workspace_unavailable): to done/ at once with the report", async () => {
  const f = await started({ open: [WS] });
  const target = path.join(TMP, `target-${n}.json`);
  const targetText = tasksFile([row("T1")]);
  fs.writeFileSync(target, targetText);
  f.put("broken.json", "{ not json");
  f.put("big.json", `{"format":"board-tasks/v1","x":"${"a".repeat(1024 * 1024)}"}`);
  fs.symlinkSync(target, path.join(f.inbox, "link.json"));
  f.put("nows.json", tasksFile([row("T1")], { workspace: "нет такого" }));
  f.put("closed.json", tasksFile([row("T1")], { workspace: undefined, workspaceId: "ws-closed" }));
  await f.m.inboxScan();
  assert.deepEqual(f.ls(), [".work", "done", "reports"]);
  const rep = (name) => f.json("done", `${name}.report.json`);
  assert.deepEqual([rep("broken").status, rep("broken").code], ["invalid_file", "invalid_file"]);
  assert.deepEqual([rep("big").status, rep("big").code], ["invalid_file", "invalid_file"]);
  assert.deepEqual([rep("link").status, rep("link").refused[0].detail], ["invalid_file", "symlink"]);
  assert.deepEqual([rep("nows").status, rep("nows").code, rep("nows").workspaceId], ["refused", "workspace_not_found", null]);
  assert.deepEqual([rep("closed").status, rep("closed").code], ["refused", "workspace_unavailable"]);
  assert.ok(fs.lstatSync(path.join(f.inbox, "done", "link.json")).isSymbolicLink(), "the link itself went to done/");
  assert.equal(fs.readFileSync(target, "utf8"), targetText, "its target is not touched");
  const rows = (await f.view()).inbox;
  assert.deepEqual(rows.map((r) => [r.file, r.report.status]).sort(), [["big.json", "invalid_file"], ["broken.json", "invalid_file"], ["closed.json", "refused"], ["link.json", "invalid_file"], ["nows.json", "refused"]]);
  assert.deepEqual((await f.view()).board.tasks, []);
  await f.m.shutdown();
});

test("*.tmp, folders and the reports are not read as task files; a taken name in done/ gets -2", async () => {
  const f = await started();
  fs.writeFileSync(path.join(f.inbox, "half.json.tmp"), tasksFile([row("T1")]));
  fs.mkdirSync(path.join(f.inbox, "sub"));
  fs.writeFileSync(path.join(f.inbox, "sub", "inner.json"), tasksFile([row("T1")]));
  fs.mkdirSync(path.join(f.inbox, "dir.json"));
  f.put("a.json", tasksFile([row("T1")]));
  await f.m.inboxScan();
  assert.deepEqual((await f.view()).inbox.map((r) => r.file), ["a.json"]);
  // a report in reports/ is never a file of tasks: the next poll leaves it, no row of its own
  await f.m.inboxScan();
  assert.deepEqual(f.ls("reports"), ["a.report.json"]);
  assert.deepEqual((await f.view()).inbox.map((r) => r.file), ["a.json"]);
  await f.m.boardInboxReject("a.json");
  f.put("a.json", tasksFile([row("T2")]));
  await f.m.inboxScan();
  await f.m.boardInboxReject("a.json");
  assert.deepEqual(f.ls("done"), ["a-2.json", "a-2.report.json", "a.json", "a.report.json"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.inbox, "done", "a-2.json"), "utf8")).tasks[0].ref, "T2");
  assert.deepEqual(f.ls(), [".work", "dir.json", "done", "half.json.tmp", "reports", "sub"], "left where they were");
  await f.m.shutdown();
});

test("after a restart the files of inbox/ are checked again", async () => {
  const f = await started();
  f.put("a.json", tasksFile([row("T1")]));
  await f.m.inboxScan();
  const was = f.json("reports", "a.report.json").at;
  await f.m.shutdown();
  await new Promise((r) => setTimeout(r, 5));
  const m = manager(f.root);
  assert.equal((await m.board()).value.inbox, undefined, "nothing before the start");
  await m.inboxStart();
  const r = (await m.board()).value.inbox;
  assert.deepEqual(r.map((x) => [x.file, x.report.status]), [["a.json", "checked"]]);
  assert.notEqual(f.json("reports", "a.report.json").at, was, "a new check");
  await m.shutdown();
});

test("file_changed: «Import» of a file changed after the check — refused, checked again; the board moved on — a new report, a second «Import»", async () => {
  const f = await started();
  f.put("a.json", tasksFile([row("T1")]));
  await f.m.inboxScan();
  const first = await rowOf(f, "a.json");
  f.put("a.json", tasksFile([row("T1"), row("T2")]));
  const changed = await f.m.boardInboxImport("a.json", first.sha256);
  assert.equal(changed.code, "file_changed");
  const again = await rowOf(f, "a.json");
  assert.notEqual(again.sha256, first.sha256);
  assert.deepEqual(again.report.created.map((x) => x.ref), ["T1", "T2"]);
  assert.deepEqual((await f.view()).board.tasks, [], "nothing written");
  // the board moves on: T1 comes from another file meanwhile
  f.put("b.json", tasksFile([row("T1")]));
  await f.m.inboxScan();
  await f.m.boardInboxImport("b.json", (await rowOf(f, "b.json")).sha256);
  const second = await f.m.boardInboxImport("a.json", again.sha256);
  assert.equal(second.value.status, "checked", "a new report, not written");
  assert.deepEqual([second.value.created.map((x) => x.ref), second.value.unchanged], [["T2"], ["T1"]]);
  assert.deepEqual((await f.view()).board.tasks.map((t) => t.ref), ["T1"]);
  const third = await f.m.boardInboxImport("a.json", (await rowOf(f, "a.json")).sha256);
  assert.equal(third.value.status, "imported");
  assert.deepEqual((await f.view()).board.tasks.map((t) => t.ref), ["T1", "T2"]);
  await f.m.shutdown();
});

test("every row refused: «Import» is refused (only «Reject»)", async () => {
  const f = await started();
  f.put("a.json", tasksFile([row("T1", { criteria: [] }), row("T2", { dependsOn: ["NOPE"] })]));
  await f.m.inboxScan();
  const r = await rowOf(f, "a.json");
  assert.deepEqual(r.report.refused.map((x) => x.code), ["no_criteria", "unknown_dependency"]);
  assert.match(r.report.refused[1].detail, /^dependsOn: no task NOPE /, "the window takes the dependency's ref from here (BoardCard importText)");
  assert.equal((await f.m.boardInboxImport("a.json", r.sha256)).code, "invalid_argument");
  assert.deepEqual(await f.m.boardInboxReject("a.json"), { ok: true, value: null });
  await f.m.shutdown();
});

// createInbox on its own, with a check and an apply of its own: a writer replaces inbox/<name> at the worst moment
function bareInbox({ onApply = async () => {}, onCheck = async () => {} } = {}) {
  const dir = path.join(TMP, `bare-${++n}`, "inbox");
  const check = async (file, bytes) => {
    await onCheck(file);
    try { JSON.parse(Buffer.from(bytes).toString()); } catch { return fileRefusal(file, sha256(bytes), "invalid_file", "not UTF-8 JSON"); }
    return importReport(file, sha256(bytes), "checked", WS, { created: [{ ref: "T1", key: "T-1" }], updated: [], unchanged: [], refused: [] });
  };
  const box = createInbox({ dir, check,
    apply: async (file, _bytes, shown) => { await onApply(file); return { report: { ...shown, status: "imported" }, changed: null }; }, changed() {} });
  const put = (name, text) => { fs.writeFileSync(path.join(dir, `${name}.tmp`), text); fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, name)); };
  const read = (...p) => fs.readFileSync(path.join(dir, ...p), "utf8");
  const ls = (...p) => fs.readdirSync(path.join(dir, ...p)).sort();
  return { box, dir, put, read, ls };
}
const V1 = tasksFile([row("T1")]);
const V2 = tasksFile([row("T1"), row("T2")]);

test("TOCTOU «Import»: a file replaced inside apply — the applied version goes to done/ with its report, the new one stays in inbox/ and is checked again", async () => {
  let swap = null;
  const b = bareInbox({ onApply: async () => swap?.() });
  await b.box.start();
  b.put("a.json", V1);
  await b.box.scan();
  const shown = b.box.rows()[0];
  swap = () => b.put("a.json", V2);
  const r = await b.box.import("a.json", shown.sha256);
  assert.equal(r.status, "imported");
  assert.equal(b.read("done", "a.json"), V1, "done/ holds exactly what was applied");
  assert.equal(JSON.parse(b.read("done", "a.report.json")).sha256, sha256(Buffer.from(V1)));
  assert.equal(b.read("a.json"), V2, "the new version is still in inbox/");
  assert.deepEqual(b.ls(".work"), []);
  await b.box.scan();
  const again = b.box.rows().find((x) => x.file === "a.json" && x.report.status === "checked");
  assert.equal(again.sha256, sha256(Buffer.from(V2)), "checked again");
  await b.box.stop();
});

test("TOCTOU check: a file replaced while it is checked — the checked copy goes to done/ as replaced, the new one stays in inbox/", async () => {
  let swap = null;
  const b = bareInbox({ onCheck: async () => swap?.() });
  await b.box.start();
  swap = () => { swap = null; b.put("a.json", V2); };
  b.put("a.json", V1);
  await b.box.scan();
  assert.equal(b.read("a.json"), V2);
  assert.equal(b.read("done", "a.json"), V1);
  assert.deepEqual([JSON.parse(b.read("done", "a.report.json")).status, JSON.parse(b.read("done", "a.report.json")).code], ["refused", "file_changed"]);
  await b.box.scan();
  assert.equal(b.box.rows().find((x) => x.report.status === "checked").sha256, sha256(Buffer.from(V2)));
  await b.box.stop();
});

// rename into .work/ watched: the writer acts right before or right after the take (fs/promises' live bindings)
async function aroundTake(when, act, fn) {
  const orig = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    const take = path.basename(path.dirname(String(to))) === ".work";
    if (take && when === "before") act();
    const r = await orig(from, to);
    if (take && when === "after") act();
    return r;
  };
  syncBuiltinESMExports();
  try { return await fn(); } finally { fs.promises.rename = orig; syncBuiltinESMExports(); }
}

test("TOCTOU invalid_file / refused: only the version read is filed; a file put in its place meanwhile is never filed with that report", async () => {
  const b = bareInbox();
  await b.box.start();
  // the poll saw a broken file, the writer put a good one before the take: the good one is what is checked — it waits
  b.put("bad.json", "{ broken");
  let once = () => { once = () => {}; b.put("bad.json", V1); };
  await aroundTake("before", () => once(), () => b.box.scan());
  assert.deepEqual(b.ls("done"), [], "nothing filed as broken");
  assert.equal(b.read("bad.json"), V1);
  assert.equal(b.box.rows().find((x) => x.file === "bad.json").report.status, "checked");
  // a broken file taken, a good one put right after: the broken copy to done/ as invalid_file, the good one stays
  b.put("x.json", "{ broken");
  once = () => { once = () => {}; b.put("x.json", V2); };
  await aroundTake("after", () => once(), () => b.box.scan());
  assert.equal(b.read("done", "x.json"), "{ broken");
  assert.equal(JSON.parse(b.read("done", "x.report.json")).status, "invalid_file");
  assert.equal(b.read("x.json"), V2);
  await b.box.scan();
  assert.equal(b.box.rows().find((x) => x.file === "x.json" && x.report.status === "checked").sha256, sha256(Buffer.from(V2)));
  // a check that throws midway: the copy goes back, nothing is lost in .work/
  const r = bareInbox({ onCheck: async () => { throw Object.assign(new Error("no"), { code: "x" }); } });
  await r.box.start();
  r.put("w.json", V1);
  await r.box.scan();
  assert.equal(r.read("w.json"), V1, "a check that fails leaves the file in inbox/, not in .work/");
  assert.deepEqual(r.ls(".work"), []);
  await r.box.stop();
  assert.deepEqual(b.ls(".work"), []);
  await b.box.stop();
});

test("TOCTOU «Reject»: a file replaced after the check is not rejected — checked again, file_changed; the version shown is rejected", async () => {
  const b = bareInbox();
  await b.box.start();
  b.put("a.json", V1);
  await b.box.scan();
  b.put("a.json", V2);
  await assert.rejects(b.box.reject("a.json"), (e) => e.code === "file_changed");
  assert.equal(b.read("a.json"), V2, "the new version stays in inbox/");
  assert.ok(!b.ls("done").includes("a.json"), "nothing rejected");
  assert.equal(b.box.rows()[0].sha256, sha256(Buffer.from(V2)));
  assert.equal(await b.box.reject("a.json"), null);
  assert.equal(b.read("done", "a.json"), V2);
  assert.equal(JSON.parse(b.read("done", "a.report.json")).status, "rejected");
  await b.box.stop();
});

test("a restart with a copy left in .work/: back to inbox/ and checked; with a newer file of its name there — to done/ as replaced", async () => {
  const b = bareInbox();
  await b.box.start();
  await b.box.stop();
  fs.writeFileSync(path.join(b.dir, ".work", "a.json"), V1);
  fs.writeFileSync(path.join(b.dir, ".work", "b.json"), V1);
  b.put("b.json", V2);
  const again = createInbox({ dir: b.dir, check: async (file, bytes) => importReport(file, sha256(bytes), "checked", WS), apply: async () => null, changed() {} });
  await again.start();
  assert.equal(b.read("a.json"), V1);
  assert.equal(b.read("b.json"), V2);
  assert.equal(b.read("done", "b.json"), V1);
  assert.deepEqual(b.ls(".work"), []);
  assert.deepEqual(again.rows().filter((x) => x.report.status === "checked").map((x) => [x.file, x.sha256]).sort(), [["a.json", sha256(Buffer.from(V1))], ["b.json", sha256(Buffer.from(V2))]]);
  await again.stop();
});

test("a check that fails while a newer file takes the name: the older copy is never overwritten in .work/ — filed in done/ as replaced", async () => {
  let fail = true;
  const b = bareInbox({ onCheck: async () => { if (fail) { fail = false; b.put("a.json", V2); throw new Error("store busy"); } } });
  await b.box.start();
  b.put("a.json", V1);
  await b.box.scan();
  assert.deepEqual(b.ls(".work"), ["a.json"], "the copy could not go back: a newer file has its name");
  await b.box.scan();
  assert.equal(b.read("done", "a.json"), V1, "the older version is kept");
  assert.equal(JSON.parse(b.read("done", "a.report.json")).code, "file_changed");
  assert.equal(b.box.rows().find((x) => x.report.status === "checked")?.sha256, sha256(Buffer.from(V2)), "the newer one is checked");
  assert.equal(b.read("a.json"), V2);
  await b.box.stop();
});

test("a symbolic link whose filing fails: it never goes back to inbox/ as its target (link() follows it on macOS)", async () => {
  const b = bareInbox();
  const secret = path.join(TMP, `secret-${++n}.json`);
  fs.writeFileSync(secret, V1);
  await b.box.start();
  fs.chmodSync(path.join(b.dir, "done"), 0o500); // done/ not writable: filing fails
  fs.symlinkSync(secret, path.join(b.dir, "a.json"));
  try { await b.box.scan(); } finally { fs.chmodSync(path.join(b.dir, "done"), 0o700); }
  assert.ok(!fs.existsSync(path.join(b.dir, "a.json")), "no regular file in inbox/ in its place");
  assert.ok(fs.lstatSync(path.join(b.dir, ".work", "a.json")).isSymbolicLink(), "the link itself waits in .work/");
  // done/ writable again: the next poll files the link itself with its own refusal
  await b.box.scan();
  assert.ok(fs.lstatSync(path.join(b.dir, "done", "a.json")).isSymbolicLink(), "the link itself is filed");
  assert.equal(JSON.parse(b.read("done", "a.report.json")).code, "invalid_file");
  // and when a newer file takes the name first: still its own refusal, the newer one checked
  fs.chmodSync(path.join(b.dir, "done"), 0o500);
  fs.symlinkSync(secret, path.join(b.dir, "c.json"));
  try { await b.box.scan(); } finally { fs.chmodSync(path.join(b.dir, "done"), 0o700); }
  b.put("c.json", V2);
  await b.box.scan();
  assert.ok(fs.lstatSync(path.join(b.dir, "done", "c.json")).isSymbolicLink());
  assert.equal(JSON.parse(b.read("done", "c.report.json")).code, "invalid_file");
  assert.equal(b.box.rows().find((x) => x.file === "c.json" && x.report.status === "checked")?.sha256, sha256(Buffer.from(V2)));
  assert.equal(fs.readFileSync(secret, "utf8"), V1, "its target untouched");
  await b.box.stop();
});

test("after a restart: a report left as .tmp next to its filed file gets its name", async () => {
  const b = bareInbox();
  await b.box.start();
  await b.box.stop();
  fs.writeFileSync(path.join(b.dir, "done", "x.json"), V1);
  fs.writeFileSync(path.join(b.dir, "done", "x.report.json.tmp"), "{}");
  const again = createInbox({ dir: b.dir, check: async () => { throw new Error("not read"); }, apply: async () => null, changed() {} });
  await again.start();
  assert.deepEqual(b.ls("done"), ["x.json", "x.report.json"]);
  await again.stop();
});

test("a name over 200 bytes before .json: invalid_file once, the report only in memory, the file left unread", async () => {
  let checks = 0;
  const b = bareInbox({ onCheck: async () => { checks++; } });
  await b.box.start();
  const long = `${"я".repeat(101)}.json`; // 202 bytes of UTF-8, 101 characters
  const fits = `${"я".repeat(100)}.json`;
  b.put(long, V1);
  b.put(fits, V1);
  await b.box.scan();
  await b.box.scan();
  const rows = b.box.rows();
  assert.deepEqual(rows.filter((x) => x.file === long).map((x) => [x.report.status, x.report.code]), [["invalid_file", "invalid_file"]], "shown once");
  assert.ok(rows.find((x) => x.file === long).report.file.length <= 255);
  assert.equal(rows.find((x) => x.file === fits).report.status, "checked");
  assert.equal(checks, 1, "the long one is never read");
  assert.ok(b.ls().includes(long));
  assert.ok(!b.ls("reports").some((f) => f.startsWith("я".repeat(101))) && !b.ls("done").length);
  for (const f of b.ls("reports")) assert.ok(Buffer.byteLength(f) <= 255);
  await b.box.stop();
});

// Fake Electron: the main window's top frame; handleMain as registerIpc wraps it
function ipc(m, win) {
  const wc = Object.assign(new EventEmitter(), { id: 1, mainFrame: { id: "frame" }, isDestroyed: () => false, send() {} });
  const handlers = new Map();
  registerOrchestrationIpc((channel, listener) => handlers.set(channel, (event, ...args) => {
    assertMainRenderer(event, () => ({ isDestroyed: () => false, webContents: wc }));
    return listener(event, ...args);
  }), m, undefined, win);
  return (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args));
}

test("«Import tasks»: one call, main picks and reads the file — a path from the window is refused; the event goes to the window", async () => {
  const root = path.join(TMP, `root-${++n}`);
  const m = manager(root);
  const file = path.join(TMP, `chosen-${n}.json`);
  fs.writeFileSync(file, tasksFile([row("T1"), row("T2", { criteria: [] })]));
  const sent = [];
  let picked = 0;
  const invoke = ipc(m, { send: (channel, payload) => sent.push([channel, payload]), pickImportFile: async () => { picked++; return file; } });
  const refused = await invoke(IPC.orchestrationBoardImportFile, "/etc/passwd");
  assert.equal(refused.code, "invalid_argument");
  assert.equal(picked, 0, "no dialog, nothing read");
  const r = await invoke(IPC.orchestrationBoardImportFile);
  assert.equal(picked, 1);
  assert.equal(r.value.file, path.basename(file));
  assert.equal(r.value.status, "imported");
  assert.deepEqual([r.value.created.map((x) => x.ref), r.value.refused.map((x) => x.code)], [["T1"], ["no_criteria"]]);
  assert.equal(fs.existsSync(path.join(root, "inbox")), false, "the button puts nothing in inbox/");
  // the dialog closed unchosen
  const none = ipc(m, { send() {}, pickImportFile: async () => null });
  assert.deepEqual(await none(IPC.orchestrationBoardImportFile), { ok: true, value: null });
  // a symlink chosen: not opened
  const link = path.join(TMP, `link-${n}.json`);
  fs.symlinkSync(file, link);
  const viaLink = ipc(m, { send() {}, pickImportFile: async () => link });
  assert.deepEqual([(await viaLink(IPC.orchestrationBoardImportFile)).value.status, (await viaLink(IPC.orchestrationBoardImportFile)).value.refused[0].detail], ["invalid_file", "symlink"]);
  // inbox/ changes reach the window on orchestration:board-event
  await m.inboxStart();
  fs.writeFileSync(path.join(root, "inbox", "x.json"), tasksFile([row("T9")]));
  await m.inboxScan();
  assert.deepEqual(sent, [[IPC.orchestrationBoardEvent, { kind: "inbox" }]]);
  assert.equal((await invoke(IPC.orchestrationBoardInboxImport, "x.json", "nope")).code, "invalid_argument");
  await m.shutdown();
});

test("the smoke's dialog hook: both variables — the file without a dialog; only one of them — the real dialog", async () => {
  let dialogs = 0;
  const dialog = async () => { dialogs++; return "/from/dialog.json"; };
  assert.equal(await importFilePicker({ isolated: true, smokeImportFile: "/smoke/tasks.json" }, dialog)(), "/smoke/tasks.json");
  assert.equal(dialogs, 0);
  assert.equal(await importFilePicker({ isolated: false, smokeImportFile: "/smoke/tasks.json" }, dialog)(), "/from/dialog.json", "only CANVASTTY_SMOKE_IMPORT_FILE");
  assert.equal(await importFilePicker({ isolated: true, smokeImportFile: null }, dialog)(), "/from/dialog.json", "only CANVASTTY_USER_DATA_DIR");
  assert.equal(await importFilePicker({ isolated: true, smokeImportFile: "relative.json" }, dialog)(), "/from/dialog.json", "not an absolute path");
  assert.equal(dialogs, 3);
  // index.ts reads both before CANVASTTY_USER_DATA_DIR is deleted, and drops the file's variable at once
  const index = fs.readFileSync(path.join(HERE, "..", "src", "main", "index.ts"), "utf8");
  const read = index.indexOf("isolated: !!process.env.CANVASTTY_USER_DATA_DIR");
  assert.ok(read > 0 && read < index.indexOf("delete process.env.CANVASTTY_USER_DATA_DIR"));
  assert.ok(index.indexOf("delete process.env.CANVASTTY_SMOKE_IMPORT_FILE") > read);
  assert.match(index, /smokeImport,\n/);
});
