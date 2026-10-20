// Electron UI smoke for E4, the interface of splitting (docs/agent-orchestration/implementation/stage-e-decomposition.md §10):
// the real window at 1280×800, fake Codex/Claude CLIs (one script per work folder), a temporary Git project; one app
// launch per scenario:
//   1. T-1 marked «Разбить на подзадачи» in the form → «Вести доску» → the autopilot's «разбивает T-1 на подзадачи» → three
//      subtasks (two at once, the third after them) → the closing run → T-1 «Готово», all four in the board's result;
//   2. the lead says «whole» → T-1 is run whole;
//   3. «Разбить» → two refusals → «Разбить ещё раз» → the subtasks are made; the split's panel shows the reasons and the proposal;
//   4. a provider's limit during the split → the autopilot continues it → the subtasks;
//   the project folder, its HEAD, status and the person's branches as they were after each.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-board-e-ui.mjs [--shots <dir>] [--only <n>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, canvasState, card, createAgent, launch as launchApp, openTab, q, waitForValue, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";

const shotsArg = process.argv.indexOf("--shots");
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg > 0 ? Number(process.argv[onlyArg + 1]) : 0;
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : fs.mkdtempSync("/tmp/cto-board-e-shots-");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 100) * 2;
const failures = [];
const passed = [];
let ledgerTotal = 0;
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };
if (!JOURNAL_V2) throw new Error("the board is journal v2 only (goal.task)");

// ---------- the fake CLIs' answers ----------
const cond = (file, r) => ({ keep: null, text: `${file} says done`, covers: [r], evidence: { kind: "change", check: null } });
// one task's four turns: the plan, the executor writes <file>, the review, the final review
const turns = (file, reqs = ["R1"]) => [
  { report: { stages: [{ title: "fix", task: `write ${file}`, conditions: reqs.map((r) => cond(file, r)) }], dropped: [], dropRequirements: [], question: null } },
  { report: { summary: "done", done: true }, writes: [[file, "done\n"]] },
  { report: { conditions: reqs.map((_, i) => ({ id: `C${i + 1}`, status: "met", paths: [file], note: "written" })), findings: [], request: "none", question: null } },
  { report: { conditions: [], findings: [], request: "none", question: null, requirements: reqs.map((r) => ({ id: r, status: "met", note: "written" })) } }
];
const part = (id, covers, dependsOn = []) => ({ id, title: `Часть ${id}`, text: `Сделать ${id}`, criteria: [`${id} готова`], dependsOn, covers });
const PROPOSAL3 = { tasks: [part("S1", ["R1"]), part("S2", ["R2"], ["S1"]), part("S3", ["R3"])], whole: null, question: null };
const PROPOSAL2 = { tasks: [part("S1", ["R1"]), part("S2", ["R2"])], whole: null, question: null };
const WHOLE = { tasks: [], whole: "одной правки достаточно", question: null };
const BAD = { tasks: [part("S1", ["R1"]), part("S2", ["R1"])], whole: null, question: null }; // R2 (and R3) are not covered
const LIMIT = { __limit: { resetsAt: Math.floor(Date.now() / 1000) - 600 } }; // behind by ten minutes: due at once

