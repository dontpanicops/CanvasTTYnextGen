// Electron UI smoke for F2, external tasks and a role's model per task (docs/agent-orchestration/implementation/
// stage-f-external-projects.md §6, §10, §11): the real window at 1280×800, fake Codex/Claude CLIs (one script per work
// folder), a temporary Git project in a separate copy, the board's autopilot with one place. The steps f2.s1–f2.s8:
//   f2.s1 a file with the external T1-MR without criteria (through «Импорт задач», the smoke's file hook): the card says
//         «внешняя», one requirement «Отметка человека «Выполнено»», no «Запустить»; the autopilot never takes it;
//   f2.s2 «Выполнено» on T1-MR while T1 is not «Готово»: the button is unavailable, main refuses deps_not_done; T2 waits_external;
//   f2.s3 «Выполнено» with a note on E1, «Снять отметку», «Выполнено» again; its dependent in the queue after the mark; once
//         the dependent started — dependents_started;
//   f2.s4 a start of an external task from the window (the goal dialog's call) → external_task; a task with runs made
//         external (board.json, after a restart) goes by its runs — external_has_runs, no mark;
//   f2.s5 «ordinary → external -MR → ordinary» with the autopilot on: after T1 it waits (wait / external, «ждёт отметки
//         внешней задачи T-2»), its runs and minutes stay, after the mark it takes T2;
//   f2.s6 «Разбить» on an external task → external_task (the form and main), no split run;
//   f2.s7 T-4: T2's models.executor over the profile's (the fake Claude gets --model of the task, the others the
//         profile's); a task with a Codex model the account is not offered — the readiness blocker model_unavailable, the
//         autopilot off not_ready, no run, the start refused model_unavailable;
//   f2.s8 the platform: here (macOS arm64) the new inputs are available; another platform is the tests' (no hook in the
//         application fakes it — orchestration-board-external.test.mjs: linux/arm64 and darwin/x64).
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-board-f2-ui.mjs [--shots <dir>]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, JOURNAL_V2, NODE, canvasState, card, createAgent, launch as launchApp, q, sleep, waitForValue, workspace } from "./orchestration-app-kit.mjs";

if (!JOURNAL_V2) throw new Error("the board is journal v2 only (goal.task)");
const { D, project, script } = workspace("cto-board-f2-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const ok = (what, cond, got) => { (cond ? passed : failures).push(cond ? what : `${what}: ${JSON.stringify(got)?.slice(0, 600)}`); };

// ---------- the fake CLIs' answers: one task's four turns per work folder (T1, T3, T2 in this order) ----------
const cond = (file) => ({ keep: null, text: `${file} says done`, covers: ["R1"], evidence: { kind: "change", check: null } });
const turns = (file) => [
  { report: { stages: [{ title: "fix", task: `write ${file}`, conditions: [cond(file)] }], dropped: [], dropRequirements: [], question: null } },
  { report: { summary: "done", done: true }, writes: [[file, "done\n"]] },
  { report: { conditions: [{ id: "C1", status: "met", paths: [file], note: "written" }], findings: [], request: "none", question: null } },
  { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "written" }] } }
];
const node = project("board-f2-app");
for (const [k, file] of ["t1.txt", "t3.txt", "t2.txt"].entries()) script(`f2/${k + 1}`, turns(file));
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.writeFileSync(D("mock-state", ".codex", "config.toml"), "");
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_CHECKS: "none", MOCK_SCRIPT: D("script", "f2"), MOCK_SCRIPT_PER_CWD: "1",
  MOCK_TURN_DELAY_MS: "300", ...extra });
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.162.0", path: PATHS, env: env({ CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({}) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const userData = D("user-data");
const BUTTON_FILE = D("chosen", "tasks.json"); // what the smoke's hook names instead of the dialog
fs.mkdirSync(path.dirname(BUTTON_FILE), { recursive: true });
const CRITERION = "Отметка человека «Выполнено»";

