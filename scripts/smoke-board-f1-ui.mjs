// Electron UI smoke for F1, the inputs of the board (docs/agent-orchestration/implementation/stage-f-external-projects.md
// §5.4, §10, §11): the real window at 1280×800, fake Codex/Claude CLIs (none of them is started: no run is made), a
// temporary Git project; the steps f1.s1–f1.s13, one per transition of an inbox/ file's life cycle, and the button:
//   f1.s1 a file in inbox/ → checked in ≤5 s: its report in reports/ and its row in the window with the autopilot off (the
//         row comes on main's event), the board unchanged; f1.s2 «Import» → imported, the tasks on the board, the file and
//         its report in done/; f1.s3 «Reject» → rejected; f1.s4 invalid_file (broken JSON, over 1 MB, a symlink — the link
//         itself to done/, its target untouched); f1.s5 a file changed after the check → file_changed and a new check;
//         f1.s6 refused (workspace_not_found, workspace_unavailable) with its code; f1.s7 *.tmp and folders not read;
//         f1.s8 a taken name in done/ → -2; f1.s9 a restart: the files of inbox/ checked again; f1.s10 «Import tasks»:
//         the file named by the smoke's hook instead of the dialog, the report in the window, nothing in inbox/; f1.s11 a
//         report in reports/ is not read as a file of tasks; f1.s12 the board moved on after the check → a new report and
//         a second «Import»; f1.s13 every row refused → «Import» unavailable.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-board-f1-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch as launchApp, q, sleep, waitForValue, workspace } from "./orchestration-app-kit.mjs";

const { D, project } = workspace("cto-board-f1-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const ok = (what, cond, got) => { (cond ? passed : failures).push(cond ? what : `${what}: ${JSON.stringify(got)?.slice(0, 600)}`); };

// ---------- the project, the fake CLIs (never started), the hook's file ----------
const node = project("board-f1-app");
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.writeFileSync(D("mock-state", ".codex", "config.toml"), "");
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_CHECKS: "none", ...extra });
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.162.0", path: PATHS, env: env({ CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({}) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const userData = D("user-data");
const INBOX = path.join(userData, "orchestration", "inbox");
const BUTTON_FILE = D("chosen", "button-tasks.json"); // what the smoke's hook names instead of the dialog (f1.s10)

const row = (ref, over = {}) => ({ ref, project: node, title: `Задача ${ref}`, text: `Сделать ${ref}`, criteria: [`${ref} готово`], ...over });
const file = (tasks, over = {}) => JSON.stringify({ format: "board-tasks/v1", workspaceId: "common", source: "smoke", tasks, ...over });
// as a writer does it: <name>.json.tmp, then rename
const put = (name, text) => { fs.writeFileSync(path.join(INBOX, `${name}.tmp`), text); fs.renameSync(path.join(INBOX, `${name}.tmp`), path.join(INBOX, name)); };
const ls = (...p) => (fs.existsSync(path.join(INBOX, ...p)) ? fs.readdirSync(path.join(INBOX, ...p)).sort() : []);
const json = (...p) => JSON.parse(fs.readFileSync(path.join(INBOX, ...p), "utf8"));

let app;
const view = () => app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");
const refs = async () => (await view()).board.tasks.map((t) => t.ref ?? t.key);
// within: the board of a workspace (a row shown in the active workspace's board, f1.s6)
const inboxRow = (name, within = "") => `${within ? `[data-board="${within}"] ` : ""}[data-board-inbox="${name}"]`;
const rowState = (name, within) => app.ev(`(() => { const el = ${q(inboxRow(name, within))}; return el && { status: el.dataset.boardInboxStatus, text: el.textContent,
  code: el.querySelector("[data-board-inbox-code]")?.dataset.boardInboxCode ?? null, tasks: [...el.querySelectorAll("[data-board-inbox-task]")].map((x) => x.dataset.boardInboxTask),
  refused: [...el.querySelectorAll("[data-board-inbox-refused]")].map((x) => x.dataset.boardInboxRefused),
  import: el.querySelector("[data-board-inbox-import]") ? !el.querySelector("[data-board-inbox-import]").disabled : null,
  reject: el.querySelector("[data-board-inbox-reject]") ? !el.querySelector("[data-board-inbox-reject]").disabled : null }; })()`);
