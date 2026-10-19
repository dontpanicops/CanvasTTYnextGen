// C4.1 (docs/agent-orchestration/implementation/stage-c4-limits.md §1): a provider's usage limit recognised in a turn's
// frames — Claude's rate_limit_info, Codex's codexErrorInfo with its windows or its text — whatever the history keeps,
// written to the feed with its reset judged at the turn's end, and read back by the one pause classification. Pure.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { codexTryAgain, limitEntry, noteLimit } from "../src/main/services/orchestration/providerLimit.ts";
import { TurnCollector } from "../src/main/services/orchestration/jsonl.ts";
import { pauseCause } from "../src/shared/orchestrationPause.ts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGit } from "../src/main/services/orchestration/git.ts";
import { createRunManager, testNativeRuntime } from "../src/main/services/orchestration/manager.ts";
import { viewCause } from "../src/renderer/src/features/orchestration/runModel.ts";

const ev = (type, value) => ({ kind: "event", type, value: { type, ...value }, bytes: 100 });
const rpc = (method, params) => ({ kind: "event", type: method, value: { jsonrpc: "2.0", method, params }, bytes: 100 });
const run = (provider, frames) => frames.reduce((s, f) => noteLimit(s, provider, f), null);
const RESET = 1_792_400_000; // seconds of the epoch
// the one recorded Codex message (codex-cli 0.155.1, evidence/real-stage-13/series-S3-S5-S6-attempt2)
const CODEX_TEXT = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 28th, 2026 11:51 PM.";

test("Claude: rate_limit_event rejected is the limit with its reset; rejected then allowed is none", () => {
  const rejected = ev("rate_limit_event", { rate_limit_info: { status: "rejected", resetsAt: RESET, rateLimitType: "five_hour" } });
  assert.deepEqual(run("claude", [rejected]), { provider: "claude", hit: true, resetsAt: RESET * 1000, source: "rate_limit_info", windows: null, text: null });
  const allowed = ev("rate_limit_event", { rate_limit_info: { status: "allowed", resetsAt: RESET } });
  assert.equal(run("claude", [rejected, allowed]).hit, false);
  assert.equal(run("claude", [ev("assistant", { message: { content: [] } })]), null);
});

test("Claude: the refusal's api_error_params.rate_limit_info is the limit too", () => {
  const s = run("claude", [ev("assistant", { error: { type: "usage_limit_reached", api_error_params: { rate_limit_info: { status: "rejected", resetsAt: RESET } } } })]);
  assert.equal(s.hit, true);
  assert.equal(s.resetsAt, RESET * 1000);
});

