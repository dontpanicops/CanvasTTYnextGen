// Electron UI smoke for C3, a merge conflict resolved by an agent (docs/agent-orchestration/implementation/stage-c3-conflicts.md):
// the real window at 1280×800, fake Codex/Claude CLIs (one script per work folder), a temporary Git project.
//   1. two tasks that both add src/shared.mjs, «Separate copy» with node --test, «Run the board» with its defaults
//      (2 at once, «Конфликты: поручать агенту»);
//   2. the second merge conflicts and goes to an agent by itself: the board says «an agent resolves the conflict», the
//      task's card «merging: an agent resolves the conflict», «Open the run» opens the resolution run (no lead turn);
//   3. its resolution checked, both tasks in the board's result, the autopilot «all done»;
//   4. two more tasks conflict again; the agent's reviewer asks for a new plan: «the agent did not resolve it», why, its
//      run, «Hand to an agent again»; the person resolves the copy, «Done, check» — all four in the result;
//   the project folder, its HEAD, status and branches as they were.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-board-c3-ui.mjs [--shots <dir>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, canvasState, card, createAgent, launch as launchApp, q, waitForValue, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("cto-board-c3-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };
if (!JOURNAL_V2) throw new Error("the board is journal v2 only (goal.task)");

// ---------- the project and the fake CLIs: one script per work folder, in the order the folders first call ----------
const node = project("board-c3-app");
const SHARED = "src/shared.mjs";
const steps = (value) => [
  { report: { stages: [{ title: "Общий модуль", task: `Add ${SHARED}`, conditions: [{ keep: null, text: `${SHARED} exists`, covers: ["R1"], evidence: { kind: "change", check: null } }] }], dropped: [], dropRequirements: [], question: null } },
  { report: { summary: `${value} added`, done: true }, writes: [[SHARED, `export const shared = "${value}";\n`]] },
  { report: { conditions: [{ id: "C1", status: "met", paths: [SHARED], note: "done" }], findings: [], request: "none", question: null } },
  { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "done" }] } }
];
// a resolution run: the executor, the reviewer of the stage, the final review (two requirements: the markers', the task's)
const resolved = [
  { report: { summary: "both kept", done: true }, writes: [[SHARED, 'export const shared = "one-two";\n']] },
  { report: { conditions: [{ id: "C1", status: "met", paths: [SHARED], note: "both kept" }], findings: [], request: "none", question: null } },
  { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "ok" }, { id: "R2", status: "met", note: "ok" }] } }
];
const replan = [
  { report: { summary: "tried", done: true }, writes: [[SHARED, 'export const shared = "three";\n']] },
  { report: { conditions: [{ id: "C1", status: "not_met", paths: [SHARED], note: "four is lost" }], findings: [], request: "replan", question: null } }
];
script("c3/1", steps("one"));
script("c3/2", steps("two"));
script("c3/3", resolved);
script("c3/4", steps("three"));
script("c3/5", steps("four"));
script("c3/6", replan);
const SCRIPT = D("script", "c3");
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.writeFileSync(D("mock-state", ".codex", "config.toml"), "");
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_CHECKS: "none", MOCK_SCRIPT: SCRIPT, MOCK_SCRIPT_PER_CWD: "1",
  MOCK_TURN_DELAY_MS: "1500", ...extra }); // the agent's line on the board stays long enough to be seen and opened
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: PATHS, env: env({ CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({}) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const git = (...a) => execFileSync("git", a, { cwd: node, encoding: "utf8" }).trim();
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);

let app;
const laptop = () => app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const shown = (key) => app.ev(`(() => { const el = ${q(`[data-board-task="${key}"]`)}; return el && { done: el.dataset.boardDone ?? null,
  mark: el.querySelector("[data-board-merge-mark]")?.textContent ?? null }; })()`);
async function newTask({ title, text, criteria }) {
  await app.clickEl(q("[data-board-new]"));
  await app.waitFor(`${q("[data-board-form]")} && true`, "task form");
  await app.type(q('[data-board-field="title"]'), title);
  await app.type(q('[data-board-field="text"]'), text);
  await app.type(q('[data-board-field="criteria"]'), criteria);
  await app.clickEl(q("[data-board-save]"));
  await app.waitFor(`!${q("[data-board-form]")}`, "task form closed");
}
async function boardShot(name) {
  const r = await app.ev(`(() => { const b = ${q("[data-board]")}.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const shot = await app.call("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
}
const view = () => app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");
async function runBoard() {
  await app.clickEl(q("[data-board-autopilot-start]"));
  await app.waitFor(`${q("[data-board-autopilot-confirm]")} && true`, "the autopilot's explanation");
  await app.clickEl(q("[data-board-autopilot-yes]"));
  await app.waitFor(`${q('[data-board-autopilot="on"]')} && true`, "the autopilot on");
}

try {
  app = await launchApp({ userData: D("user-data"), providers, port: PORT, shots: SHOTS });
  await laptop();
  // ---------- 1. the link, the board, two tasks, a separate copy ----------
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
  await newTask({ title: "Общий модуль one", text: "Добавить src/shared.mjs со значением one", criteria: "src/shared.mjs есть" });
  await newTask({ title: "Общий модуль two", text: "Добавить src/shared.mjs со значением two", criteria: "src/shared.mjs есть" });
  const linkId = (await canvasState(app)).links[0].linkId;
  const saved = await app.ev(`window.canvasTTY.orchestration.profile(${JSON.stringify(linkId)}).then((r) => window.canvasTTY.orchestration.saveProfile(${JSON.stringify(linkId)},
    { ...r.value.profile, workMode: "copy", checks: ["node --test"] })).then((r) => r.ok)`);
  expect(saved === true, "the project's settings: a separate copy, node --test", saved);
  const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branches: git("for-each-ref", "--format=%(refname)", "refs/heads"), files: fs.readdirSync(node).sort() };
  await runBoard();
  expect((await app.ev(`${q("[data-board-autopilot-conflicts]")}?.dataset.boardAutopilotConflicts`)) === "agent", "the autopilot says «Конфликты: поручать агенту»");

  // ---------- 2. the conflict goes to an agent by itself ----------
  const agentLine = await waitForValue(() => app.ev(`${q("[data-board-head-agent]")}?.textContent ?? null`), "the board's line «an agent resolves the conflict»", 180_000);
  expect(agentLine.includes("агент разрешает конфликт"), "the board says an agent resolves the conflict", agentLine);
  const v1 = await view();
  const going = v1.heads[0].merges.find((m) => m.agent?.pending);
  const resolutionRunId = going?.agent.resolutionRunId;
  const markAgent = await shown(going.task.key);
  expect(markAgent?.mark === "объединяется: агент разрешает конфликт", "the task's card: «merging: an agent resolves the conflict»", markAgent);
  const listed = await app.ev("window.canvasTTY.orchestration.list().then((r) => r.value.map((s) => s.view.runId))");
  expect(!listed.includes(resolutionRunId), "the resolution run is not in the list of runs (it is on no link)", listed);
  await app.shot("c3-01-agent-resolves");
  await boardShot("c3-01-agent-resolves-board");
  await app.clickEl(q("[data-board-head-agent-open]"));
  const panelRun = await waitForValue(() => app.ev(`${q("[data-orch-run-id]")}?.dataset.orchRunId ?? null`), "the resolution run's panel", 15_000).catch(() => null);
  expect(panelRun === resolutionRunId, "«Open the run» opens the resolution run", [panelRun, resolutionRunId]);
  await app.shot("c3-02-resolution-panel");
  await app.ev(`${q(".orch-panel__close")}?.click()`);
  await app.waitFor(`!${q(".orch-panel")}`, "the panel closed");

  // ---------- 3. both in the result ----------
  await app.waitFor(`${q('[data-board-autopilot-stop="all_done"]')} && true`, "the autopilot done", 180_000);
  const v2 = await view();
  const h2 = v2.heads[0];
  const m2 = h2.merges.find((m) => m.runId === going.runId);
  expect(m2.status === "completed" && m2.completion === "confirmed", "the agent's merge completed with its checks", [m2.status, m2.completion]);
  expect(execFileSync("git", ["show", `${h2.commit}:${SHARED}`], { cwd: node, encoding: "utf8" }) === 'export const shared = "one-two";\n', "the result holds the agent's resolution");
  const resolution = await app.ev(`window.canvasTTY.orchestration.get(${JSON.stringify(resolutionRunId)}).then((r) => r.ok && r.value.view.status)`);
  expect(resolution === "completed", "the resolution run completed", resolution);
  expect((await shown(going.task.key))?.mark === "в итоге доски", "the task's card: «in the board's result»");
  await boardShot("c3-03-both-in-result-board");

  // ---------- 4. the agent does not get there; the person finishes ----------
  await newTask({ title: "Общий модуль three", text: "Добавить src/shared.mjs со значением three", criteria: "src/shared.mjs есть" });
  await newTask({ title: "Общий модуль four", text: "Добавить src/shared.mjs со значением four", criteria: "src/shared.mjs есть" });
  await runBoard();
  await app.waitFor(`${q('[data-board-merge-waits="merge_agent_failed"]')} && true`, "the merge waits: the agent did not resolve it", 240_000);
  const why = await app.ev(`${q("[data-board-merge-agent-why]")}?.dataset.boardMergeAgentWhy ?? null`);
  expect(why === "replan", "the why: the reviewer asked for a new plan", why);
  const again = await app.ev(`${q("[data-board-merge-agent]")}?.textContent ?? null`);
  expect(again === "Поручить агенту ещё раз", "«Hand to an agent again» offered", again);
  expect(!!(await app.ev(`${q("[data-board-merge-agent-open]")} && true`)), "the agent's run can be opened from the pause");
  await app.shot("c3-04-agent-failed");
  await boardShot("c3-04-agent-failed-board");
  const v3 = await view();
  const waits = v3.heads[0].merges.find((m) => m.status === "paused");
  fs.writeFileSync(path.join(waits.dir, SHARED), 'export const shared = "one-two-three-four";\n');
  await app.clickEl(q("[data-board-merge-check]"));
  // the merge completes; the autopilot was waiting for the person, now nothing is left
  await waitForValue(async () => (await view()).heads[0].merges.find((m) => m.runId === waits.runId && m.status === "completed"), "the person's resolution merged", 120_000);
  const h4 = (await view()).heads[0];
  expect(execFileSync("git", ["show", `${h4.commit}:${SHARED}`], { cwd: node, encoding: "utf8" }) === 'export const shared = "one-two-three-four";\n', "the result holds the person's resolution after the agent's try");
  await boardShot("c3-05-person-finished-board");

  const after = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branches: git("for-each-ref", "--format=%(refname)", "refs/heads"), files: fs.readdirSync(node).sort() };
  expect(after.head === before.head && after.status === before.status && JSON.stringify(after.files) === JSON.stringify(before.files)
    && after.branches.split("\n").filter((b) => !b.startsWith("refs/heads/raoden/")).join() === before.branches.split("\n").join(),
    "the project folder, its HEAD, status and the person's branches as they were", { before, after });
  await app.shot("c3-06-done");
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 1500)}`);
  try { await app?.shot("failure"); } catch {}
} finally {
  const exit = await app?.quit?.();
  console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, passedList: passed, failures, fakeCliProcesses: ledgerCount(), shots: SHOTS, exit }, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}