const rowIs = (name, status, ms = 10_000, within) => waitForValue(async () => { const s = await rowState(name, within); return s?.status === status ? s : null; }, `${name}: ${status}`, ms);
const report = () => app.ev(`(() => { const el = ${q("[data-board-import-report]")}; return el && { status: el.dataset.boardImportReport, line: el.querySelector("[data-board-import-line]")?.textContent,
  created: [...el.querySelectorAll("[data-board-import-created]")].map((x) => x.dataset.boardImportCreated),
  unchanged: [...el.querySelectorAll("[data-board-import-unchanged]")].map((x) => x.dataset.boardImportUnchanged),
  refused: [...el.querySelectorAll("[data-board-import-refused]")].map((x) => [x.dataset.boardImportRefused, x.textContent]) }; })()`);
const closeReport = async () => { await app.clickEl(q(".launch-dialog__close")); await app.waitFor(`!${q("[data-board-import-report]")}`, "the report window closed"); };
// a screenshot is evidence, not a check: one that does not come back is named in the log, the steps go on
const shot = (name) => app.shot(`f1-${name}`).catch((e) => console.log(`[smoke] screenshot ${name}: ${String(e?.message ?? e)}`));

async function start() {
  // the smoke's dialog hook: both variables (§5.6); --user-data-dir is the same folder
  app = await launchApp({ userData, providers, port: PORT, shots: SHOTS, env: { CANVASTTY_USER_DATA_DIR: userData, CANVASTTY_SMOKE_IMPORT_FILE: BUTTON_FILE } });
  await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await app.waitFor("!!window.canvasTTY?.orchestration", "the orchestration API");
  if (!(await app.ev(`!!${q("[data-board]")}`))) await app.clickEl(q("[data-board-button]"));
  await app.waitFor(`${q("[data-board]")} && true`, "the board on the canvas");
}

