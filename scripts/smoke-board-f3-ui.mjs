// Electron UI smoke for F3, the base, the branch and the commit (docs/agent-orchestration/implementation/
// stage-f-external-projects.md §7, §10, §11): the real window at 1280×800, fake Codex/Claude CLIs (one script per work
// folder), a fixture Git project with a bare remote «upstream» (its branch «stable» is the run base) and the hooks
// pre-commit and commit-msg (a neutral fixture hook: the issue ISSUE-1 in the message or in the branch), the worktree mode
// (the path autopilotParallelStep), a neutral fixture profile after §7.6: branchTemplate {issue}-{ref}, runBase
// upstream/stable. The fake login shell logs its lines; on request its `git fetch` fails or hangs. The steps f3.s1–f3.s9:
//   f3.s1 the template's refusals in the profile: branch_template_invalid (no {ref}/{run8}, «..», a space),
//         branch_template_unknown ({foo}), work_mode_not_worktree (copy);
//   f3.s2 runBase: the remote's address read and kept; remote_base_mode in copy and project; runBase changed while the
//         autopilot is on (it waits for a mark) — settings_changed, before any fetch;
//   f3.s3 a free run passes; «Разбить» unavailable (the form, main: remote_base_mode); the dialog's start of a board
//         task — remote_base_dialog; T1-MR gets no waits_mr; a direct dependency on an ordinary task — waits_mr on the
//         card and others_wait of the autopilot;
//   f3.s4 two tasks chained through T1-MR, the remote moved between the starts: T1 on ISSUE-1-T1 from the remote's commit,
//         its commit through the hooks; no board's ref, no merge, no take; the mark of T1-MR — a new fetch, T2 from the
//         moved commit; after «Готово» the names are the same;
//   f3.s5 the branch ISSUE-1-T3 only on the remote — the run on ISSUE-1-T3-2; every name up to -9 taken — branch_taken;
//   f3.s6 the commit-msg hook refuses — a pause finish_unconfirmed, not «Готово»; no --no-verify;
//   f3.s7 the fetch fails, or hangs longer than its 120 s — base_fetch_failed; another fetch address — base_remote_mismatch;
//         no run; pushurl ≠ url with the right url — the base is taken (f3.s8 runs so);
//   f3.s8 a task without issue (its dependency done) at {issue}-{ref} — branch_template_field on its card, the autopilot takes
//         the next one and does not stop on it;
//   f3.s9 the profile without the new keys: canvastty/<run8>, the take raoden/…, the board's result made and merged as before.
// Needs `npm run build` first. Starts no real model. Usage: node scripts/smoke-board-f3-ui.mjs [--shots <dir>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, JOURNAL_V2, NODE, canvasState, card, createAgent, launch as launchApp, q, waitForValue, workspace } from "./orchestration-app-kit.mjs";

