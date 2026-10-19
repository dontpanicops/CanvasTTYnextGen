// Electron UI smoke for C4, a provider's usage limit on the board (docs/agent-orchestration/implementation/stage-c4-limits.md):
// the real window at 1280×800, fake Codex/Claude CLIs, a temporary Git project.
//   1. one task, «Separate copy» with a check, «Run the board»;
//   2. the executor's turn ends at Claude's limit (the fake CLI's rate_limit_event, reset a few seconds ahead): the run
//      pauses as before, the board's autopilot stays on — «waiting for the Claude limit until …», the task's pause names
//      the limit with its time;
//   3. the reset passes: the autopilot continues the run itself — «continued T-1 after the limit reset …», the task
//      «Done», the autopilot «all done»; the notification «The limit reset, continuing: T-1» (when the window is not in
//      focus) and the Dock badge back to 0;
//   the project folder, its HEAD, status and branches as they were.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-board-limit-ui.mjs [--shots <dir>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, canvasState, card, createAgent, launch as launchApp, q, waitForValue, workspace, JOURNAL_V2 } from "./orchestration-app-kit.mjs";

const { D, project, script } = workspace("cto-board-limit-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const expect = (ok, what, got) => { (ok ? passed : failures).push(ok ? what : `${what}: ${JSON.stringify(got)?.slice(0, 400)}`); };
if (!JOURNAL_V2) throw new Error("the board is journal v2 only (goal.task)");

const node = project("board-limit-app");
const FILE = "src/limit.mjs";
// the reset a few seconds after the turn: due at reset + 60 s (§2.3), so 50 s behind the start of the turn plus a margin
const RESET_IN_S = 15;
const steps = [
  { report: { stages: [{ title: "Модуль", task: `Add ${FILE}`, conditions: [{ keep: null, text: `${FILE} exists`, covers: ["R1"], evidence: { kind: "change", check: null } }] }], dropped: [], dropRequirements: [], question: null } },
  { report: { __limit: { resetsAt: null } } }, // replaced below with the time of the run
  { report: { summary: "added", done: true }, writes: [[FILE, "export const limit = 1;\n"]] },
  { report: { conditions: [{ id: "C1", status: "met", paths: [FILE], note: "done" }], findings: [], request: "none", question: null } },
  { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "done" }] } }
];
const SCRIPT_DIR = D("script", "limit");
fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.writeFileSync(D("mock-state", ".codex", "config.toml"), "");
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_CHECKS: "none", MOCK_SCRIPT: SCRIPT_DIR, MOCK_SCRIPT_PER_CWD: "1",
  MOCK_TURN_DELAY_MS: "800", ...extra });