const row = (ref, over = {}) => ({ ref, project: node, title: `Задача ${ref}`, text: `Сделать ${ref}`, criteria: [`${ref} готово`], ...over });
const file = (tasks) => JSON.stringify({ format: "board-tasks/v1", workspaceId: "common", source: "smoke-f2", tasks });
const claudeModels = () => {
  const f = D("mock-state", "claude-argv.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l); const i = a.indexOf("--model"); return i >= 0 ? a[i + 1] : null; }) : [];
};

let app;
const view = () => app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");
const taskOf = async (ref) => (await view()).board.tasks.find((t) => t.ref === ref);
const sel = (key, inner = "") => q(`[data-board-task="${key}"] ${inner}`.trim());
const line = (key) => app.ev(`${sel(key, "[data-board-line-text]")}?.textContent ?? null`);
const has = (key, inner) => app.ev(`!!${sel(key, inner)}`);
const reason = (key) => app.ev(`${sel(key)}?.dataset.boardReason ?? null`);
const ipc = (call) => app.ev(`window.canvasTTY.orchestration.${call}`);
// a card low in its column: scrolled into view first (the column scrolls on its own)
const click = async (selector) => { await app.ev(`${selector}?.scrollIntoView({ block: "center" })`); await app.clickEl(selector); };
const shot = (name) => app.shot(`f2-${name}`).catch((e) => console.log(`[smoke] screenshot ${name}: ${String(e?.message ?? e)}`));
const apState = async () => Object.values((await view()).autopilot ?? {})[0] ?? null;
let linkId = null;

async function start() {
  app = await launchApp({ userData, providers, port: PORT, shots: SHOTS, env: { CANVASTTY_USER_DATA_DIR: userData, CANVASTTY_SMOKE_IMPORT_FILE: BUTTON_FILE } });
  await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await app.waitFor("!!window.canvasTTY?.orchestration", "the orchestration API");
}
async function showBoard() {
  if (!(await app.ev(`!!${q("[data-board]")}`))) await app.clickEl(q("[data-board-button]"));
  await app.waitFor(`${q("[data-board]")} && true`, "the board on the canvas");
}
async function importFile(tasks) {
  fs.writeFileSync(BUTTON_FILE, file(tasks));
  await app.clickEl(q("[data-board-import]"));
  const r = await waitForValue(() => app.ev(`${q("[data-board-import-report]")}?.dataset.boardImportReport ?? null`), "the import's report");
  await app.clickEl(q(".launch-dialog__close"));
  await app.waitFor(`!${q("[data-board-import-report]")}`, "the report window closed");
  return r;
}
async function runBoard() {
  await app.clickEl(q("[data-board-autopilot-start]"));
  await app.waitFor(`${q("[data-board-autopilot-confirm]")} && true`, "the autopilot's explanation");
  await app.clickEl(q("[data-board-autopilot-yes]"));
  await app.waitFor(`${q('[data-board-autopilot="on"]')} && true`, "the autopilot on");
}
async function mark(key, note) {
  await click(sel(key, "[data-board-external-done]"));
  await app.waitFor(`${sel(key, "[data-board-external-confirm]")} && true`, `${key}: the mark's note`);
  if (note) await app.type(sel(key, "[data-board-external-note]"), note);
  await click(sel(key, "[data-board-external-yes]"));
  await app.waitFor(`${q(`[data-board-task="${key}"][data-board-done="external"]`)} && true`, `${key} marked`);
}

try {
  await start();
  // ---------- f2.s8: the new inputs here ----------
  ok("f2.s8 here (macOS arm64) the new inputs are available — «Выполнено» on another platform is the tests' (no hook fakes the platform)",
    await app.ev("window.canvasTTY.orchestration.newInputs") === true);
  // the lead (Codex) and the executor (Claude) on one link; the project in a separate copy, one place, the executor's model
  await createAgent(app, "Агент Codex (лид)", node);
  await createAgent(app, "Агент Claude (исполнитель)", node);
  const c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex"), exec = c.agents.find((a) => a.provider === "claude");
  const ends = () => Promise.all([app.center(card(lead.agentId, ".agent-card__port")), app.center(card(exec.agentId, ".agent-card__body"))]);
  let prev = null;
  const [from, to] = await waitForValue(async () => { const e = await ends(); const still = prev && JSON.stringify(prev) === JSON.stringify(e); prev = e; return still ? e : null; }, "the cards laid out");
  await app.drag(from, to, 20);
  await app.waitFor("window.canvasTTY.orchestration.canvas().then((r) => r.value.links.length === 1)", "link");
  linkId = (await canvasState(app)).links[0].linkId;
  await showBoard();
  const saved = await app.ev(`window.canvasTTY.orchestration.profile(${JSON.stringify(linkId)}).then((r) => window.canvasTTY.orchestration.saveProfile(${JSON.stringify(linkId)},
    { ...r.value.profile, workMode: "copy", checks: ["true"], models: { lead: null, executor: "sonnet", reviewer: null } })).then((r) => r.ok)`);
  const budget = await ipc(`boardBudget(${JSON.stringify(linkId)}, { runs: 10, minutes: 240, parallel: 1 }).then((r) => r.ok)`);
  ok("the project's settings: a separate copy, a check, the executor's model sonnet; one place", saved === true && budget === true, [saved, budget]);

  // ---------- f2.s1: the import with the external T1-MR without criteria ----------
  const imported = await importFile([row("T1"), row("T1-MR", { criteria: undefined, external: true, dependsOn: ["T1"] }),
    row("T2", { dependsOn: ["T1-MR"], models: { executor: "opus" } }), row("E1", { criteria: undefined, external: true }), row("T3", { dependsOn: ["E1"] })]);
  const v1 = await view();
  const keyOf = Object.fromEntries(v1.board.tasks.map((t) => [t.ref, t.key]));
  ok("f2.s1 imported: T1, T1-MR, T2, E1, T3 → T-1…T-5", imported === "imported" && JSON.stringify(Object.values(keyOf)) === JSON.stringify(["T-1", "T-2", "T-3", "T-4", "T-5"]), keyOf);
  const mr = v1.board.tasks.find((t) => t.ref === "T1-MR");
  ok("f2.s1 T1-MR: external, one requirement «Отметка человека «Выполнено»»", mr.external === true && JSON.stringify(mr.criteria) === JSON.stringify([CRITERION]), mr);
  const ext = await app.ev(`${sel("T-2", "[data-board-external]")}?.textContent ?? null`);
  ok("f2.s1 the card: «внешняя», «Выполнено», no «Запустить»", ext === "внешняя" && (await has("T-2", "[data-board-external-done]")) && !(await has("T-2", "[data-board-start]"))
    && !(await has("T-2", "[data-board-start-anyway]")), ext);
  ok("f2.s1 T2 keeps its model: models.executor opus", JSON.stringify(v1.board.tasks.find((t) => t.ref === "T2").models) === JSON.stringify({ executor: "opus" }));
  await shot("s1-external");

  // ---------- f2.s2: «Выполнено» while T1 is not «Готово» ----------
  const disabled = await app.ev(`${sel("T-2", "[data-board-external-done]")}?.disabled ?? null`);
  const refused2 = await ipc(`boardExternalMark(${JSON.stringify(mr.id)}, true)`);
  ok("f2.s2 «Выполнено» unavailable; main refuses deps_not_done", disabled === true && refused2.code === "deps_not_done", [disabled, refused2]);
  ok("f2.s2 the dependent T2 waits_external: «Ждёт отметки внешней задачи T-2»", (await reason("T-3")) === "waits_external" && (await line("T-3")) === "Ждёт отметки внешней задачи T-2", [await reason("T-3"), await line("T-3")]);
  await shot("s2-waits-external");

  // ---------- f2.s4: a start of an external task from the window ----------
  const goal = (t) => ({ text: t.text, criteria: t.criteria, checks: [], commands: ["true"], mode: "autopilot", workMode: "copy", task: { id: t.id, key: t.key } });
  const s4 = await ipc(`startOnLink(${JSON.stringify({ linkId, requestId: crypto.randomUUID(), goal: goal(mr) })})`);
  ok("f2.s4 a start of T1-MR (the goal dialog's call) → external_task, no run", s4.code === "external_task" && (await view()).facts.length === 0, s4);

  // ---------- f2.s6: «Разбить» on an external task ----------
  await click(sel("T-4", ".board-task__title"));
  await app.waitFor(`${q("[data-board-form]")} && true`, "the form of E1");
  await app.clickEl(q('[data-board-field="decompose"]'));
  await app.clickEl(q("[data-board-save]"));
  const formError = await waitForValue(() => app.ev(`${q("[data-board-form] .orch-error")}?.textContent ?? null`), "the form's refusal").catch(() => null);
  ok("f2.s6 «Разбить на подзадачи» on E1 → «Внешнюю задачу не запускают и не разбивают…» (external_task)", formError === "Внешнюю задачу не запускают и не разбивают: её отмечает человек («Выполнено»)", formError);
  await app.clickEl(q(".launch-dialog__close"));
  await app.waitFor(`!${q("[data-board-form]")}`, "the form closed");
  const e1 = await taskOf("E1");
  const s6 = await ipc(`boardDecompose(${JSON.stringify(e1.id)}, "ru")`);
  ok("f2.s6 «Разбить» (main) → external_task; E1 not marked «Разбить»", s6.code === "external_task" && !e1.decompose, [s6, e1.decompose]);
  await shot("s6-no-split");

  // ---------- f2.s3: «Выполнено» with a note, «Снять отметку», «Выполнено» again ----------
  await mark("T-4", "сделано вручную");
  ok("f2.s3 E1 «Готово (отмечено вами: «Выполнено»)», the note on the card and in board.json", (await line("T-4")) === "Готово (отмечено вами: «Выполнено»)"
    && (await app.ev(`${sel("T-4", "[data-board-external]")}?.textContent ?? null`)) === "внешняя · сделано вручную" && (await taskOf("E1")).externalDone?.note === "сделано вручную",
  [await line("T-4"), (await taskOf("E1")).externalDone]);
  ok("f2.s3 its dependent T3 in the queue without a reason after the mark", (await app.ev(`${sel("T-5")}?.dataset.boardTaskColumn`)) === "queue" && (await reason("T-5")) === null
    && (await has("T-5", "[data-board-start]")), await reason("T-5"));
  await shot("s3-marked");
  await click(sel("T-4", "[data-board-external-undo]"));
  await app.waitFor(`${q('[data-board-task="T-5"][data-board-reason="waits_external"]')} && true`, "T3 waits again");
  ok("f2.s3 «Снять отметку» while T3 is not started: E1 back in the queue, T3 waits_external", (await app.ev(`${sel("T-4")}?.dataset.boardDone ?? null`)) === null
    && !(await taskOf("E1")).externalDone, await line("T-4"));
  await mark("T-4");

  // ---------- f2.s5: the autopilot on — T1, then T3 (E1 marked), then it waits for the mark of T1-MR ----------
  await runBoard();
  const waiting = await waitForValue(async () => { const s = await apState(); return s?.on && s.waits === "external" ? s : null; }, "the autopilot waits for T1-MR's mark", 240_000).catch(() => null);
  const v5 = await view();
  const started = (ref) => v5.facts.filter((f) => f.taskId === v5.board.tasks.find((t) => t.ref === ref).id);
  ok("f2.s5 after T1 (and T3, whose E1 is marked) the autopilot waits — wait / external with the key T-2, not off", waiting?.waitsKey === "T-2" && started("T1").length === 1
    && started("T3").length === 1 && started("T2").length === 0, waiting);
  ok("f2.s1 the autopilot never took an external task", started("T1-MR").length === 0 && started("E1").length === 0);
  const waitsText = await waitForValue(() => app.ev(`${q('[data-board-autopilot-waits="external"]')}?.textContent ?? null`), "the autopilot's line").catch(() => null);
  ok("f2.s5 the autopilot's line: «ждёт отметки внешней задачи T-2»", waitsText === "ждёт отметки внешней задачи T-2", waitsText);
  await shot("s5-waits");
  // f2.s3: T3 has started — the mark of E1 can no longer be taken off
  const undo = await ipc(`boardExternalMark(${JSON.stringify(e1.id)}, false)`);
  ok("f2.s3 «Снять отметку» once T3 started → dependents_started, the mark stays", undo.code === "dependents_started" && !!(await taskOf("E1")).externalDone, undo);
  const before = await apState();
  await sleep(6000);
  const after = await apState();
  ok("f2.s5 the wait spends nothing: the runs and the minutes are the same after 6 s", after.waits === "external" && after.used.runs === before.used.runs && after.used.minutes === before.used.minutes
    && after.used.runs === 2, { before: before.used, after: after.used });
  await mark("T-2", "MR T1 влит");
  const taken = await waitForValue(async () => { const v = await view(); const t2 = v.board.tasks.find((t) => t.ref === "T2"); return v.facts.some((f) => f.taskId === t2.id) ? v : null; }, "T2 started", 30_000).catch(() => null);
  ok("f2.s5 after the mark the autopilot takes T2", !!taken);
  await app.waitFor(`${q('[data-board-autopilot-stop="all_done"]')} && true`, "the autopilot all_done", 240_000);
  ok("f2.s5 the chain «T1 → T1-MR → T2» is done: T2 «Готово — подтверждено проверками»", (await app.ev(`${sel("T-3")}?.dataset.boardDone ?? null`)) === "confirmed", await line("T-3"));

  // ---------- f2.s7: T-4 — the task's model over the profile's; an unknown Codex model ----------
  ok("f2.s7 the fake Claude got the profile's sonnet for T1 and T3 and the task's opus for T2", JSON.stringify(claudeModels()) === JSON.stringify(["sonnet", "sonnet", "opus"]), claudeModels());
  const v7 = await view();
  const runOf = (ref) => v7.facts.find((f) => f.taskId === v7.board.tasks.find((t) => t.ref === ref).id).runId;
  const models = await ipc(`get(${JSON.stringify(runOf("T2"))}).then((r) => r.value.view.progress.models)`);
  const models1 = await ipc(`get(${JSON.stringify(runOf("T1"))}).then((r) => r.value.view.progress.models)`);
  ok("f2.s7 the goals: T2 executor opus, T1 executor sonnet (the profile's)", models?.executor === "opus" && models1?.executor === "sonnet", [models, models1]);
  await importFile([row("U1", { models: { lead: "gpt-nope" } })]);
  const u1 = await taskOf("U1");
  const ready = await ipc(`readiness(${JSON.stringify({ linkId, commands: ["true"], workMode: "copy", models: { lead: "gpt-nope", executor: "sonnet", reviewer: null } })})`);
  const item = ready.value?.items.find((i) => i.id === "model");
  ok("f2.s7 the readiness of U1's goal: the blocker model_unavailable (gpt-nope)", ready.value?.ready === false && item?.level === "blocker" && item.facts?.code === "model_unavailable" && item.facts.model === "gpt-nope", item);
  const factsBefore = (await view()).facts.length;
  await runBoard();
  await app.waitFor(`${q('[data-board-autopilot-stop="not_ready"]')} && true`, "the autopilot off not_ready", 60_000);
  const stop = (await apState()).stop;
  ok("f2.s7 the autopilot off not_ready «model: Codex: model gpt-nope…», U1 not started (no run failed)", stop.key === u1.key && /^model: Codex: model gpt-nope is not available/.test(stop.detail)
    && (await view()).facts.length === factsBefore, stop);
  const refused7 = await ipc(`startOnLink(${JSON.stringify({ linkId, requestId: crypto.randomUUID(), goal: { ...goal(u1), models: { lead: "gpt-nope" } } })})`);
  ok("f2.s7 a start with U1's model → model_unavailable, no run", refused7.code === "model_unavailable" && (await view()).facts.length === factsBefore, refused7);
  await shot("s7-model-unavailable");

  // ---------- f2.s6: no split run ever ----------
  ok("f2.s6 no decomposition run was made", !(await view()).facts.some((f) => f.decompositionOf), (await view()).facts.map((f) => f.decompositionOf));

  // ---------- f2.s4: a task with runs made external (board.json by hand, after a restart) goes by its runs ----------
  await app.quit();
  const boardPath = path.join(userData, "orchestration", "board.json");
  const b = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  const t3 = b.tasks.find((t) => t.ref === "T3");
  t3.external = true;
  fs.writeFileSync(boardPath, JSON.stringify(b));
  await start();
  await showBoard();
  await app.waitFor(`${sel("T-5")} && true`, "T3 on the board");
  const runsLine = await app.ev(`${sel("T-5", "[data-board-external]")}?.textContent ?? null`);
  ok("f2.s4 T3 (external, with its run): by its run — «Готово — подтверждено проверками», «У задачи есть запуски, внешней она не считается», no «Выполнено»",
    (await app.ev(`${sel("T-5")}?.dataset.boardDone ?? null`)) === "confirmed" && runsLine === "У задачи есть запуски, внешней она не считается" && !(await has("T-5", "[data-board-external-done]")), runsLine);
  const s4b = await ipc(`boardExternalMark(${JSON.stringify(t3.id)}, true)`);
  ok("f2.s4 «Выполнено» on it → external_has_runs", s4b.code === "external_has_runs", s4b);
  await shot("s4-has-runs");
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 1500)}`);
  try { await app?.shot("f2-failure"); } catch {}
} finally {
  await app?.quit?.();
}

console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, passedList: passed, failures, fakeCliProcesses: fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0, shots: SHOTS }, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