try {
  await start();
  ok("the new inputs are available here (macOS arm64)", await app.ev("window.canvasTTY.orchestration.newInputs") === true);
  await waitForValue(() => fs.existsSync(path.join(INBOX, "done")) && fs.existsSync(path.join(INBOX, "reports")), "inbox/ made at the start");
  ok("inbox/, reports/, done/ are 0700", ["", "reports", "done"].every((d) => (fs.statSync(path.join(INBOX, d)).mode & 0o777) === 0o700));

  // ---------- f1.s1: a file in inbox/ → checked, the row by main's event, the autopilot off ----------
  const v0 = await view();
  ok("f1.s1 the autopilot is off, nothing polls the board in the window", Object.values(v0.autopilot ?? {}).every((s) => !s.on) && !v0.queued && !v0.heads, v0.autopilot);
  const t0 = Date.now();
  put("a.json", file([row("T1"), row("T2", { dependsOn: ["T1"] })]));
  const s1 = await rowIs("a.json", "checked", 5000).catch(() => null);
  const s1ms = Date.now() - t0;
  ok("f1.s1 the row in the window in ≤5 s: its tasks, «Import» and «Reject»", !!s1 && s1ms <= 5000 && s1.tasks.join() === "T1,T2" && s1.import === true && s1.reject === true, { s1, s1ms });
  ok("f1.s1 the row reads «Задачи a.json: 2 задач, 0 отказов» with ref, title, project, dependsOn", /Задачи a\.json: 2 задач, 0 отказов/.test(s1?.text ?? "")
    && s1.text.includes("Задача T2") && s1.text.includes(node) && /после T1/.test(s1.text), s1?.text);
  ok("f1.s1 reports/a.report.json is checked", ls("reports").includes("a.report.json") && json("reports", "a.report.json").status === "checked", ls("reports"));
  ok("f1.s1 the board did not change", (await refs()).length === 0, await refs());
  await shot("s1-checked");

  // ---------- f1.s2: «Import» → imported ----------
  await app.clickEl(`${q(inboxRow("a.json"))}.querySelector("[data-board-inbox-import]")`);
  const s2 = await waitForValue(async () => { const r = await report(); return r?.status === "imported" ? r : null; }, "the report of «Import»", 10_000).catch(() => null);
  ok("f1.s2 the report window: imported, created T1 and T2", s2?.created.join() === "T1,T2" && /создано 2, обновлено 0, без изменений 0, отказов 0/.test(s2.line), s2);
  await shot("s2-imported");
  await closeReport();
  ok("f1.s2 the tasks on the board", JSON.stringify(await refs()) === JSON.stringify(["T1", "T2"]) && await app.ev(`!!${q('[data-board-task="T-2"]')}`), await refs());
  ok("f1.s2 the file and its report in done/, the row gone", ls("done").join() === "a.json,a.report.json" && json("done", "a.report.json").status === "imported"
    && !ls().includes("a.json") && !ls("reports").includes("a.report.json") && !(await rowState("a.json")), { done: ls("done"), inbox: ls() });

  // ---------- f1.s3: «Reject» → rejected ----------
  put("b.json", file([row("T3")]));
  await rowIs("b.json", "checked");
  await app.clickEl(`${q(inboxRow("b.json"))}.querySelector("[data-board-inbox-reject]")`);
  await app.waitFor(`!${q(inboxRow("b.json"))}`, "b.json's row gone");
  ok("f1.s3 rejected: in done/ with its report, nothing on the board", json("done", "b.report.json").status === "rejected" && ls("done").includes("b.json") && !(await refs()).includes("T3"), ls("done"));

  // ---------- f1.s4: invalid_file — broken JSON, over 1 MB, a symlink ----------
  const target = D("outside", "target.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file([row("T9")]));
  const targetBefore = fs.readFileSync(target, "utf8");
  const targetStat = fs.statSync(target);
  put("broken.json", "{ \"format\": ");
  put("big.json", `{"format":"board-tasks/v1","workspaceId":"common","tasks":[],"pad":"${"x".repeat(1024 * 1024 + 16)}"}`);
  fs.symlinkSync(target, path.join(INBOX, "link.json"));
  const s4 = await Promise.all(["broken.json", "big.json", "link.json"].map((f) => rowIs(f, "invalid_file").catch(() => null)));
  ok("f1.s4 three rows invalid_file with the code's words, no decision buttons", s4.every((s) => s && s.code === "invalid_file" && s.import === null && s.reject === null
    && s.text.includes("Файл не разобран или не по формату")), s4);
  ok("f1.s4 the three and their reports in done/ at once", ["broken", "big", "link"].every((f) => ls("done").includes(`${f}.json`) && json("done", `${f}.report.json`).code === "invalid_file")
    && !["broken.json", "big.json", "link.json"].some((f) => ls().includes(f)), ls("done"));
  ok("f1.s4 the symlink: detail «symlink», the link itself in done/, its target unread and untouched", json("done", "link.report.json").refused[0].detail === "symlink"
    && fs.lstatSync(path.join(INBOX, "done", "link.json")).isSymbolicLink() && fs.readFileSync(target, "utf8") === targetBefore
    && fs.statSync(target).mtimeMs === targetStat.mtimeMs, json("done", "link.report.json"));
  await shot("s4-invalid");

  // ---------- f1.s5: changed after the check → file_changed, a new check ----------
  put("c.json", file([row("T4")]));
  await rowIs("c.json", "checked");
  const shownSha = (await view()).inbox.find((r) => r.file === "c.json").sha256;
  put("c.json", file([row("T4"), row("T5")]));
  // «Import» of what the person was shown (the row's hash), sent the way the row's button sends it
  const s5 = await app.ev(`window.canvasTTY.orchestration.boardInboxImport("c.json", ${JSON.stringify(shownSha)})`);
  const again = await waitForValue(async () => { const s = await rowState("c.json"); return s?.tasks.join() === "T4,T5" ? s : null; }, "c.json checked again").catch(() => null);
  ok("f1.s5 file_changed: nothing written, the file checked again with its new hash", s5.code === "file_changed" && !!again && json("reports", "c.report.json").sha256 !== shownSha
    && !(await refs()).includes("T4"), { s5, again });
  await app.clickEl(`${q(inboxRow("c.json"))}.querySelector("[data-board-inbox-reject]")`);
  await app.waitFor(`!${q(inboxRow("c.json"))}`, "c.json's row gone");

  // ---------- f1.s6: refused with the file's code ----------
  put("nows.json", file([row("T6")], { workspaceId: undefined, workspace: "нет такого" }));
  put("closed.json", file([row("T6")], { workspaceId: "ws-closed-1" }));
  const nows = await rowIs("nows.json", "refused").catch(() => null);
  const active = await app.ev("document.querySelector('[data-board]')?.dataset.board ?? null"); // the board on the canvas is the active workspace's
  const closed = await rowIs("closed.json", "refused", 10_000, active).catch(() => null);
  ok("f1.s6 workspace_not_found: «Пространство нет такого не найдено среди открытых», no buttons", nows?.code === "workspace_not_found" && nows.text.includes("Пространство нет такого не найдено среди открытых")
    && nows.import === null, nows);
  ok("f1.s6 workspace_unavailable by its id, shown in the active workspace's board", active === "common" && closed?.code === "workspace_unavailable" && closed.text.includes("Пространство с этим id закрыто или неизвестно"), closed);
  ok("f1.s6 both in done/ at once, refused with the code", json("done", "nows.report.json").status === "refused" && json("done", "nows.report.json").code === "workspace_not_found"
    && json("done", "nows.report.json").workspaceId === null && json("done", "closed.report.json").code === "workspace_unavailable" && !ls().includes("nows.json"), ls("done"));
  await shot("s6-refused");

  // ---------- f1.s7: *.tmp and folders are not read ----------
  fs.writeFileSync(path.join(INBOX, "half.json.tmp"), file([row("T7")]));
  fs.mkdirSync(path.join(INBOX, "sub"), { recursive: true });
  fs.writeFileSync(path.join(INBOX, "sub", "inner.json"), file([row("T7")]));
  fs.mkdirSync(path.join(INBOX, "folder.json"));
  await sleep(5000); // two polls and more
  const rows7 = (await view()).inbox?.map((r) => r.file) ?? [];
  ok("f1.s7 no row, no report, nothing moved for *.tmp, sub/ and folder.json/", !rows7.some((f) => ["half.json.tmp", "inner.json", "folder.json"].includes(f))
    && ls().includes("half.json.tmp") && ls("sub").join() === "inner.json" && ls().includes("folder.json") && !ls("reports").some((f) => /half|inner|folder/.test(f))
    && !ls("done").some((f) => /half|inner|folder/.test(f)), { rows7, inbox: ls(), reports: ls("reports") });

  // ---------- f1.s8: a taken name in done/ → -2 ----------
  put("a.json", file([row("T8")]));
  await rowIs("a.json", "checked");
  await app.clickEl(`${q(inboxRow("a.json"))}.querySelector("[data-board-inbox-reject]")`);
  await app.waitFor(`!${q(inboxRow("a.json"))}`, "the second a.json's row gone");
  ok("f1.s8 done/a-2.json and done/a-2.report.json; the first a.json kept", ls("done").includes("a-2.json") && ls("done").includes("a-2.report.json")
    && JSON.parse(fs.readFileSync(path.join(INBOX, "done", "a-2.json"), "utf8")).tasks[0].ref === "T8" && json("done", "a.report.json").status === "imported", ls("done"));

  // ---------- f1.s11: a report in reports/ is not read as a file of tasks ----------
  put("d.json", file([row("T10")]));
  await rowIs("d.json", "checked");
  const before11 = fs.readFileSync(path.join(INBOX, "reports", "d.report.json"), "utf8");
  await sleep(4500);
  const rows11 = (await view()).inbox.map((r) => r.file);
  ok("f1.s11 reports/d.report.json stays as written, no row of its own, the only checked row is d.json", fs.readFileSync(path.join(INBOX, "reports", "d.report.json"), "utf8") === before11
    && !rows11.some((f) => f.includes("report")) && (await view()).inbox.filter((r) => r.report.status === "checked").map((r) => r.file).join() === "d.json"
    && ls("reports").join() === "d.report.json", { rows11, reports: ls("reports") });

  // ---------- f1.s12: the board moved on after the check → a new report, a second «Import» ----------
  put("e.json", file([row("X1"), row("X2")]));
  const e1 = await rowIs("e.json", "checked");
  ok("f1.s12 checked: X1 and X2 to be created", e1.tasks.join() === "X1,X2", e1);
  put("g.json", file([row("X1")]));
  await rowIs("g.json", "checked");
  await app.clickEl(`${q(inboxRow("g.json"))}.querySelector("[data-board-inbox-import]")`);
  await waitForValue(async () => (await report())?.status === "imported", "g.json imported");
  await closeReport();
  await app.clickEl(`${q(inboxRow("e.json"))}.querySelector("[data-board-inbox-import]")`);
  const e2 = await waitForValue(async () => { const r = await report(); return r?.status === "checked" ? r : null; }, "the new report of e.json").catch(() => null);
  ok("f1.s12 the first «Import»: a new report (X2 created, X1 unchanged), nothing written", e2?.created.join() === "X2" && e2.unchanged.join() === "X1" && !(await refs()).includes("X2"), e2);
  await shot("s12-new-report");
  await closeReport();
  ok("f1.s12 the row waits with its new report", (await rowState("e.json"))?.import === true && json("reports", "e.report.json").unchanged.join() === "X1");
  await app.clickEl(`${q(inboxRow("e.json"))}.querySelector("[data-board-inbox-import]")`);
  const e3 = await waitForValue(async () => { const r = await report(); return r?.status === "imported" ? r : null; }, "e.json imported").catch(() => null);
  ok("f1.s12 the second «Import» writes what was shown last", e3?.created.join() === "X2" && (await refs()).includes("X2") && json("done", "e.report.json").status === "imported", e3);
  await closeReport();

  // ---------- f1.s13: every row refused → «Import» unavailable ----------
  put("h.json", file([row("Y1", { criteria: [] }), row("Y2", { dependsOn: ["NOPE"] })]));
  const h = await rowIs("h.json", "checked");
  ok("f1.s13 every row refused: «Import» disabled, «Reject» available, the refusals in words", h.import === false && h.reject === true
    && h.refused.join() === "no_criteria,unknown_dependency" && h.text.includes("У задачи Y1 нет критериев") && h.text.includes("Зависимость NOPE не найдена"), h);
  await shot("s13-all-refused");
  await app.clickEl(`${q(inboxRow("h.json"))}.querySelector("[data-board-inbox-reject]")`);
  await app.waitFor(`!${q(inboxRow("h.json"))}`, "h.json's row gone");

  // ---------- f1.s10: «Import tasks» — the hook names the file instead of the dialog ----------
  fs.mkdirSync(path.dirname(BUTTON_FILE), { recursive: true });
  fs.writeFileSync(BUTTON_FILE, file([row("B1"), row("B2", { criteria: [] })]));
  const inboxBefore = ls();
  await app.clickEl(q("[data-board-import]"));
  const s10 = await waitForValue(async () => { const r = await report(); return r?.status === "imported" ? r : null; }, "the button's report").catch(() => null);
  ok("f1.s10 the report in the window: B1 created, B2 refused «У задачи B2 нет критериев»", s10?.created.join() === "B1" && s10.refused.length === 1 && s10.refused[0][0] === "no_criteria"
    && s10.refused[0][1].includes("У задачи B2 нет критериев") && /Задачи button-tasks\.json: создано 1, обновлено 0, без изменений 0, отказов 1/.test(s10.line), s10);
  await shot("s10-button-report");
  await closeReport();
  ok("f1.s10 B1 on the board; nothing put in inbox/", (await refs()).includes("B1") && JSON.stringify(ls()) === JSON.stringify(inboxBefore), { inbox: ls(), before: inboxBefore });

  // ---------- f1.s9: a restart — the files of inbox/ checked again ----------
  const at9 = json("reports", "d.report.json").at;
  await app.quit();
  put("r.json", file([row("R1")])); // put while the application is closed
  await sleep(50);
  await start();
  const r9 = await rowIs("r.json", "checked", 10_000).catch(() => null);
  const d9 = await rowIs("d.json", "checked", 10_000).catch(() => null);
  ok("f1.s9 after the restart: d.json checked again (a new report), r.json put while closed checked", !!r9 && !!d9 && json("reports", "d.report.json").at !== at9
    && ls("reports").includes("r.report.json"), { r9, d9, at9 });
  ok("f1.s9 the board is as it was", JSON.stringify((await refs()).sort()) === JSON.stringify(["B1", "T1", "T2", "X1", "X2"]), await refs());
  await shot("s9-restart");
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 1500)}`);
  try { await app?.shot("f1-failure"); } catch {}
} finally {
  await app?.quit?.();
}

const fakeCli = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0;
ok("no CLI was started (no run, no model)", fakeCli === 0, fakeCli);
console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, passedList: passed, failures, fakeCliProcesses: fakeCli, shots: SHOTS }, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