const SHELL = D("login-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.162.0", path: PATHS, env: env({ CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.303 (Claude Code)", path: PATHS, env: env({}) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const git = (...a) => execFileSync("git", a, { cwd: node, encoding: "utf8" }).trim();
const ledgerCount = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0);

let app;
const laptop = () => app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
async function boardShot(name) {
  const r = await app.ev(`(() => { const b = ${q("[data-board]")}.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const shot = await app.call("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
}
const view = () => app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");

try {
  app = await launchApp({ userData: D("user-data"), providers, port: PORT, shots: SHOTS });
  await laptop();
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
  await app.clickEl(q("[data-board-new]"));
  await app.waitFor(`${q("[data-board-form]")} && true`, "task form");
  await app.type(q('[data-board-field="title"]'), "Модуль limit");
  await app.type(q('[data-board-field="text"]'), "Добавить src/limit.mjs");
  await app.type(q('[data-board-field="criteria"]'), "src/limit.mjs есть");
  await app.clickEl(q("[data-board-save]"));
  await app.waitFor(`!${q("[data-board-form]")}`, "task form closed");
  const linkId = (await canvasState(app)).links[0].linkId;
  const saved = await app.ev(`window.canvasTTY.orchestration.profile(${JSON.stringify(linkId)}).then((r) => window.canvasTTY.orchestration.saveProfile(${JSON.stringify(linkId)},
    { ...r.value.profile, workMode: "copy", checks: ["node --version"] })).then((r) => r.ok)`);
  expect(saved === true, "the project's settings: a separate copy, a check", saved);
  const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branches: git("for-each-ref", "--format=%(refname)", "refs/heads"), files: fs.readdirSync(node).sort() };
  // the reset: RESET_IN_S after now, less the 60 s margin, so it is due RESET_IN_S from now
  steps[1] = { report: { __limit: { resetsAt: Math.floor(Date.now() / 1000) + RESET_IN_S - 60 } } };
  script("limit/1", steps);

  await app.clickEl(q("[data-board-autopilot-start]"));
  await app.waitFor(`${q("[data-board-autopilot-confirm]")} && true`, "the autopilot's explanation");
  await app.clickEl(q("[data-board-autopilot-yes]"));
  await app.waitFor(`${q('[data-board-autopilot="on"]')} && true`, "the autopilot on");

  // ---------- 2. the limit: the autopilot waits ----------
  const waitsText = await waitForValue(() => app.ev(`${q('[data-board-autopilot-waits="provider_limit"]')}?.textContent ?? null`), "the autopilot waits for the limit", 120_000);
  expect(/^ждёт лимита Claude до \d{1,2}:\d{2}$/.test(waitsText), "the autopilot: «ждёт лимита Claude до HH:MM»", waitsText);
  const v1 = await view();
  const fact = v1.facts[0];
  expect(fact.status === "paused" && fact.reason === "environment_error" && fact.providerLimit?.provider === "claude" && typeof fact.providerLimit.resetsAt === "number",
    "the run paused as before (environment_error), the limit known with its reset", fact);
  expect(v1.autopilot[linkId].on === true, "the autopilot stays on");
  const cardLine = await app.ev(`${q('[data-board-task="T-1"] [data-board-line-text]')}?.textContent ?? null`);
  expect(/^На паузе: исчерпан лимит использования Claude до \d{1,2}:\d{2}$/.test(cardLine ?? ""), "the task's card names the limit and its time", cardLine);
  await app.shot("limit-01-waits");
  await boardShot("limit-01-waits-board");

  // ---------- 3. the reset passes: continued by itself ----------
  const resumed = await waitForValue(() => app.ev(`${q("[data-board-autopilot-resumed]")}?.textContent ?? null`), "the autopilot continued", 120_000).catch(() => null);
  expect(/^продолжил T-1 после сброса лимита в /.test(resumed ?? ""), "the autopilot: «продолжил T-1 после сброса лимита в …»", resumed);
  await app.waitFor(`${q('[data-board-autopilot-stop="all_done"]')} && true`, "the autopilot done", 120_000);
  const v2 = await view();
  expect(v2.facts[0].status === "completed" && v2.facts[0].completion === "confirmed", "the task «Done», confirmed by checks", v2.facts[0]);
  const out = app.output();
  const notes = [...out.matchAll(/\[smoke\] notify (\{.*\})/g)].map((m) => JSON.parse(m[1]));
  const told = notes.find((n) => n.title === "Лимит сброшен, продолжаю: T-1");
  const focused = await app.ev("document.hasFocus()");
  expect(told ? told.body === "Claude" : focused, "the notification «Лимит сброшен, продолжаю: T-1» (or the window was in focus: none, by the rule)", { notes, focused });
  const badges = [...out.matchAll(/\[smoke\] notify badge (\d+)/g)].map((m) => Number(m[1]));
  expect(badges.at(-1) === 0, "the Dock badge back to 0", badges);
  await boardShot("limit-02-done-board");

  const after = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branches: git("for-each-ref", "--format=%(refname)", "refs/heads"), files: fs.readdirSync(node).sort() };
  expect(after.head === before.head && after.status === before.status && JSON.stringify(after.files) === JSON.stringify(before.files)
    && after.branches.split("\n").filter((b) => !b.startsWith("refs/heads/raoden/")).join() === before.branches.split("\n").join(),
    "the project folder, its HEAD, status and the person's branches as they were", { before, after });
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 1500)}`);
  try { await app?.shot("failure"); } catch {}
} finally {
  const exit = await app?.quit?.();
  console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, passedList: passed, failures, fakeCliProcesses: ledgerCount(), shots: SHOTS, exit }, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}