if (!JOURNAL_V2) throw new Error("the board is journal v2 only (goal.task)");
const { D, git, project, script } = workspace("cto-board-f3-");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : D("shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 150);
const failures = [];
const passed = [];
const ok = (what, cond, got) => { (cond ? passed : failures).push(cond ? what : `${what}: ${JSON.stringify(got)?.slice(0, 600)}`); };

// ---------- the fake CLIs' answers: one script per work folder, in the order of the runs ----------
const cond = (file) => ({ keep: null, text: `${file} says done`, covers: ["R1"], evidence: { kind: "change", check: null } });
const turns = (file) => [
  { report: { stages: [{ title: "fix", task: `write ${file}`, conditions: [cond(file)] }], dropped: [], dropRequirements: [], question: null } },
  { report: { summary: "done", done: true }, writes: [[file, "done\n"]] },
  { report: { conditions: [{ id: "C1", status: "met", paths: [file], note: "written" }], findings: [], request: "none", question: null } },
  { report: { conditions: [], findings: [], request: "none", question: null, requirements: [{ id: "R1", status: "met", note: "written" }] } }
];
// the free run (its plan only), T1, T2, T3, T5, T7, T8
for (const [k, f] of ["free", "t1.txt", "t2.txt", "t3.txt", "t5.txt", "t7.txt", "t8.txt"].entries()) script(`f3/${k + 1}`, f === "free" ? turns("free.txt").slice(0, 1) : turns(f));

// ---------- the fixture project: a bare remote, the hooks, a committer of its own ----------
const app0 = project("board-f3-app");
const bare = D("remote.git");
git(D(), "init", "-q", "--bare", bare);
git(app0, "remote", "add", "upstream", bare);
git(app0, "push", "-q", "upstream", "main:stable");
git(app0, "config", "user.name", "smoke");
git(app0, "config", "user.email", "smoke@localhost");
const hooksLog = D("hooks.log");
fs.writeFileSync(path.join(app0, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho "pre-commit $(git rev-parse --abbrev-ref HEAD)" >> "${hooksLog}"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(app0, ".git", "hooks", "commit-msg"), `#!/bin/sh
# a neutral fixture hook: the task's issue in the message or in the branch
b=$(git rev-parse --abbrev-ref HEAD)
grep -q "ISSUE-1" "$1" && { echo "commit-msg ok $b" >> "${hooksLog}"; exit 0; }
echo "$b" | grep -q "ISSUE-1" && { echo "commit-msg ok $b" >> "${hooksLog}"; exit 0; }
echo "commit-msg refused $b" >> "${hooksLog}"
echo "commit-msg: no ISSUE-1 in the message or the branch" >&2
exit 1
`, { mode: 0o755 });
const stable0 = git(app0, "rev-parse", "refs/remotes/upstream/stable").trim();
// the remote's stable moved by someone else: a commit pushed from another clone
const moveRemote = (file) => {
  const c = D(`clone-${file}`);
  git(D(), "clone", "-q", "-b", "stable", bare, c);
  fs.writeFileSync(path.join(c, file), "moved\n");
  git(c, "add", "-A");
  git(c, "commit", "-q", "-m", `move ${file}`);
  git(c, "push", "-q", "origin", "stable");
  return git(c, "rev-parse", "HEAD").trim();
};
const branches = () => git(app0, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").filter(Boolean).sort();
const boardRefs = () => git(app0, "for-each-ref", "--format=%(refname)", "refs/raoden/").trim();

fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
fs.writeFileSync(D("mock-state", ".codex", "config.toml"), "");
const ledger = D("ledger.jsonl");
const wrap = (p) => {
  const f = D(`${p}-mock`);
  fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return f;
};
const GIT_DIR = path.dirname(fs.realpathSync(execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim()));
const PATHS = `${path.dirname(NODE)}:${GIT_DIR}:/usr/bin:/bin`;
const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, MOCK_CHECKS: "none", MOCK_SCRIPT: D("script", "f3"), MOCK_SCRIPT_PER_CWD: "1",
  MOCK_TURN_DELAY_MS: "300", ...extra });
// the user's login shell: every line logged; the remote base's fetch fails or hangs on request
const SHELL = D("login-shell");
const shellLog = D("shell.log"), fetchLog = D("fetch.log"), FETCH_FAIL = D("fetch-fail"), FETCH_HANG = D("fetch-hang");
fs.writeFileSync(SHELL, `#!/bin/sh
[ "$1" = "-ilc" ] && shift
printf '%s\\n' "$1" >> "${shellLog}"
case "$1" in *"git fetch"*)
  printf '%s\\n' "$1" >> "${fetchLog}"
  [ -f "${FETCH_FAIL}" ] && { echo "fatal: the fixture's remote is down" >&2; exit 128; }
  [ -f "${FETCH_HANG}" ] && exec sleep 300 ;;
esac
exec /bin/sh -c "$1"
`, { mode: 0o755 });
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const providers = D("providers.json");
fs.writeFileSync(providers, JSON.stringify({
  codex: { executable: wrap("codex"), version: "codex-cli 0.162.0", path: PATHS, env: env({ CODEX_HOME: D("mock-state", ".codex") }) },
  claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({}) },
  shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
}));
const userData = D("user-data");
const BUTTON_FILE = D("chosen", "tasks.json"); // what the smoke's hook names instead of the dialog
fs.mkdirSync(path.dirname(BUTTON_FILE), { recursive: true });
const row = (ref, over = {}) => ({ ref, project: app0, title: `Задача ${ref}`, text: `Сделать ${ref}`, criteria: [`${ref} готово`], ...over });
const file = (tasks) => JSON.stringify({ format: "board-tasks/v1", workspaceId: "common", source: "smoke-f3", tasks });