// One launch of the app on a fresh project: the lead and the executor linked, the board shown, the project's settings
// (a separate copy, a check). sets[k] is the script of the k-th work folder in the order the folders first call.
async function scenario(n, name, sets, body, delay = 1500) {
  if (ONLY && ONLY !== n) return;
  const { D, project, script } = workspace(`cto-board-e${n}-`);
  const node = project("board-e-app");
  for (const [k, steps] of sets.entries()) script(`e/${k + 1}`, steps);
  fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
  fs.writeFileSync(D("mock-state", ".codex", "config.toml"), "");
  const ledger = D("ledger.jsonl");
  const wrap = (p) => {
    const f = D(`${p}-mock`);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
  const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_CHECKS: "none", MOCK_SCRIPT: D("script", "e"), MOCK_SCRIPT_PER_CWD: "1",
    MOCK_TURN_DELAY_MS: String(delay), ...extra });
  const SHELL = D("login-shell");
  fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  const providers = D("providers.json");
  fs.writeFileSync(providers, JSON.stringify({
    codex: { executable: wrap("codex"), version: "codex-cli 0.162.0", path: PATHS, env: env({ CODEX_HOME: D("mock-state", ".codex") }) },
    claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({}) },
    shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
  }));
  const git = (...a) => execFileSync("git", a, { cwd: node, encoding: "utf8" }).trim();
  const snapshot = () => ({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), files: fs.readdirSync(node).sort().join(),
    branches: git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").split("\n").filter((b) => !b.startsWith("refs/heads/raoden/")).join() });
  const ok = (what, cond, got) => expect(cond, `[${n}] ${what}`, got);
  let app;
  try {
    app = await launchApp({ userData: D("user-data"), providers, port: PORT + n, shots: SHOTS });
    await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await createAgent(app, "Агент Codex (лид)", node);
    await createAgent(app, "Агент Claude (исполнитель)", node);
    const c = await canvasState(app);
    const lead = c.agents.find((a) => a.provider === "codex"), exec = c.agents.find((a) => a.provider === "claude");
    const ends = () => Promise.all([app.center(card(lead.agentId, ".agent-card__port")), app.center(card(exec.agentId, ".agent-card__body"))]);
    let prev = null;
    const [from, to] = await waitForValue(async () => { const e = await ends(); const still = prev && JSON.stringify(prev) === JSON.stringify(e); prev = e; return still ? e : null; }, "the cards laid out");
    await app.drag(from, to, 20);
    await app.waitFor("window.canvasTTY.orchestration.canvas().then((r) => r.value.links.length === 1)", "link");
    await app.clickEl(q("[data-board-button]"));
    await app.waitFor(`${q("[data-board]")} && true`, "the board on the canvas");
    const linkId = (await canvasState(app)).links[0].linkId;
    const saved = await app.ev(`window.canvasTTY.orchestration.profile(${JSON.stringify(linkId)}).then((r) => window.canvasTTY.orchestration.saveProfile(${JSON.stringify(linkId)},
      { ...r.value.profile, workMode: "copy", checks: ["true"] })).then((r) => r.ok)`);
    ok("the project's settings: a separate copy, a check", saved === true, saved);
    const view = () => app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");
    const line = (key) => app.ev(`${q(`[data-board-task="${key}"] [data-board-line-text]`)}?.textContent ?? null`);
    const has = (key, sel) => app.ev(`!!${q(`[data-board-task="${key}"] ${sel}`)}`);
    const shot = async (what) => {
      const r = await app.ev(`(() => { const b = ${q("[data-board]")}.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
      const s = await app.call("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } });
      fs.writeFileSync(path.join(SHOTS, `e${n}-${what}.png`), Buffer.from(s.data, "base64"));
    };
    async function newTask({ title, text, criteria, decompose = false }) {
      await app.clickEl(q("[data-board-new]"));
      await app.waitFor(`${q("[data-board-form]")} && true`, "task form");
      await app.type(q('[data-board-field="title"]'), title);
      await app.type(q('[data-board-field="text"]'), text);
      await app.type(q('[data-board-field="criteria"]'), criteria);
      if (decompose) await app.clickEl(q('[data-board-field="decompose"]'));
      await app.clickEl(q("[data-board-save]"));
      await app.waitFor(`!${q("[data-board-form]")}`, "task form closed");
    }
    async function runBoard() {
      await app.clickEl(q("[data-board-autopilot-start]"));
      await app.waitFor(`${q("[data-board-autopilot-confirm]")} && true`, "the autopilot's explanation");
      await app.clickEl(q("[data-board-autopilot-yes]"));
      await app.waitFor(`${q('[data-board-autopilot="on"]')} && true`, "the autopilot on");
    }
    const stopCode = (code, ms = 240_000) => app.waitFor(`${q(`[data-board-autopilot-stop="${code}"]`)} && true`, `the autopilot stopped: ${code}`, ms);
    const before = snapshot();
    await body({ app, ok, view, line, has, shot, newTask, runBoard, stopCode, node });
    const after = snapshot();
    ok("the project folder, its HEAD, status and the person's branches as they were", JSON.stringify(before) === JSON.stringify(after), { before, after });
  } catch (error) {
    failures.push(`[${n}] error: ${String(error?.stack ?? error).slice(0, 1500)}`);
    try { await app?.shot(`e${n}-failure`); } catch {}
    try { console.log(`[${n}] split facts:`, JSON.stringify(await app.ev("window.canvasTTY.orchestration.board().then((r) => r.value.facts.map((f) => [f.decompositionOf, f.status, f.reason, f.split, f.splitFailed, f.halted]))"))); } catch {}
  } finally {
    await app?.quit?.();
    ledgerTotal += fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0;
    passed.push(`[${n}] ${name}: finished`);
  }
}

const CRIT3 = "первое\nвторое\nтретье";

// ---------- 1. the autopilot splits, three subtasks, the closing run ----------
await scenario(1, "the autopilot splits the task", [
  [{ report: PROPOSAL3 }],
  turns("s2.txt"), turns("s3.txt"), turns("s4.txt"), turns("p.txt", ["R1", "R2", "R3"])
], async ({ app, ok, view, line, has, shot, newTask, runBoard, stopCode }) => {
  await newTask({ title: "Большая задача", text: "Сделать три вещи", criteria: CRIT3, decompose: true });
  await app.waitFor(`${q('[data-board-task="T-1"]')} && true`, "T-1 on the board");
  ok("T-1 offers «Разбить» and no plain «Запустить»", (await has("T-1", "[data-board-decompose]")) && !(await has("T-1", "[data-board-start]")), await line("T-1"));
  await shot("marked");
  await runBoard();
  const splitting = await waitForValue(() => app.ev(`${q("[data-board-autopilot-splitting]")}?.textContent ?? null`), "the autopilot's «разбивает T-1»", 120_000).catch(() => null);
  ok("the autopilot says «разбивает T-1 на подзадачи»", splitting === "разбивает T-1 на подзадачи", splitting);
  await shot("autopilot-splitting");
  await stopCode("all_done");
  const v = await view();
  const parent = v.board.tasks.find((t) => t.key === "T-1");
  const subs = v.board.tasks.filter((t) => t.parentId === parent.id);
  ok("three subtasks were made by the split", subs.length === 3 && !!parent.decomposedBy, subs.map((t) => t.key));
  const s = (cover) => subs.find((t) => t.covers.join() === cover);
  ok("the second subtask depends on the first", s("R2").dependsOn.includes(s("R1").id), s("R2").dependsOn);
  const started = subs.map((t) => ({ key: t.key, at: v.facts.find((f) => f.taskId === t.id)?.createdAt ?? 0 })).sort((a, b) => a.at - b.at);
  ok("the first two start before the third (two at once)", started[2].key === s("R2").key, started);
  ok("T-1 «Готово» (confirmed)", (await app.ev(`${q('[data-board-task="T-1"]')}?.dataset.boardDone ?? null`)) === "confirmed", await line("T-1"));
  const head = v.heads[0];
  ok("all four are in the board's result", head.merges.filter((m) => m.status === "completed").length === 4, head.merges.map((m) => [m.task.key, m.status]));
  const sub = await app.ev(`${q('[data-board-task="T-1"] [data-board-subtasks]')}?.textContent ?? null`);
  ok("T-1: «подзадачи: 3 из 3 в итоге доски» with the keys of the subtasks", /подзадачи: 3 из 3 в итоге доски/.test(sub ?? "") && /T-2/.test(sub), sub);
  const part = await app.ev(`${q('[data-board-task="T-2"] [data-board-part-of]')}?.textContent ?? null`);
  ok("a subtask: «часть T-1»", /часть T-1/.test(part ?? ""), part);
  const covers = await app.ev(`${q('[data-board-task="T-2"] [data-board-covers]')}?.textContent ?? null`);
  ok("a subtask: «закрывает R1 задачи T-1»", covers === "закрывает R1 задачи T-1", covers);
  await app.clickEl(q('[data-board-task="T-1"] [data-board-subtask-link="T-3"]'));
  ok("a key of a subtask is a link to its card", (await app.ev("document.activeElement?.closest('[data-board-task]')?.dataset.boardTask")) === "T-3");
  await shot("done");
});

// ---------- 2. whole ----------
await scenario(2, "the lead says whole", [
  [{ report: WHOLE }], turns("p.txt")
], async ({ app, ok, view, line, has, newTask, runBoard, stopCode, shot }) => {
  await newTask({ title: "Малая задача", text: "Одна правка", criteria: "первое", decompose: true });
  await runBoard();
  await stopCode("all_done");
  const v = await view();
  const parent = v.board.tasks.find((t) => t.key === "T-1");
  ok("one split, answered «whole»; the task has its own run; no subtasks", v.facts.filter((f) => f.decompositionOf === parent.id && f.split === "whole").length === 1
    && v.facts.filter((f) => f.taskId === parent.id).length === 1 && !v.board.tasks.some((t) => t.parentId === parent.id), v.facts.map((f) => [f.decompositionOf, f.split, f.taskId]));
  ok("T-1 «Готово»", (await app.ev(`${q('[data-board-task="T-1"]')}?.dataset.boardDone ?? null`)) === "confirmed", await line("T-1"));
  ok("no split buttons are left on it", !(await has("T-1", "[data-board-decompose]")) && !(await has("T-1", "[data-board-decompose-again]")));
  await shot("whole-done");
});

// ---------- 3. two refusals, «Разбить ещё раз» ----------
await scenario(3, "two refusals, split again", [
  [{ report: BAD }, { report: BAD }], [{ report: PROPOSAL2 }]
], async ({ app, ok, view, line, has, newTask, shot }) => {
  await newTask({ title: "Большая задача", text: "Сделать две вещи", criteria: "первое\nвторое", decompose: true });
  await app.clickEl(q('[data-board-task="T-1"] [data-board-decompose]'));
  await app.waitFor(`${q('[data-board-task="T-1"][data-board-reason="decomposition_failed"]')} && true`, "T-1: the split failed", 180_000);
  const l = await line("T-1");
  ok("the failure is in words: «разбиение не удалось: предложение лида дважды не прошло проверку»", l === "разбиение не удалось: предложение лида дважды не прошло проверку", l);
  ok("«Разбить ещё раз», «Выполнить целиком», «Открыть разбиение» are offered",
    (await has("T-1", "[data-board-decompose-again]")) && (await has("T-1", "[data-board-decompose-whole]")) && (await has("T-1", "[data-board-split-open]")));
  await shot("failed");
  const first = (await view()).facts.find((f) => f.decompositionOf)?.runId;
  await app.clickEl(q('[data-board-task="T-1"] [data-board-split-open]'));
  const panelRun = await waitForValue(() => app.ev(`${q("[data-orch-run-id]")}?.dataset.orchRunId ?? null`), "the split run's panel", 15_000).catch(() => null);
  ok("«Открыть разбиение» opens the split run's panel", panelRun === first, [panelRun, first]);
  await openTab(app, "plan");
  const plan = await waitForValue(() => app.ev(`${q('[data-orch-body="plan"]')}?.textContent ?? null`).then((t) => (/requirements not covered/.test(t ?? "") ? t : null)), "the refusal's reasons on the Plan tab", 20_000).catch(() => null);
  ok("the Plan tab shows the refusal's reasons", !!plan, plan);
  await app.shot("e3-split-panel-refused");
  await app.ev(`${q(".orch-panel__close")}?.click()`);
  await app.waitFor(`!${q(".orch-panel")}`, "the panel closed");
  await app.clickEl(q('[data-board-task="T-1"] [data-board-decompose-again]'));
  // while the second split goes on: its panel shows the proposal
  await app.waitFor(`${q('[data-board-task="T-1"][data-board-reason="decomposing"] [data-board-split-open]')} && true`, "«Открыть разбиение» of the second split", 60_000);
  await app.clickEl(q('[data-board-task="T-1"] [data-board-split-open]'));
  await openTab(app, "plan");
  const proposal = await waitForValue(() => app.ev(`${q('[data-orch-body="plan"]')}?.textContent ?? null`).then((t) => (/S2 Часть S2 — зависит от: —; закрывает: R2/.test(t ?? "") ? t : null)), "the proposal on the Plan tab", 90_000).catch(() => null);
  ok("the Plan tab shows the proposal: title, dependencies, covered R", !!proposal, proposal);
  await app.shot("e3-split-panel-proposal");
  await app.ev(`${q(".orch-panel__close")}?.click()`);
  await app.waitFor(`${q('[data-board-task="T-2"]')} && ${q('[data-board-task="T-3"]')} && true`, "the subtasks on the board", 120_000);
  const v = await view();
  ok("two subtasks were made by the second split", v.board.tasks.filter((t) => t.parentId === v.board.tasks.find((x) => x.key === "T-1").id).length === 2);
  const sub = await app.ev(`${q('[data-board-task="T-1"] [data-board-subtasks]')}?.textContent ?? null`);
  ok("T-1: «подзадачи: 0 из 2 в итоге доски»", /подзадачи: 0 из 2 в итоге доски/.test(sub ?? ""), sub);
  ok("no split buttons on T-1 any more", !(await has("T-1", "[data-board-decompose-again]")) && !(await has("T-1", "[data-board-decompose]")));
  await shot("subtasks-made");
}, 4000);

// ---------- 4. a provider's limit during the split ----------
await scenario(4, "a limit during the split", [
  [{ report: LIMIT }, { report: PROPOSAL2 }], turns("s2.txt"), turns("s3.txt"), turns("p.txt", ["R1", "R2"])
], async ({ app, ok, view, line, newTask, runBoard, shot }) => {
  await newTask({ title: "Большая задача", text: "Сделать две вещи", criteria: "первое\nвторое", decompose: true });
  await runBoard();
  const seen = new Set();
  await waitForValue(async () => {
    const r = await app.ev(`(() => ({ waits: ${q("[data-board-autopilot-waits]")}?.dataset.boardAutopilotWaits ?? null, resumed: ${q("[data-board-autopilot-resumed]")}?.dataset.boardAutopilotResumed ?? null,
      stop: ${q("[data-board-autopilot-stop]")}?.dataset.boardAutopilotStop ?? null }))()`);
    for (const x of [r.waits && `waits:${r.waits}`, r.resumed && `resumed:${r.resumed}`]) if (x) seen.add(x);
    return r.stop;
  }, "the autopilot ended", 240_000);
  const resumed = await view().then((v) => v.autopilot && Object.values(v.autopilot)[0]);
  ok("the autopilot ended all_done", resumed?.stop?.code === "all_done", resumed?.stop);
  const v = await view();
  const parent = v.board.tasks.find((t) => t.key === "T-1");
  const split = v.facts.filter((f) => f.decompositionOf === parent.id);
  ok("one split run, continued after the limit, proposed; two subtasks; T-1 done", split.length === 1 && split[0].split === "proposed"
    && v.board.tasks.filter((t) => t.parentId === parent.id).length === 2 && (await line("T-1")) !== null, split.map((f) => [f.status, f.split]));
  ok("T-1 «Готово»", (await app.ev(`${q('[data-board-task="T-1"]')}?.dataset.boardDone ?? null`)) === "confirmed", await line("T-1"));
  ok("the limit was seen: the autopilot waited or resumed", seen.size > 0, [...seen]);
  await shot("limit-done");
});

console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, passedList: passed, failures, fakeCliProcesses: ledgerTotal, shots: SHOTS }, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
