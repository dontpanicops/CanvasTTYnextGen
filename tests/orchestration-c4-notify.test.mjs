// C4.3 (docs/agent-orchestration/implementation/stage-c4-limits.md §4, §5): the board's own notifications — a merge
// waiting for the person once per merge and reason (a restart repeats none: the record), the autopilot continuing after
// a provider's limit, the board's result moved only when asked for; the Dock badge; the autopilot's line at a limit.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_NOTIFY_PREFS, boardHeadNotes } from "../src/renderer/src/features/orchestration/notify.ts";
import { resetTime } from "../src/renderer/src/features/orchestration/runModel.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSettings, SettingsStore } from "../src/main/services/SettingsStore.ts";

const merge = (extra) => ({ runId: "m1", board: "refs/raoden/board/common/1", base: "b".repeat(40), task: { id: "t", key: "T-2", runId: "r", commit: "c".repeat(40) },
  status: "paused", reason: "merge_conflict", detail: null, completion: null, conflicts: ["a.txt"], outside: [], interference: false, retrying: false, dir: null, createdAt: 10, ...extra });
const head = (merges) => ({ workspaceId: "common", project: "/x/app", ref: "refs/raoden/board/common/1", n: 1, commit: "b".repeat(40), behind: null, branch: null, merges });
const place = (p) => p.split("/").at(-1);
const run = (heads, notified, prefs = DEFAULT_NOTIFY_PREFS, autopilot = {}, focused = false) => boardHeadNotes("ru", heads, autopilot, notified, prefs, focused, place);

test("a merge waiting for the person: told once per merge and reason, never again from the kept record; first seen — only recorded; a slot or a run is not told", () => {
  const first = run([head([merge()])], {});
  assert.deepEqual([first.notes.length, first.notified["merge:m1"], first.waiting], [0, "merge_conflict", 1], "first seen: recorded, counted on the badge");
  const before = run([head([merge({ status: "running", reason: null })])], {});
  const told = run([head([merge()])], before.notified);
  assert.deepEqual(told.notes.map((n) => [n.runId, n.signal, n.title, n.body]), [["merge-m1", "waiting", "app", "Объединение T-2 — конфликт, решите"]]);
  assert.equal(run([head([merge()])], told.notified).notes.length, 0, "the same again (a restart reads the record): nothing");
  const agentFailed = run([head([merge({ reason: "merge_agent_failed" })])], told.notified);
  assert.equal(agentFailed.notes[0].body, "Объединение T-2 — агент не справился", "another reason: told");
  for (const reason of ["merge_waits_slot"]) assert.equal(run([head([merge({ reason })])], before.notified).notes.length, 0, reason);
  assert.equal(run([head([merge({ status: "running", reason: null, agent: { attempt: 1, reason: "conflict", resolutionRunId: "z", pending: true } })])], before.notified).waiting, 0);
  // the window in focus, or «Доска» off: recorded, not told
  assert.equal(run([head([merge()])], before.notified, DEFAULT_NOTIFY_PREFS, {}, true).notes.length, 0);
  assert.equal(run([head([merge()])], before.notified, { ...DEFAULT_NOTIFY_PREFS, board: false }).notes.length, 0);
});

test("the autopilot continued a run after a limit: told once per continuation; the run's note opens it", () => {
  const ap = (resumed) => ({ L: { on: true, budget: { runs: 5, minutes: 240 }, used: { runs: 1, minutes: 0 }, waits: null, stop: null, resumed } });
  const r1 = { runId: "run-1", key: "T-1", provider: "claude", at: "2026-10-19T12:01:00.000Z" };
  const seen = run([], {}, DEFAULT_NOTIFY_PREFS, ap(null));
  const told = run([], seen.notified, DEFAULT_NOTIFY_PREFS, ap(r1));
  assert.deepEqual(told.notes.map((n) => [n.runId, n.title, n.body]), [["run-1", "Лимит сброшен, продолжаю: T-1", "Claude"]]);
  assert.equal(run([], told.notified, DEFAULT_NOTIFY_PREFS, ap(r1)).notes.length, 0);
});

test("the board's result moved: only with «Итог доски обновлён» on (off by default), once per new merge, the tasks merged since", () => {
  const done = (key, at, extra) => merge({ runId: `d${at}`, task: { id: key, key, runId: "r", commit: "c".repeat(40) }, status: "completed", reason: null, completion: "confirmed", createdAt: at, ...extra });
  const on = { ...DEFAULT_NOTIFY_PREFS, boardHead: true };
  assert.equal(DEFAULT_NOTIFY_PREFS.boardHead, false);
  const seen = run([head([done("T-1", 10)])], {}, on);
  assert.equal(seen.notes.length, 0, "first seen: recorded");
  const two = run([head([done("T-3", 30), done("T-2", 20), done("T-1", 10)])], seen.notified, on);
  assert.deepEqual(two.notes.map((n) => n.body), ["Итог доски обновлён: T-2, T-3 · проверки прошли"]);
  assert.equal(run([head([done("T-3", 30), done("T-2", 20), done("T-1", 10)])], seen.notified).notes.length, 0, "off by default");
  assert.equal(run([head([done("T-3", 30), done("T-2", 20), done("T-1", 10)])], two.notified, on).notes.length, 0);
  // «already» merged nothing: no move
  assert.equal(run([head([done("T-4", 40, { reason: "already" }), done("T-1", 10)])], seen.notified, on).notes.length, 0);
});

test("the setting boardHead survives the settings' normalisation; absent — off", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-c4-notify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const defaults = await new SettingsStore(directory, "ru", "darwin").load();
  assert.equal(defaults.notifications.boardHead, false);
  const s = normalizeSettings({ notifications: { waiting: true, completed: true, failed: true, dockBadge: true, bounce: false, board: true, boardHead: true } }, defaults);
  assert.equal(s.notifications.boardHead, true);
  assert.equal(normalizeSettings({ notifications: { board: true } }, defaults).notifications.boardHead, false);
});

test("a reset time: today the hour, tomorrow «завтра», later the date", () => {
  const now = new Date(2026, 9, 19, 10, 0).getTime();
  assert.match(resetTime("ru", new Date(2026, 9, 19, 15, 0).getTime(), now), /^15:00$/);
  assert.match(resetTime("ru", new Date(2026, 9, 20, 15, 0).getTime(), now), /^завтра 15:00$/);
  assert.match(resetTime("en", new Date(2026, 9, 20, 15, 0).getTime(), now), /^tomorrow 3:00\s?PM$/);
  assert.match(resetTime("ru", new Date(2026, 9, 24, 15, 0).getTime(), now), /24 окт.*15:00/);
});