let app;
const view = () => app.ev("window.canvasTTY.orchestration.board().then((r) => r.value)");
const taskOf = async (ref) => (await view()).board.tasks.find((t) => t.ref === ref);
const sel = (key, inner = "") => q(`[data-board-task="${key}"] ${inner}`.trim());
const line = (key) => app.ev(`${sel(key, "[data-board-line-text]")}?.textContent ?? null`);
const reason = (key) => app.ev(`${sel(key)}?.dataset.boardReason ?? null`);
const ipc = (call) => app.ev(`window.canvasTTY.orchestration.${call}`);
const J = (v) => JSON.stringify(v);
const click = async (selector) => { await app.ev(`${selector}?.scrollIntoView({ block: "center" })`); await app.clickEl(selector); };
const shot = (name) => app.shot(`f3-${name}`).catch((e) => console.log(`[smoke] screenshot ${name}: ${String(e?.message ?? e)}`));
const apState = async () => Object.values((await view()).autopilot ?? {})[0] ?? null;
const runsOf = async (ref) => { const v = await view(); const t = v.board.tasks.find((x) => x.ref === ref); return v.facts.filter((f) => f.taskId === t.id); };
const goalOf = (runId) => {
  const dir = path.join(userData, "orchestration", "runs", runId);
  const first = JSON.parse(fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").split("\n")[0]);
  return JSON.parse(fs.readFileSync(path.join(dir, "texts", first.data.goal.sha256), "utf8"));
};
const runCount = () => (fs.existsSync(path.join(userData, "orchestration", "runs")) ? fs.readdirSync(path.join(userData, "orchestration", "runs")).length : 0);
let linkId = null;
let base = null; // the profile as F3 sets it

async function start() {
  app = await launchApp({ userData, providers, port: PORT, shots: SHOTS, env: { CANVASTTY_USER_DATA_DIR: userData, CANVASTTY_SMOKE_IMPORT_FILE: BUTTON_FILE } });
  await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await app.waitFor("!!window.canvasTTY?.orchestration", "the orchestration API");
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
  await app.waitFor(`${q("[data-board-autopilot-start]")} && true`, "the autopilot off in the window", 20_000);
  await app.clickEl(q("[data-board-autopilot-start]"));
  await app.waitFor(`${q("[data-board-autopilot-confirm]")} && true`, "the autopilot's explanation");
  await app.clickEl(q("[data-board-autopilot-yes]"));
  await app.waitFor(`${q('[data-board-autopilot="on"]')} && true`, "the autopilot on");
}
const stopped = (ms = 240_000) => waitForValue(async () => { const s = await apState(); return s && !s.on && s.stop ? s.stop : null; }, "the autopilot to stop", ms);
async function mark(key) {
  await click(sel(key, "[data-board-external-done]"));
  await app.waitFor(`${sel(key, "[data-board-external-confirm]")} && true`, `${key}: the mark's note`);
  await click(sel(key, "[data-board-external-yes]"));
  await app.waitFor(`${q(`[data-board-task="${key}"][data-board-done="external"]`)} && true`, `${key} marked`);
}
const saveProfile = (over) => ipc(`saveProfile(${J(linkId)}, ${J({ ...base, ...over })}).then((r) => r.ok ? r.value : { code: r.code })`);
const stopRun = async (runId) => {
  const v = await ipc(`get(${J(runId)}).then((r) => r.value.view)`);
  await ipc(`command(${J({ runId, commandId: crypto.randomUUID(), expectedRevision: v.revision, command: { kind: "stop" } })})`);
  return waitForValue(() => ipc(`get(${J(runId)}).then((r) => ["stopped", "failed", "completed"].includes(r.value.view.status) ? r.value.view.status : null)`), `${runId} stopped`, 60_000);
};

try {
  await start();
  // the lead (Codex) and the executor (Claude) on one link
  await createAgent(app, "Агент Codex (лид)", app0);
  await createAgent(app, "Агент Claude (исполнитель)", app0);
  const c = await canvasState(app);
  const lead = c.agents.find((a) => a.provider === "codex"), exec = c.agents.find((a) => a.provider === "claude");
  const ends = () => Promise.all([app.center(card(lead.agentId, ".agent-card__port")), app.center(card(exec.agentId, ".agent-card__body"))]);
  let prev = null;
  const [from, to] = await waitForValue(async () => { const e = await ends(); const still = prev && J(prev) === J(e); prev = e; return still ? e : null; }, "the cards laid out");
  await app.drag(from, to, 20);
  await app.waitFor("window.canvasTTY.orchestration.canvas().then((r) => r.value.links.length === 1)", "link");
  linkId = (await canvasState(app)).links[0].linkId;
  if (!(await app.ev(`!!${q("[data-board]")}`))) await app.clickEl(q("[data-board-button]"));
  await app.waitFor(`${q("[data-board]")} && true`, "the board on the canvas");
  const p0 = await ipc(`profile(${J(linkId)}).then((r) => r.value.profile)`);
  base = { ...p0, workMode: "worktree", checks: ["true"], prepare: { auto: false, steps: [] }, finish: { ...p0.finish, commit: true } };
  ok("one place", (await ipc(`boardBudget(${J(linkId)}, { runs: 20, minutes: 240, parallel: 1 }).then((r) => r.ok)`)) === true);

  // ---------- f3.s1: the template in the profile ----------
  const tpl = {};
  for (const [name, over] of [["{ref}", { branchTemplate: "{ref}" }], ["fixed", { branchTemplate: "fixed-name" }], ["dots", { branchTemplate: "a..{ref}" }],
    ["space", { branchTemplate: "a {ref}" }], ["foo", { branchTemplate: "{foo}-{ref}" }], ["copy", { branchTemplate: "{ref}", workMode: "copy" }]]) {
    const r = await saveProfile(over);
    tpl[name] = r.code ?? r.branchTemplate;
  }
  ok("f3.s1 {ref} saved; no {ref}/{run8}, «..», a space — branch_template_invalid; {foo} — branch_template_unknown; copy — work_mode_not_worktree",
    J(tpl) === J({ "{ref}": "{ref}", fixed: "branch_template_invalid", dots: "branch_template_invalid", space: "branch_template_invalid", foo: "branch_template_unknown", copy: "work_mode_not_worktree" }), tpl);

  // ---------- f3.s2: the remote base ----------
  const runBase = { remote: "upstream", branch: "stable", remoteUrl: null };
  const saved = await saveProfile({ branchTemplate: "{issue}-{ref}", runBase });
  const read = await ipc(`profile(${J(linkId)}).then((r) => r.value.profile.runBase)`);
  ok("f3.s2 runBase saved, the remote's address read by main (shown in the settings)", saved.runBase?.remoteUrl === bare && read?.remoteUrl === bare, [saved, read]);
  const copyBase = await saveProfile({ workMode: "copy", branchTemplate: undefined, runBase });
  const projectBase = await saveProfile({ workMode: "project", branchTemplate: undefined, runBase });
  ok("f3.s2 runBase in copy and project — remote_base_mode", copyBase.code === "remote_base_mode" && projectBase.code === "remote_base_mode", [copyBase, projectBase]);
  base = { ...base, branchTemplate: "{issue}-{ref}", runBase };
  await saveProfile({});

  const imported = await importFile([row("T1", { issue: "ISSUE-1", commitTitle: "feat: первая задача" }), row("T1-MR", { criteria: undefined, external: true, dependsOn: ["T1"] }),
    row("T2", { issue: "ISSUE-1", commitTitle: "feat: вторая задача", dependsOn: ["T1-MR"] })]);
  const t1 = await taskOf("T1"), mr = await taskOf("T1-MR");
  ok("imported T1, T1-MR, T2 (issue, commitTitle)", imported === "imported" && t1.issue === "ISSUE-1" && t1.commitTitle === "feat: первая задача", [imported, t1]);
  const place = (await view()).remoteBase ?? [];
  ok("the board's view names the place with the remote base", place.length === 1 && place[0].endsWith(`\0${app0}`), place);

  // ---------- f3.s3: a free run, «Разбить», the dialog's start ----------
  const free = await ipc(`startOnLink(${J({ linkId, requestId: crypto.randomUUID(), goal: { text: "a free run", criteria: ["free.txt says done"], checks: [], commands: ["true"], mode: "autopilot", reviewPlan: true, workMode: "worktree" } })})`);
  ok("f3.s3 a free run (no task) in this project is created", free.ok === true, free);
  const freeId = free.value?.runId;
  await waitForValue(() => ipc(`get(${J(freeId)}).then((r) => r.value.view.status === "paused" ? true : null)`), "the free run to wait for its plan", 120_000);
  const dialog = await ipc(`startOnLink(${J({ linkId, requestId: crypto.randomUUID(), goal: { text: t1.text, criteria: t1.criteria, checks: [], commands: ["true"], mode: "autopilot", workMode: "worktree", task: { id: t1.id, key: t1.key } } })})`);
  ok("f3.s3 the dialog's start of T1 (the goal dialog's call) → remote_base_dialog, no run", dialog.code === "remote_base_dialog" && runCount() === 1, [dialog, runCount()]);
  const startBtn = await app.ev(`({ disabled: ${sel(t1.key, "[data-board-start]")}?.disabled ?? null, title: ${sel(t1.key, "[data-board-start]")}?.title ?? null })`);
  ok("f3.s3 the card: «Запустить» of T1 unavailable, with the reason (remote_base_dialog)", startBtn.disabled === true && /автопилот/.test(startBtn.title ?? ""), startBtn);
  const split = await ipc(`boardDecompose(${J(t1.id)}, "ru")`);
  const splitMark = await ipc(`boardUpdate(${J(t1.id)}, { decompose: true })`);
  ok("f3.s3 «Разбить» (main: the mark and the split) → remote_base_mode", split.code === "remote_base_mode" && splitMark.code === "remote_base_mode", [split, splitMark]);
  await click(sel(t1.key, ".board-task__title"));
  await app.waitFor(`${q("[data-board-form]")} && true`, "the form of T1");
  const box = await app.ev(`({ disabled: ${q('[data-board-field="decompose"]')}?.disabled ?? null, title: ${q('[data-board-field="decompose"]')}?.closest("label")?.title ?? null })`);
  ok("f3.s3 the form: «Разбить на подзадачи» unavailable, with the reason", box.disabled === true && /базе от remote/.test(box.title ?? ""), box);
  await shot("s3-no-split");
  await app.clickEl(q(".launch-dialog__close"));
  await app.waitFor(`!${q("[data-board-form]")}`, "the form closed");
  ok("f3.s3 T1-MR waits for T1 (waits_task), never waits_mr", (await reason(mr.key)) === "waits_task", await reason(mr.key));

  ok("f3.s3 the free run is stopped (its plan shown)", (await stopRun(freeId)) === "stopped");

  // ---------- f3.s4: T1 → T1-MR → T2, the remote moved between the starts ----------
  await runBoard();
  const waiting = await waitForValue(async () => { const s = await apState(); return s?.on && s.waits === "external" ? s : s && !s.on ? s : null; }, "T1 done, the wait for T1-MR", 240_000);
  ok("f3.s3 after T1 the autopilot waits for T1-MR's mark (wait / external), not off", waiting.on === true && waiting.waitsKey === mr.key, waiting);
  const [r1] = await runsOf("T1");
  const g1 = goalOf(r1.runId);
  ok("f3.s4 T1: the branch ISSUE-1-T1, the base the remote's commit", g1.branch === "ISSUE-1-T1" && J(g1.base) === J({ branch: "upstream/stable", commit: stable0, key: "remote" }), [g1.branch, g1.base]);
  ok("f3.s4 T1's commit through the hooks: its title, on the remote's commit", git(app0, "log", "-1", "--format=%s", "ISSUE-1-T1").trim() === "feat: первая задача"
    && git(app0, "rev-parse", "ISSUE-1-T1^").trim() === stable0 && lines(hooksLog).includes("pre-commit ISSUE-1-T1") && lines(hooksLog).includes("commit-msg ok ISSUE-1-T1"), lines(hooksLog));
  // the autopilot's state above is main's; the card is the renderer's, read again every 2 s while the autopilot is on
  await app.waitFor(`${sel(mr.key)} && !${sel(mr.key)}.dataset.boardReason && ${sel(mr.key, "[data-board-external-done]")}?.disabled === false`,
    "T1-MR's card: no reason, «Выполнено» enabled", 10_000).catch(() => {});
  ok("f3.s3 T1-MR: no waits_mr, «Выполнено» available once T1 is «Готово»", (await reason(mr.key)) === null && (await app.ev(`${sel(mr.key, "[data-board-external-done]")}?.disabled`)) === false, await reason(mr.key));
  ok("f3.s4 no board's ref, no merge, no take", boardRefs() === "" && (await view()).heads === undefined && !branches().some((b) => b.startsWith("raoden/")) && r1.taken == null, [boardRefs(), branches()]);
  await shot("s4-waits-mr-mark");
  ok("f3.s4 one fetch for T1's start", lines(fetchLog).length === 1, lines(fetchLog));
  // f3.s2: runBase changed while the autopilot is on (it waits for the mark): the next start is refused settings_changed
  const other = await saveProfile({ runBase: { ...runBase, branch: "other" } });
  await mark(mr.key);
  const changed = await stopped(30_000);
  ok("f3.s2 runBase changed while on → settings_changed, before any fetch or start", other.runBase?.branch === "other" && changed.code === "settings_changed"
    && lines(fetchLog).length === 1 && (await runsOf("T2")).length === 0, [other.runBase, changed]);
  await saveProfile({});
  // the remote moves between the starts; on again — the start after the mark fetches anew
  const moved = moveRemote("moved.txt");
  await runBoard();
  const t2Run = await waitForValue(async () => (await runsOf("T2"))[0] ?? null, "T2 started", 60_000);
  ok("f3.s4 after the mark of T1-MR the start fetched anew", lines(fetchLog).length === 2, lines(fetchLog));
  const g2 = goalOf(t2Run.runId);
  ok("f3.s4 T2 from the moved remote's commit, on ISSUE-1-T2", g2.branch === "ISSUE-1-T2" && g2.base?.commit === moved && g2.base?.key === "remote", [g2.branch, g2.base]);
  const end4 = await stopped();
  ok("f3.s4 the chain done: all_done", end4.code === "all_done", end4);
  ok("f3.s4 T2's commit on the moved commit, through the hooks", git(app0, "rev-parse", "ISSUE-1-T2^").trim() === moved && git(app0, "log", "-1", "--format=%s", "ISSUE-1-T2").trim() === "feat: вторая задача"
    && lines(hooksLog).includes("commit-msg ok ISSUE-1-T2"));
  const v4 = await view();
  ok("f3.s4 after «Готово» the names are the same, no take, no board's ref", ["T1", "T2"].every((r) => v4.board.tasks.find((t) => t.ref === r)) && (await runsOf("T1"))[0].taken == null
    && (await runsOf("T2"))[0].taken == null && branches().includes("ISSUE-1-T1") && branches().includes("ISSUE-1-T2") && boardRefs() === "", branches());
  ok("f3.s4 every fetch: GIT_TERMINAL_PROMPT=0, the explicit refspec", lines(fetchLog).every((l) => l === "GIT_TERMINAL_PROMPT=0 git fetch --no-tags 'upstream' '+refs/heads/stable:refs/remotes/upstream/stable'"), lines(fetchLog));

  // ---------- f3.s3: a direct dependency on an ordinary task ----------
  await importFile([row("D1", { issue: "ISSUE-1", dependsOn: ["T2"] })]);
  const d1 = await taskOf("D1");
  await app.waitFor(`${q(`[data-board-task="${d1.key}"][data-board-reason="waits_mr"]`)} && true`, "D1 waits_mr");
  ok("f3.s3 D1 (directly on T2): waits_mr on the card", /MR/.test((await line(d1.key)) ?? ""), await line(d1.key));
  await runBoard();
  const others = await stopped(60_000);
  ok("f3.s3 the autopilot with only D1 left: others_wait", others.code === "others_wait" && (await runsOf("D1")).length === 0, others);
  await shot("s3-waits-mr");

  // ---------- f3.s5: the free name ----------
  git(app0, "push", "-q", "upstream", "main:refs/heads/ISSUE-1-T3");
  await importFile([row("T3", { issue: "ISSUE-1" })]);
  await runBoard();
  const t3Run = await waitForValue(async () => (await runsOf("T3"))[0] ?? null, "T3 started", 60_000);
  ok("f3.s5 ISSUE-1-T3 only on the remote: the run on ISSUE-1-T3-2", goalOf(t3Run.runId).branch === "ISSUE-1-T3-2" && branches().includes("ISSUE-1-T3-2") && !branches().includes("ISSUE-1-T3"), goalOf(t3Run.runId).branch);
  await stopped();
  for (const k of ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8"]) git(app0, "branch", `ISSUE-1-T4${k}`);
  git(app0, "push", "-q", "upstream", "main:refs/heads/ISSUE-1-T4-9");
  await importFile([row("T4", { issue: "ISSUE-1" })]);
  const before5 = runCount();
  await runBoard();
  const taken = await stopped(60_000);
  const t4 = await taskOf("T4");
  ok("f3.s5 every name up to -9 taken: start_failed branch_taken, no run", taken.code === "start_failed" && taken.detail === "branch_taken" && taken.key === t4.key && runCount() === before5, taken);
  await ipc(`boardArchive(${J(t4.id)}, true)`);

  // ---------- f3.s6: the commit-msg hook refuses ----------
  await importFile([row("T5", { issue: "ISSUE-2", commitTitle: "feat: пятая задача" })]);
  await runBoard();
  const paused = await stopped();
  const [r5] = await runsOf("T5");
  const v5 = await ipc(`get(${J(r5.runId)}).then((r) => r.value.view)`);
  ok("f3.s6 the hook refused: a pause finish_unconfirmed, not «Готово»; the autopilot off run_paused", paused.code === "run_paused" && v5.status === "paused" && v5.reason === "finish_unconfirmed"
    && (await app.ev(`${sel((await taskOf("T5")).key)}?.dataset.boardDone ?? null`)) === null && lines(hooksLog).includes("commit-msg refused ISSUE-2-T5"), [paused, v5.status, v5.reason]);
  ok("f3.s6 no --no-verify in any line of the login shell", lines(shellLog).length > 0 && !lines(shellLog).some((l) => l.includes("--no-verify")) && lines(shellLog).some((l) => l.includes("git commit")));
  await shot("s6-hook-refused");
  await stopRun(r5.runId);
  await ipc(`boardArchive(${J((await taskOf("T5")).id)}, true)`);

  // ---------- f3.s7: the fetch's refusals ----------
  await importFile([row("X1", { criteria: undefined, external: true }), row("T6", { dependsOn: ["X1"] }), row("T7", { issue: "ISSUE-1" })]);
  const x1 = await taskOf("X1"), t6 = await taskOf("T6"), t7 = await taskOf("T7");
  await mark(x1.key);
  const before7 = runCount();
  fs.writeFileSync(FETCH_FAIL, "");
  await runBoard();
  const failed = await stopped(60_000);
  const failedText = await waitForValue(() => app.ev(`${q('[data-board-autopilot-stop="base_fetch_failed"]')}?.textContent ?? null`), "the stop in the window").catch(() => null);
  ok("f3.s7 the fetch fails → base_fetch_failed, no run; the window says so", failed.code === "base_fetch_failed" && failed.key === t7.key && runCount() === before7
    && (failedText ?? "").includes(`${t7.key}: не удалось получить ветку remote — проверьте сеть и доступ`), [failed, failedText]);
  await shot("s7-fetch-failed");
  fs.rmSync(FETCH_FAIL);
  fs.writeFileSync(FETCH_HANG, "");
  const t0 = Date.now();
  await runBoard();
  const hung = await stopped(200_000);
  ok("f3.s7 the fetch hangs → base_fetch_failed after its 120 s, no run", hung.code === "base_fetch_failed" && /did not answer in 120 s/.test(hung.detail ?? "") && Date.now() - t0 >= 115_000 && runCount() === before7,
    [hung, Math.round((Date.now() - t0) / 1000)]);
  fs.rmSync(FETCH_HANG);
  git(app0, "remote", "set-url", "upstream", D("elsewhere.git"));
  await runBoard();
  const mismatch = await stopped(60_000);
  ok("f3.s7 another fetch address → base_remote_mismatch, no run", mismatch.code === "base_remote_mismatch" && runCount() === before7, mismatch);
  git(app0, "remote", "set-url", "upstream", bare);
  git(app0, "remote", "set-url", "--push", "upstream", D("push-only.git"));

  // ---------- f3.s8: a task without issue at {issue}-{ref}; pushurl ≠ url ----------
  await runBoard();
  const t7Run = await waitForValue(async () => (await runsOf("T7"))[0] ?? null, "T7 started", 60_000);
  ok("f3.s7 pushurl ≠ url with the right url: the base is taken", goalOf(t7Run.runId).base?.key === "remote" && goalOf(t7Run.runId).branch === "ISSUE-1-T7", goalOf(t7Run.runId));
  ok("f3.s8 T6 (no issue, its dependency X1 done): branch_template_field on its card, skipped — T7 taken", (await reason(t6.key)) === "branch_template_field" && (await runsOf("T6")).length === 0,
    [await reason(t6.key), await line(t6.key)]);
  const end8 = await stopped();
  ok("f3.s8 the autopilot did not stop on T6: T7 done, then others_wait", end8.code === "others_wait" && (await runsOf("T7"))[0].status === "completed", end8);
  await shot("s8-template-field");

  // ---------- f3.s9: the profile without the new keys ----------
  for (const t of [d1, t6]) await ipc(`boardArchive(${J(t.id)}, true)`);
  const { branchTemplate: _b, runBase: _r, ...plain } = base;
  base = plain;
  const plainSaved = await saveProfile({});
  ok("f3.s9 the profile without branchTemplate and runBase", plainSaved.branchTemplate === undefined && plainSaved.runBase === undefined, plainSaved);
  await importFile([row("T8", { commitTitle: "feat: ISSUE-1 восьмая задача" })]); // the fixture hook: ISSUE-1 in the message (the branch is canvastty/…)
  const fetches9 = lines(fetchLog).length;
  await runBoard();
  const r8 = await waitForValue(async () => (await runsOf("T8"))[0] ?? null, "T8 started", 60_000);
  const own8 = await waitForValue(() => branches().includes(`canvastty/${r8.runId.slice(0, 8)}`) || null, "T8's worktree branch", 60_000).catch(() => false);
  const end9 = await stopped();
  const g8 = goalOf(r8.runId);
  const v9 = await view();
  ok("f3.s9 as before: canvastty/<run8>, no goal.branch, the base the board's result (T-0), no fetch", end9.code === "all_done" && !("branch" in g8) && g8.base?.key === "T-0"
    && own8 === true && lines(fetchLog).length === fetches9, [end9, g8.base, g8.branch]);
  ok("f3.s9 the take raoden/…, the board's result made and merged", /^refs\/raoden\/board\//.test(boardRefs()) && branches().some((b) => b.startsWith("raoden/"))
    && v9.heads?.[0]?.merges?.some((m) => m.status === "completed"), [boardRefs(), branches(), v9.heads?.[0]?.merges?.map((m) => m.status)]);
  await shot("s9-as-before");
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 1500)}`);
  try { failures.push(`state: ${J({ autopilot: await apState(), runs: await ipc("list().then((r) => r.value.map((x) => [x.view.runId.slice(0, 8), x.view.status, x.view.reason]))") })}`.slice(0, 1500)); } catch {}
  try { await app?.shot("f3-failure"); } catch {}
} finally {
  await app?.quit?.();
}

console.log(JSON.stringify({ ok: failures.length === 0, passed: passed.length, passedList: passed, failures, fakeCliProcesses: fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0, fetches: lines(fetchLog).length, shots: SHOTS }, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