test("Codex: usageLimitExceeded takes the used-up window's reset; without windows the reset from its text; without either unknown", () => {
  const windows = rpc("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 100, resetsAt: RESET }, secondary: { usedPercent: 40, resetsAt: RESET + 9999 } } });
  const error = rpc("error", { error: { message: CODEX_TEXT, codexErrorInfo: "usageLimitExceeded" }, willRetry: false, threadId: "t", turnId: "u" });
  assert.deepEqual([run("codex", [windows, error]).hit, run("codex", [windows, error]).resetsAt], [true, RESET * 1000]);
  const fromText = run("codex", [error]);
  assert.equal(fromText.resetsAt, new Date(2026, 8, 28, 23, 51).getTime());
  const bare = rpc("error", { error: { message: "limit", codexErrorInfo: "usageLimitExceeded" } });
  assert.equal(run("codex", [bare]).resetsAt, null);
  // the windows arriving after the error still give the reset
  assert.equal(run("codex", [bare, windows]).resetsAt, RESET * 1000);
});

test("Codex: rateLimitExceeded is a throttle, not a limit; the text alone (older CLIs, exec) is a limit", () => {
  assert.equal(run("codex", [rpc("error", { error: { message: "rate limited", codexErrorInfo: "rateLimitExceeded" }, willRetry: true })]), null);
  const text = run("codex", [rpc("turn/completed", { turn: { status: "failed", error: { message: CODEX_TEXT } } })]);
  assert.deepEqual([text.hit, text.source], [true, "codex_text"]);
  const exec = run("codex", [ev("turn.failed", { error: { message: CODEX_TEXT } })]);
  assert.equal(exec.hit, true);
  // error then turn/completed with the same message: the first, structured, stays
  const both = run("codex", [rpc("error", { error: { message: CODEX_TEXT, codexErrorInfo: "usageLimitExceeded" } }), rpc("turn/completed", { turn: { status: "failed", error: { message: CODEX_TEXT } } })]);
  assert.equal(both.source, "codex_error");
});

test("codexTryAgain: the recorded format in local time; anything else null", () => {
  assert.equal(codexTryAgain("try again at Oct 1st, 2026 9:05 AM."), new Date(2026, 9, 1, 9, 5).getTime());
  assert.equal(codexTryAgain("try again at Dec 12th, 2026 12:00 AM"), new Date(2026, 11, 12, 0, 0).getTime());
  assert.equal(codexTryAgain("try again later"), null);
  assert.equal(codexTryAgain("try again at Foo 1st, 2026 9:05 AM"), null);
});

test("a turn of 1500 frames with the limit at its end: the history keeps the first 1000, the limit is still seen", () => {
  const c = new TurnCollector("claude", { maxEvents: 1000, maxErrors: 100 });
  for (let i = 0; i < 1499; i++) c.push(ev("assistant", { message: { content: [{ type: "text", text: `${i}` }] } }));
  c.push(ev("rate_limit_event", { rate_limit_info: { status: "rejected", resetsAt: RESET } }));
  assert.equal(c.events.length, 1000);
  assert.equal(c.limit?.hit, true);
  assert.equal(c.limit?.resetsAt, RESET * 1000);
});

test("the feed's record: the reset judged at the turn's end — beyond 7 days or over an hour behind is unknown", () => {
  const end = Date.UTC(2026, 9, 19, 12, 0);
  const at = (ms) => limitEntry({ provider: "claude", hit: true, resetsAt: ms, source: "rate_limit_info", windows: null, text: null }, end).detail.limitResetsAt;
  assert.equal(at(end + 3 * 3600_000), "2026-10-19T15:00:00.000Z");
  assert.equal(at(end + 8 * 24 * 3600_000), null);
  assert.equal(at(end - 2 * 3600_000), null);
  assert.equal(at(end - 10 * 60_000), "2026-10-19T11:50:00.000Z");
  assert.equal(at(null), null);
  const e = limitEntry({ provider: "codex", hit: true, resetsAt: end + 3600_000, source: "codex_error", windows: null, text: null }, end);
  assert.equal(e.text, "Codex: usage limit reached · resets 2026-10-19 13:00 UTC");
  assert.deepEqual(Object.keys(e.detail).sort(), ["limitProvider", "limitResetsAt", "limitSource"]);
});

test("pauseCause reads main's record first; the Codex text of a run from before C4 still reads, its reset unparsed", () => {
  const turnId = "t1";
  const entries = (error) => [
    { id: 1, turnId, kind: "error", provider: "claude", role: "executor", text: error.text, detail: error.detail },
    { id: 2, turnId, kind: "turn_finished", provider: "claude", role: "executor", text: "failed", detail: { endStep: "terminal_failure" } }
  ];
  const mine = limitEntry({ provider: "claude", hit: true, resetsAt: Date.UTC(2026, 9, 19, 15), source: "rate_limit_info", windows: null, text: null }, Date.UTC(2026, 9, 19, 12));
  assert.deepEqual(pauseCause("environment_error", turnId, entries(mine)),
    { kind: "provider_limit", reason: "environment_error", provider: "claude", resetsAt: null, resetsAtMs: Date.UTC(2026, 9, 19, 15) });
  const old = pauseCause("environment_error", turnId, entries({ text: CODEX_TEXT }));
  assert.deepEqual([old.kind, old.resetsAt, old.resetsAtMs], ["provider_limit", "Sep 28th, 2026 11:51 PM", null]);
  // another pause than the turn's outcome makes is not the limit's
  assert.equal(pauseCause("invalid_report", turnId, entries(mine)).kind, "reason");
});

// ---------- a real cycle on the fake CLIs: the executor's turn ends at Claude's limit ----------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT = findGit(process.env);
const NODE = fs.realpathSync(process.execPath);
const LAUNCH = { command: NODE, args: [path.join(HERE, "..", "src", "orchestration", "supervisor.mjs")], env: {} };
const OPTS = { skip: process.platform === "win32" && "orchestration runs on macOS and Linux", timeout: 120_000 };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-c4-limit-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.writeFileSync(path.join(TMP, "gitconfig"), "");
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let k = 0;
const wrapper = (name, mock) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${path.join(HERE, "fixtures", "orchestration", mock)}" "$@"\n`, { mode: 0o755 });
  return file;
};
const CODEX = wrapper("codex", "mock-codex.mjs");
const CLAUDE = wrapper("claude", "mock-claude.mjs");
const SHELL = path.join(TMP, "test-shell");
fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
fs.mkdirSync(path.join(TMP, ".codex"));
fs.writeFileSync(path.join(TMP, ".codex", "config.toml"), "");
function script(steps) {
  const dir = path.join(TMP, `script-${++k}`);
  fs.mkdirSync(dir);
  steps.forEach((s, i) => { fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(s)); });
  return dir;
}
function manager(steps) {
  const file = path.join(TMP, `providers-${++k}.json`);
  const p = { path: `${TMP}:/usr/bin:/bin`, env: { HOME: TMP, CODEX_HOME: path.join(TMP, ".codex"), MOCK_STATE: fs.mkdtempSync(path.join(TMP, "state-")), MOCK_SCRIPT: script(steps), MOCK_CHECKS: "none" } };
  fs.writeFileSync(file, JSON.stringify({ codex: { executable: CODEX, version: "codex-cli 0.162.0", ...p }, claude: { executable: CLAUDE, version: "2.1.303 (Claude Code)", ...p },
    shell: SHELL, checkEnv: { ...GIT_ENV, PATH: `/usr/bin:/bin:${path.dirname(GIT)}`, HOME: TMP } }));
  return createRunManager({ platform: "darwin", root: path.join(TMP, `root-${++k}`), gitPath: () => GIT, launch: () => LAUNCH, nodePath: () => NODE, stopGraceMs: 2000,
    agents: async () => { throw new Error("not used"); }, native: testNativeRuntime(file, () => LAUNCH), leadSandbox: false, journalV2: true });
}
function project() {
  const dir = path.join(TMP, `project-${++k}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync(GIT, a, { cwd: dir, env: GIT_ENV });
  return dir;
}
const PLAN = { stages: [{ title: "Edit", task: "Edit a.txt", conditions: [{ keep: null, text: "a.txt changed", covers: ["R1"], evidence: { kind: "change", check: null } }] }], dropped: [], dropRequirements: [], question: null };

test("a cycle on the fake CLIs: Claude's limit ends the executor's turn — paused as before, the limit in the feed before the turn's end, read with its reset", OPTS, async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
  const m = manager([PLAN, { __limit: { resetsAt } }]);
  const runId = randomUUID();
  assert.ok((await m.create({ requestId: runId, source: project(), goal: { text: "Edit a.txt", criteria: ["a.txt changed"], checks: [], commands: ["true"], workMode: "copy", mode: "autopilot" } })).ok);
  let view;
  for (const end = Date.now() + 60_000; Date.now() < end; await sleep(50)) { view = (await m.get(runId)).value.view; if (view.status === "paused") break; }
  assert.deepEqual([view.status, view.reason], ["paused", "environment_error"], "the journal is unchanged");
  const entries = (await m.activity(runId, 0, 500)).value.entries;
  const at = entries.findIndex((e) => e.kind === "error" && e.detail?.limitProvider === "claude");
  const end = entries.findIndex((e, i) => i > at && e.kind === "turn_finished");
  assert.ok(at >= 0 && end > at, "the limit before the turn's end");
  assert.equal(entries[at].detail.limitSource, "rate_limit_info");
  const cause = viewCause(view, entries);
  assert.deepEqual([cause.kind, cause.provider, cause.resetsAtMs], ["provider_limit", "claude", resetsAt * 1000]);
  await m.shutdown();
});
